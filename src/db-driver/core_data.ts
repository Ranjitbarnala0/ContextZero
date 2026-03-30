/**
 * ContextZero — Core Data Service
 *
 * Data access layer for the core symbol spine entities.
 * All DB query results use runtime type guards instead of unsafe `as` casts.
 */

import { db } from './index';
import { v4 as uuidv4 } from 'uuid';
import { Logger } from '../logger';
import { firstRow, optionalStringField, validateRows, validateSymbolVersionRow, type SymbolVersionRow } from './result';
import { resolveExistingPath } from '../path-security';
import type { BehavioralProfile, IndexStatus } from '../types';

const log = new Logger('core-data');

/** PostgreSQL error codes used for conflict resolution */
const PG_UNIQUE_VIOLATION = '23505';

/**
 * Safely extract a string field from an unknown row.
 * Throws if the row or field is missing when required.
 */
function extractId(row: Record<string, unknown> | undefined, field: string): string {
    if (!row || typeof row[field] !== 'string') {
        throw new Error(`Expected ${field} in query result but got ${row ? typeof row[field] : 'undefined row'}`);
    }
    return row[field] as string;
}

// Input interfaces
export interface RepositoryInput {
    name: string;
    default_branch: string;
    visibility: 'public' | 'private';
    language_set: string[];
    base_path?: string;
}

export interface SnapshotInput {
    repo_id: string;
    commit_sha: string;
    branch: string;
    parent_snapshot_id?: string | null;
}

export interface FileInput {
    snapshot_id: string;
    path: string;
    content_hash: string;
    language: string;
    parse_status?: string;
}

export interface SymbolInput {
    repo_id: string;
    stable_key: string;
    canonical_name: string;
    kind: string;
    logical_namespace?: string;
}

export interface SymbolVersionInput {
    symbol_id: string;
    snapshot_id: string;
    file_id: string;
    range_start_line: number;
    range_start_col: number;
    range_end_line: number;
    range_end_col: number;
    signature: string;
    ast_hash: string;
    body_hash: string;
    normalized_ast_hash?: string;
    summary: string;
    body_source?: string | null;
    visibility: string;
    language: string;
    uncertainty_flags?: string[];
}

// SymbolVersionRow is the canonical type defined in result.ts.
// Re-export here for backward compatibility with importers.
export type { SymbolVersionRow } from './result';

export class CoreDataService {

    public async createRepository(input: RepositoryInput): Promise<string> {
        const canonicalBasePath = input.base_path ? resolveExistingPath(input.base_path) : null;

        // Repository identity is the canonical filesystem path, not the human-readable name.
        // Different repos can share a name; they must never share a repo_id unless the path matches.
        if (canonicalBasePath) {
            const byPath = await db.query(
                `SELECT repo_id FROM repositories WHERE base_path = $1`,
                [canonicalBasePath]
            );
            if (byPath.rowCount && byPath.rowCount > 0) {
                const existingId = extractId(byPath.rows[0] as Record<string, unknown> | undefined, 'repo_id');
                await db.query(`
                    UPDATE repositories
                    SET name = $1, default_branch = $2, visibility = $3, language_set = $4, updated_at = NOW()
                    WHERE repo_id = $5
                `, [input.name, input.default_branch, input.visibility, input.language_set, existingId]);
                log.info('Repository matched by base_path — updated metadata', {
                    repo_id: existingId,
                    name: input.name,
                    base_path: canonicalBasePath,
                });
                return existingId;
            }
        }

        const id = uuidv4();
        try {
            const result = await db.query(`
                INSERT INTO repositories (repo_id, name, default_branch, visibility, language_set, base_path)
                VALUES ($1, $2, $3, $4, $5, $6)
                RETURNING repo_id
            `, [id, input.name, input.default_branch, input.visibility, input.language_set, canonicalBasePath]);
            const repoId = extractId(result.rows[0] as Record<string, unknown> | undefined, 'repo_id');
            log.info('Repository created', { repo_id: repoId, name: input.name, base_path: canonicalBasePath });
            return repoId;
        } catch (err) {
            const error = err as { code?: string };
            if (canonicalBasePath && error.code === PG_UNIQUE_VIOLATION) {
                const byPath = await db.query(
                    `SELECT repo_id FROM repositories WHERE base_path = $1`,
                    [canonicalBasePath]
                );
                if (byPath.rowCount && byPath.rowCount > 0) {
                    const existingId = extractId(byPath.rows[0] as Record<string, unknown> | undefined, 'repo_id');
                    await db.query(`
                        UPDATE repositories
                        SET name = $1, default_branch = $2, visibility = $3, language_set = $4, updated_at = NOW()
                        WHERE repo_id = $5
                    `, [input.name, input.default_branch, input.visibility, input.language_set, existingId]);
                    log.info('Repository create raced on base_path — reused existing row', {
                        repo_id: existingId,
                        name: input.name,
                        base_path: canonicalBasePath,
                    });
                    return existingId;
                }
            }
            throw err;
        }
    }

