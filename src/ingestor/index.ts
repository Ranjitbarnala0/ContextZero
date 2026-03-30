/**
 * ContextZero — Ingestion Pipeline
 *
 * Orchestrates full codebase ingestion: file discovery, language dispatch,
 * symbol extraction, relation resolution, behavioral profiling, and
 * contract extraction.
 *
 * Security: Uses execFileSync (array args) instead of execSync (shell string)
 * for Python adapter invocation to prevent command injection.
 */

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
import { Logger } from '../logger';
import { coreDataService } from '../db-driver/core_data';
import { structuralGraphEngine } from '../analysis-engine';
import { behavioralEngine } from '../analysis-engine/behavioral';
import { contractEngine } from '../analysis-engine/contracts';
import { extractFromTypeScript } from '../adapters/ts';
import { semanticEngine } from '../semantic-engine';
import { dispatchResolver } from '../analysis-engine/dispatch-resolver';
import { symbolLineageEngine } from '../analysis-engine/symbol-lineage';
import { effectEngine } from '../analysis-engine/effect-engine';
import { deepContractSynthesizer } from '../analysis-engine/deep-contracts';
import { conceptFamilyEngine } from '../analysis-engine/concept-families';
import { temporalEngine } from '../analysis-engine/temporal-engine';
import { db } from '../db-driver';
import { booleanField, firstRow, optionalStringField } from '../db-driver/result';
import { symbolCache, profileCache, capsuleCache, homologCache, queryCache } from '../cache';
import { resolveExistingPath, resolvePathWithinBase } from '../path-security';
import type { PoolClient } from 'pg';
import type { SymbolVersionRow } from '../db-driver/core_data';
import type {
    AdapterExtractionResult, IngestionResult,
    ExtractedSymbol,
} from '../types';

const log = new Logger('ingestor');

/** File extensions to language mapping.
 *  Every extension here MUST have a corresponding adapter dispatch path.
 *  tree-sitter-cpp is a superset of C, so .c/.h map to 'cpp'. */
const LANGUAGE_MAP: Record<string, string> = {
    // TypeScript
    '.ts': 'typescript',
    '.tsx': 'typescript',
    '.mts': 'typescript',
    '.cts': 'typescript',
    // JavaScript
    '.js': 'javascript',
    '.jsx': 'javascript',
    '.mjs': 'javascript',
    '.cjs': 'javascript',
    // Python
    '.py': 'python',
    '.pyi': 'python', // Type stubs — critical for type inference
    '.pyw': 'python',
    // C / C++ (tree-sitter-cpp is a C superset)
    '.c': 'cpp',
    '.cpp': 'cpp',
    '.cc': 'cpp',
    '.cxx': 'cpp',
    '.hpp': 'cpp',
    '.hh': 'cpp',
    '.hxx': 'cpp',
    '.h': 'cpp',
    // Go
    '.go': 'go',
    // Rust
    '.rs': 'rust',
    // Java
    '.java': 'java',
    // C#
    '.cs': 'csharp',
    // Ruby
    '.rb': 'ruby',
    // Kotlin
    '.kt': 'kotlin',
    '.kts': 'kotlin',
    // Swift
    '.swift': 'swift',
    // PHP
    '.php': 'php',
    // Shell / Bash
    '.sh': 'bash',
    '.bash': 'bash',
};

/** Directories to always skip — build outputs, dependency caches, IDE configs */
const SKIP_DIRS = new Set([
    // Version control
    '.git', '.svn', '.hg',
    // JavaScript/TypeScript
    'node_modules', 'dist', 'build', '.next', '.nuxt', '.turbo',
    '.yarn', '.pnpm-store',
    // Python
    '__pycache__', '.venv', 'venv', '.mypy_cache', '.pytest_cache',
    '.ruff_cache', '.tox', '.eggs', 'egg-info',
    // Rust
    'target',
    // Go
    'vendor',
    // Java / Gradle / Maven
    '.gradle', '.mvn',
    // C# / .NET
    'bin', 'obj', 'packages',
    // iOS / macOS
    'Pods', '.build',
    // C / C++
    'cmake-build-debug', 'cmake-build-release',
    // Test / CI coverage
    'coverage', '.nyc_output',
    // IDE configs
    '.idea', '.vscode', '.vs',
    // General caches
    '.cache', 'out', '_build',
]);

/** Max file size to process (5MB) */
const MAX_FILE_SIZE = 5 * 1024 * 1024;

export class Ingestor {

