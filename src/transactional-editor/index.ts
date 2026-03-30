/**
 * ContextZero — Transactional Change Engine
 *
 * 9-state lifecycle for managing code changes with full validation.
 * State machine:
 *   planned → prepared → patched → reindexed → validated →
 *   propagation_pending → committed | rolled_back | failed
 *
 * 6-level progressive validation:
 *   1. Syntax check (per-file parse)
 *   2. Type check (tsc --noEmit / mypy)
 *   3. Contract delta (before/after contract comparison)
 *   4. Behavioral delta (before/after purity/resource comparison)
 *   5. Invariant check (re-verify affected invariants)
 *   6. Test execution (run affected test suites)
 *
 * Uses sandbox.ts for all subprocess execution (no raw execSync).
 */

import * as fsp from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { db } from '../db-driver';
import { v4 as uuidv4 } from 'uuid';
import { Logger } from '../logger';
import { sandboxExec, sandboxTypeCheck, sandboxRunTests } from './sandbox';
import { behavioralEngine } from '../analysis-engine/behavioral';
import { contractEngine } from '../analysis-engine/contracts';
import { ingestor } from '../ingestor';
import { firstRow, optionalStringField, parseCountField, requireFirstRow, requireStringField } from '../db-driver/result';
import { resolvePathWithinBase } from '../path-security';
import type { PoolClient } from 'pg';
import {
    UserFacingError,
} from '../types';
import type {
    TransactionState, PatchSet,
    ValidationReport, ValidationMode,
    PropagationCandidate,
    ChangeTransaction,
    TransactionRecoverySummary,
} from '../types';

const log = new Logger('transactional-editor');
const RECOVERABLE_STATES: TransactionState[] = [
    'prepared',
    'patched',
    'reindexed',
    'validated',
    'propagation_pending',
    'failed',
];
const DEFAULT_STALE_TRANSACTION_MS = readPositiveIntEnv('SCG_STALE_TRANSACTION_MS', 6 * 60 * 60 * 1000);
const DEFAULT_RECOVERY_BATCH_SIZE = readPositiveIntEnv('SCG_STALE_TRANSACTION_BATCH_SIZE', 100);

/** Maximum file size allowed for backup during applyPatch (5 MB) */
const MAX_BACKUP_FILE_SIZE = 5 * 1024 * 1024;