    public async getRepository(repo_id: string): Promise<Record<string, unknown> | null> {
        const result = await db.query(
            `SELECT repo_id, name, default_branch, visibility, language_set, base_path,
                    created_at, updated_at
             FROM repositories WHERE repo_id = $1`, [repo_id]);
        return (result.rows[0] as Record<string, unknown> | undefined) ?? null;
    }

    public async createSnapshot(input: SnapshotInput): Promise<string> {
        const id = uuidv4();
        const result = await db.query(`
            INSERT INTO snapshots (snapshot_id, repo_id, commit_sha, branch, parent_snapshot_id, index_status)
            VALUES ($1, $2, $3, $4, $5, 'pending')
            ON CONFLICT (repo_id, commit_sha) DO UPDATE SET
                branch = EXCLUDED.branch,
                parent_snapshot_id = EXCLUDED.parent_snapshot_id
            RETURNING snapshot_id
        `, [id, input.repo_id, input.commit_sha, input.branch, input.parent_snapshot_id || null]);
        const snapId = extractId(result.rows[0] as Record<string, unknown> | undefined, 'snapshot_id');
        log.info('Snapshot created', { snapshot_id: snapId, commit_sha: input.commit_sha });
        return snapId;
    }

    public async getSnapshot(snapshot_id: string): Promise<Record<string, unknown> | null> {
        const result = await db.query(
            `SELECT snapshot_id, repo_id, commit_sha, branch, parent_snapshot_id,
                    indexed_at, index_status
             FROM snapshots WHERE snapshot_id = $1`, [snapshot_id]);
        return (result.rows[0] as Record<string, unknown> | undefined) ?? null;
    }

    public async updateSnapshotStatus(snapshot_id: string, status: IndexStatus): Promise<void> {
        await db.query(`UPDATE snapshots SET index_status = $1 WHERE snapshot_id = $2`, [status, snapshot_id]);
        log.debug('Snapshot status updated', { snapshot_id, status });
    }

    public async addFile(input: FileInput): Promise<string> {
        const id = uuidv4();
        const result = await db.query(`
            INSERT INTO files (file_id, snapshot_id, path, content_hash, language, parse_status)
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (snapshot_id, path) DO UPDATE SET
                content_hash = EXCLUDED.content_hash,
                parse_status = EXCLUDED.parse_status
            RETURNING file_id
        `, [id, input.snapshot_id, input.path, input.content_hash, input.language, input.parse_status || 'parsed']);
        return extractId(result.rows[0] as Record<string, unknown> | undefined, 'file_id');
    }

    public async mergeSymbol(input: SymbolInput): Promise<string> {
        const id = uuidv4();
        // Use INSERT ON CONFLICT to avoid TOCTOU race between SELECT and INSERT
        const result = await db.query(`
            INSERT INTO symbols (symbol_id, repo_id, stable_key, canonical_name, kind, logical_namespace)
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (repo_id, stable_key) DO UPDATE SET
                canonical_name = EXCLUDED.canonical_name,
                kind = EXCLUDED.kind
            RETURNING symbol_id
        `, [id, input.repo_id, input.stable_key, input.canonical_name, input.kind, input.logical_namespace || null]);
        const symbolId = extractId(result.rows[0] as Record<string, unknown> | undefined, 'symbol_id');
        if (symbolId !== id) {
            log.debug('Symbol merged (existing)', { symbol_id: symbolId, stable_key: input.stable_key });
        } else {
            log.debug('Symbol created', { symbol_id: id, stable_key: input.stable_key });
        }
        return symbolId;
    }

    public async insertSymbolVersion(input: SymbolVersionInput): Promise<string> {
        const id = uuidv4();
        const result = await db.query(`
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
            RETURNING symbol_version_id
        `, [
            id, input.symbol_id, input.snapshot_id, input.file_id,
            input.range_start_line, input.range_start_col, input.range_end_line, input.range_end_col,
            input.signature, input.ast_hash, input.body_hash, input.normalized_ast_hash || null,
            input.summary, input.body_source ?? null, input.visibility, input.language,
            input.uncertainty_flags || []
        ]);
        return extractId(result.rows[0] as Record<string, unknown> | undefined, 'symbol_version_id');
    }