    /**
     * Ingest a full repository into the ContextZero graph.
     */
    public async ingestRepo(
        repoPath: string,
        repoName: string,
        commitSha: string,
        branch: string = 'main',
        parentSnapshotId: string | null = null
    ): Promise<IngestionResult> {
        const timer = log.startTimer('ingestRepo', { repoPath, repoName, commitSha });
        const startTime = Date.now();
        let canonicalRepoPath: string;

        // Validate repoPath exists and is a directory before doing anything
        try {
            canonicalRepoPath = resolveExistingPath(repoPath);
            const stat = await fsp.stat(canonicalRepoPath);
            if (!stat.isDirectory()) {
                throw new Error(`Not a directory: ${canonicalRepoPath}`);
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            throw new Error(`Invalid repository path: ${msg}`);
        }

        // Acquire an advisory lock keyed on a hash of (repoPath, commitSha) to prevent
        // concurrent ingestion of the same repo/commit from corrupting snapshot data.
        // Uses pg_try_advisory_lock to fail fast instead of blocking.
        const lockKey = crypto.createHash('md5')
            .update(`ingest:${canonicalRepoPath}:${commitSha}`)
            .digest()
            .readInt32BE(0);
        const lockResult = await db.query('SELECT pg_try_advisory_lock($1) AS acquired', [lockKey]);
        const lockAcquired = booleanField(firstRow(lockResult), 'acquired') === true;
        if (!lockAcquired) {
            log.warn('Ingestion already in progress for this repo/commit, skipping', { repoPath: canonicalRepoPath, commitSha });
            return {
                repo_id: '', snapshot_id: '', files_processed: 0, files_failed: 0,
                symbols_extracted: 0, relations_extracted: 0,
                behavior_hints_extracted: 0, contract_hints_extracted: 0,
                duration_ms: Date.now() - startTime,
            };
        }

        try {

        // 0. Clean up stale data from previous failed/partial ingestion.
        // When TS extraction succeeds but Python fails (or vice versa), the snapshot
        // is marked 'partial' but successfully-extracted symbols from the first language
        // remain. On re-ingestion, these orphaned records (behavioral_profiles,
        // contract_profiles, structural_relations, test_artifacts, effect_signatures)
        // must be purged before fresh extraction to prevent data inconsistency.
        try {
            const staleSnapshot = await db.query(
                `SELECT snapshot_id FROM snapshots
                 WHERE repo_id = (SELECT repo_id FROM repositories WHERE name = $1 LIMIT 1)
                 AND commit_sha = $2 AND (index_status IN ('partial', 'failed')
                     OR (index_status = 'indexing' AND indexed_at < NOW() - INTERVAL '10 minutes'))`,
                [repoName, commitSha]
            );
            if (staleSnapshot.rows.length > 0) {
                const staleId = staleSnapshot.rows[0]?.snapshot_id;
                if (typeof staleId === 'string') {
                    log.info('Cleaning up stale snapshot data from previous failed ingestion', { staleId });
                    await this.cleanupSnapshotData(staleId);
                }
            }
        } catch (cleanupErr) {
            // Cleanup failure must not prevent new ingestion — log and continue
            log.warn('Stale snapshot cleanup failed (non-fatal, proceeding with fresh ingestion)', {
                error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
            });
        }

        // 1. Ensure repository exists (pass base_path so incremental indexing works)
        const repoId = await coreDataService.createRepository({
            name: repoName,
            default_branch: branch,
            visibility: 'private',
            language_set: [],
            base_path: canonicalRepoPath,
        });

        // 2. Create snapshot
        const snapshotId = await coreDataService.createSnapshot({
            repo_id: repoId,
            commit_sha: commitSha,
            branch,
            parent_snapshot_id: parentSnapshotId,
        });

        await coreDataService.updateSnapshotStatus(snapshotId, 'indexing');

        // 3. Discover files
        const files = await this.discoverFiles(canonicalRepoPath);
        log.info('Files discovered', { count: files.length });

        // 3.5 Delta detection: if parent snapshot exists, load parent file hashes
        // Files with matching content_hash are skipped during extraction —
        // their symbol_versions, behavioral_profiles, and contract_profiles are
        // bulk-copied from the parent snapshot via SQL INSERT...SELECT.
        let parentHashes: Map<string, string> | null = null;
        let unchangedCount = 0;
        if (parentSnapshotId) {
            try {
                // Verify parent snapshot is complete before using it for delta copy.
                // A partial/failed parent would have incomplete symbol data, causing
                // silent data loss when bulk-copying symbols for unchanged files.
                const parentStatusResult = await db.query(
                    `SELECT index_status FROM snapshots WHERE snapshot_id = $1`,
                    [parentSnapshotId]
                );
                const parentStatus = optionalStringField(firstRow(parentStatusResult), 'index_status');
                if (parentStatus !== 'complete') {
                    log.warn('Delta detection: parent snapshot is not complete, falling back to full ingestion', {
                        parentSnapshotId, parentStatus,
                    });
                } else {
                const parentFilesResult = await db.query(
                    `SELECT path, content_hash FROM files WHERE snapshot_id = $1`,
                    [parentSnapshotId]
                );
                parentHashes = new Map<string, string>();
                for (const row of parentFilesResult.rows as { path: string; content_hash: string }[]) {
                    parentHashes.set(row.path, row.content_hash);
                }
                log.info('Delta detection: parent snapshot loaded', {
                    parentSnapshotId, parentFiles: parentHashes.size,
                });
                }
            } catch {
                log.warn('Delta detection: could not load parent snapshot, falling back to full ingestion');
                parentHashes = null;
            }
        }

        // 4. Group files by language (delta-aware: skip unchanged files)
        const tsPaths: string[] = [];
        const pyPaths: string[] = [];
        const cppPaths: string[] = [];
        const goPaths: string[] = [];
        const rustPaths: string[] = [];
        const javaPaths: string[] = [];
        const csharpPaths: string[] = [];
        const rubyPaths: string[] = [];
        const kotlinPaths: string[] = [];
        const swiftPaths: string[] = [];
        const phpPaths: string[] = [];
        const bashPaths: string[] = [];
        let filesProcessed = 0;
        let filesFailed = 0;
        let symbolsExtracted = 0;
        let relationsExtracted = 0;
        let behaviorHintsExtracted = 0;
        let contractHintsExtracted = 0;
        const languageSet = new Set<string>();

        for (const filePath of files) {
            const ext = path.extname(filePath);
            const lang = LANGUAGE_MAP[ext];
            if (!lang) continue;

            languageSet.add(lang);
            const relativePath = path.relative(canonicalRepoPath, filePath);
            const contentHash = await this.hashFile(filePath);

            // Register file
            await coreDataService.addFile({
                snapshot_id: snapshotId,
                path: relativePath,
                content_hash: contentHash,
                language: lang,
            });

            // Delta optimization: skip extraction for files unchanged since parent snapshot
            if (parentHashes && parentHashes.get(relativePath) === contentHash) {
                unchangedCount++;
                continue;
            }

            if (lang === 'typescript' || lang === 'javascript') {
                tsPaths.push(filePath);
            } else if (lang === 'python') {
                pyPaths.push(filePath);
            } else if (lang === 'cpp') {
                cppPaths.push(filePath);
            } else if (lang === 'go') {
                goPaths.push(filePath);
            } else if (lang === 'rust') {
                rustPaths.push(filePath);
            } else if (lang === 'java') {
                javaPaths.push(filePath);
            } else if (lang === 'csharp') {
                csharpPaths.push(filePath);
            } else if (lang === 'ruby') {
                rubyPaths.push(filePath);
            } else if (lang === 'kotlin') {
                kotlinPaths.push(filePath);
            } else if (lang === 'swift') {
                swiftPaths.push(filePath);
            } else if (lang === 'php') {
                phpPaths.push(filePath);
            } else if (lang === 'bash') {
                bashPaths.push(filePath);
            }
        }

        // 4.5 Bulk-copy symbol data for unchanged files from parent snapshot.
        // This is the core of incremental ingestion: instead of re-parsing unchanged files,
        // copy their symbol_versions, behavioral_profiles, and contract_profiles in 3 SQL queries.
        if (parentSnapshotId && unchangedCount > 0) {
            try {
                // Copy symbol versions: join on matching (path + content_hash) files
                const copyResult = await db.query(`
                    INSERT INTO symbol_versions (
                        symbol_version_id, symbol_id, snapshot_id, file_id,
                        range_start_line, range_start_col, range_end_line, range_end_col,
                        signature, ast_hash, body_hash, normalized_ast_hash,
                        summary, body_source, visibility, language, uncertainty_flags
                    )
                    SELECT
                        gen_random_uuid(), sv.symbol_id, $2, f_new.file_id,
                        sv.range_start_line, sv.range_start_col, sv.range_end_line, sv.range_end_col,
                        sv.signature, sv.ast_hash, sv.body_hash, sv.normalized_ast_hash,
                        sv.summary, sv.body_source, sv.visibility, sv.language, sv.uncertainty_flags
                    FROM symbol_versions sv
                    JOIN files f_old ON f_old.file_id = sv.file_id AND f_old.snapshot_id = $1
                    JOIN files f_new ON f_new.path = f_old.path AND f_new.snapshot_id = $2
                                     AND f_new.content_hash = f_old.content_hash
                    WHERE sv.snapshot_id = $1
                    ON CONFLICT (symbol_id, snapshot_id) DO NOTHING
                `, [parentSnapshotId, snapshotId]);
                const copiedSymbols = copyResult.rowCount ?? 0;
                symbolsExtracted += copiedSymbols;

                // Copy behavioral profiles for newly copied symbol versions
                await db.query(`
                    INSERT INTO behavioral_profiles (
                        behavior_profile_id, symbol_version_id, purity_class,
                        resource_touches, db_reads, db_writes, network_calls,
                        cache_ops, file_io, auth_operations, validation_operations,
                        exception_profile, state_mutation_profile, transaction_profile
                    )
                    SELECT
                        gen_random_uuid(), sv_new.symbol_version_id, bp.purity_class,
                        bp.resource_touches, bp.db_reads, bp.db_writes, bp.network_calls,
                        bp.cache_ops, bp.file_io, bp.auth_operations, bp.validation_operations,
                        bp.exception_profile, bp.state_mutation_profile, bp.transaction_profile
                    FROM behavioral_profiles bp
                    JOIN symbol_versions sv_old ON sv_old.symbol_version_id = bp.symbol_version_id
                                                AND sv_old.snapshot_id = $1
                    JOIN symbol_versions sv_new ON sv_new.symbol_id = sv_old.symbol_id
                                                AND sv_new.snapshot_id = $2
                    ON CONFLICT DO NOTHING
                `, [parentSnapshotId, snapshotId]);

                // Copy contract profiles
                await db.query(`
                    INSERT INTO contract_profiles (
                        contract_profile_id, symbol_version_id, input_contract, output_contract,
                        error_contract, schema_refs, api_contract_refs, serialization_contract,
                        security_contract, derived_invariants_count
                    )
                    SELECT
                        gen_random_uuid(), sv_new.symbol_version_id, cp.input_contract, cp.output_contract,
                        cp.error_contract, cp.schema_refs, cp.api_contract_refs, cp.serialization_contract,
                        cp.security_contract, cp.derived_invariants_count
                    FROM contract_profiles cp
                    JOIN symbol_versions sv_old ON sv_old.symbol_version_id = cp.symbol_version_id
                                                AND sv_old.snapshot_id = $1
                    JOIN symbol_versions sv_new ON sv_new.symbol_id = sv_old.symbol_id
                                                AND sv_new.snapshot_id = $2
                    ON CONFLICT DO NOTHING
                `, [parentSnapshotId, snapshotId]);

                filesProcessed += unchangedCount;
                log.info('Delta ingestion: copied unchanged symbols from parent', {
                    unchangedFiles: unchangedCount, copiedSymbols,
                });
            } catch (err) {
                log.warn('Delta copy failed — unchanged files will be missed this run', {
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        }

        // 5. Extract from TypeScript files
        if (tsPaths.length > 0) {
            const tsconfigPath = await this.findTsconfig(canonicalRepoPath);
            try {
                const tsResult = extractFromTypeScript(tsPaths, tsconfigPath || undefined);
                const counts = await this.persistExtractionResult(
                    tsResult, repoId, snapshotId, canonicalRepoPath, 'typescript'
                );
                symbolsExtracted += counts.symbols;
                relationsExtracted += counts.relations;
                behaviorHintsExtracted += counts.behaviorHints;
                contractHintsExtracted += counts.contractHints;
                filesProcessed += tsPaths.length;
            } catch (err) {
                log.error('TypeScript extraction failed', err);
                filesFailed += tsPaths.length;
            }
        }

        // 6. Extract from Python files (parallel worker pool, same pattern as tree-sitter)
        if (pyPaths.length > 0) {
            const PY_CONCURRENCY = Math.min(8, pyPaths.length);
            const pyWorkQueue = [...pyPaths]; // copy — workers drain via .shift()
            const pyResults: { result: AdapterExtractionResult | null; filePath: string }[] = [];

            const pyExtractWorker = async (): Promise<void> => {
                for (let pyPath = pyWorkQueue.shift(); pyPath; pyPath = pyWorkQueue.shift()) {
                    try {
                        const pyResult = await this.extractFromPython(pyPath, canonicalRepoPath);
                        pyResults.push({ result: pyResult, filePath: pyPath });
                    } catch (err) {
                        log.error('Python extraction failed', err, { file: pyPath });
                        pyResults.push({ result: null, filePath: pyPath });
                    }
                }
            };

            const pyWorkers = Array.from({ length: PY_CONCURRENCY }, () => pyExtractWorker());
            await Promise.all(pyWorkers);

            // Sequential persistence (I/O-bound, order-dependent DB operations)
            for (const { result: pyResult, filePath: pyPath } of pyResults) {
                if (pyResult) {
                    try {
                        const counts = await this.persistExtractionResult(
                            pyResult, repoId, snapshotId, canonicalRepoPath, 'python'
                        );
                        symbolsExtracted += counts.symbols;
                        relationsExtracted += counts.relations;
                        behaviorHintsExtracted += counts.behaviorHints;
                        contractHintsExtracted += counts.contractHints;
                        filesProcessed++;
                    } catch (err) {
                        log.error('Python persistence failed', err, { file: pyPath });
                        filesFailed++;
                    }
                } else {
                    filesFailed++;
                }
            }
        }

        // 6b. Extract from C++, Go, Rust, Java, C#, Ruby files via tree-sitter universal adapter
        // Uses parallel extraction with controlled concurrency for CPU-bound tree-sitter parsing,
        // followed by sequential DB persistence (which is I/O-bound and benefits from batching).
        const treeSitterPaths: { filePath: string; lang: 'cpp' | 'go' | 'rust' | 'java' | 'csharp' | 'ruby' | 'kotlin' | 'swift' | 'php' | 'bash' }[] = [
            ...cppPaths.map(p => ({ filePath: p, lang: 'cpp' as const })),
            ...goPaths.map(p => ({ filePath: p, lang: 'go' as const })),
            ...rustPaths.map(p => ({ filePath: p, lang: 'rust' as const })),
            ...javaPaths.map(p => ({ filePath: p, lang: 'java' as const })),
            ...csharpPaths.map(p => ({ filePath: p, lang: 'csharp' as const })),
            ...rubyPaths.map(p => ({ filePath: p, lang: 'ruby' as const })),
            ...kotlinPaths.map(p => ({ filePath: p, lang: 'kotlin' as const })),
            ...swiftPaths.map(p => ({ filePath: p, lang: 'swift' as const })),
            ...phpPaths.map(p => ({ filePath: p, lang: 'php' as const })),
            ...bashPaths.map(p => ({ filePath: p, lang: 'bash' as const })),
        ];

        if (treeSitterPaths.length > 0) {
            // Phase A: Parallel extraction (CPU-bound tree-sitter parsing)
            const CONCURRENCY = Math.min(8, treeSitterPaths.length);
            const extractionResults: { result: AdapterExtractionResult | null; lang: string; filePath: string }[] = [];
            const workQueue = [...treeSitterPaths]; // copy — workers drain via .shift()

            const extractWorker = async (): Promise<void> => {
                for (let item = workQueue.shift(); item; item = workQueue.shift()) {
                    const { filePath, lang } = item;
                    try {
                        const result = await this.extractWithUniversalAdapter(filePath, canonicalRepoPath, lang);
                        extractionResults.push({ result, lang, filePath });
                    } catch (err) {
                        log.error(`${lang} extraction failed`, err, { file: filePath });
                        extractionResults.push({ result: null, lang, filePath });
                    }
                }
            };

            const workers = Array.from({ length: CONCURRENCY }, () => extractWorker());
            await Promise.all(workers);

            // Phase B: Sequential persistence (I/O-bound, order-dependent DB operations)
            for (const { result, lang } of extractionResults) {
                if (result) {
                    try {
                        const counts = await this.persistExtractionResult(
                            result, repoId, snapshotId, canonicalRepoPath, lang
                        );
                        symbolsExtracted += counts.symbols;
                        relationsExtracted += counts.relations;
                        behaviorHintsExtracted += counts.behaviorHints;
                        contractHintsExtracted += counts.contractHints;
                        filesProcessed++;
                    } catch (err) {
                        log.error(`${lang} persistence failed`, err);
                        filesFailed++;
                    }
                } else {
                    filesFailed++;
                }
            }
        }

        // Determine extraction health BEFORE running post-extraction analysis.
        // Only skip post-extraction when NO files were successfully processed.
        // Partial success (some files failed) should still run analysis on the
        // successfully extracted symbols — otherwise a single broken file in a
        // 1000-file repo would leave ALL symbols without behavioral propagation.
        const extractionFailed = filesProcessed === 0 && filesFailed > 0;
        const extractionPartial = filesFailed > 0;
        if (extractionFailed) {
            log.warn('Extraction completely failed — skipping all post-extraction analysis', {
                filesProcessed, filesFailed,
            });
        } else if (extractionPartial) {
            log.warn('Extraction partially failed — proceeding with post-extraction analysis on successful files', {
                filesProcessed, filesFailed,
            });
        }

        // 7. Resolve structural relations and run post-extraction analysis
        //    (only when extraction is fully successful)
        const svRows = await coreDataService.getSymbolVersionsForSnapshot(snapshotId);

        if (!extractionFailed) {
        // Mine invariants from tests
        await contractEngine.mineInvariantsFromTests(repoId, snapshotId, svRows);

        // 7.5 Propagate behavioral profiles transitively through the call graph.
        // This must run AFTER all profiles AND relations are created.
        // Without this, main() → train() → torch.save() would leave main() as "pure"
        // because pattern matching only scans each function's own body text.
        const propagated = await behavioralEngine.propagateTransitive(snapshotId);
        log.info('Behavioral profiles propagated transitively', { snapshotId, propagated });

        // 7.6 Populate test artifacts
        await this.populateTestArtifacts(svRows, snapshotId, repoId);

        // 7.7 Compute semantic embeddings (TF-IDF + MinHash + LSH)
        // NEW-002 fix: Run batch embedding as part of ingestion so that
        // semantic_intent_similarity in the homolog engine produces real
        // values instead of always 0.
        try {
            const embedded = await semanticEngine.batchEmbedSnapshot(snapshotId);
            log.info('Semantic embeddings computed', { snapshotId, embedded });
        } catch (err) {
            log.warn('Semantic embedding failed (non-fatal)', { snapshotId, error: err instanceof Error ? err.message : String(err) });
            // Non-fatal: homolog engine falls back to name-based similarity
        }
        } // end if (!extractionFailed)

        // ════════════════════════════════════════════════════════════════
        // V2 ENGINES — dispatch, lineage, effects, deep contracts, families, temporal
        // All V2 engines are non-fatal: if any fails, V1 data is still complete.
        // Skipped entirely when extraction is partial to avoid orphaned derived data.
        // ════════════════════════════════════════════════════════════════

        let v2DispatchEdges = 0;
        let v2Lineages = 0;
        let v2EffectSignatures = 0;
        let v2DeepContracts = 0;
        let v2ConceptFamilies = 0;
        let v2TemporalCoChanges = 0;

        if (extractionFailed) {
            log.info('Skipping V2 engines due to complete extraction failure', { snapshotId });
        }

        if (!extractionFailed) {
        // V2-1: Build class hierarchy and resolve dispatch edges
        try {
            // Static import (top of file) — no dynamic import overhead
            const hierarchyCount = await dispatchResolver.buildClassHierarchy(snapshotId);
            log.info('V2: Class hierarchy built', { snapshotId, hierarchyCount });
            v2DispatchEdges = await dispatchResolver.resolveDispatches(snapshotId, repoId);
            log.info('V2: Dispatch edges resolved', { snapshotId, v2DispatchEdges });
        } catch (err) {
            log.warn('V2: Dispatch resolution failed (non-fatal)', { error: err instanceof Error ? err.message : String(err) });
        }

        // V2-2: Compute symbol lineage (needs previous snapshot)
        try {
            // Static import (top of file)
            const prevSnapshotResult = await db.query(
                `SELECT snapshot_id FROM snapshots WHERE repo_id = $1 AND snapshot_id != $2 ORDER BY indexed_at DESC LIMIT 1`,
                [repoId, snapshotId]
            );
            const prevSnapshotId = optionalStringField(firstRow(prevSnapshotResult), 'snapshot_id') ?? null;
            const lineageResult = await symbolLineageEngine.computeLineage(repoId, snapshotId, prevSnapshotId);
            v2Lineages = lineageResult.births + lineageResult.exact_matches + lineageResult.renames_detected;
            log.info('V2: Symbol lineage computed', { snapshotId, ...lineageResult });
        } catch (err) {
            log.warn('V2: Symbol lineage failed (non-fatal)', { error: err instanceof Error ? err.message : String(err) });
        }

        // V2-3: Compute effect signatures from behavioral profiles
        try {
            // Static import (top of file)
            v2EffectSignatures = await effectEngine.computeEffectSignatures(snapshotId);
            log.info('V2: Effect signatures computed', { snapshotId, v2EffectSignatures });
            // Propagate effects transitively through call graph
            const propagatedEffects = await effectEngine.propagateEffectsTransitive(snapshotId);
            log.info('V2: Effects propagated transitively', { snapshotId, propagatedEffects });
        } catch (err) {
            log.warn('V2: Effect engine failed (non-fatal)', { error: err instanceof Error ? err.message : String(err) });
        }

        // V2-4: Deep contract synthesis from code body
        try {
            // Static import (top of file)
            v2DeepContracts = await deepContractSynthesizer.synthesizeContracts(repoId, snapshotId);
            log.info('V2: Deep contracts synthesized', { snapshotId, v2DeepContracts });
        } catch (err) {
            log.warn('V2: Deep contract synthesis failed (non-fatal)', { error: err instanceof Error ? err.message : String(err) });
        }

        // V2-5: Build concept families from homolog pairs
        try {
            // Static import (top of file)
            const familyResult = await conceptFamilyEngine.buildFamilies(repoId, snapshotId);
            v2ConceptFamilies = familyResult.families_created;
            log.info('V2: Concept families built', { snapshotId, ...familyResult });
        } catch (err) {
            log.warn('V2: Concept family engine failed (non-fatal)', { error: err instanceof Error ? err.message : String(err) });
        }

        // V2-6: Mine temporal intelligence from git history
        try {
            const repoResult = await db.query(
                `SELECT base_path FROM repositories WHERE repo_id = $1`,
                [repoId]
            );
            const basePath = optionalStringField(firstRow(repoResult), 'base_path');
            if (basePath) {
                // Static import (top of file)
                const temporalResult = await temporalEngine.computeTemporalIntelligence(repoId, snapshotId, basePath);
                v2TemporalCoChanges = temporalResult.co_change_pairs;
                log.info('V2: Temporal intelligence computed', { snapshotId, ...temporalResult });
            } else {
                log.debug('V2: Skipping temporal analysis — no base_path configured');
            }
        } catch (err) {
            log.warn('V2: Temporal engine failed (non-fatal)', { error: err instanceof Error ? err.message : String(err) });
        }
        } // end if (!extractionFailed) for V2 engines

        // 8. Update repository language_set and snapshot status
        if (languageSet.size > 0) {
            await db.query(
                `UPDATE repositories SET language_set = $1, updated_at = NOW() WHERE repo_id = $2`,
                [Array.from(languageSet), repoId]
            );
        }

        const finalStatus = filesFailed > 0 && filesProcessed === 0 ? 'failed'
            : filesFailed > 0 ? 'partial'
            : 'complete';
        await coreDataService.updateSnapshotStatus(snapshotId, finalStatus);

        const result: IngestionResult = {
            repo_id: repoId,
            snapshot_id: snapshotId,
            files_processed: filesProcessed,
            files_failed: filesFailed,
            symbols_extracted: symbolsExtracted,
            relations_extracted: relationsExtracted,
            behavior_hints_extracted: behaviorHintsExtracted,
            contract_hints_extracted: contractHintsExtracted,
            duration_ms: Date.now() - startTime,
            // V2 additions
            dispatch_edges_resolved: v2DispatchEdges,
            lineages_computed: v2Lineages,
            effect_signatures_computed: v2EffectSignatures,
            deep_contracts_mined: v2DeepContracts,
            concept_families_built: v2ConceptFamilies,
            temporal_co_changes_found: v2TemporalCoChanges,
        };

        timer({ ...result });
        return result;

        } finally {
            // Release the ingestion advisory lock regardless of success/failure
            await db.query('SELECT pg_advisory_unlock($1)', [lockKey]).catch((err: unknown) => {
                log.error('Failed to release ingestion advisory lock', err instanceof Error ? err : new Error(String(err)), { lockKey });
            });
            // Invalidate caches after ingestion — stale profiles/capsules can cause wrong analysis
            symbolCache.clear();
            profileCache.clear();
            capsuleCache.clear();
            homologCache.clear();
            queryCache.clear();
        }
    }

    /**
     * Persist extraction results to the database.
     * Symbol version INSERTs are accumulated and batched via db.batchInsert().
     */
    private async persistExtractionResult(
        extraction: AdapterExtractionResult,
        repoId: string,
        snapshotId: string,
        repoPath: string,
        language: string
    ): Promise<{ symbols: number; relations: number; behaviorHints: number; contractHints: number }> {

        // Accumulate symbol version INSERT statements for batching
        const svInsertStatements: { text: string; params: unknown[] }[] = [];

        // File content cache — read each source file at most once for body_source extraction.
        // Keyed by absolute path to avoid symlink/aliasing cache misses.
        const fileContentCache = new Map<string, string[] | null>();
        const getFileLines = async (filePath: string): Promise<string[] | null> => {
            const abs = path.isAbsolute(filePath) ? filePath : path.resolve(repoPath, filePath);
            if (fileContentCache.has(abs)) return fileContentCache.get(abs) ?? null;
            try {
                const content = await fsp.readFile(abs, 'utf-8');
                const lines = content.split('\n');
                fileContentCache.set(abs, lines);
                return lines;
            } catch (err) {
                log.warn('Failed to read file for body_source extraction', { filePath: abs, error: err instanceof Error ? err.message : String(err) });
                fileContentCache.set(abs, null);
                return null;
            }
        };

        // Phase 0: Normalize ALL keys in the extraction result to relative paths.
        // Adapters may return absolute paths (e.g., "/home/user/repo/src/file.ts#Func").
        // The DB stores relative paths ("src/file.ts"). Normalize everything up front.
        const normalizeKey = (key: string): string => {
            // Support both "::" and "#" separators for cross-adapter compatibility
            let sepIdx = key.indexOf('::');
            if (sepIdx < 0) sepIdx = key.indexOf('#');
            const filePart = sepIdx >= 0 ? key.substring(0, sepIdx) : key;
            if (path.isAbsolute(filePart)) {
                const relPart = path.relative(repoPath, filePart);
                return sepIdx >= 0 ? relPart + key.substring(sepIdx) : relPart;
            }
            return key;
        };
        for (const rel of extraction.relations) {
            rel.source_key = normalizeKey(rel.source_key);
        }
        for (const hint of extraction.behavior_hints) {
            hint.symbol_key = normalizeKey(hint.symbol_key);
        }
        for (const hint of extraction.contract_hints) {
            hint.symbol_key = normalizeKey(hint.symbol_key);
        }

        // Phase 1: Merge symbols and batch insert.
        // Track symbolId→svEntry to deduplicate: if two extracted symbols
        // share the same (symbol_id, snapshot_id), the ON CONFLICT DO UPDATE
        // keeps the original symbol_version_id. We must use the DB's actual
        // symbol_version_id in Phase 3, not the generated svId.
        const symbolIdToEntry = new Map<string, { svId: string; sym: ExtractedSymbol; symbolId: string }>();

        for (const sym of extraction.symbols) {
            // Stable key format: "filePath::SymbolName" or "filePath#SymbolName"
            // Support both separators for cross-adapter compatibility
            let separatorIdx = sym.stable_key.indexOf('::');
            if (separatorIdx < 0) separatorIdx = sym.stable_key.indexOf('#');
            let stableKeyPath = separatorIdx >= 0 ? sym.stable_key.substring(0, separatorIdx) : sym.stable_key;
            if (path.isAbsolute(stableKeyPath)) {
                stableKeyPath = path.relative(repoPath, stableKeyPath);
                sym.stable_key = separatorIdx >= 0
                    ? stableKeyPath + sym.stable_key.substring(separatorIdx)
                    : stableKeyPath;
            }

            const symbolId = await coreDataService.mergeSymbol({
                repo_id: repoId,
                stable_key: sym.stable_key,
                canonical_name: sym.canonical_name,
                kind: sym.kind,
            });

            const relativePath = stableKeyPath;
            const fileResult = await db.query(
                `SELECT file_id FROM files WHERE snapshot_id = $1 AND path = $2`,
                [snapshotId, relativePath]
            );
            const fileId = optionalStringField(firstRow(fileResult), 'file_id');
            if (!fileId) continue;

            // Extract body source from file using line ranges
            const lines = await getFileLines(stableKeyPath);
            let bodySource: string | null = null;
            if (lines && sym.range_start_line >= 1 && sym.range_end_line >= sym.range_start_line) {
                const start = Math.max(0, sym.range_start_line - 1);
                const end = Math.min(lines.length, sym.range_end_line);
                let raw = lines.slice(start, end).join('\n');
                // Strip null bytes — they corrupt PostgreSQL TEXT columns
                if (raw.includes('\0')) raw = raw.replace(/\0/g, '');
                bodySource = raw;
            }

            const svId = crypto.randomUUID();
            svInsertStatements.push({
                text: `
                    INSERT INTO symbol_versions (
                        symbol_version_id, symbol_id, snapshot_id, file_id,
                        range_start_line, range_start_col, range_end_line, range_end_col,
                        signature, ast_hash, body_hash, normalized_ast_hash,
                        summary, body_source, visibility, language, uncertainty_flags
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
                    ON CONFLICT (symbol_id, snapshot_id) DO UPDATE SET
                        file_id = EXCLUDED.file_id,
                        range_start_line = EXCLUDED.range_start_line,
                        range_start_col = EXCLUDED.range_start_col,
                        range_end_line = EXCLUDED.range_end_line,
                        range_end_col = EXCLUDED.range_end_col,
                        signature = EXCLUDED.signature,
                        ast_hash = EXCLUDED.ast_hash,
                        body_hash = EXCLUDED.body_hash,
                        normalized_ast_hash = EXCLUDED.normalized_ast_hash,
                        summary = EXCLUDED.summary,
                        body_source = EXCLUDED.body_source,
                        visibility = EXCLUDED.visibility,
                        language = EXCLUDED.language,
                        uncertainty_flags = EXCLUDED.uncertainty_flags
                `,
                params: [
                    svId, symbolId, snapshotId, fileId,
                    sym.range_start_line, sym.range_start_col, sym.range_end_line, sym.range_end_col,
                    sym.signature, sym.ast_hash, sym.body_hash, sym.normalized_ast_hash || null,
                    sym.summary || '', bodySource, sym.visibility, language,
                    // Only propagate extraction-wide uncertainty flags that genuinely
                    // apply to every symbol.  `parse_error` is NOT safe to broadcast:
                    // the TS adapter accumulates flags across an entire multi-file batch,
                    // so a single missing file would tag every symbol in the repo with
                    // parse_error — causing massive false-positive uncertainty annotations
                    // (e.g. 3,867 / 3,904 symbols flagged when ingestion fully succeeded).
                    // `encoding_fallback` and `extraction_error` are true file-level flags
                    // set by the universal adapter (called per-file), so they are safe.
                    (extraction.uncertainty_flags || []).filter(f =>
                        f === 'encoding_fallback' || f === 'extraction_error'
                    )
                ],
            });
            // Deduplicate: keep the last entry per symbolId (matches ON CONFLICT DO UPDATE behavior)
            symbolIdToEntry.set(symbolId, { svId, sym, symbolId });
        }

        // Phase 2: Batch insert all symbol versions in a single transaction
        if (svInsertStatements.length > 0) {
            await db.batchInsert(svInsertStatements);
        }

        // Phase 2.5: Batch resolve actual symbol_version_ids from the DB.
        // When ON CONFLICT DO UPDATE fires, the DB keeps the existing
        // symbol_version_id, not the one we generated. Single batch query
        // instead of N individual queries.
        const resolvedEntries: { svId: string; sym: ExtractedSymbol }[] = [];
        const allEntries = Array.from(symbolIdToEntry.values());
        if (allEntries.length > 0) {
            const symbolIds = allEntries.map(e => e.symbolId);
            const placeholders = symbolIds.map((_, i) => `$${i + 1}`).join(',');
            const batchResult = await db.query(
                `SELECT symbol_id, symbol_version_id FROM symbol_versions
                 WHERE symbol_id IN (${placeholders}) AND snapshot_id = $${symbolIds.length + 1}`,
                [...symbolIds, snapshotId]
            );
            const svIdBySymbolId = new Map<string, string>();
            for (const row of batchResult.rows) {
                svIdBySymbolId.set(row.symbol_id as string, row.symbol_version_id as string);
            }
            for (const entry of allEntries) {
                const actualSvId = svIdBySymbolId.get(entry.symbolId);
                if (actualSvId) {
                    resolvedEntries.push({ svId: actualSvId, sym: entry.sym });
                }
            }
        }

        // Phase 3: Process behavior and contract hints (uses resolved svIds)
        // Pre-build lookup maps for O(1) instead of O(n*m) .filter() per symbol
        const hintsByKey = new Map<string, typeof extraction.behavior_hints>();
        for (const h of extraction.behavior_hints) {
            const existing = hintsByKey.get(h.symbol_key);
            if (existing) existing.push(h);
            else hintsByKey.set(h.symbol_key, [h]);
        }
        const contractsByKey = new Map<string, typeof extraction.contract_hints>();
        for (const h of extraction.contract_hints) {
            const existing = contractsByKey.get(h.symbol_key);
            if (existing) existing.push(h);
            else contractsByKey.set(h.symbol_key, [h]);
        }

        for (const { svId, sym } of resolvedEntries) {
            // Process behavior hints for this symbol.
            // Always create a profile — even for symbols with zero hints.
            // A pure function with empty arrays IS its behavioral profile.
            // Skipping this would cause "profile not found" for pure functions.
            const symHints = hintsByKey.get(sym.stable_key) ?? [];
            await behavioralEngine.extractBehavioralProfiles(svId, symHints);

            // Process contract hints for this symbol
            const symContracts = contractsByKey.get(sym.stable_key) ?? [];
            for (const hint of symContracts) {
                await contractEngine.extractContractProfile(svId, hint);
            }
        }

        // Resolve structural relations
        const relCount = await structuralGraphEngine.computeRelationsFromRaw(
            snapshotId, repoId, extraction.relations
        );

        return {
            symbols: extraction.symbols.length,
            relations: relCount,
            behaviorHints: extraction.behavior_hints.length,
            contractHints: extraction.contract_hints.length,
        };
    }

    /**
     * Extract symbols from a Python file using the LibCST extractor.
     * Uses execFileSync with array args (not shell string) to prevent injection.
     */
    private async extractFromPython(filePath: string, repoPath: string): Promise<AdapterExtractionResult | null> {
        const extractorPath = path.join(__dirname, '..', 'adapters', 'py', 'extractor.py');

        try {
            await fsp.access(extractorPath);
        } catch {
            log.warn('Python extractor not found', { path: extractorPath });
            return null;
        }

        try {
            // execFileAsync with array args — safe from command injection, non-blocking
            const result = await execFileAsync('python3', [extractorPath, filePath], {
                cwd: repoPath,
                timeout: 30_000,
                maxBuffer: 1_048_576,
                encoding: 'utf-8',
            });

            const parsed: unknown = JSON.parse(result.stdout);
            if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as Record<string, unknown>).symbols)) {
                log.error('Python adapter returned invalid extraction result', undefined, { file: filePath });
                return null;
            }
            const extraction = parsed as AdapterExtractionResult;
            if (!Array.isArray(extraction.relations)) extraction.relations = [];
            if (!Array.isArray(extraction.behavior_hints)) extraction.behavior_hints = [];
            if (!Array.isArray(extraction.contract_hints)) extraction.contract_hints = [];

            // Key normalization is now handled centrally in persistExtractionResult
            // (Phase 0) — no per-adapter normalization needed.

            return extraction;
        } catch (err) {
            log.error('Python extractor failed', err, { file: filePath });
            return null;
        }
    }

    /**
     * Clean up all dependent data for a stale snapshot (partial/failed).
     * Deletes in FK-safe order (leaf tables first) within a single transaction.
     * Uses chunked deletes to avoid exceeding PostgreSQL parameter limits
     * for snapshots with large numbers of symbol versions.
     */
    private async cleanupSnapshotData(snapshotId: string): Promise<void> {
        const CHUNK_SIZE = 500; // Max symbol_version_ids per DELETE batch

        await db.transaction(async (client: PoolClient) => {
            // Get all symbol_version_ids for this snapshot
            const svResult = await db.queryWithClient(client,
                'SELECT symbol_version_id FROM symbol_versions WHERE snapshot_id = $1',
                [snapshotId]
            );
            const svIds = svResult.rows.map((r: { symbol_version_id: string }) => r.symbol_version_id);

            if (svIds.length > 0) {
                // Delete in dependency order (leaf tables first), chunked to
                // avoid exceeding PostgreSQL's max parameter count (~65535)
                for (let offset = 0; offset < svIds.length; offset += CHUNK_SIZE) {
                    const chunk = svIds.slice(offset, offset + CHUNK_SIZE);
                    const placeholders = chunk.map((_: string, i: number) => `$${i + 1}`).join(',');

                    await db.queryWithClient(client,
                        `DELETE FROM test_artifacts WHERE symbol_version_id IN (${placeholders})`,
                        chunk
                    );
                    await db.queryWithClient(client,
                        `DELETE FROM effect_signatures WHERE symbol_version_id IN (${placeholders})`,
                        chunk
                    );
                    await db.queryWithClient(client,
                        `DELETE FROM contract_profiles WHERE symbol_version_id IN (${placeholders})`,
                        chunk
                    );
                    await db.queryWithClient(client,
                        `DELETE FROM behavioral_profiles WHERE symbol_version_id IN (${placeholders})`,
                        chunk
                    );
                    // structural_relations references svIds in both src and dst columns
                    const dualPlaceholders = chunk.map((_: string, i: number) => `$${i + 1}`).join(',');
                    const dualChunk = [...chunk, ...chunk];
                    const dstPlaceholders = chunk.map((_: string, i: number) => `$${chunk.length + i + 1}`).join(',');
                    await db.queryWithClient(client,
                        `DELETE FROM structural_relations WHERE src_symbol_version_id IN (${dualPlaceholders}) OR dst_symbol_version_id IN (${dstPlaceholders})`,
                        dualChunk
                    );
                    // semantic_vectors may also reference symbol_version_ids
                    await db.queryWithClient(client,
                        `DELETE FROM semantic_vectors WHERE symbol_version_id IN (${placeholders})`,
                        chunk
                    );
                }

                await db.queryWithClient(client,
                    'DELETE FROM symbol_versions WHERE snapshot_id = $1',
                    [snapshotId]
                );
            }

            await db.queryWithClient(client,
                'DELETE FROM files WHERE snapshot_id = $1',
                [snapshotId]
            );
            // Don't delete the snapshot row itself — it will be updated via upsert
            // when the fresh ingestion creates a new snapshot for this repo+commit.
            log.info('Stale snapshot data cleaned up', { snapshotId, symbolVersions: svIds.length });
        });
    }

    /**
     * Identify test files and create test_artifact records.
     * Links tests to the symbols they reference via structural relations.
     */
    private async populateTestArtifacts(
        svRows: SymbolVersionRow[],
        _snapshotId: string,
        _repoId: string
    ): Promise<number> {
        let count = 0;

        // Identify test symbols
        const testSvs = svRows.filter(sv =>
            sv.file_path.includes('.test.') ||
            sv.file_path.includes('.spec.') ||
            sv.file_path.includes('__tests__')
        );

        // Build a name→svId map for non-test symbols (for body-scanning fallback)
        const nonTestSvs = svRows.filter(sv =>
            !sv.file_path.includes('.test.') &&
            !sv.file_path.includes('.spec.') &&
            !sv.file_path.includes('__tests__')
        );
        const nameToSvId = new Map<string, string>();
        for (const sv of nonTestSvs) {
            // Only index names with 3+ chars to avoid false matches on 'a', 'i', etc.
            if (sv.canonical_name.length >= 3) {
                nameToSvId.set(sv.canonical_name, sv.symbol_version_id);
            }
        }

        const testSvIdSet = new Set(testSvs.map(t => t.symbol_version_id));

        for (const testSv of testSvs) {
            // Find which non-test symbols this test references
            // by checking structural_relations from this test symbol
            const relResult = await db.query(`
                SELECT DISTINCT sr.dst_symbol_version_id
                FROM structural_relations sr
                WHERE sr.src_symbol_version_id = $1
                AND sr.relation_type IN ('calls', 'references', 'imports')
            `, [testSv.symbol_version_id]);

            const relatedSet = new Set(
                relResult.rows
                    .map((r: { dst_symbol_version_id: string }) => r.dst_symbol_version_id)
                    .filter((id: string) => !testSvIdSet.has(id))
            );

            // Body-scanning fallback: scan test body for non-test symbol names.
            // This catches symbols referenced in mock setups, string imports, and
            // describe/it block names that the adapter didn't extract as relations.
            if (testSv.body_source) {
                for (const [name, svId] of nameToSvId) {
                    if (!relatedSet.has(svId) && testSv.body_source.includes(name)) {
                        relatedSet.add(svId);
                    }
                }
            }

            const relatedSymbols = Array.from(relatedSet);

            // Detect test framework
            let framework = 'unknown';
            if (testSv.file_path.includes('.test.ts') || testSv.file_path.includes('.test.js')) {
                framework = 'jest';
            } else if (testSv.file_path.includes('.spec.ts') || testSv.file_path.includes('.spec.js')) {
                framework = 'jest'; // or mocha
            } else if (testSv.file_path.endsWith('.py')) {
                framework = 'pytest';
            }

            await coreDataService.insertTestArtifact({
                symbol_version_id: testSv.symbol_version_id,
                framework,
                related_symbols: relatedSymbols,
                assertion_summary: `Test: ${testSv.canonical_name}`,
                coverage_hints: null,
            });
            count++;
        }

        log.info('Test artifacts populated', { count });
        return count;
    }

    /**
     * Extract symbols from C++/Go files using the tree-sitter universal adapter.
     */
    private async extractWithUniversalAdapter(
        filePath: string,
        repoPath: string,
        language: 'cpp' | 'go' | 'rust' | 'java' | 'csharp' | 'ruby' | 'kotlin' | 'swift' | 'php' | 'bash'
    ): Promise<AdapterExtractionResult | null> {
        try {
            // Lazy-load to avoid tree-sitter initialization cost when not needed
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { extractWithTreeSitter } = require('../adapters/universal') as {
                extractWithTreeSitter: (fp: string, src: string, lang: string) => AdapterExtractionResult;
            };
            const source = await fsp.readFile(filePath, 'utf-8');
            const relativePath = path.relative(repoPath, filePath);
            return extractWithTreeSitter(relativePath, source, language);
        } catch (err) {
            log.error('Tree-sitter extraction failed', err, { file: filePath, language });
            return null;
        }
    }

    /**
     * Discover all processable files in the repository.
     */
    private static readonly MAX_FILE_COUNT = 100_000;

    private async discoverFiles(repoPath: string): Promise<string[]> {
        const files: string[] = [];
        let limitHit = false;

        const walk = async (dir: string): Promise<void> => {
            if (limitHit) return;
            let entries: fs.Dirent[];
            try {
                entries = await fsp.readdir(dir, { withFileTypes: true });
            } catch {
                // Directory unreadable (permissions, deleted mid-scan) — skip gracefully
                return;
            }
            for (const entry of entries) {
                const entryPath = path.join(dir, entry.name);

                // Skip symlinks to prevent symlink-based traversal attacks
                try {
                    const lstats = await fsp.lstat(entryPath);
                    if (lstats.isSymbolicLink()) {
                        log.warn('Skipping symlink during file discovery', { path: entryPath });
                        continue;
                    }
                } catch {
                    // Skip entries we cannot stat
                    continue;
                }

                if (entry.isDirectory()) {
                    if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
                    await walk(entryPath);
                } else if (entry.isFile()) {
                    const ext = path.extname(entry.name);
                    if (LANGUAGE_MAP[ext]) {
                        if (files.length >= Ingestor.MAX_FILE_COUNT) {
                            limitHit = true;
                            log.warn('File count limit reached — some files may not be indexed', {
                                limit: Ingestor.MAX_FILE_COUNT, repoPath,
                            });
                            return;
                        }
                        try {
                            const stat = await fsp.stat(entryPath);
                            if (stat.size <= MAX_FILE_SIZE) {
                                files.push(entryPath);
                            }
                        } catch {
                            // Skip unreadable files
                        }
                    }
                }
            }
        }

        await walk(repoPath);
        return files;
    }

    private async hashFile(filePath: string): Promise<string> {
        try {
            const content = await fsp.readFile(filePath);
            return crypto.createHash('sha256').update(content).digest('hex');
        } catch {
            // File deleted/unreadable between discovery and hashing — return empty hash
            log.warn('File unreadable during hashing — may have been deleted', { filePath });
            return crypto.createHash('sha256').update('').digest('hex');
        }
    }

    /**
     * Incremental indexing: re-parse only changed files.
     * Accepts a list of changed file paths (from git diff), invalidates
     * affected symbols, re-extracts, re-computes profiles and relations.
     */
    public async ingestIncremental(
        repoId: string,
        snapshotId: string,
        changedPaths: string[]
    ): Promise<{
        symbolsUpdated: number;
        relationsUpdated: number;
        dispatch_edges_resolved: number;
        lineages_computed: number;
        effect_signatures_computed: number;
        deep_contracts_mined: number;
        concept_families_built: number;
        temporal_co_changes_found: number;
    }> {
        const timer = log.startTimer('ingestIncremental', {
            repoId, snapshotId, changedCount: changedPaths.length,
        });

        // Acquire an advisory lock keyed on (repoId, snapshotId) to prevent
        // concurrent incremental ingestion from corrupting snapshot data.
        const lockKey = crypto.createHash('md5')
            .update(`ingest-incr:${repoId}:${snapshotId}`)
            .digest()
            .readInt32BE(0);
        const lockResult = await db.query('SELECT pg_try_advisory_lock($1) AS acquired', [lockKey]);
        const lockAcquired = booleanField(firstRow(lockResult), 'acquired') === true;
        if (!lockAcquired) {
            log.warn('Incremental ingestion already in progress for this repo/snapshot, skipping', { repoId, snapshotId });
            return {
                symbolsUpdated: 0, relationsUpdated: 0,
                dispatch_edges_resolved: 0, lineages_computed: 0,
                effect_signatures_computed: 0, deep_contracts_mined: 0,
                concept_families_built: 0, temporal_co_changes_found: 0,
            };
        }

        try {

        // Get repo base path from DB
        const repoResult = await db.query(
            `SELECT base_path FROM repositories WHERE repo_id = $1`,
            [repoId]
        );
        const basePath = optionalStringField(firstRow(repoResult), 'base_path');
        if (!basePath) throw new Error(`Repository base path not configured for repo: ${repoId}`);

        let symbolsUpdated = 0;
        let relationsUpdated = 0;

        // 1. Delete old symbol_versions for changed files
        // Wrapped in a single DB transaction for atomicity
        const invalidatedSvIds: string[] = [];
        await db.transaction(async (client: PoolClient) => {
            for (const changedPath of changedPaths) {
                const fileResult = await db.queryWithClient(client,
                    `SELECT file_id FROM files WHERE snapshot_id = $1 AND path = $2`,
                    [snapshotId, changedPath]
                );
                const fileId = optionalStringField(firstRow(fileResult), 'file_id');

                if (fileId) {
                    // Collect symbol_version_ids being invalidated for cache eviction
                    const svResult = await db.queryWithClient(client,
                        `SELECT symbol_version_id FROM symbol_versions WHERE file_id = $1`,
                        [fileId]
                    );
                    for (const row of svResult.rows as { symbol_version_id: string }[]) {
                        invalidatedSvIds.push(row.symbol_version_id);
                    }

                    // Delete structural relations touching these symbol versions
                    await db.queryWithClient(client, `
                        DELETE FROM structural_relations
                        WHERE src_symbol_version_id IN (
                            SELECT symbol_version_id FROM symbol_versions WHERE file_id = $1
                        ) OR dst_symbol_version_id IN (
                            SELECT symbol_version_id FROM symbol_versions WHERE file_id = $1
                        )
                    `, [fileId]);

                    // Delete behavioral/contract profiles
                    await db.queryWithClient(client, `
                        DELETE FROM behavioral_profiles WHERE symbol_version_id IN (
                            SELECT symbol_version_id FROM symbol_versions WHERE file_id = $1
                        )
                    `, [fileId]);
                    await db.queryWithClient(client, `
                        DELETE FROM contract_profiles WHERE symbol_version_id IN (
                            SELECT symbol_version_id FROM symbol_versions WHERE file_id = $1
                        )
                    `, [fileId]);

                    // Delete semantic vectors
                    await db.queryWithClient(client, `
                        DELETE FROM semantic_vectors WHERE symbol_version_id IN (
                            SELECT symbol_version_id FROM symbol_versions WHERE file_id = $1
                        )
                    `, [fileId]);

                    // Mark inferred_relations as stale (set valid_to)
                    await db.queryWithClient(client, `
                        UPDATE inferred_relations SET valid_to_snapshot_id = $1
                        WHERE valid_to_snapshot_id IS NULL
                        AND (src_symbol_version_id IN (
                            SELECT symbol_version_id FROM symbol_versions WHERE file_id = $2
                        ) OR dst_symbol_version_id IN (
                            SELECT symbol_version_id FROM symbol_versions WHERE file_id = $2
                        ))
                    `, [snapshotId, fileId]);

                    // Delete old symbol versions for this file
                    await db.queryWithClient(client,
                        `DELETE FROM symbol_versions WHERE file_id = $1 AND snapshot_id = $2`,
                        [fileId, snapshotId]
                    );
                }
            }
        });

        // Invalidate in-process caches for deleted profiles
        // This ensures subsequent reads don't serve stale behavioral/contract data
        for (const svId of invalidatedSvIds) {
            profileCache.invalidate(`bp:${svId}`);
            profileCache.invalidate(`cp:${svId}`);
        }
        log.debug('Cache invalidated for incremental reindex', {
            invalidatedSymbols: invalidatedSvIds.length,
        });

        // 2. Re-extract from changed files
        const tsPaths: string[] = [];
        const pyPaths: string[] = [];
        const cppPaths: string[] = [];
        const goPaths: string[] = [];
        const rustPaths: string[] = [];
        const javaPaths: string[] = [];
        const csharpPaths: string[] = [];
        const rubyPaths: string[] = [];
        const kotlinPaths: string[] = [];
        const swiftPaths: string[] = [];
        const phpPaths: string[] = [];
        const bashPaths: string[] = [];

        for (const changedPath of changedPaths) {
            const fullPath = this.resolveSafePath(basePath, changedPath);
            try {
                await fsp.access(fullPath);
            } catch {
                continue;
            }

            const ext = path.extname(changedPath);
            const lang = LANGUAGE_MAP[ext];
            if (!lang) continue;

            // Update file hash
            const contentHash = await this.hashFile(fullPath);
            await db.query(
                `UPDATE files SET content_hash = $1, parse_status = 'parsed' WHERE snapshot_id = $2 AND path = $3`,
                [contentHash, snapshotId, changedPath]
            );

            if (lang === 'typescript' || lang === 'javascript') {
                tsPaths.push(fullPath);
            } else if (lang === 'python') {
                pyPaths.push(fullPath);
            } else if (lang === 'cpp') {
                cppPaths.push(fullPath);
            } else if (lang === 'go') {
                goPaths.push(fullPath);
            } else if (lang === 'rust') {
                rustPaths.push(fullPath);
            } else if (lang === 'java') {
                javaPaths.push(fullPath);
            } else if (lang === 'csharp') {
                csharpPaths.push(fullPath);
            } else if (lang === 'ruby') {
                rubyPaths.push(fullPath);
            } else if (lang === 'kotlin') {
                kotlinPaths.push(fullPath);
            } else if (lang === 'swift') {
                swiftPaths.push(fullPath);
            } else if (lang === 'php') {
                phpPaths.push(fullPath);
            } else if (lang === 'bash') {
                bashPaths.push(fullPath);
            }
        }

        // 3. Re-extract TypeScript
        if (tsPaths.length > 0) {
            const tsconfigPath = await this.findTsconfig(basePath);
            try {
                const tsResult = extractFromTypeScript(tsPaths, tsconfigPath || undefined);
                const counts = await this.persistExtractionResult(
                    tsResult, repoId, snapshotId, basePath, 'typescript'
                );
                symbolsUpdated += counts.symbols;
                relationsUpdated += counts.relations;
            } catch (err) {
                log.error('Incremental TS extraction failed', err);
            }
        }

        // 4. Re-extract Python
        for (const pyPath of pyPaths) {
            try {
                const pyResult = await this.extractFromPython(pyPath, basePath);
                if (pyResult) {
                    const counts = await this.persistExtractionResult(
                        pyResult, repoId, snapshotId, basePath, 'python'
                    );
                    symbolsUpdated += counts.symbols;
                    relationsUpdated += counts.relations;
                }
            } catch (err) {
                log.error('Incremental Python extraction failed', err, { file: pyPath });
            }
        }

        // 4b. Re-extract C++, Go, Rust, Java, C#, Ruby via tree-sitter universal adapter
        const treeSitterPaths: { filePath: string; lang: 'cpp' | 'go' | 'rust' | 'java' | 'csharp' | 'ruby' | 'kotlin' | 'swift' | 'php' | 'bash' }[] = [
            ...cppPaths.map(p => ({ filePath: p, lang: 'cpp' as const })),
            ...goPaths.map(p => ({ filePath: p, lang: 'go' as const })),
            ...rustPaths.map(p => ({ filePath: p, lang: 'rust' as const })),
            ...javaPaths.map(p => ({ filePath: p, lang: 'java' as const })),
            ...csharpPaths.map(p => ({ filePath: p, lang: 'csharp' as const })),
            ...rubyPaths.map(p => ({ filePath: p, lang: 'ruby' as const })),
            ...kotlinPaths.map(p => ({ filePath: p, lang: 'kotlin' as const })),
            ...swiftPaths.map(p => ({ filePath: p, lang: 'swift' as const })),
            ...phpPaths.map(p => ({ filePath: p, lang: 'php' as const })),
            ...bashPaths.map(p => ({ filePath: p, lang: 'bash' as const })),
        ];

        for (const { filePath, lang } of treeSitterPaths) {
            try {
                const result = await this.extractWithUniversalAdapter(filePath, basePath, lang);
                if (result) {
                    const counts = await this.persistExtractionResult(
                        result, repoId, snapshotId, basePath, lang
                    );
                    symbolsUpdated += counts.symbols;
                    relationsUpdated += counts.relations;
                }
            } catch (err) {
                log.error(`Incremental ${lang} extraction failed`, err, { file: filePath });
            }
        }

        // 5. Re-populate test artifacts for affected files
        const allSvRows = await coreDataService.getSymbolVersionsForSnapshot(snapshotId);
        await this.populateTestArtifacts(allSvRows, snapshotId, repoId);

        // ════════════════════════════════════════════════════════════════
        // V2 ENGINES — dispatch, lineage, effects, deep contracts, families, temporal
        // All V2 engines are non-fatal: if any fails, V1 data is still complete.
        // ════════════════════════════════════════════════════════════════

        let v2DispatchEdges = 0;
        let v2Lineages = 0;
        let v2EffectSignatures = 0;
        let v2DeepContracts = 0;
        let v2ConceptFamilies = 0;
        let v2TemporalCoChanges = 0;

        // V2-1: Build class hierarchy and resolve dispatch edges
        try {
            // Static import (top of file) — no dynamic import overhead
            const hierarchyCount = await dispatchResolver.buildClassHierarchy(snapshotId);
            log.info('V2 incremental: Class hierarchy built', { snapshotId, hierarchyCount });
            v2DispatchEdges = await dispatchResolver.resolveDispatches(snapshotId, repoId);
            log.info('V2 incremental: Dispatch edges resolved', { snapshotId, v2DispatchEdges });
        } catch (err) {
            log.warn('V2 incremental: Dispatch resolution failed (non-fatal)', { error: err instanceof Error ? err.message : String(err) });
        }

        // V2-2: Compute symbol lineage (needs previous snapshot)
        try {
            // Static import (top of file)
            const prevSnapshotResult = await db.query(
                `SELECT snapshot_id FROM snapshots WHERE repo_id = $1 AND snapshot_id != $2 ORDER BY indexed_at DESC LIMIT 1`,
                [repoId, snapshotId]
            );
            const prevSnapshotId = optionalStringField(firstRow(prevSnapshotResult), 'snapshot_id') ?? null;
            const lineageResult = await symbolLineageEngine.computeLineage(repoId, snapshotId, prevSnapshotId);
            v2Lineages = lineageResult.births + lineageResult.exact_matches + lineageResult.renames_detected;
            log.info('V2 incremental: Symbol lineage computed', { snapshotId, ...lineageResult });
        } catch (err) {
            log.warn('V2 incremental: Symbol lineage failed (non-fatal)', { error: err instanceof Error ? err.message : String(err) });
        }

        // V2-3: Compute effect signatures from behavioral profiles
        try {
            // Static import (top of file)
            v2EffectSignatures = await effectEngine.computeEffectSignatures(snapshotId);
            log.info('V2 incremental: Effect signatures computed', { snapshotId, v2EffectSignatures });
            // Propagate effects transitively through call graph
            const propagatedEffects = await effectEngine.propagateEffectsTransitive(snapshotId);
            log.info('V2 incremental: Effects propagated transitively', { snapshotId, propagatedEffects });
        } catch (err) {
            log.warn('V2 incremental: Effect engine failed (non-fatal)', { error: err instanceof Error ? err.message : String(err) });
        }

        // V2-4: Deep contract synthesis from code body
        try {
            // Static import (top of file)
            v2DeepContracts = await deepContractSynthesizer.synthesizeContracts(repoId, snapshotId);
            log.info('V2 incremental: Deep contracts synthesized', { snapshotId, v2DeepContracts });
        } catch (err) {
            log.warn('V2 incremental: Deep contract synthesis failed (non-fatal)', { error: err instanceof Error ? err.message : String(err) });
        }

        // V2-5: Build concept families from homolog pairs
        try {
            // Static import (top of file)
            const familyResult = await conceptFamilyEngine.buildFamilies(repoId, snapshotId);
            v2ConceptFamilies = familyResult.families_created;
            log.info('V2 incremental: Concept families built', { snapshotId, ...familyResult });
        } catch (err) {
            log.warn('V2 incremental: Concept family engine failed (non-fatal)', { error: err instanceof Error ? err.message : String(err) });
        }

        // V2-6: Mine temporal intelligence from git history
        try {
            if (basePath) {
                // Static import (top of file)
                const temporalResult = await temporalEngine.computeTemporalIntelligence(repoId, snapshotId, basePath);
                v2TemporalCoChanges = temporalResult.co_change_pairs;
                log.info('V2 incremental: Temporal intelligence computed', { snapshotId, ...temporalResult });
            } else {
                log.debug('V2 incremental: Skipping temporal analysis — no base_path configured');
            }
        } catch (err) {
            log.warn('V2 incremental: Temporal engine failed (non-fatal)', { error: err instanceof Error ? err.message : String(err) });
        }

        const result = {
            symbolsUpdated,
            relationsUpdated,
            dispatch_edges_resolved: v2DispatchEdges,
            lineages_computed: v2Lineages,
            effect_signatures_computed: v2EffectSignatures,
            deep_contracts_mined: v2DeepContracts,
            concept_families_built: v2ConceptFamilies,
            temporal_co_changes_found: v2TemporalCoChanges,
        };
        timer({ ...result });
        return result;

        } finally {
            // Release the incremental ingestion advisory lock regardless of success/failure
            await db.query('SELECT pg_advisory_unlock($1)', [lockKey]).catch((err: unknown) => {
                log.error('Failed to release incremental ingestion advisory lock', err instanceof Error ? err : new Error(String(err)), { lockKey });
            });
        }
    }

    /**
     * Resolve a file path safely within a base directory.
     * Resolves symlinks on the base path first to prevent symlink-based escapes.
     */
    private resolveSafePath(basePath: string, filePath: string): string {
        const safePath = resolvePathWithinBase(basePath, filePath, { allowMissing: true });
        return safePath.existed ? safePath.realPath : safePath.resolvedPath;
    }

    private async findTsconfig(repoPath: string): Promise<string | null> {
        const tsconfig = path.join(repoPath, 'tsconfig.json');
        try {
            await fsp.access(tsconfig);
            return tsconfig;
        } catch {
            return null;
        }
    }
}

export const ingestor = new Ingestor();