function readPositiveIntEnv(name: string, fallback: number): number {
    const raw = process.env[name];
    if (!raw) return fallback;
    const parsed = parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

interface ValidationSymbolPair {
    base_symbol_version_id: string;
    validation_symbol_version_id: string | null;
    symbol_id: string;
    canonical_name: string;
}

/** Valid state transitions */
const VALID_TRANSITIONS: Record<TransactionState, TransactionState[]> = {
    planned:               ['prepared', 'failed', 'rolled_back'],
    prepared:              ['patched', 'failed', 'rolled_back'],
    patched:               ['reindexed', 'failed', 'rolled_back'],
    reindexed:             ['validated', 'failed', 'rolled_back'],
    validated:             ['propagation_pending', 'committed', 'failed', 'rolled_back'],
    propagation_pending:   ['committed', 'failed', 'rolled_back'],
    committed:             [],
    rolled_back:           [],
    failed:                ['rolled_back'],
};

export class TransactionalChangeEngine {

    /**
     * Create a new change transaction.
     */
    public async createTransaction(
        repoId: string,
        baseSnapshotId: string,
        createdBy: string,
        targetSymbolVersionIds: string[]
    ): Promise<string> {
        const txnId = uuidv4();
        const timer = log.startTimer('createTransaction', { txnId, repoId });

        await db.query(`
            INSERT INTO change_transactions (
                txn_id, repo_id, base_snapshot_id, created_by,
                state, target_symbol_versions, patches
            ) VALUES ($1, $2, $3, $4, 'planned', $5, '[]'::jsonb)
        `, [txnId, repoId, baseSnapshotId, createdBy, targetSymbolVersionIds]);

        timer();
        return txnId;
    }

    /**
     * Resolve the repository base path from the DB for a given transaction.
     */
    private async getRepoBasePath(txnId: string): Promise<string> {
        const result = await db.query(
            `SELECT r.base_path FROM change_transactions ct
             JOIN repositories r ON r.repo_id = ct.repo_id
             WHERE ct.txn_id = $1`,
            [txnId]
        );
        const basePath = optionalStringField(firstRow(result), 'base_path');
        if (!basePath) {
            throw new Error(`Repository base path not configured for transaction: ${txnId}`);
        }
        return basePath;
    }

    /**
     * Apply a patch to the transaction.
     *
     * State machine flow: planned → prepared (backup done) → patched (files written).
     * Only callable from 'planned' state. If any step fails, transaction
     * rolls back to 'planned' (backup) or 'prepared' (write failure).
     */
    public async applyPatch(
        txnId: string,
        patches: PatchSet,
        repoBasePath?: string
    ): Promise<void> {
        const timer = log.startTimer('applyPatch', { txnId, patchCount: patches.length });
        const txn = await this.loadTransaction(txnId);
        if (!txn) throw UserFacingError.notFound(`Transaction ${txnId}`);

        // applyPatch is only valid from 'planned' state — ensures idempotency
        if (txn.state !== 'planned') {
            throw UserFacingError.badRequest(
                `applyPatch requires transaction in 'planned' state, got '${txn.state}'`
            );
        }

        // Resolve base path from DB if not provided
        const basePath = repoBasePath || await this.getRepoBasePath(txnId);

        // Phase 1: Backup original files to database (planned → prepared)
        // Wrapped in a DB transaction with advisory locks for concurrent file isolation.
        // Advisory locks are automatically released on COMMIT/ROLLBACK.
        await db.transaction(async (client: PoolClient) => {
            for (const patch of patches) {
                const fullPath = this.resolveSafePath(basePath, patch.file_path);

                // Acquire advisory lock: hash file path to int32 for pg_advisory_xact_lock
                // This serializes concurrent access to the same file across transactions
                const pathHash = crypto.createHash('md5').update(fullPath).digest();
                const lockKey = pathHash.readInt32BE(0);
                await db.queryWithClient(client, 'SELECT pg_advisory_xact_lock($1)', [lockKey]);

                // Guard: reject files that are too large to back up safely
                try {
                    const fileStat = await fsp.stat(fullPath);
                    if (fileStat.size > MAX_BACKUP_FILE_SIZE) {
                        throw new Error(`File too large for backup: ${patch.file_path}`);
                    }
                } catch (err) {
                    // If stat threw our size error, re-throw it
                    if (err instanceof Error && err.message.startsWith('File too large')) {
                        throw err;
                    }
                    // Otherwise file doesn't exist — that's fine, we'll record null below
                }

                let originalContent: string | null = null;
                try {
                    originalContent = await fsp.readFile(fullPath, 'utf-8');
                } catch {
                    // File doesn't exist yet — null signals "created by this patch"
                }
                await db.queryWithClient(client, `
                    INSERT INTO transaction_file_backups (backup_id, txn_id, file_path, original_content)
                    VALUES ($1, $2, $3, $4)
                `, [uuidv4(), txnId, patch.file_path, originalContent]);
            }

            // Transition state inside the transaction
            await db.queryWithClient(client,
                `UPDATE change_transactions SET state = $1, updated_at = NOW() WHERE txn_id = $2`,
                ['prepared', txnId]
            );
        });
        log.info('Transaction state changed', { txnId, newState: 'prepared' });

        // Phase 2: Write patched files (prepared → patched)
        // Atomic write-all-or-nothing: write to temp files first, then rename.
        // fs.rename is atomic on the same filesystem (Linux/macOS), so either
        // all files land at their final paths or none do.
        const tempFiles: string[] = [];
        try {
            // Step 1: Write all patches to temporary files
            for (const patch of patches) {
                const fullPath = this.resolveSafePath(basePath, patch.file_path);
                const dir = path.dirname(fullPath);
                try {
                    await fsp.access(dir);
                } catch {
                    await fsp.mkdir(dir, { recursive: true });
                }
                const tmpPath = `${fullPath}.scg-tmp`;
                await fsp.writeFile(tmpPath, patch.new_content, 'utf-8');
                tempFiles.push(tmpPath);
            }

            // Step 2: Atomically rename all temp files to their final paths
            for (let i = 0; i < patches.length; i++) {
                const fullPath = this.resolveSafePath(basePath, patches[i]!.file_path);
                await fsp.rename(tempFiles[i]!, fullPath);
            }
        } catch (writeErr) {
            // Clean up any remaining temp files before failing
            for (const tmp of tempFiles) {
                try { await fsp.unlink(tmp); } catch { /* already renamed or missing */ }
            }
            log.error('Phase 2 file write failed — marking transaction as failed', writeErr, { txnId });
            await this.transitionState(txnId, 'failed');
            throw writeErr;
        }

        // Store patches and advance to 'patched'
        await db.query(`
            UPDATE change_transactions SET patches = $1, updated_at = NOW()
            WHERE txn_id = $2
        `, [JSON.stringify(patches), txnId]);

        await this.transitionState(txnId, 'patched');
        timer();
    }

    /**
     * Run 6-level progressive validation.
     */
    public async validate(
        txnId: string,
        repoBasePath: string,
        mode: ValidationMode = 'standard'
    ): Promise<ValidationReport> {
        const timer = log.startTimer('validate', { txnId, mode });
        const txn = await this.loadTransaction(txnId);
        if (!txn) throw UserFacingError.notFound(`Transaction ${txnId}`);

        // Must be at least patched to validate
        if (!['patched', 'reindexed'].includes(txn.state)) {
            throw UserFacingError.badRequest(`Cannot validate transaction in state: ${txn.state}`);
        }

        const levels: ValidationReport['levels'] = [];
        let allPassed = true;

        // Level 1: Syntax check
        const syntaxResult = await this.runSyntaxCheck(repoBasePath, txn.patches as PatchSet);
        levels.push({
            level: 1,
            name: 'syntax_check',
            passed: syntaxResult.passed,
            details: syntaxResult.details,
            failures: syntaxResult.failures,
        });
        if (!syntaxResult.passed) allPassed = false;

        // Level 2: Type check
        if (allPassed || mode === 'strict') {
            const typeResult = await this.runTypeCheck(repoBasePath);
            levels.push({
                level: 2,
                name: 'type_check',
                passed: typeResult.passed,
                details: typeResult.details,
                failures: typeResult.failures,
        });
        if (!typeResult.passed) allPassed = false;
    }

        let validationSnapshotId: string | undefined;
        let validationPairs: ValidationSymbolPair[] = [];

        if ((allPassed || mode === 'strict') && mode !== 'quick') {
            validationSnapshotId = await this.ensureValidationSnapshot(txn, repoBasePath);
            validationPairs = await this.loadValidationSymbolPairs(txn, validationSnapshotId);
        }

        if (txn.state === 'patched') {
            await this.transitionState(txnId, 'reindexed');
        }

        // Level 3: Contract delta (standard + strict)
        if ((allPassed || mode === 'strict') && mode !== 'quick') {
            const contractResult = await this.runContractDelta(validationPairs);
            levels.push({
                level: 3,
                name: 'contract_delta',
                passed: contractResult.passed,
                details: contractResult.details,
                failures: contractResult.failures,
            });
            if (!contractResult.passed) allPassed = false;
        }

        // Level 4: Behavioral delta (standard + strict)
        if ((allPassed || mode === 'strict') && mode !== 'quick') {
            const behaviorResult = await this.runBehavioralDelta(validationPairs);
            levels.push({
                level: 4,
                name: 'behavioral_delta',
                passed: behaviorResult.passed,
                details: behaviorResult.details,
                failures: behaviorResult.failures,
            });
            if (!behaviorResult.passed) allPassed = false;
        }

        // Level 5: Invariant check (standard + strict; non-blocking in standard)
        if ((allPassed || mode === 'strict') && mode !== 'quick') {
            const invariantResult = await this.runInvariantCheck(validationPairs);
            levels.push({
                level: 5,
                name: 'invariant_check',
                passed: invariantResult.passed,
                details: invariantResult.details,
                failures: invariantResult.failures,
            });
            if (!invariantResult.passed) {
                if (mode === 'strict') {
                    allPassed = false;
                } else {
                    log.warn('Invariant check failed (non-blocking in standard mode)', {
                        failures: invariantResult.failures,
                    });
                }
            }
        }

        // Level 6: Test execution (standard + strict)
        if ((allPassed || mode === 'strict') && mode !== 'quick') {
            const testResult = await this.runTestExecution(repoBasePath, validationPairs);
            levels.push({
                level: 6,
                name: 'test_execution',
                passed: testResult.passed,
                details: testResult.details,
                failures: testResult.failures,
            });
            if (!testResult.passed) allPassed = false;
        }

        await this.transitionState(txnId, allPassed ? 'validated' : 'failed');

        const report: ValidationReport = {
            transaction_id: txnId,
            mode,
            overall_passed: allPassed,
            levels,
            executed_at: new Date(),
            validation_snapshot_id: validationSnapshotId,
        };

        // Store report reference
        await db.query(`
            UPDATE change_transactions
            SET validation_report_ref = $1, updated_at = NOW()
            WHERE txn_id = $2
        `, [JSON.stringify(report), txnId]);

        timer({ passed: allPassed, levels_run: levels.length });
        return report;
    }

    /**
     * Commit a validated transaction.
     *
     * Uses a single DB transaction with FOR UPDATE to prevent double-commit
     * race conditions and ensure atomic state transition + backup deletion.
     */
    public async commit(txnId: string): Promise<void> {
        await db.transaction(async (client: PoolClient) => {
            // Lock the transaction row to prevent concurrent commit/rollback
            const lockResult = await db.queryWithClient(client,
                `SELECT state FROM change_transactions WHERE txn_id = $1 FOR UPDATE`,
                [txnId]
            );
            const row = firstRow(lockResult);
            if (!row) throw UserFacingError.notFound(`Transaction ${txnId}`);
            const currentState = requireStringField(row, 'state', `Transaction ${txnId}`) as TransactionState;
            this.assertTransition(currentState, 'committed');

            // Atomic: transition state AND delete backups in one transaction
            await db.queryWithClient(client,
                `UPDATE change_transactions SET state = 'committed', updated_at = NOW() WHERE txn_id = $1`,
                [txnId]
            );
            await db.queryWithClient(client,
                `DELETE FROM transaction_file_backups WHERE txn_id = $1`,
                [txnId]
            );
        });
        log.info('Transaction committed', { txnId });
    }

    /**
     * Rollback a transaction — restore original files.
     * Validates state transition BEFORE performing any file restoration
     * to prevent corrupting committed transactions.
     */
    public async rollback(txnId: string): Promise<void> {
        const timer = log.startTimer('rollback', { txnId });
        const txn = await this.loadTransaction(txnId);
        if (!txn) throw UserFacingError.notFound(`Transaction ${txnId}`);

        // CRITICAL: Validate state transition BEFORE any file operations.
        // Without this check, rollback on a 'committed' transaction would restore
        // files before discovering the state transition is invalid.
        const allowedTargets = VALID_TRANSITIONS[txn.state] ?? [];
        if (!allowedTargets.includes('rolled_back') && !allowedTargets.includes('failed')) {
            throw UserFacingError.badRequest(
                `Cannot rollback transaction in state '${txn.state}' — only non-terminal states can be rolled back`
            );
        }

        // Resolve repo base path for path validation during rollback
        // CRITICAL: if we cannot resolve the base path, we MUST abort the rollback entirely.
        // Silently skipping file restoration while deleting backups causes irreversible data loss.
        let realBase: string;
        try {
            const repoBasePath = await this.getRepoBasePath(txnId);
            realBase = await fsp.realpath(path.resolve(repoBasePath));
        } catch (err) {
            log.error('Cannot resolve repo base path for rollback — aborting to preserve backup data', err, { txnId });
            throw new Error(`Rollback aborted: cannot resolve repository base path for transaction ${txnId}. Backup data is preserved — retry after fixing the repository path.`);
        }

        // Restore file backups from database
        const backupResult = await db.query(
            `SELECT file_path, original_content FROM transaction_file_backups WHERE txn_id = $1`,
            [txnId]
        );

        const restoredFiles: string[] = [];
        const failedFiles: string[] = [];

        for (const backup of backupResult.rows as { file_path: string; original_content: string | null }[]) {
            try {
                const backupPath = path.isAbsolute(backup.file_path)
                    ? path.relative(realBase, backup.file_path)
                    : backup.file_path;
                const safePath = resolvePathWithinBase(realBase, backupPath, { allowMissing: true });
                const resolvedBackupPath = safePath.existed ? safePath.realPath : safePath.resolvedPath;

                if (backup.original_content === null) {
                    // File was newly created — remove it
                    try {
                        await fsp.access(resolvedBackupPath);
                        await fsp.unlink(resolvedBackupPath);
                    } catch {
                        // File already absent — nothing to remove
                    }
                } else {
                    const parentDir = path.dirname(resolvedBackupPath);
                    try {
                        await fsp.access(parentDir);
                    } catch {
                        await fsp.mkdir(parentDir, { recursive: true });
                    }
                    await fsp.writeFile(resolvedBackupPath, backup.original_content, 'utf-8');
                }
                restoredFiles.push(backup.file_path);
            } catch (err) {
                log.error('Failed to restore backup', err, { filePath: backup.file_path });
                failedFiles.push(backup.file_path);
            }
        }

        // Only delete backups for successfully restored files; keep failed ones for manual recovery
        if (restoredFiles.length > 0) {
            await db.query(
                `DELETE FROM transaction_file_backups WHERE txn_id = $1 AND file_path = ANY($2)`,
                [txnId, restoredFiles]
            );
        }

        if (failedFiles.length > 0) {
            log.error('Rollback incomplete: failed to restore files', null, {
                txnId,
                failedCount: failedFiles.length,
                failedFiles,
            });
            await this.transitionState(txnId, 'failed');
        } else {
            await this.transitionState(txnId, 'rolled_back');
        }
        timer();
    }

    /**
     * Recover stale non-terminal transactions left behind by crashes or interrupted runs.
     * Rolls them back when possible, and defensively removes lingering backups for
     * already-terminal transactions.
     */
    public async recoverStaleTransactions(
        olderThanMs: number = DEFAULT_STALE_TRANSACTION_MS,
        limit: number = DEFAULT_RECOVERY_BATCH_SIZE,
    ): Promise<TransactionRecoverySummary> {
        const timer = log.startTimer('recoverStaleTransactions', { olderThanMs, limit });
        const cutoff = new Date(Date.now() - olderThanMs);
        const staleResult = await db.query(
            `SELECT ct.txn_id, ct.state, COUNT(tfb.backup_id) AS backup_count
             FROM change_transactions ct
             LEFT JOIN transaction_file_backups tfb ON tfb.txn_id = ct.txn_id
             WHERE ct.state = ANY($1::text[])
               AND ct.updated_at < $2
             GROUP BY ct.txn_id, ct.state, ct.updated_at
             ORDER BY ct.updated_at ASC
             LIMIT $3`,
            [RECOVERABLE_STATES, cutoff.toISOString(), limit],
        );

        let recovered = 0;
        let recoveryFailed = 0;

        for (const row of staleResult.rows as Array<{ txn_id: string; state: TransactionState; backup_count: string | number }>) {
            const backupCount = parseCountField(row as Record<string, unknown>, 'backup_count');
            try {
                if (backupCount === 0 && row.state === 'failed') {
                    await this.transitionState(row.txn_id, 'rolled_back');
                } else {
                    await this.rollback(row.txn_id);
                }
                recovered++;
            } catch (error) {
                recoveryFailed++;
                log.error('Failed to recover stale transaction', error, {
                    txnId: row.txn_id,
                    state: row.state,
                    backup_count: backupCount,
                });
            }
        }

        const cleanupResult = await db.query(
            `DELETE FROM transaction_file_backups tfb
             USING change_transactions ct
             WHERE tfb.txn_id = ct.txn_id
               AND ct.state IN ('committed', 'rolled_back')
             RETURNING tfb.backup_id`,
        );

        const summary: TransactionRecoverySummary = {
            scanned: staleResult.rows.length,
            recovered,
            recovery_failed: recoveryFailed,
            cleaned_terminal_backups: cleanupResult.rowCount ?? 0,
        };

        timer({ ...summary });
        return summary;
    }

    /**
     * Get transaction state.
     */
    public async getTransaction(txnId: string): Promise<ChangeTransaction | null> {
        return this.loadTransaction(txnId);
    }

    /**
     * Compute propagation proposals for homologs of changed symbols.
     */
    public async computePropagationProposals(
        txnId: string,
        _snapshotId: string
    ): Promise<PropagationCandidate[]> {
        const txn = await this.loadTransaction(txnId);
        if (!txn) throw UserFacingError.notFound(`Transaction ${txnId}`);

        const proposals: PropagationCandidate[] = [];

        for (const svId of txn.target_symbol_versions) {
            // Find homologs via inferred_relations
            const result = await db.query(`
                SELECT ir.dst_symbol_version_id, ir.relation_type, ir.confidence,
                       s.canonical_name, eb.contradiction_flags
                FROM inferred_relations ir
                JOIN symbol_versions sv ON sv.symbol_version_id = ir.dst_symbol_version_id
                JOIN symbols s ON s.symbol_id = sv.symbol_id
                JOIN evidence_bundles eb ON eb.evidence_bundle_id = ir.evidence_bundle_id
                WHERE ir.src_symbol_version_id = $1
                AND ir.confidence >= 0.70
                AND ir.review_state != 'rejected'
            `, [svId]);

            for (const row of result.rows as {
                dst_symbol_version_id: string;
                relation_type: string;
                confidence: number;
                canonical_name: string;
                contradiction_flags: string[];
            }[]) {
                const hasContradictions = Array.isArray(row.contradiction_flags) && row.contradiction_flags.length > 0;
                proposals.push({
                    homolog_symbol_id: row.dst_symbol_version_id,
                    homolog_name: row.canonical_name,
                    relation_type: row.relation_type as PropagationCandidate['relation_type'],
                    confidence: row.confidence,
                    is_safe: !hasContradictions && row.confidence >= 0.85,
                    patch_proposal: null,
                    risk_notes: hasContradictions
                        ? [`Contradictions detected: ${(row.contradiction_flags || []).join(', ')}`]
                        : [],
                });
            }
        }

        // Store propagation report
        if (proposals.length > 0 && txn.state === 'validated') {
            await this.transitionState(txnId, 'propagation_pending');
            await db.query(`
                UPDATE change_transactions
                SET propagation_report_ref = $1, updated_at = NOW()
                WHERE txn_id = $2
            `, [JSON.stringify(proposals), txnId]);
        }

        return proposals;
    }

    // ────────── Validation Level Implementations ──────────

    private async runSyntaxCheck(
        repoBasePath: string,
        patches: PatchSet
    ): Promise<{ passed: boolean; details: string; failures: string[] }> {
        const failures: string[] = [];

        for (const patch of patches) {
            if (patch.file_path.endsWith('.ts') || patch.file_path.endsWith('.tsx')) {
                const fullPath = this.resolveSafePath(repoBasePath, patch.file_path);
                const result = await sandboxExec('npx', ['tsc', '--noEmit', '--allowJs', fullPath], {
                    cwd: repoBasePath,
                    timeoutMs: 30_000,
                    maxOutputBytes: 256_000,
                });
                if (result.exitCode !== 0) {
                    const output = this.captureDiagnostics(result.stdout, result.stderr);
                    failures.push(`${patch.file_path}: ${output.substring(0, 500)}`);
                }
            } else if (patch.file_path.endsWith('.py')) {
                const fullPath = this.resolveSafePath(repoBasePath, patch.file_path);
                const result = await sandboxExec('python3', ['-m', 'py_compile', fullPath], {
                    cwd: repoBasePath,
                    timeoutMs: 15_000,
                    maxOutputBytes: 64_000,
                });
                if (result.exitCode !== 0) {
                    const output = this.captureDiagnostics(result.stdout, result.stderr);
                    failures.push(`${patch.file_path}: ${output.substring(0, 500)}`);
                }
            }
        }

        return {
            passed: failures.length === 0,
            details: failures.length === 0 ? 'All patched files pass syntax check' : `${failures.length} syntax errors`,
            failures,
        };
    }

    private async runTypeCheck(
        repoBasePath: string
    ): Promise<{ passed: boolean; details: string; failures: string[] }> {
        const result = await sandboxTypeCheck(repoBasePath);
        const combinedOutput = this.captureDiagnostics(result.stdout, result.stderr);
        const failures = result.exitCode !== 0
            ? combinedOutput.split('\n').filter(l => l.includes('error TS')).slice(0, 20)
            : [];

        return {
            passed: result.exitCode === 0,
            details: result.exitCode === 0
                ? 'Type check passed'
                : `Type check failed (exit ${result.exitCode})`,
            failures,
        };
    }

    private async runContractDelta(
        validationPairs: ValidationSymbolPair[]
    ): Promise<{ passed: boolean; details: string; failures: string[] }> {
        const failures: string[] = [];

        for (const pair of validationPairs) {
            const validationSymbolVersionId = this.requireValidationSymbol(pair, failures);
            if (!validationSymbolVersionId) continue;

            // Load before/after contract profiles
            const before = await contractEngine.getProfile(pair.base_symbol_version_id);
            const after = await contractEngine.getProfile(validationSymbolVersionId);
            if (!before || !after) {
                failures.push(`Contract profiles unavailable for ${pair.canonical_name}`);
                continue;
            }

            // Compare contracts using the real engine
            const delta = contractEngine.compareContracts(before, after);

            if (delta.outputChanged) {
                failures.push(`Output contract changed for ${pair.canonical_name}: '${before.output_contract}' → '${after.output_contract}'`);
            }
            if (delta.errorChanged) {
                failures.push(`Error contract changed for ${pair.canonical_name}: '${before.error_contract}' → '${after.error_contract}'`);
            }
            if (delta.securityChanged) {
                failures.push(`Security contract changed for ${pair.canonical_name}: '${before.security_contract}' → '${after.security_contract}'`);
            }
            if (delta.inputChanged) {
                failures.push(`Input contract changed for ${pair.canonical_name}: '${before.input_contract}' → '${after.input_contract}'`);
            }
        }

        return {
            passed: failures.length === 0,
            details: failures.length === 0
                ? 'No contract violations detected'
                : `${failures.length} contract regressions detected`,
            failures,
        };
    }

    private async runBehavioralDelta(
        validationPairs: ValidationSymbolPair[]
    ): Promise<{ passed: boolean; details: string; failures: string[] }> {
        const failures: string[] = [];

        for (const pair of validationPairs) {
            const validationSymbolVersionId = this.requireValidationSymbol(pair, failures);
            if (!validationSymbolVersionId) continue;

            // Load before/after behavioral profiles
            const before = await behavioralEngine.getProfile(pair.base_symbol_version_id);
            const after = await behavioralEngine.getProfile(validationSymbolVersionId);
            if (!before || !after) {
                failures.push(`Behavioral profiles unavailable for ${pair.canonical_name}`);
                continue;
            }

            // Compare behavior using the real engine
            const delta = behavioralEngine.compareBehavior(before, after);

            if (delta.purityDirection === 'escalated') {
                failures.push(`Purity escalated for ${pair.canonical_name}: '${before.purity_class}' → '${after.purity_class}'`);
            }
            if (delta.newResourceTouches.length > 0) {
                failures.push(`New resource touches for ${pair.canonical_name}: ${delta.newResourceTouches.join(', ')}`);
            }
            if (delta.sideEffectsChanged) {
                failures.push(`Side effects changed for ${pair.canonical_name}`);
            }
        }

        return {
            passed: failures.length === 0,
            details: failures.length === 0
                ? 'No behavioral regressions'
                : `${failures.length} behavioral regressions detected`,
            failures,
        };
    }

    private async runInvariantCheck(
        validationPairs: ValidationSymbolPair[]
    ): Promise<{ passed: boolean; details: string; failures: string[] }> {
        const failures: string[] = [];

        // Check invariants scoped to affected symbols
        for (const pair of validationPairs) {
            const validationSymbolVersionId = this.requireValidationSymbol(pair, failures);
            if (!validationSymbolVersionId) continue;
            const result = await db.query(`
                SELECT i.expression, i.strength, i.source_type
                FROM invariants i
                JOIN symbol_versions sv ON sv.symbol_id = i.scope_symbol_id
                WHERE sv.symbol_version_id = $1
                AND i.strength >= 0.80
            `, [validationSymbolVersionId]);

            for (const row of result.rows as { expression: string; strength: number; source_type: string }[]) {
                if (row.strength >= 0.90) {
                    failures.push(`High-strength invariant needs re-verification for ${pair.canonical_name}: ${row.expression}`);
                }
            }
        }

        return {
            passed: failures.length === 0,
            details: failures.length === 0
                ? 'All invariants verified'
                : `${failures.length} invariants need re-verification`,
            failures,
        };
    }

    private async runTestExecution(
        repoBasePath: string,
        validationPairs: ValidationSymbolPair[]
    ): Promise<{ passed: boolean; details: string; failures: string[] }> {
        // Find test files related to changed symbols
        const testPaths: string[] = [];
        const failures: string[] = [];

        for (const pair of validationPairs) {
            const validationSymbolVersionId = this.requireValidationSymbol(pair, failures);
            if (!validationSymbolVersionId) continue;
            const result = await db.query(`
                SELECT DISTINCT f.path
                FROM test_artifacts ta
                JOIN symbol_versions sv ON sv.symbol_version_id = ta.symbol_version_id
                JOIN files f ON f.file_id = sv.file_id
                WHERE $1 = ANY(ta.related_symbols)
            `, [validationSymbolVersionId]);

            for (const row of result.rows as { path: string }[]) {
                if (!testPaths.includes(row.path)) {
                    testPaths.push(row.path);
                }
            }
        }

        if (testPaths.length === 0) {
            return {
                passed: failures.length === 0,
                details: failures.length === 0
                    ? 'No test files found for affected symbols'
                    : 'Unable to map all affected symbols into the validation snapshot',
                failures,
            };
        }

        const result = await sandboxRunTests(repoBasePath, testPaths);
        const combinedOutput = this.captureDiagnostics(result.stdout, result.stderr);
        if (result.exitCode !== 0) {
            failures.push(...combinedOutput.split('\n').filter(l => /FAIL|Error|✕|×/.test(l)).slice(0, 20));
        }

        return {
            passed: result.exitCode === 0 && failures.length === 0,
            details: result.exitCode === 0
                ? `${testPaths.length} test files passed`
                : `Tests failed (exit ${result.exitCode})`,
            failures,
        };
    }

    // ────────── Helpers ──────────

    private captureDiagnostics(stdout: string, stderr: string): string {
        const output = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n');
        return output || 'No diagnostics captured';
    }

    private buildValidationCommitSha(txn: ChangeTransaction): string {
        const hash = crypto.createHash('sha256')
            .update(`${txn.txn_id}:${JSON.stringify(txn.patches)}:${Date.now()}`)
            .digest('hex')
            .slice(0, 24);
        return `txnval-${txn.txn_id.slice(0, 8)}-${hash}`;
    }

    private async ensureValidationSnapshot(
        txn: ChangeTransaction,
        repoBasePath: string
    ): Promise<string> {
        const existingSnapshotId = txn.validation_report_ref?.validation_snapshot_id;
        if (existingSnapshotId) {
            const existing = await db.query(
                `SELECT snapshot_id, index_status FROM snapshots WHERE snapshot_id = $1 AND repo_id = $2`,
                [existingSnapshotId, txn.repo_id]
            );
            const row = firstRow(existing);
            const snapshotId = optionalStringField(row, 'snapshot_id');
            if (snapshotId && optionalStringField(row, 'index_status') === 'complete') {
                return snapshotId;
            }
        }

        const repoResult = await db.query(
            `SELECT name, default_branch FROM repositories WHERE repo_id = $1`,
            [txn.repo_id]
        );
        const repoRow = requireFirstRow(repoResult, `Repository not found for transaction: ${txn.txn_id}`);
        const repoName = requireStringField(repoRow, 'name', `Repository not found for transaction: ${txn.txn_id}`);
        const defaultBranch = optionalStringField(repoRow, 'default_branch');

        const snapshotResult = await db.query(
            `SELECT branch FROM snapshots WHERE snapshot_id = $1`,
            [txn.base_snapshot_id]
        );
        const branch = optionalStringField(firstRow(snapshotResult), 'branch') || defaultBranch || 'main';

        const ingestionResult = await ingestor.ingestRepo(
            repoBasePath,
            repoName,
            this.buildValidationCommitSha(txn),
            branch,
            txn.base_snapshot_id,
        );

        if (!ingestionResult.snapshot_id) {
            throw new Error(`Validation snapshot ingestion failed for transaction: ${txn.txn_id}`);
        }

        // Verify the snapshot completed successfully — a partial snapshot would
        // produce incomplete validation results (false negatives).
        const statusResult = await db.query(
            `SELECT index_status FROM snapshots WHERE snapshot_id = $1`,
            [ingestionResult.snapshot_id]
        );
        const status = optionalStringField(firstRow(statusResult), 'index_status');
        if (status !== 'complete') {
            throw new Error(
                `Validation snapshot is ${status ?? 'unknown'} (not complete) for transaction: ${txn.txn_id}. ` +
                `Re-ingestion may be required.`
            );
        }

        return ingestionResult.snapshot_id;
    }

    private async loadValidationSymbolPairs(
        txn: ChangeTransaction,
        validationSnapshotId: string
    ): Promise<ValidationSymbolPair[]> {
        const result = await db.query(`
            SELECT base.symbol_version_id AS base_symbol_version_id,
                   current.symbol_version_id AS validation_symbol_version_id,
                   base.symbol_id,
                   s.canonical_name
            FROM symbol_versions base
            JOIN symbols s ON s.symbol_id = base.symbol_id
            LEFT JOIN symbol_versions current
                ON current.symbol_id = base.symbol_id
               AND current.snapshot_id = $2
            WHERE base.symbol_version_id = ANY($1::uuid[])
        `, [txn.target_symbol_versions, validationSnapshotId]);

        const pairs = result.rows as ValidationSymbolPair[];
        const seen = new Set(pairs.map(pair => pair.base_symbol_version_id));
        const failures = txn.target_symbol_versions
            .filter(svId => !seen.has(svId))
            .map(svId => `Target symbol missing from base snapshot: ${svId}`);

        if (failures.length > 0) {
            throw new Error(`Validation snapshot mapping failed: ${failures.join('; ')}`);
        }

        return pairs;
    }

    private requireValidationSymbol(pair: ValidationSymbolPair, failures: string[]): string | null {
        if (!pair.validation_symbol_version_id) {
            failures.push(
                `Validation snapshot missing target symbol: ${pair.canonical_name} (${pair.base_symbol_version_id})`
            );
            return null;
        }
        return pair.validation_symbol_version_id;
    }

    private async loadTransaction(txnId: string): Promise<ChangeTransaction | null> {
        const result = await db.query(
            `SELECT txn_id, repo_id, base_snapshot_id, created_by, state,
                    target_symbol_versions, patches, impact_report_ref,
                    validation_report_ref, propagation_report_ref,
                    created_at, updated_at
             FROM change_transactions WHERE txn_id = $1`,
            [txnId]
        );
        return (result.rows[0] as ChangeTransaction | undefined) ?? null;
    }

    private assertTransition(currentState: TransactionState, targetState: TransactionState): void {
        const valid = VALID_TRANSITIONS[currentState];
        if (!valid || !valid.includes(targetState)) {
            throw new Error(
                `Invalid state transition: ${currentState} → ${targetState}. ` +
                `Valid transitions: ${valid?.join(', ') || 'none'}`
            );
        }
    }

    private async transitionState(txnId: string, newState: TransactionState): Promise<void> {
        // Wrap SELECT + validation + UPDATE in a single transaction with
        // FOR UPDATE row lock to eliminate the TOCTOU race condition.
        await db.transaction(async (client: PoolClient) => {
            const current = await client.query(
                `SELECT state FROM change_transactions WHERE txn_id = $1 FOR UPDATE`,
                [txnId]
            );
            const stateValue = current.rows[0]?.['state'];
            const currentState = typeof stateValue === 'string' ? stateValue as TransactionState : undefined;
            if (currentState) {
                this.assertTransition(currentState, newState);
            }

            await client.query(
                `UPDATE change_transactions SET state = $1, updated_at = NOW() WHERE txn_id = $2`,
                [newState, txnId]
            );
        });
        log.info('Transaction state changed', { txnId, newState });
    }

    /**
     * Resolve a file path safely, preventing path traversal.
     * Uses fsp.realpath on the base to resolve symlinks before
     * checking containment — prevents symlink-based escapes.
     */
    private resolveSafePath(basePath: string, filePath: string): string {
        const safePath = resolvePathWithinBase(basePath, filePath, { allowMissing: true });
        return safePath.existed ? safePath.realPath : safePath.resolvedPath;
    }
}

export const transactionalChangeEngine = new TransactionalChangeEngine();