    public async insertStructuralRelation(input: {
        src_symbol_version_id: string;
        dst_symbol_version_id: string;
        relation_type: string;
        strength?: number;
        source?: string;
        confidence: number;
    }): Promise<string> {
        const id = uuidv4();
        const result = await db.query(`
            INSERT INTO structural_relations
                (relation_id, src_symbol_version_id, dst_symbol_version_id, relation_type, strength, source, confidence)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (src_symbol_version_id, dst_symbol_version_id, relation_type)
            DO UPDATE SET confidence = GREATEST(structural_relations.confidence, EXCLUDED.confidence),
                          strength = EXCLUDED.strength,
                          source = EXCLUDED.source
            RETURNING relation_id
        `, [id, input.src_symbol_version_id, input.dst_symbol_version_id, input.relation_type,
            input.strength ?? 1.0, input.source ?? 'static_analysis', input.confidence]);
        return optionalStringField(firstRow(result), 'relation_id') ?? id;
    }

    public async upsertBehavioralProfile(profile: Omit<BehavioralProfile, 'behavior_profile_id'>): Promise<string> {
        const id = uuidv4();
        const result = await db.query(`
            INSERT INTO behavioral_profiles (
                behavior_profile_id, symbol_version_id, purity_class,
                resource_touches, db_reads, db_writes, network_calls, cache_ops, file_io,
                auth_operations, validation_operations, exception_profile,
                state_mutation_profile, transaction_profile
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
            ON CONFLICT (symbol_version_id) DO UPDATE SET
                purity_class = EXCLUDED.purity_class,
                resource_touches = EXCLUDED.resource_touches,
                db_reads = EXCLUDED.db_reads,
                db_writes = EXCLUDED.db_writes,
                network_calls = EXCLUDED.network_calls,
                cache_ops = EXCLUDED.cache_ops,
                file_io = EXCLUDED.file_io,
                auth_operations = EXCLUDED.auth_operations,
                validation_operations = EXCLUDED.validation_operations,
                exception_profile = EXCLUDED.exception_profile,
                state_mutation_profile = EXCLUDED.state_mutation_profile,
                transaction_profile = EXCLUDED.transaction_profile
            RETURNING behavior_profile_id
        `, [
            id, profile.symbol_version_id, profile.purity_class,
            profile.resource_touches, profile.db_reads, profile.db_writes,
            profile.network_calls, profile.cache_ops, profile.file_io,
            profile.auth_operations, profile.validation_operations, profile.exception_profile,
            profile.state_mutation_profile, profile.transaction_profile
        ]);
        return optionalStringField(firstRow(result), 'behavior_profile_id') ?? id;
    }

    public async upsertContractProfile(profile: {
        symbol_version_id: string;
        input_contract: string;
        output_contract: string;
        error_contract: string;
        schema_refs: string[];
        api_contract_refs: string[];
        serialization_contract: string;
        security_contract: string;
        derived_invariants_count: number;
    }): Promise<string> {
        const id = uuidv4();
        const result = await db.query(`
            INSERT INTO contract_profiles (
                contract_profile_id, symbol_version_id,
                input_contract, output_contract, error_contract,
                schema_refs, api_contract_refs, serialization_contract,
                security_contract, derived_invariants_count
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            ON CONFLICT (symbol_version_id) DO UPDATE SET
                input_contract = EXCLUDED.input_contract,
                output_contract = EXCLUDED.output_contract,
                error_contract = EXCLUDED.error_contract,
                schema_refs = EXCLUDED.schema_refs,
                api_contract_refs = EXCLUDED.api_contract_refs,
                serialization_contract = EXCLUDED.serialization_contract,
                security_contract = EXCLUDED.security_contract,
                derived_invariants_count = EXCLUDED.derived_invariants_count
            RETURNING contract_profile_id
        `, [
            id, profile.symbol_version_id,
            profile.input_contract, profile.output_contract, profile.error_contract,
            profile.schema_refs, profile.api_contract_refs, profile.serialization_contract,
            profile.security_contract, profile.derived_invariants_count
        ]);
        return optionalStringField(firstRow(result), 'contract_profile_id') ?? id;
    }

    public async insertInvariant(invariant: {
        repo_id: string;
        scope_symbol_id: string | null;
        scope_level: string;
        expression: string;
        source_type: string;
        strength: number;
        validation_method: string;
        last_verified_snapshot_id: string | null;
    }): Promise<string> {
        const id = uuidv4();
        const result = await db.query(`
            INSERT INTO invariants (
                invariant_id, repo_id, scope_symbol_id, scope_level,
                expression, source_type, strength, validation_method, last_verified_snapshot_id
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            ON CONFLICT (repo_id, COALESCE(scope_symbol_id, '00000000-0000-0000-0000-000000000000'::uuid), expression)
            DO UPDATE SET strength = GREATEST(invariants.strength, EXCLUDED.strength),
                          last_verified_snapshot_id = EXCLUDED.last_verified_snapshot_id,
                          source_type = EXCLUDED.source_type,
                          validation_method = EXCLUDED.validation_method,
                          scope_level = EXCLUDED.scope_level
            RETURNING invariant_id
        `, [
            id, invariant.repo_id, invariant.scope_symbol_id, invariant.scope_level,
            invariant.expression, invariant.source_type, invariant.strength,
            invariant.validation_method, invariant.last_verified_snapshot_id
        ]);
        return optionalStringField(firstRow(result), 'invariant_id') ?? id;
    }

    public async getFilePath(file_id: string): Promise<string | null> {
        const result = await db.query(`SELECT path FROM files WHERE file_id = $1`, [file_id]);
        return optionalStringField(firstRow(result), 'path') ?? null;
    }

    public async insertTestArtifact(artifact: {
        symbol_version_id: string;
        framework: string;
        related_symbols: string[];
        assertion_summary: string;
        coverage_hints: Record<string, unknown> | null;
    }): Promise<string> {
        const id = uuidv4();
        const result = await db.query(`
            INSERT INTO test_artifacts (
                test_artifact_id, symbol_version_id, framework,
                related_symbols, assertion_summary, coverage_hints
            ) VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (symbol_version_id) DO UPDATE SET
                framework = EXCLUDED.framework,
                related_symbols = EXCLUDED.related_symbols,
                assertion_summary = EXCLUDED.assertion_summary,
                coverage_hints = EXCLUDED.coverage_hints
            RETURNING test_artifact_id
        `, [id, artifact.symbol_version_id, artifact.framework,
            artifact.related_symbols, artifact.assertion_summary,
            artifact.coverage_hints ? JSON.stringify(artifact.coverage_hints) : null]);
        return extractId(result.rows[0] as Record<string, unknown> | undefined, 'test_artifact_id');
    }

    public async getSymbolVersionsForSnapshot(snapshot_id: string): Promise<SymbolVersionRow[]> {
        const result = await db.query(`
            SELECT sv.*, s.canonical_name, s.kind, s.stable_key, s.repo_id, f.path as file_path
            FROM symbol_versions sv
            JOIN symbols s ON s.symbol_id = sv.symbol_id
            JOIN files f ON f.file_id = sv.file_id
            WHERE sv.snapshot_id = $1
            ORDER BY sv.symbol_version_id
            LIMIT 100000
        `, [snapshot_id]);
        return validateRows(result.rows, validateSymbolVersionRow, 'getSymbolVersionsForSnapshot');
    }

    /**
     * Cursor-based paginated version of getSymbolVersionsForSnapshot.
     * Use this for snapshots that may contain 50K+ rows to avoid loading
     * the entire table into memory at once.
     *
     * @param snapshot_id  The snapshot to query
     * @param options.limit  Max rows per page (default 1000)
     * @param options.afterId  Cursor: return rows with symbol_version_id > afterId
     * @param options.excludeBodySource  If true, omits body_source to reduce transfer size
     */
    public async getSymbolVersionsForSnapshotPaginated(
        snapshot_id: string,
        options?: { limit?: number; afterId?: string; excludeBodySource?: boolean }
    ): Promise<{ rows: SymbolVersionRow[]; hasMore: boolean }> {
        const limit = options?.limit ?? 1000;
        const columns = options?.excludeBodySource
            ? 'sv.symbol_version_id, sv.symbol_id, sv.snapshot_id, sv.file_id, sv.range_start_line, sv.range_start_col, sv.range_end_line, sv.range_end_col, sv.signature, sv.ast_hash, sv.body_hash, sv.summary, sv.visibility, sv.language, sv.uncertainty_flags, s.canonical_name, s.kind, s.stable_key, s.repo_id, f.path as file_path'
            : 'sv.*, s.canonical_name, s.kind, s.stable_key, s.repo_id, f.path as file_path';

        let sql = `
            SELECT ${columns}
            FROM symbol_versions sv
            JOIN symbols s ON s.symbol_id = sv.symbol_id
            JOIN files f ON f.file_id = sv.file_id
            WHERE sv.snapshot_id = $1
        `;
        const params: unknown[] = [snapshot_id];

        if (options?.afterId) {
            sql += ` AND sv.symbol_version_id > $2`;
            params.push(options.afterId);
        }

        sql += ` ORDER BY sv.symbol_version_id LIMIT $${params.length + 1}`;
        params.push(limit + 1); // fetch one extra to detect hasMore

        const result = await db.query(sql, params);
        const hasMore = result.rows.length > limit;
        const rawRows = hasMore ? result.rows.slice(0, limit) : result.rows;
        const rows = validateRows(rawRows, validateSymbolVersionRow, 'getSymbolVersionsForSnapshotPaginated');

        return { rows, hasMore };
    }
}

export const coreDataService = new CoreDataService();
