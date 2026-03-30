/**
 * ContextZero — MCP Bridge Tool Handlers
 *
 * Direct-call implementations for all 49 ContextZero tools, executing engine
 * code without HTTP overhead. Each handler mirrors the logic from the REST API
 * but returns structured MCP CallToolResult payloads.
 *
 * All handlers follow the pattern:
 *   (args) => Promise<CallToolResult>
 *
 * Errors are caught and returned as isError:true results — handlers never throw.
 */

import { db } from '../db-driver';
import { coreDataService } from '../db-driver/core_data';
import { structuralGraphEngine } from '../analysis-engine';
import { behavioralEngine } from '../analysis-engine/behavioral';
import { contractEngine } from '../analysis-engine/contracts';
import { blastRadiusEngine } from '../analysis-engine/blast-radius';
import { capsuleCompiler } from '../analysis-engine/capsule-compiler';
import { homologCache } from '../cache';
import { uncertaintyTracker } from '../analysis-engine/uncertainty';
import { homologInferenceEngine } from '../homolog-engine';
import { transactionalChangeEngine } from '../transactional-editor';
import { ingestor } from '../ingestor';
import { firstRow, optionalStringField, parseCountField } from '../db-driver/result';
import { resolvePathWithinBase } from '../path-security';
import {
    buildNativeCodebaseOverview,
    deriveWorkspaceSnapshotIdentity,
    ensureAllowedRepoPath,
    searchWorkspaceCode,
    searchWorkspaceSymbols,
} from '../workspace-native';
import * as path from 'path';
// V2 engine imports — lazy-loaded to avoid breaking if files don't exist yet
import type { CapsuleMode, ValidationMode, TracePack } from '../types';
import { UserFacingError } from '../types';
import type { McpLogger } from './index';
// ────────── Service Layer (shared with REST API) ──────────
import {
    resolveSymbol,
    getSymbolDetails,
    getCodebaseOverview,
    compileSmartContext,
    searchCode,
    listRepos,
    listSnapshots,
    getNeighbors,
    explainRelation,
    getTests,
    findConcept,
    reviewHomolog,
    computeSemanticDiff,
    computeContractDiff,
    planChange,
    prepareChange,
    applyPropagation,
    runRetentionPolicy,
    getRetentionStats,
    listStaleTransactions,
    cleanupStaleTransactions,
} from '../services';
import { destroyAllCaches, symbolCache, profileCache, capsuleCache, homologCache as adminHomologCache, queryCache } from '../cache';

// ────────── Safe Error Prefixes (shared with index.ts) ──────────
//
// Error prefixes that are safe to expose to clients (user-facing errors, not internal details).
// Both the bridge safeTool wrapper and handlers import this list to ensure consistency.

export const SAFE_ERROR_PREFIXES = [
    'Transaction not found', 'Invalid', 'Repository not found', 'Snapshot not found',
    'Symbol not found', 'not allowed', 'required', 'must be', 'Path traversal',
    'Rollback aborted', 'Base path not', 'already in progress', 'patches[',
    'Validation snapshot', 'Repository not found for transaction',
    'Repository path is not accessible', 'Failed to validate repository path',
    'Cannot validate transaction', 'Cannot rollback transaction',
    'applyPatch requires', 'Repository base path not configured',
    'Allowed base path violation', 'File too large',
] as const;

// ────────── MCP CallToolResult ──────────
//
// We define a precise type matching what the MCP SDK expects.
// The content array items must use literal 'text' for the type field.

interface TextContent {
    type: 'text';
    text: string;
}

interface CallToolResult {
    content: TextContent[];
    isError?: boolean;
    [key: string]: unknown;
}

// ────────── Shared Helpers ──────────

/** Standard MCP text result */
function textResult(data: unknown): CallToolResult {
    return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    };
}

/** MCP error result (isError: true) */
function errorResult(message: string): CallToolResult {
    return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
        isError: true,
    };
}

/** Resolve repo base path for a transaction from the DB */
async function resolveRepoBasePathForTxn(txnId: string): Promise<string | null> {
    const result = await db.query(
        `SELECT r.base_path FROM change_transactions ct
         JOIN repositories r ON r.repo_id = ct.repo_id
         WHERE ct.txn_id = $1`,
        [txnId],
    );
    return optionalStringField(firstRow(result), 'base_path') ?? null;
}

// ────────── Type-safe arg extractors ──────────
//
// Replace bare `as` casts with runtime-validated extractors.
// Zod in index.ts validates shape, but handlers receive Record<string, unknown>.

function requireString(args: Record<string, unknown>, key: string): string {
    const val = args[key];
    if (typeof val !== 'string' || val.length === 0) {
        throw new Error(`Missing required string parameter: ${key}`);
    }
    return val;
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
    const val = args[key];
    return typeof val === 'string' && val.length > 0 ? val : undefined;
}

function requireInt(args: Record<string, unknown>, key: string, defaultVal: number): number {
    const val = args[key];
    if (val === undefined || val === null) return defaultVal;
    const num = typeof val === 'number' ? val : parseInt(String(val), 10);
    return Number.isFinite(num) ? num : defaultVal;
}

function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
    const val = args[key];
    if (val === undefined || val === null) return undefined;
    const num = typeof val === 'number' ? val : parseFloat(String(val));
    return Number.isFinite(num) ? num : undefined;
}

function optionalBool(args: Record<string, unknown>, key: string): boolean | undefined {
    const val = args[key];
    return typeof val === 'boolean' ? val : undefined;
}

function requireArray<T>(args: Record<string, unknown>, key: string): T[] {
    const val = args[key];
    if (!Array.isArray(val)) {
        throw new Error(`Missing required array parameter: ${key}`);
    }
    return val as T[];
}

function optionalArray<T>(args: Record<string, unknown>, key: string): T[] | undefined {
    const val = args[key];
    return Array.isArray(val) ? val as T[] : undefined;
}

// ────────── UUID validation ──────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUUID(v: unknown): v is string {
    return typeof v === 'string' && UUID_RE.test(v);
}

// ────────── Tool 1: Resolve Symbol ──────────

export async function handleResolveSymbol(args: Record<string, unknown>, log: McpLogger): Promise<CallToolResult> {
    const query = requireString(args, 'query');
    const repo_id = requireString(args, 'repo_id');
    const snapshot_id = optionalString(args, 'snapshot_id');
    const kind_filter = optionalString(args, 'kind_filter');
    const limit = requireInt(args, 'limit', 10);

    if (!isUUID(repo_id)) return errorResult('repo_id is required and must be a valid UUID');
    if (snapshot_id !== undefined && !isUUID(snapshot_id)) return errorResult('snapshot_id must be a valid UUID');

    log.debug('scg_resolve_symbol', { query, repo_id });

    const result = await resolveSymbol(query, repo_id, snapshot_id, kind_filter, Math.min(Math.max(limit, 1), 100));
    return textResult(result);
}

// ────────── Tool 2: Get Symbol Details ──────────

export async function handleGetSymbolDetails(args: Record<string, unknown>, log: McpLogger): Promise<CallToolResult> {
    const symbol_version_id = requireString(args, 'symbol_version_id');
    const view_mode = optionalString(args, 'view_mode') || 'summary';

    if (!isUUID(symbol_version_id)) return errorResult('symbol_version_id is required and must be a valid UUID');
    if (!['code', 'summary', 'signature'].includes(view_mode)) {
        return errorResult('view_mode must be one of: code, summary, signature');
    }

    log.debug('scg_get_symbol_details', { symbol_version_id, view_mode });

    const result = await getSymbolDetails(symbol_version_id, view_mode as 'code' | 'summary' | 'signature');
    return textResult(result);
}

// ────────── Tool 3: Get Symbol Relations ──────────

export async function handleGetSymbolRelations(args: Record<string, unknown>, log: McpLogger): Promise<CallToolResult> {
    const symbol_version_id = requireString(args, 'symbol_version_id');
    const direction = optionalString(args, 'direction') || 'both';

    if (!isUUID(symbol_version_id)) return errorResult('symbol_version_id is required and must be a valid UUID');
    if (!['inbound', 'outbound', 'both'].includes(direction)) {
        return errorResult('direction must be one of: inbound, outbound, both');
    }

    log.debug('scg_get_symbol_relations', { symbol_version_id, direction });

    let relations;
    if (direction === 'inbound') {
        relations = await structuralGraphEngine.getCallers(symbol_version_id);
    } else if (direction === 'outbound') {
        relations = await structuralGraphEngine.getCallees(symbol_version_id);
    } else {
        relations = await structuralGraphEngine.getRelationsForSymbol(symbol_version_id);
    }

    // If no relations found and the symbol is a class, aggregate relations from
    // all methods belonging to this class. Class-level queries returning empty is
    // confusing when the class clearly has methods that call other things.
    if (relations.length === 0) {
        let kindRow: { kind: string; snapshot_id: string } | undefined;
        try {
            const kindResult = await db.query(
                `SELECT s.kind, sv.snapshot_id FROM symbol_versions sv
                 JOIN symbols s ON s.symbol_id = sv.symbol_id
                 WHERE sv.symbol_version_id = $1`,
                [symbol_version_id]
            );
            kindRow = kindResult?.rows?.[0] as { kind: string; snapshot_id: string } | undefined;
        } catch (err) {
            log.debug('scg_get_symbol_relations: symbol kind lookup failed — skipping class aggregation', {
                symbol_version_id,
                error: err instanceof Error ? err.message : String(err),
            });
        }
        if (kindRow && kindRow.kind === 'class') {
            // Find all method symbol_versions that belong to this class
            // by matching stable_key prefix (class_file#ClassName.)
            let memberIds: string[] = [];
            try {
                const memberResult = await db.query(`
                    SELECT sv2.symbol_version_id
                    FROM symbol_versions sv
                    JOIN symbols s ON s.symbol_id = sv.symbol_id
                    JOIN symbols s2 ON s2.stable_key LIKE s.stable_key || '.%'
                    JOIN symbol_versions sv2 ON sv2.symbol_id = s2.symbol_id
                    WHERE sv.symbol_version_id = $1
                    AND sv2.snapshot_id = $2
                `, [symbol_version_id, kindRow.snapshot_id]);
                memberIds = (memberResult?.rows ?? []).map((r: { symbol_version_id: string }) => r.symbol_version_id);
            } catch (err) {
                log.debug('scg_get_symbol_relations: member lookup failed — skipping class aggregation', {
                    symbol_version_id,
                    error: err instanceof Error ? err.message : String(err),
                });
            }
            if (memberIds.length > 0) {
                const placeholders = memberIds.map((_: string, i: number) => `$${i + 1}`).join(',');
                const aggResult = await db.query(`
                    SELECT relation_id, src_symbol_version_id, dst_symbol_version_id,
                           relation_type, strength, source, confidence, provenance
                    FROM structural_relations
                    WHERE src_symbol_version_id IN (${placeholders})
                       OR dst_symbol_version_id IN (${placeholders})
                    ORDER BY confidence DESC
                    LIMIT 200
                `, memberIds);
                relations = aggResult.rows;
            }
        }
    }

    return textResult({ relations, count: relations.length });
}

// ────────── Tool 4: Get Behavioral Profile ──────────

export async function handleGetBehavioralProfile(args: Record<string, unknown>, log: McpLogger): Promise<CallToolResult> {
    const symbol_version_id = requireString(args, 'symbol_version_id');
    if (!isUUID(symbol_version_id)) return errorResult('symbol_version_id is required and must be a valid UUID');

    log.debug('scg_get_behavioral_profile', { symbol_version_id });

    const profile = await behavioralEngine.getProfile(symbol_version_id);
    if (!profile) {
        return errorResult('Behavioral profile not found');
    }
    return textResult({ profile });
}

// ────────── Tool 5: Get Contract Profile ──────────

export async function handleGetContractProfile(args: Record<string, unknown>, log: McpLogger): Promise<CallToolResult> {
    const symbol_version_id = requireString(args, 'symbol_version_id');
    if (!isUUID(symbol_version_id)) return errorResult('symbol_version_id is required and must be a valid UUID');

    log.debug('scg_get_contract_profile', { symbol_version_id });

    const profile = await contractEngine.getProfile(symbol_version_id);
    if (!profile) {
        return errorResult('Contract profile not found');
    }
    return textResult({ profile });
}

// ────────── Tool 6: Get Invariants ──────────

export async function handleGetInvariants(args: Record<string, unknown>, log: McpLogger): Promise<CallToolResult> {
    const symbol_id = requireString(args, 'symbol_id');
    if (!isUUID(symbol_id)) return errorResult('symbol_id is required and must be a valid UUID');

    log.debug('scg_get_invariants', { symbol_id });

    const invariants = await contractEngine.getInvariantsForSymbol(symbol_id);
    return textResult({ invariants, count: invariants.length });
}

// ────────── Tool 7: Get Uncertainty Report ──────────

export async function handleGetUncertainty(args: Record<string, unknown>, log: McpLogger): Promise<CallToolResult> {
    const snapshot_id = requireString(args, 'snapshot_id');
    if (!isUUID(snapshot_id)) return errorResult('snapshot_id is required and must be a valid UUID');

    log.debug('scg_get_uncertainty', { snapshot_id });

    const report = await uncertaintyTracker.getSnapshotUncertainty(snapshot_id);
    return textResult({ report });
}

// ────────── Tool 8: Find Homologs ──────────

export async function handleFindHomologs(args: Record<string, unknown>, log: McpLogger): Promise<CallToolResult> {
    const symbol_version_id = requireString(args, 'symbol_version_id');
    const snapshot_id = requireString(args, 'snapshot_id');
    const rawConf = typeof args.confidence_threshold === 'number' ? args.confidence_threshold
        : typeof args.confidence_threshold === 'string' ? parseFloat(args.confidence_threshold) : NaN;
    const confidence_threshold = Number.isFinite(rawConf) ? Math.min(Math.max(rawConf, 0), 1) : 0.70;

    if (!isUUID(symbol_version_id)) return errorResult('symbol_version_id is required and must be a valid UUID');
    if (!isUUID(snapshot_id)) return errorResult('snapshot_id is required and must be a valid UUID');

    log.debug('scg_find_homologs', { symbol_version_id, snapshot_id, confidence_threshold });

    // Check homologCache (imported at top of file)
    const cacheKey = `hom:${symbol_version_id}:${snapshot_id}:${confidence_threshold}`;
    const cached = homologCache.get(cacheKey);
    if (cached) {
        return textResult(cached);
    }

    const homologs = await homologInferenceEngine.findHomologs(
        symbol_version_id, snapshot_id, confidence_threshold,
    );

    const result = { homologs, count: homologs.length };
    homologCache.set(cacheKey, result);
    return textResult(result);
}

// ────────── Tool 9: Blast Radius ──────────

export async function handleBlastRadius(args: Record<string, unknown>, log: McpLogger): Promise<CallToolResult> {
    const symbol_version_ids = args.symbol_version_ids;
    const snapshot_id = requireString(args, 'snapshot_id');
    const rawDepth = typeof args.depth === 'number' ? args.depth : typeof args.depth === 'string' ? parseInt(args.depth, 10) : NaN;
    const depth = Number.isFinite(rawDepth) ? Math.min(Math.max(rawDepth, 1), 5) : 2;

    if (!Array.isArray(symbol_version_ids) || symbol_version_ids.length === 0) {
        return errorResult('symbol_version_ids is required and must be a non-empty array of UUIDs');
    }
    for (const id of symbol_version_ids) {
        if (!isUUID(id)) return errorResult(`Invalid UUID in symbol_version_ids: ${id}`);
    }
    if (!isUUID(snapshot_id)) return errorResult('snapshot_id is required and must be a valid UUID');

    log.debug('scg_blast_radius', { symbol_version_ids, snapshot_id, depth });

    const validatedIds: string[] = symbol_version_ids as string[];
    const report = await blastRadiusEngine.computeBlastRadius(
        snapshot_id, validatedIds, depth,
    );

    return textResult({ report });
}

// ────────── Tool 10: Compile Context Capsule ──────────

export async function handleCompileContextCapsule(args: Record<string, unknown>, log: McpLogger): Promise<CallToolResult> {
    const symbol_version_id = requireString(args, 'symbol_version_id');
    const snapshot_id = requireString(args, 'snapshot_id');
    const mode = optionalString(args, 'mode') || 'standard';
    const token_budget = typeof args.token_budget === 'number'
        ? Math.min(Math.max(args.token_budget, 100), 100_000)
        : 8000;

    if (!isUUID(symbol_version_id)) return errorResult('symbol_version_id is required and must be a valid UUID');
    if (!isUUID(snapshot_id)) return errorResult('snapshot_id is required and must be a valid UUID');
    if (!['minimal', 'standard', 'strict'].includes(mode)) {
        return errorResult('mode must be one of: minimal, standard, strict');
    }

    log.debug('scg_compile_context_capsule', { symbol_version_id, snapshot_id, mode, token_budget });

    // Resolve repo base path from DB
    const basePathResult = await db.query(
        `SELECT r.base_path FROM repositories r
         JOIN symbols s ON s.repo_id = r.repo_id
         JOIN symbol_versions sv ON sv.symbol_id = s.symbol_id
         WHERE sv.symbol_version_id = $1`,
        [symbol_version_id],
    );
    const repoBasePath = optionalStringField(firstRow(basePathResult), 'base_path');

    const capsule = await capsuleCompiler.compile(
        symbol_version_id, snapshot_id, mode as CapsuleMode, token_budget, repoBasePath,
    );

    return textResult({ capsule });
}

// ────────── Tool 11: Create Change Transaction ──────────

export async function handleCreateChangeTransaction(args: Record<string, unknown>, log: McpLogger): Promise<CallToolResult> {
    const repo_id = requireString(args, 'repo_id');
    const base_snapshot_id = requireString(args, 'base_snapshot_id');
    const created_by = optionalString(args, 'created_by') || 'mcp';
    const target_symbol_version_ids = args.target_symbol_version_ids;
    const task_description = optionalString(args, 'task_description');

    if (!isUUID(repo_id)) return errorResult('repo_id is required and must be a valid UUID');
    if (!isUUID(base_snapshot_id)) return errorResult('base_snapshot_id is required and must be a valid UUID');
    if (!Array.isArray(target_symbol_version_ids) || target_symbol_version_ids.length === 0) {
        return errorResult('target_symbol_version_ids is required and must be a non-empty array of UUIDs');
    }
    for (const id of target_symbol_version_ids) {
        if (!isUUID(id)) return errorResult(`Invalid UUID in target_symbol_version_ids: ${id}`);
    }

    log.debug('scg_create_change_transaction', { repo_id, base_snapshot_id });

    const validatedTargetIds: string[] = target_symbol_version_ids as string[];
    const txnId = await transactionalChangeEngine.createTransaction(
        repo_id, base_snapshot_id, created_by,
        validatedTargetIds,
    );

    if (task_description) {
        await db.query(`
            UPDATE change_transactions
            SET impact_report_ref = $1, updated_at = NOW()
            WHERE txn_id = $2
        `, [JSON.stringify({ task_description }), txnId]);
    }

    return textResult({ txn_id: txnId, state: 'planned' });
}

// ────────── Tool 12: Apply Patch ──────────

export async function handleApplyPatch(args: Record<string, unknown>, log: McpLogger): Promise<CallToolResult> {
    const txn_id = requireString(args, 'txn_id');
    const patches = args.patches;

    if (!isUUID(txn_id)) return errorResult('txn_id is required and must be a valid UUID');
    if (!Array.isArray(patches) || patches.length === 0) {
        return errorResult('patches is required and must be a non-empty array');
    }

    // Validate patch structure and block path traversal
    if (patches.length > 100) {
        return errorResult('patches: must have at most 100 patches');
    }
    // Hoist module import outside loop — dynamic import inside a loop adds async overhead per patch
    const path = await import('path');
    for (let i = 0; i < patches.length; i++) {
        const p = patches[i] as Record<string, unknown>;
        if (!p || typeof p.file_path !== 'string' || typeof p.new_content !== 'string') {
            return errorResult(`patches[${i}] must have file_path (string) and new_content (string)`);
        }
        const filePath = String(p.file_path);
        const newContent = String(p.new_content);
        // Cap individual patch content at 5MB
        if (newContent.length > 5 * 1024 * 1024) {
            return errorResult(`patches[${i}].new_content: exceeds 5MB size limit`);
        }
        // Block URL-encoded characters that could bypass normalization
        if (/%[0-9a-fA-F]{2}/.test(filePath)) {
            return errorResult(`patches[${i}].file_path: URL-encoded characters not allowed`);
        }
        // Block null bytes
        if (filePath.includes('\0')) {
            return errorResult(`patches[${i}].file_path: null bytes not allowed`);
        }
        // Reject backslashes (Windows paths)
        if (filePath.includes('\\')) {
            return errorResult(`patches[${i}].file_path: backslashes not allowed`);
        }
        // Normalize and reject traversal / absolute paths
        const normalized = path.normalize(filePath);
        if (normalized.startsWith('..') || path.isAbsolute(normalized)) {
            return errorResult(`patches[${i}].file_path: path traversal or absolute path not allowed`);
        }
    }

    log.debug('scg_apply_patch', { txn_id, patch_count: patches.length });

    const repoBasePath = await resolveRepoBasePathForTxn(txn_id);
    if (!repoBasePath) {
        return errorResult('Repository base path not configured for this transaction');
    }

    await transactionalChangeEngine.applyPatch(txn_id, patches, repoBasePath);
    return textResult({ txn_id, state: 'patched' });
}

// ────────── Tool 13: Validate Change ──────────

export async function handleValidateChange(args: Record<string, unknown>, log: McpLogger): Promise<CallToolResult> {
    const txn_id = requireString(args, 'txn_id');
    const mode = optionalString(args, 'mode') || 'standard';

    if (!isUUID(txn_id)) return errorResult('txn_id is required and must be a valid UUID');
    if (!['quick', 'standard', 'strict'].includes(mode)) {
        return errorResult('mode must be one of: quick, standard, strict');
    }

    log.debug('scg_validate_change', { txn_id, mode });

    const repoBasePath = await resolveRepoBasePathForTxn(txn_id);
    if (!repoBasePath) {
        return errorResult('Repository base path not configured for this transaction');
    }

    const report = await transactionalChangeEngine.validate(txn_id, repoBasePath, mode as ValidationMode);
    return textResult({ report });
}

// ────────── Tool 14: Commit Change ──────────

export async function handleCommitChange(args: Record<string, unknown>, log: McpLogger): Promise<CallToolResult> {
    const txn_id = requireString(args, 'txn_id');
    if (!isUUID(txn_id)) return errorResult('txn_id is required and must be a valid UUID');

    log.debug('scg_commit_change', { txn_id });

    await transactionalChangeEngine.commit(txn_id);
    return textResult({ txn_id, state: 'committed' });
}

// ────────── Tool 15: Rollback Change ──────────

export async function handleRollbackChange(args: Record<string, unknown>, log: McpLogger): Promise<CallToolResult> {
    const txn_id = requireString(args, 'txn_id');
    if (!isUUID(txn_id)) return errorResult('txn_id is required and must be a valid UUID');

    log.debug('scg_rollback_change', { txn_id });

    await transactionalChangeEngine.rollback(txn_id);
    return textResult({ txn_id, state: 'rolled_back' });
}

// ────────── Tool 16: Propagation Proposals ──────────

export async function handlePropagationProposals(args: Record<string, unknown>, log: McpLogger): Promise<CallToolResult> {
    const txn_id = requireString(args, 'txn_id');
    const snapshot_id = requireString(args, 'snapshot_id');

    if (!isUUID(txn_id)) return errorResult('txn_id is required and must be a valid UUID');
    if (!isUUID(snapshot_id)) return errorResult('snapshot_id is required and must be a valid UUID');

    log.debug('scg_propagation_proposals', { txn_id, snapshot_id });

    const proposals = await transactionalChangeEngine.computePropagationProposals(txn_id, snapshot_id);
    return textResult({ proposals, count: proposals.length });
}

// ────────── Tool 17: Get Transaction ──────────

export async function handleGetTransaction(args: Record<string, unknown>, log: McpLogger): Promise<CallToolResult> {
    const txn_id = requireString(args, 'txn_id');
    if (!isUUID(txn_id)) return errorResult('txn_id is required and must be a valid UUID');

    log.debug('scg_get_transaction', { txn_id });

    const txn = await transactionalChangeEngine.getTransaction(txn_id);
    if (!txn) {
        return errorResult('Transaction not found');
    }
    return textResult({ transaction: txn });
}

// ────────── MCP-Only Tool: Register Repository ──────────

export async function handleRegisterRepo(args: Record<string, unknown>, log: McpLogger): Promise<CallToolResult> {
    const repo_name = requireString(args, 'repo_name');
    const repo_path = requireString(args, 'repo_path');
    const default_branch = typeof args.default_branch === 'string' && args.default_branch.trim()
        ? args.default_branch.trim()
        : 'main';
    const visibility = args.visibility === 'public' ? 'public' : 'private';

    let resolvedPath: string;
    try {
        resolvedPath = await ensureAllowedRepoPath(repo_path, {
            fallbackBasePaths: [process.cwd()],
            log,
        });
    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (msg.includes('ENOENT') || msg.includes('EACCES') || msg.includes('not within allowed')) {
            return errorResult('Repository path is not accessible or not within allowed base paths');
        }
        return errorResult('Failed to validate repository path');
    }

    log.debug('scg_register_repo', { repo_name, repo_path: resolvedPath, visibility });

    const repo_id = await coreDataService.createRepository({
        name: repo_name,
        default_branch,
        visibility,
        language_set: [],
        base_path: resolvedPath,
    });

    return textResult({ repo_id, registered_path: resolvedPath });
}

// ────────── Tool 18: Ingest Repository ──────────

export async function handleIngestRepo(args: Record<string, unknown>, log: McpLogger): Promise<CallToolResult> {
    const repo_id = optionalString(args, 'repo_id');
    const repo_path = optionalString(args, 'repo_path');
    const repo_name = optionalString(args, 'repo_name');
    const commit_sha = typeof args.commit_sha === 'string' && args.commit_sha.trim()
        ? args.commit_sha.trim()
        : undefined;
    const requestedBranch = typeof args.branch === 'string' && args.branch.trim()
        ? args.branch.trim()
        : undefined;

    if (repo_id && repo_path) {
        return errorResult('Provide either repo_id or repo_path, not both');
    }
    if (!repo_id && !repo_path) {
        return errorResult('repo_id or repo_path is required');
    }
    if (repo_id && !isUUID(repo_id)) {
        return errorResult('repo_id must be a valid UUID');
    }

    let resolvedRepoId: string;
    let resolvedRepoPath: string;
    let resolvedRepoName: string;
    let resolvedBranch = requestedBranch || 'main';
    let autoRegistered = false;

    if (repo_id) {
        const repo = await coreDataService.getRepository(repo_id);
        if (!repo) {
            return errorResult('Repository not found. Register it first via scg_register_repo');
        }

        const repoBasePath = typeof repo['base_path'] === 'string' ? repo['base_path'] : undefined;
        if (!repoBasePath) {
            return errorResult('Repository base path not configured. Register it first via scg_register_repo');
        }

        resolvedRepoId = repo_id;
        resolvedRepoPath = repoBasePath;
        resolvedRepoName = typeof repo['name'] === 'string' ? repo['name'] : path.basename(repoBasePath);
        if (!requestedBranch && typeof repo['default_branch'] === 'string' && repo['default_branch']) {
            resolvedBranch = repo['default_branch'];
        }
    } else {
        let allowedRepoPath: string;
        try {
            allowedRepoPath = await ensureAllowedRepoPath(repo_path!, {
                fallbackBasePaths: [process.cwd()],
                log,
            });
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            if (msg.includes('ENOENT') || msg.includes('EACCES') || msg.includes('not within allowed')) {
                return errorResult('Repository path is not accessible or not within allowed base paths');
            }
            return errorResult('Failed to validate repository path');
        }

        resolvedRepoPath = allowedRepoPath;
        resolvedRepoName = repo_name?.trim() || path.basename(allowedRepoPath);
        resolvedRepoId = await coreDataService.createRepository({
            name: resolvedRepoName,
            default_branch: resolvedBranch,
            visibility: 'private',
            language_set: [],
            base_path: allowedRepoPath,
        });
        autoRegistered = true;
    }

    const identity = await deriveWorkspaceSnapshotIdentity(resolvedRepoPath, {
        commitSha: commit_sha,
        branch: resolvedBranch,
    });

    log.debug('scg_ingest_repo', {
        repo_id: resolvedRepoId,
        repo_path: resolvedRepoPath,
        commit_sha: identity.commit_sha,
        commit_source: identity.source,
        branch: identity.branch,
        auto_registered: autoRegistered,
    });

    const result = await ingestor.ingestRepo(
        resolvedRepoPath,
        resolvedRepoName,
        identity.commit_sha,
        identity.branch,
    );
    return textResult({
        result: {
            ...result,
            repo_id: resolvedRepoId,
            commit_sha: identity.commit_sha,
            commit_source: identity.source,
            branch: identity.branch,
            auto_registered: autoRegistered,
            fingerprint_truncated: identity.truncated,
            fingerprint_files_considered: identity.files_considered,
        },
    });
}

// ────────── Tool 19: List Repositories ──────────

export async function handleListRepos(args: Record<string, unknown>, log: McpLogger): Promise<CallToolResult> {
    const limit = typeof args.limit === 'number' ? Math.min(Math.max(args.limit, 1), 100) : 20;
    const offset = typeof args.offset === 'number' ? Math.min(Math.max(args.offset, 0), 100_000) : 0;

    log.debug('scg_list_repos', { limit, offset });

    const result = await listRepos(limit, offset);
    return textResult(result);
}

// ────────── Tool 20: List Snapshots ──────────

export async function handleListSnapshots(args: Record<string, unknown>, log: McpLogger): Promise<CallToolResult> {
    const repo_id = requireString(args, 'repo_id');
    const limit = typeof args.limit === 'number' ? Math.min(Math.max(args.limit, 1), 100) : 20;
    const offset = typeof args.offset === 'number' ? Math.min(Math.max(args.offset, 0), 100_000) : 0;

    if (!isUUID(repo_id)) return errorResult('repo_id is required and must be a valid UUID');

    log.debug('scg_list_snapshots', { repo_id, limit, offset });

    const result = await listSnapshots(repo_id, limit, offset);
    return textResult(result);
}

// ────────── Tool 21: Snapshot Stats ──────────

export async function handleSnapshotStats(args: Record<string, unknown>, log: McpLogger): Promise<CallToolResult> {
    const snapshot_id = requireString(args, 'snapshot_id');
    if (!isUUID(snapshot_id)) return errorResult('snapshot_id is required and must be a valid UUID');

    log.debug('scg_snapshot_stats', { snapshot_id });

    // BUG-001 fix: Check if the snapshot actually exists and has data.
    // Ghost snapshots (orphaned after re-ingestion) return empty results
    // instead of an error, which silently misleads clients.
    const snapshotCheck = await db.query(
        `SELECT snapshot_id, index_status FROM snapshots WHERE snapshot_id = $1`,
        [snapshot_id],
    );
    if (snapshotCheck.rows.length === 0) {
        return errorResult(`Snapshot not found: ${snapshot_id}`);
    }

    const [fileCount, symbolCount, relationCount, uncertaintyReport] = await Promise.all([
        db.query(`SELECT COUNT(*) as cnt FROM files WHERE snapshot_id = $1`, [snapshot_id]),
        db.query(`SELECT COUNT(*) as cnt FROM symbol_versions WHERE snapshot_id = $1`, [snapshot_id]),
        db.query(`
            SELECT COUNT(*) as cnt FROM structural_relations sr
            JOIN symbol_versions sv ON sv.symbol_version_id = sr.src_symbol_version_id
            WHERE sv.snapshot_id = $1
        `, [snapshot_id]),
        uncertaintyTracker.getSnapshotUncertainty(snapshot_id),
    ]);

    const files = parseCountField(firstRow(fileCount));
    const symbols = parseCountField(firstRow(symbolCount));

    // If a snapshot exists but has zero files and zero symbols, it's orphaned
    if (files === 0 && symbols === 0) {
        const status = optionalStringField(firstRow(snapshotCheck), 'index_status') ?? '';
        if (status === 'complete' || status === 'partial') {
            return errorResult(
                `Snapshot ${snapshot_id} is orphaned — it was superseded by a newer ingestion. ` +
                `Re-ingest the repository to get a fresh snapshot.`
            );
        }
    }

    return textResult({
        snapshot_id,
        files,
        symbols,
        relations: parseCountField(firstRow(relationCount)),
        uncertainty: uncertaintyReport,
    });
}

// ────────── Tool 22: Persist Homologs ──────────

export async function handlePersistHomologs(args: Record<string, unknown>, log: McpLogger): Promise<CallToolResult> {
    const source_symbol_version_id = requireString(args, 'source_symbol_version_id');
    const snapshot_id = requireString(args, 'snapshot_id');
    const rawConf = typeof args.confidence_threshold === 'number' ? args.confidence_threshold
        : typeof args.confidence_threshold === 'string' ? parseFloat(args.confidence_threshold) : NaN;
    const confidence_threshold = Number.isFinite(rawConf) ? Math.min(Math.max(rawConf, 0), 1) : 0.70;

    if (!isUUID(source_symbol_version_id)) return errorResult('source_symbol_version_id is required and must be a valid UUID');
    if (!isUUID(snapshot_id)) return errorResult('snapshot_id is required and must be a valid UUID');

    log.debug('scg_persist_homologs', { source_symbol_version_id, snapshot_id, confidence_threshold });

    const homologs = await homologInferenceEngine.findHomologs(
        source_symbol_version_id, snapshot_id, confidence_threshold,
    );

    const persisted = await homologInferenceEngine.persistHomologs(
        source_symbol_version_id, homologs, snapshot_id,
    );

    return textResult({ homologs_found: homologs.length, persisted });
}

// ────────── Tool 23: Read Source Code ──────────
//
// Serves symbol source directly from the database (body_source column).
// No disk I/O required — works in Docker, remote deployments, and
// survives repo path changes. Falls back to disk for pre-migration data.
// Supports batch queries (multiple symbol_version_ids in one call).

export async function handleReadSource(args: Record<string, unknown>, log: McpLogger): Promise<CallToolResult> {
    const repo_id = requireString(args, 'repo_id');
    const symbol_version_id = optionalString(args, 'symbol_version_id');
    const symbol_version_ids = optionalArray<string>(args, 'symbol_version_ids');
    const file_path = optionalString(args, 'file_path');
    const start_line = optionalNumber(args, 'start_line');
    const end_line = optionalNumber(args, 'end_line');
    const context_lines = typeof args.context_lines === 'number' ? Math.min(Math.max(args.context_lines, 0), 50) : 0;

    if (!isUUID(repo_id)) return errorResult('repo_id is required and must be a valid UUID');

    // Batch mode: multiple symbol_version_ids (capped at 20 to prevent massive IN clauses)
    const MAX_BATCH_IDS = 20;
    const ids: string[] = [];
    if (symbol_version_ids && Array.isArray(symbol_version_ids)) {
        for (const id of symbol_version_ids) {
            if (isUUID(id)) ids.push(id);
            if (ids.length >= MAX_BATCH_IDS) break;
        }
    } else if (symbol_version_id && isUUID(symbol_version_id)) {
        ids.push(symbol_version_id);
    }

    if (ids.length === 0 && !file_path) {
        return errorResult('Either symbol_version_id, symbol_version_ids, or file_path is required');
    }

    log.debug('scg_read_source', { repo_id, ids: ids.length, file_path });

    // Symbol-scoped serving (batch)
    if (ids.length > 0) {
        const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
        const svResult = await db.query(`
            SELECT sv.symbol_version_id, sv.range_start_line, sv.range_end_line,
                   sv.signature, sv.summary, sv.body_source,
                   s.canonical_name, s.kind, s.stable_key,
                   f.path as file_path
            FROM symbol_versions sv
            JOIN symbols s ON s.symbol_id = sv.symbol_id
            JOIN files f ON f.file_id = sv.file_id
            WHERE sv.symbol_version_id IN (${placeholders})
        `, ids);

        if (svResult.rows.length === 0) return errorResult('No symbol versions found');

        const symbols = (svResult.rows as {
            symbol_version_id: string;
            range_start_line: number;
            range_end_line: number;
            signature: string;
            summary: string;
            body_source: string | null;
            canonical_name: string;
            kind: string;
            stable_key: string;
            file_path: string;
        }[]).map(sv => {
            // Nullish coalescing: empty string is a valid body
            const source = sv.body_source ?? null;

            return {
                symbol_version_id: sv.symbol_version_id,
                canonical_name: sv.canonical_name,
                kind: sv.kind,
                signature: sv.signature,
                summary: sv.summary,
                file_path: sv.file_path,
                start_line: sv.range_start_line,
                end_line: sv.range_end_line,
                source: source || '[source unavailable]',
                token_estimate: source ? Math.ceil(source.length / 4) : 0,
            };
        });

        return textResult({ symbols, count: symbols.length });
    }

    // File-path mode (unchanged — reads from disk)
    const repo = await coreDataService.getRepository(repo_id);
    if (!repo) return errorResult('Repository not found');
    const basePath = typeof repo.base_path === 'string' ? repo.base_path : '';
    if (!basePath) return errorResult('Repository base path not configured');

    const fs = await import('fs');
    const fsp = fs.promises;

    try {
        const safePath = resolvePathWithinBase(basePath, file_path!);
        const resolvedPath = safePath.realPath;
        const content = await fsp.readFile(resolvedPath, 'utf-8');
        const lines = content.split('\n');

        let outputLines: string[];
        if (start_line !== undefined && end_line !== undefined) {
            // Apply context_lines to expand the range
            const s = Math.max(1, start_line - context_lines);
            const e = Math.min(lines.length, end_line + context_lines);
            outputLines = lines.slice(s - 1, e).map((line, i) => `${s + i}: ${line}`);
        } else {
            const cap = Math.min(lines.length, 500);
            outputLines = lines.slice(0, cap).map((line, i) => `${i + 1}: ${line}`);
            if (lines.length > 500) {
                outputLines.push(`... (${lines.length - 500} more lines truncated)`);
            }
        }

        return textResult({
            file_path,
            total_lines: lines.length,
            source: outputLines.join('\n'),
        });
    } catch (error) {
        log.warn('scg_read_source failed', {
            repo_id,
            file_path,
            error: error instanceof Error ? error.message : String(error),
        });
        return errorResult('File not readable');
    }
}


// ────────── Tool 24: Search Code ──────────
//
// Grep/search across indexed files in a repository. Returns matching
// lines with context. This enables deep audit through MCP without
// needing to read every file manually.

export async function handleSearchCode(args: Record<string, unknown>, log: McpLogger): Promise<CallToolResult> {
    const repo_id = requireString(args, 'repo_id');
    const pattern = requireString(args, 'pattern');
    const file_pattern = optionalString(args, 'file_pattern');
    const max_results = typeof args.max_results === 'number' ? Math.min(args.max_results, 100) : 30;
    const context_lines_count = typeof args.context_lines === 'number' ? Math.min(args.context_lines, 5) : 2;

    if (!isUUID(repo_id)) return errorResult('repo_id is required and must be a valid UUID');
    if (!pattern || typeof pattern !== 'string') return errorResult('pattern is required');
    if (pattern.length > 500) return errorResult('pattern too long (max 500 chars)');

    log.debug('scg_search_code', { repo_id, pattern, file_pattern });

    const result = await searchCode(repo_id, pattern, {
        filePattern: file_pattern,
        maxResults: max_results,
        contextLines: context_lines_count,
    }, log);
    return textResult(result);
}

// ────────── Tool 25: Codebase Overview ──────────
//
// High-level architecture summary with risk assessment. Answers:
// "What does this codebase look like? Where are the risks?"
// This is the tool that turns ContextZero from an indexer into an auditor.

export async function handleCodebaseOverview(args: Record<string, unknown>, log: McpLogger): Promise<CallToolResult> {
    const repo_id = requireString(args, 'repo_id');
    const snapshot_id = requireString(args, 'snapshot_id');

    if (!isUUID(repo_id)) return errorResult('repo_id is required and must be a valid UUID');
    if (!isUUID(snapshot_id)) return errorResult('snapshot_id is required and must be a valid UUID');

    log.debug('scg_codebase_overview', { repo_id, snapshot_id });

    const overview = await getCodebaseOverview(snapshot_id);
    return textResult(overview);
}

// ────────── MCP-Only Tool: Native Codebase Overview ──────────

export async function handleNativeCodebaseOverview(args: Record<string, unknown>, log: McpLogger): Promise<CallToolResult> {
    const repo_path = requireString(args, 'repo_path');
    const max_files = optionalNumber(args, 'max_files');

    if (!repo_path || typeof repo_path !== 'string') {
        return errorResult('repo_path is required and must be a string');
    }

    let resolvedPath: string;
    try {
        resolvedPath = await ensureAllowedRepoPath(repo_path, {
            fallbackBasePaths: [process.cwd()],
            log,
        });
    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (msg.includes('ENOENT') || msg.includes('EACCES') || msg.includes('not within allowed')) {
            return errorResult('Repository path is not accessible or not within allowed base paths');
        }
        return errorResult('Failed to validate repository path');
    }

    log.debug('scg_native_codebase_overview', { repo_path: resolvedPath, max_files });

    const overview = await buildNativeCodebaseOverview(resolvedPath, { maxFiles: max_files });
    return textResult({
        repo_path: resolvedPath,
        mode: 'native_preindex',
        overview,
    });
}

// ────────── MCP-Only Tool: Native Symbol Search ──────────

export async function handleNativeSymbolSearch(args: Record<string, unknown>, log: McpLogger): Promise<CallToolResult> {
    const repo_path = requireString(args, 'repo_path');
    const query = requireString(args, 'query');
    const kind_filter = optionalString(args, 'kind_filter');
    const language = optionalString(args, 'language') as
        | 'typescript' | 'javascript' | 'python' | 'cpp' | 'go' | 'rust' | 'java' | 'csharp' | 'ruby'
        | undefined;
    const max_files = optionalNumber(args, 'max_files');
    const max_results = optionalNumber(args, 'max_results');

    if (!repo_path || typeof repo_path !== 'string') {
        return errorResult('repo_path is required and must be a string');
    }
    if (!query || typeof query !== 'string') {
        return errorResult('query is required and must be a string');
    }

    let resolvedPath: string;
    try {
        resolvedPath = await ensureAllowedRepoPath(repo_path, {
            fallbackBasePaths: [process.cwd()],
            log,
        });
    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (msg.includes('ENOENT') || msg.includes('EACCES') || msg.includes('not within allowed')) {
            return errorResult('Repository path is not accessible or not within allowed base paths');
        }
        return errorResult('Failed to validate repository path');
    }

    log.debug('scg_native_symbol_search', {
        repo_path: resolvedPath,
        query,
        kind_filter,
        language,
        max_files,
        max_results,
    });

    const result = await searchWorkspaceSymbols(resolvedPath, query, {
        kindFilter: kind_filter,
        language,
        maxFiles: max_files,
        maxResults: max_results,
    });
    return textResult({
        repo_path: resolvedPath,
        mode: 'native_preindex',
        ...result,
    });
}

// ────────── MCP-Only Tool: Native Search Code ──────────

export async function handleNativeSearchCode(args: Record<string, unknown>, log: McpLogger): Promise<CallToolResult> {
    const repo_path = requireString(args, 'repo_path');
    const pattern = requireString(args, 'pattern');
    const file_pattern = optionalString(args, 'file_pattern');
    const max_files = optionalNumber(args, 'max_files');
    const max_results = optionalNumber(args, 'max_results');
    const context_lines = optionalNumber(args, 'context_lines');

    if (!repo_path || typeof repo_path !== 'string') {
        return errorResult('repo_path is required and must be a string');
    }
    if (!pattern || typeof pattern !== 'string') {
        return errorResult('pattern is required');
    }
    if (pattern.length > 500) {
        return errorResult('pattern too long (max 500 chars)');
    }

    let resolvedPath: string;
    try {
        resolvedPath = await ensureAllowedRepoPath(repo_path, {
            fallbackBasePaths: [process.cwd()],
            log,
        });
    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (msg.includes('ENOENT') || msg.includes('EACCES') || msg.includes('not within allowed')) {
            return errorResult('Repository path is not accessible or not within allowed base paths');
        }
        return errorResult('Failed to validate repository path');
    }

    log.debug('scg_native_search_code', {
        repo_path: resolvedPath,
        pattern,
        file_pattern,
        max_files,
        max_results,
        context_lines,
    });

    const result = await searchWorkspaceCode(resolvedPath, pattern, {
        filePattern: file_pattern,
        maxFiles: max_files,
        maxResults: max_results,
        contextLines: context_lines,
        log,
    });
    return textResult({
        repo_path: resolvedPath,
        mode: 'native_preindex',
        ...result,
    });
}

// ────────── Tool 26: Semantic Search ──────────
//
// Body-content semantic search using TF-IDF similarity.
// Unlike resolve_symbol (name-only pg_trgm), this searches INSIDE
// function bodies. "where does the code accumulate V×V matrices"
// returns relevant symbols ranked by body-view cosine similarity.

export async function handleSemanticSearch(args: Record<string, unknown>, log: McpLogger): Promise<CallToolResult> {
    const query = requireString(args, 'query');
    const snapshot_id = requireString(args, 'snapshot_id');
    const limit = typeof args.limit === 'number' ? Math.min(Math.max(args.limit, 1), 50) : 15;
    const include_source = optionalBool(args, 'include_source') !== false; // default true

    if (!query || typeof query !== 'string') return errorResult('query is required');
    if (query.length > 2000) return errorResult('query too long (max 2000 chars)');
    if (!isUUID(snapshot_id)) return errorResult('snapshot_id is required and must be a valid UUID');

    log.debug('scg_semantic_search', { query, snapshot_id, limit });

    // Delegate to SemanticEngine.searchByQuery — uses LSH candidate narrowing
    // with batched fallback. Never loads more than ~1000 vectors at a time.
    const { semanticEngine } = await import('../semantic-engine');
    const topResults = await semanticEngine.searchByQuery(query, snapshot_id, limit);

    if (topResults.length === 0) {
        return textResult({ matches: [], total: 0, note: 'No semantic matches found' });
    }

    // Load symbol metadata (and optionally source) for top results
    const topIds = topResults.map(r => r.svId);
    const placeholders = topIds.map((_, i) => `$${i + 1}`).join(',');
    const metaResult = await db.query(`
        SELECT sv.symbol_version_id, s.canonical_name, s.kind, s.stable_key,
               sv.signature, sv.summary, sv.body_source,
               f.path as file_path, sv.range_start_line, sv.range_end_line
        FROM symbol_versions sv
        JOIN symbols s ON s.symbol_id = sv.symbol_id
        JOIN files f ON f.file_id = sv.file_id
        WHERE sv.symbol_version_id IN (${placeholders})
    `, topIds);

    const metaMap = new Map<string, Record<string, unknown>>();
    for (const row of metaResult.rows) {
        const svId = typeof row.symbol_version_id === 'string' ? row.symbol_version_id : String(row.symbol_version_id);
        metaMap.set(svId, row as Record<string, unknown>);
    }

    const matches = topResults.map(r => {
        const meta = metaMap.get(r.svId);
        if (!meta) return null;

        let adjustedSimilarity = r.similarity;
        const kind = meta.kind as string;
        const bodyLen = meta.body_source ? String(meta.body_source).length : 0;
        const startLine = meta.range_start_line as number | undefined;
        const endLine = meta.range_end_line as number | undefined;
        const lineSpan = (startLine && endLine) ? endLine - startLine + 1 : 0;

        // Boost function/method/class results — they represent meaningful code units
        if (kind === 'function' || kind === 'method' || kind === 'class') {
            adjustedSimilarity *= 1.15;
        }
        // Demote single-line variable/constant declarations — they are noise
        // in semantic search (matching on individual word tokens)
        if ((kind === 'variable' || kind === 'constant') && lineSpan <= 2 && bodyLen < 120) {
            adjustedSimilarity *= 0.3;
        }

        return {
            symbol_version_id: r.svId,
            canonical_name: meta.canonical_name,
            kind: meta.kind,
            file_path: meta.file_path,
            start_line: meta.range_start_line,
            end_line: meta.range_end_line,
            signature: meta.signature,
            similarity: parseFloat(Math.min(1.0, adjustedSimilarity).toFixed(4)),
            ...(include_source && meta.body_source ? {
                source: meta.body_source,
                token_estimate: Math.ceil(String(meta.body_source).length / 4),
            } : {}),
        };
    }).filter(Boolean);

    // Re-sort by adjusted similarity
    matches.sort((a: { similarity: number } | null, b: { similarity: number } | null) =>
        (b?.similarity ?? 0) - (a?.similarity ?? 0));

    return textResult({
        query,
        total: matches.length,
        matches,
    });
}

// ────────── Tool 27: Smart Context ──────────
//
// Task-oriented context bundles. Instead of the consumer making 8+ calls
// to gather context for a change task, this tool:
//   1. Takes a task description + target symbols + token budget
//   2. Computes blast radius for targets
//   3. Ranks all impacted symbols by relevance to the task
//   4. Bundles target source + impacted source + tests + homologs
//   5. Returns a single response with everything needed, token-budgeted
//
// This is the "give me everything I need for this change" tool.

export async function handleSmartContext(args: Record<string, unknown>, log: McpLogger): Promise<CallToolResult> {
    const task_description = requireString(args, 'task_description');
    const target_symbol_version_ids = requireArray<string>(args, 'target_symbol_version_ids');
    const snapshot_id = requireString(args, 'snapshot_id');
    const token_budget = typeof args.token_budget === 'number' ? Math.max(100, Math.min(args.token_budget, 100_000)) : 20_000;
    const depth = typeof args.depth === 'number' ? Math.min(Math.max(args.depth, 1), 5) : 2;

    if (!Array.isArray(target_symbol_version_ids) || target_symbol_version_ids.length === 0) {
        return errorResult('target_symbol_version_ids is required (non-empty array of UUIDs)');
    }
    if (!isUUID(snapshot_id)) return errorResult('snapshot_id is required and must be a valid UUID');
    for (const id of target_symbol_version_ids) {
        if (!isUUID(id)) return errorResult(`Invalid UUID in target_symbol_version_ids: ${id}`);
    }

    log.debug('scg_smart_context', {
        task: task_description.slice(0, 100),
        targets: target_symbol_version_ids.length,
        budget: token_budget,
    });

    const result = await compileSmartContext(task_description, target_symbol_version_ids, snapshot_id, {
        tokenBudget: token_budget,
        depth,
    });
    return textResult(result);
}


// ════════════════════════════════════════════════════════════════════════════
// V2 HANDLERS — Dispatch, Lineage, Effects, Families, Temporal, Runtime
// ════════════════════════════════════════════════════════════════════════════

/**
 * Get dispatch edges for a symbol — resolved method chains.
 */
export async function handleGetDispatchEdges(args: Record<string, unknown>, _log: McpLogger): Promise<CallToolResult> {
    const symbol_version_id = requireString(args, 'symbol_version_id');
    if (!isUUID(symbol_version_id)) return errorResult('symbol_version_id required');

    const { dispatchResolver } = await import('../analysis-engine/dispatch-resolver');
    const edges = await dispatchResolver.getDispatchEdges(symbol_version_id);

    return textResult({
        symbol_version_id,
        dispatch_edges: edges,
        total: edges.length,
    });
}

/**
 * Get class hierarchy (MRO) for a class symbol.
 */
export async function handleGetClassHierarchy(args: Record<string, unknown>, _log: McpLogger): Promise<CallToolResult> {
    const snapshot_id = requireString(args, 'snapshot_id');
    const symbol_version_id = requireString(args, 'symbol_version_id');
    if (!isUUID(snapshot_id) || !isUUID(symbol_version_id)) return errorResult('snapshot_id and symbol_version_id required');

    const { dispatchResolver } = await import('../analysis-engine/dispatch-resolver');
    const mro = await dispatchResolver.getMRO(snapshot_id, symbol_version_id);

    return textResult({
        symbol_version_id,
        method_resolution_order: mro,
    });
}

/**
 * Get symbol lineage history across snapshots.
 */
export async function handleGetSymbolLineage(args: Record<string, unknown>, _log: McpLogger): Promise<CallToolResult> {
    const symbol_id = requireString(args, 'symbol_id');
    if (!isUUID(symbol_id)) return errorResult('symbol_id required');

    const { symbolLineageEngine } = await import('../analysis-engine/symbol-lineage');
    const history = await symbolLineageEngine.getLineageHistory(symbol_id);

    return textResult({
        symbol_id,
        lineage_history: history,
    });
}

/**
 * Get effect signature for a symbol.
 */
export async function handleGetEffectSignature(args: Record<string, unknown>, _log: McpLogger): Promise<CallToolResult> {
    const symbol_version_id = requireString(args, 'symbol_version_id');
    if (!isUUID(symbol_version_id)) return errorResult('symbol_version_id required');

    const { effectEngine } = await import('../analysis-engine/effect-engine');
    const signature = await effectEngine.getEffectSignature(symbol_version_id);

    if (!signature) {
        return textResult({ symbol_version_id, effect_signature: null, message: 'No effect signature found' });
    }

    return textResult({
        symbol_version_id,
        effects: signature.effects,
        effect_class: signature.effect_class,
        reads_resources: signature.reads_resources,
        writes_resources: signature.writes_resources,
        emits_events: signature.emits_events,
        calls_external: signature.calls_external,
        mutates_state: signature.mutates_state,
        requires_auth: signature.requires_auth,
        throws_errors: signature.throws_errors,
        confidence: signature.confidence,
    });
}

/**
 * Diff effects between two symbol versions (before/after change).
 */
export async function handleDiffEffects(args: Record<string, unknown>, _log: McpLogger): Promise<CallToolResult> {
    const before_sv_id = requireString(args, 'before_symbol_version_id');
    const after_sv_id = requireString(args, 'after_symbol_version_id');
    if (!isUUID(before_sv_id) || !isUUID(after_sv_id)) return errorResult('before_symbol_version_id and after_symbol_version_id required');

    const { effectEngine } = await import('../analysis-engine/effect-engine');
    const diff = await effectEngine.diffEffects(before_sv_id, after_sv_id);

    return textResult({
        before_symbol_version_id: before_sv_id,
        after_symbol_version_id: after_sv_id,
        diff,
    });
}

/**
 * Get concept family for a symbol.
 */
export async function handleGetConceptFamily(args: Record<string, unknown>, _log: McpLogger): Promise<CallToolResult> {
    const symbol_version_id = requireString(args, 'symbol_version_id');
    if (!isUUID(symbol_version_id)) return errorResult('symbol_version_id required');

    const { conceptFamilyEngine } = await import('../analysis-engine/concept-families');
    const family = await conceptFamilyEngine.getFamilyForSymbol(symbol_version_id);

    if (!family) {
        return textResult({ symbol_version_id, family: null, message: 'Symbol does not belong to a concept family' });
    }

    return textResult({
        symbol_version_id,
        family,
    });
}

/**
 * List all concept families in a snapshot.
 */
export async function handleListConceptFamilies(args: Record<string, unknown>, _log: McpLogger): Promise<CallToolResult> {
    const snapshot_id = requireString(args, 'snapshot_id');
    if (!isUUID(snapshot_id)) return errorResult('snapshot_id required');

    const { conceptFamilyEngine } = await import('../analysis-engine/concept-families');
    const families = await conceptFamilyEngine.getFamilies(snapshot_id);

    return textResult({
        snapshot_id,
        families,
        total: families.length,
    });
}

/**
 * Get temporal risk score for a symbol.
 */
export async function handleGetTemporalRisk(args: Record<string, unknown>, _log: McpLogger): Promise<CallToolResult> {
    const symbol_id = requireString(args, 'symbol_id');
    const snapshot_id = requireString(args, 'snapshot_id');
    if (!isUUID(symbol_id) || !isUUID(snapshot_id)) return errorResult('symbol_id and snapshot_id required');

    const { temporalEngine } = await import('../analysis-engine/temporal-engine');
    const risk = await temporalEngine.getRiskScore(symbol_id, snapshot_id);

    if (!risk) {
        return textResult({ symbol_id, risk: null, message: 'No temporal risk data available' });
    }

    return textResult({
        symbol_id,
        snapshot_id,
        risk,
    });
}

/**
 * Get co-change partners for a symbol.
 */
export async function handleGetCoChangePartners(args: Record<string, unknown>, _log: McpLogger): Promise<CallToolResult> {
    const symbol_id = requireString(args, 'symbol_id');
    const repo_id = requireString(args, 'repo_id');
    const rawJaccard = typeof args['min_jaccard'] === 'number' ? args['min_jaccard'] : 0.3;
    const min_jaccard = Math.max(0, Math.min(1, Number.isFinite(rawJaccard) ? rawJaccard : 0.3));
    if (!isUUID(symbol_id) || !isUUID(repo_id)) return errorResult('symbol_id and repo_id required');

    const { temporalEngine } = await import('../analysis-engine/temporal-engine');
    const partners = await temporalEngine.getCoChangePartners(symbol_id, repo_id, min_jaccard);

    return textResult({
        symbol_id,
        co_change_partners: partners,
        total: partners.length,
    });
}

/**
 * Ingest runtime trace data.
 */
export async function handleIngestRuntimeTrace(args: Record<string, unknown>, _log: McpLogger): Promise<CallToolResult> {
    const repo_id = requireString(args, 'repo_id');
    const snapshot_id = requireString(args, 'snapshot_id');
    const rawTracePack = args['trace_pack'];
    if (!rawTracePack || typeof rawTracePack !== 'object' || Array.isArray(rawTracePack)) {
        return errorResult('repo_id, snapshot_id, and trace_pack required');
    }
    const tp = rawTracePack as Record<string, unknown>;
    if (!isUUID(repo_id) || !isUUID(snapshot_id)) return errorResult('repo_id, snapshot_id, and trace_pack required');

    // Validate trace_pack internals (matching REST API validation)
    const validSources = ['test_execution', 'dev_run', 'ci_trace', 'production_sample'];
    if (!tp.source || typeof tp.source !== 'string' || !validSources.includes(tp.source)) {
        return errorResult('trace_pack.source must be one of: ' + validSources.join(', '));
    }
    if (!tp.timestamp || typeof tp.timestamp !== 'string' || isNaN(Date.parse(tp.timestamp))) {
        return errorResult('trace_pack.timestamp must be a valid ISO 8601 date string');
    }
    if (tp.call_edges != null) {
        if (!Array.isArray(tp.call_edges)) return errorResult('trace_pack.call_edges must be an array');
        for (let i = 0; i < tp.call_edges.length; i++) {
            const edge = tp.call_edges[i];
            if (!edge || typeof edge !== 'object' || Array.isArray(edge)) {
                return errorResult(`trace_pack.call_edges[${i}] must have caller_key:string, callee_key:string, call_count:integer>=1`);
            }
            const e = edge as Record<string, unknown>;
            if (typeof e.caller_key !== 'string' || typeof e.callee_key !== 'string' ||
                typeof e.call_count !== 'number' || !Number.isInteger(e.call_count) || e.call_count < 1) {
                return errorResult(`trace_pack.call_edges[${i}] must have caller_key:string, callee_key:string, call_count:integer>=1`);
            }
        }
    }

    const trace_pack: TracePack = {
        source: tp.source as TracePack['source'],
        timestamp: new Date(String(tp.timestamp)),
        call_edges: (Array.isArray(tp.call_edges) ? tp.call_edges : []) as TracePack['call_edges'],
        dynamic_routes: (Array.isArray(tp.dynamic_routes) ? tp.dynamic_routes : []) as TracePack['dynamic_routes'],
        observed_types: (Array.isArray(tp.observed_types) ? tp.observed_types : []) as TracePack['observed_types'],
        framework_events: (Array.isArray(tp.framework_events) ? tp.framework_events : []) as TracePack['framework_events'],
    };

    const { runtimeEvidenceEngine } = await import('../analysis-engine/runtime-evidence');
    const result = await runtimeEvidenceEngine.ingestTrace(repo_id, snapshot_id, trace_pack);

    return textResult({
        repo_id,
        snapshot_id,
        ingestion_result: result,
    });
}

/**
 * Get runtime evidence for a symbol.
 */
export async function handleGetRuntimeEvidence(args: Record<string, unknown>, _log: McpLogger): Promise<CallToolResult> {
    const symbol_version_id = requireString(args, 'symbol_version_id');
    if (!isUUID(symbol_version_id)) return errorResult('symbol_version_id required');

    const { runtimeEvidenceEngine } = await import('../analysis-engine/runtime-evidence');
    const evidence = await runtimeEvidenceEngine.getEvidenceForSymbol(symbol_version_id);

    return textResult({
        symbol_version_id,
        runtime_evidence: evidence,
    });
}

// ────────── Tool 39: Health Check ──────────

/**
 * Health check — returns DB connection status, pool stats, uptime, and version.
 */
export async function handleHealthCheck(_args: Record<string, unknown>, _log: McpLogger): Promise<CallToolResult> {
    const health = await db.healthCheck();
    const poolStats = db.getPoolStats();

    // Count applied migrations — table is "_migrations" (created by src/db-driver/migrate.ts)
    let migrationsApplied = 0;
    try {
        const migResult = await db.query('SELECT COUNT(*) AS cnt FROM _migrations');
        migrationsApplied = parseCountField(firstRow(migResult));
    } catch (error) {
        // _migrations table may not exist yet (first run before db:migrate)
        _log.debug('Health check could not read migrations table', {
            error: error instanceof Error ? error.message : String(error),
        });
    }

    return textResult({
        status: health.connected ? 'healthy' : 'unhealthy',
        db: {
            connected: health.connected,
            latency_ms: health.latency_ms,
            pool: poolStats,
            migrations_applied: migrationsApplied,
        },
        extensions: health.extensions,
        uptime_seconds: Math.floor(process.uptime()),
        version: process.env['SCG_VERSION'] || '2.0.0',
    });
}

// ────────── Tool 40: Incremental Index ──────────

/**
 * Incrementally re-index changed files in a snapshot.
 * Accepts a list of changed file paths (from git diff), invalidates
 * affected symbols, re-extracts, re-computes profiles and relations.
 */
export async function handleIncrementalIndex(args: Record<string, unknown>, log: McpLogger): Promise<CallToolResult> {
    const repo_id = requireString(args, 'repo_id');
    const snapshot_id = requireString(args, 'snapshot_id');
    const changed_paths = requireArray<string>(args, 'changed_paths');

    if (!isUUID(repo_id)) return errorResult('repo_id is required and must be a valid UUID');
    if (!isUUID(snapshot_id)) return errorResult('snapshot_id is required and must be a valid UUID');
    if (!Array.isArray(changed_paths) || changed_paths.length === 0) {
        return errorResult('changed_paths is required (non-empty array of strings)');
    }
    for (const p of changed_paths) {
        if (typeof p !== 'string' || p.length === 0) {
            return errorResult('Each changed_path must be a non-empty string');
        }
    }

    log.debug('scg_incremental_index', {
        repo_id, snapshot_id, changed_count: changed_paths.length,
    });

    const result = await ingestor.ingestIncremental(repo_id, snapshot_id, changed_paths);
    return textResult({ result });
}

// ────────── Tool 41: Batch Embed Snapshot ──────────

/**
 * Batch-embed all symbol versions in a snapshot.
 * Returns the number of symbols embedded.
 */
export async function handleBatchEmbed(args: Record<string, unknown>, log: McpLogger): Promise<CallToolResult> {
    const snapshot_id = requireString(args, 'snapshot_id');

    if (!isUUID(snapshot_id)) return errorResult('snapshot_id is required and must be a valid UUID');

    log.debug('scg_batch_embed', { snapshot_id });

    const { semanticEngine } = await import('../semantic-engine');
    const embedded = await semanticEngine.batchEmbedSnapshot(snapshot_id);
    return textResult({ snapshot_id, symbols_embedded: embedded });
}

// ────────── Tool 42: Cache Stats ──────────

/**
 * Returns stats from all 5 in-process caches.
 */
export async function handleCacheStats(_args: Record<string, unknown>, _log: McpLogger): Promise<CallToolResult> {
    const { symbolCache, profileCache, capsuleCache, homologCache, queryCache } = await import('../cache');
    return textResult({
        symbol: symbolCache.stats(),
        profile: profileCache.stats(),
        capsule: capsuleCache.stats(),
        homolog: homologCache.stats(),
        query: queryCache.stats(),
    });
}

// ────────── Tool 43: Get Tests ──────────

export async function handleGetTests(args: Record<string, unknown>, log: McpLogger): Promise<CallToolResult> {
    const symbol_id = requireString(args, 'symbol_id');
    const snapshot_id = requireString(args, 'snapshot_id');
    if (!isUUID(symbol_id)) return errorResult('symbol_id is required and must be a valid UUID');
    if (!isUUID(snapshot_id)) return errorResult('snapshot_id is required and must be a valid UUID');
    log.debug('scg_get_tests', { symbol_id, snapshot_id });
    const result = await getTests({ symbol_id, snapshot_id });
    return textResult(result);
}

// ────────── Tool 44: Explain Relation ──────────

export async function handleExplainRelation(args: Record<string, unknown>, log: McpLogger): Promise<CallToolResult> {
    const src_symbol_version_id = requireString(args, 'src_symbol_version_id');
    const dst_symbol_version_id = requireString(args, 'dst_symbol_version_id');
    const snapshot_id = requireString(args, 'snapshot_id');
    if (!isUUID(src_symbol_version_id)) return errorResult('src_symbol_version_id is required and must be a valid UUID');
    if (!isUUID(dst_symbol_version_id)) return errorResult('dst_symbol_version_id is required and must be a valid UUID');
    if (!isUUID(snapshot_id)) return errorResult('snapshot_id is required and must be a valid UUID');
    log.debug('scg_explain_relation', { src_symbol_version_id, dst_symbol_version_id, snapshot_id });
    const result = await explainRelation({ src_symbol_version_id, dst_symbol_version_id, snapshot_id });
    return textResult(result);
}

// ────────── Tool 45: Get Neighbors ──────────

export async function handleGetNeighbors(args: Record<string, unknown>, log: McpLogger): Promise<CallToolResult> {
    const symbol_version_id = requireString(args, 'symbol_version_id');
    const snapshot_id = requireString(args, 'snapshot_id');
    if (!isUUID(symbol_version_id)) return errorResult('symbol_version_id is required and must be a valid UUID');
    if (!isUUID(snapshot_id)) return errorResult('snapshot_id is required and must be a valid UUID');
    const direction = optionalString(args, 'direction') || 'both';
    const depth = typeof args.depth === 'number' ? Math.min(Math.max(Math.round(args.depth), 1), 5) : 2;
    const max_nodes = typeof args.max_nodes === 'number' ? Math.min(Math.max(Math.round(args.max_nodes), 1), 500) : 100;
    const relation_types = Array.isArray(args.relation_types) ? (args.relation_types as string[]).filter(t => typeof t === 'string') : undefined;
    log.debug('scg_get_neighbors', { symbol_version_id, snapshot_id, direction, depth, max_nodes });
    const result = await getNeighbors({ symbol_version_id, snapshot_id, direction: direction as 'inbound' | 'outbound' | 'both', depth, max_nodes, relation_types });
    return textResult(result);
}

// ────────── Tool 46: Find Concept ──────────

export async function handleFindConcept(args: Record<string, unknown>, log: McpLogger): Promise<CallToolResult> {
    const concept = requireString(args, 'concept');
    const repo_id = requireString(args, 'repo_id');
    const snapshot_id = requireString(args, 'snapshot_id');
    if (!concept) return errorResult('concept is required');
    if (!isUUID(repo_id)) return errorResult('repo_id is required and must be a valid UUID');
    if (!isUUID(snapshot_id)) return errorResult('snapshot_id is required and must be a valid UUID');
    const kind_filter = optionalString(args, 'kind_filter') || undefined;
    const language_filter = optionalString(args, 'language_filter') || undefined;
    const limit = typeof args.limit === 'number' ? Math.min(Math.max(Math.round(args.limit), 1), 100) : 20;
    log.debug('scg_find_concept', { concept, repo_id, snapshot_id, limit });
    const result = await findConcept({ concept, repo_id, snapshot_id, kind_filter, language_filter, limit });
    return textResult(result);
}

// ────────── Tool 47: Semantic Diff ──────────

export async function handleSemanticDiff(args: Record<string, unknown>, log: McpLogger): Promise<CallToolResult> {
    const before_symbol_version_id = requireString(args, 'before_symbol_version_id');
    const after_symbol_version_id = requireString(args, 'after_symbol_version_id');
    if (!isUUID(before_symbol_version_id)) return errorResult('before_symbol_version_id is required and must be a valid UUID');
    if (!isUUID(after_symbol_version_id)) return errorResult('after_symbol_version_id is required and must be a valid UUID');
    log.debug('scg_semantic_diff', { before_symbol_version_id, after_symbol_version_id });
    const result = await computeSemanticDiff({ before_symbol_version_id, after_symbol_version_id });
    return textResult(result);
}

// ────────── Tool 48: Contract Diff ──────────

export async function handleContractDiff(args: Record<string, unknown>, log: McpLogger): Promise<CallToolResult> {
    const before_symbol_version_id = optionalString(args, 'before_symbol_version_id') || undefined;
    const after_symbol_version_id = optionalString(args, 'after_symbol_version_id') || undefined;
    const txn_id = optionalString(args, 'txn_id') || undefined;
    if (!txn_id && (!before_symbol_version_id || !after_symbol_version_id)) {
        return errorResult('Either txn_id or both before_symbol_version_id and after_symbol_version_id are required');
    }
    if (before_symbol_version_id && !isUUID(before_symbol_version_id)) return errorResult('before_symbol_version_id must be a valid UUID');
    if (after_symbol_version_id && !isUUID(after_symbol_version_id)) return errorResult('after_symbol_version_id must be a valid UUID');
    if (txn_id && !isUUID(txn_id)) return errorResult('txn_id must be a valid UUID');
    log.debug('scg_contract_diff', { before_symbol_version_id, after_symbol_version_id, txn_id });
    const result = await computeContractDiff({ before_symbol_version_id, after_symbol_version_id, txn_id });
    return textResult(result);
}

// ────────── Tool 49: Plan Change ──────────

export async function handlePlanChange(args: Record<string, unknown>, log: McpLogger): Promise<CallToolResult> {
    const repo_id = requireString(args, 'repo_id');
    const snapshot_id = requireString(args, 'snapshot_id');
    const task_description = requireString(args, 'task_description');
    if (!isUUID(repo_id)) return errorResult('repo_id is required and must be a valid UUID');
    if (!isUUID(snapshot_id)) return errorResult('snapshot_id is required and must be a valid UUID');
    if (!task_description) return errorResult('task_description is required');
    const max_candidates = typeof args.max_candidates === 'number' ? Math.min(Math.max(Math.round(args.max_candidates), 1), 20) : 5;
    const scope_constraints = typeof args.scope_constraints === 'object' && args.scope_constraints !== null
        ? args.scope_constraints as { kind_filter?: string; file_pattern?: string }
        : undefined;
    log.debug('scg_plan_change', { repo_id, snapshot_id, task_description: task_description.substring(0, 100) });
    const result = await planChange({ repo_id, snapshot_id, task_description, max_candidates, scope_constraints });
    return textResult(result);
}

// ────────── Tool 50: Prepare Change ──────────

export async function handlePrepareChange(args: Record<string, unknown>, log: McpLogger): Promise<CallToolResult> {
    const repo_id = requireString(args, 'repo_id');
    const base_snapshot_id = requireString(args, 'base_snapshot_id');
    if (!isUUID(repo_id)) return errorResult('repo_id is required and must be a valid UUID');
    if (!isUUID(base_snapshot_id)) return errorResult('base_snapshot_id is required and must be a valid UUID');
    const target_ids = args.target_symbol_version_ids;
    if (!Array.isArray(target_ids) || target_ids.length === 0) return errorResult('target_symbol_version_ids is required and must be a non-empty array');
    for (const id of target_ids) {
        if (!isUUID(id)) return errorResult(`target_symbol_version_ids: ${String(id)} is not a valid UUID`);
    }
    const plan_id = optionalString(args, 'plan_id') || undefined;
    const created_by = optionalString(args, 'created_by') || 'mcp';
    if (plan_id && !isUUID(plan_id)) return errorResult('plan_id must be a valid UUID');
    log.debug('scg_prepare_change', { repo_id, base_snapshot_id, target_count: target_ids.length });
    const result = await prepareChange({ repo_id, base_snapshot_id, target_symbol_version_ids: target_ids as string[], plan_id, created_by });
    return textResult(result);
}

// ────────── Tool 51: Apply Propagation ──────────

export async function handleApplyPropagation(args: Record<string, unknown>, log: McpLogger): Promise<CallToolResult> {
    const txn_id = requireString(args, 'txn_id');
    const target_symbol_version_id = requireString(args, 'target_symbol_version_id');
    if (!isUUID(txn_id)) return errorResult('txn_id is required and must be a valid UUID');
    if (!isUUID(target_symbol_version_id)) return errorResult('target_symbol_version_id is required and must be a valid UUID');
    const patch = args.patch;
    if (!patch || typeof patch !== 'object') return errorResult('patch is required and must be an object with file_path and new_content');
    const p = patch as Record<string, unknown>;
    if (typeof p.file_path !== 'string' || typeof p.new_content !== 'string') {
        return errorResult('patch must have file_path (string) and new_content (string)');
    }
    if ((p.new_content as string).length > 5 * 1024 * 1024) {
        return errorResult('patch.new_content exceeds 5MB size limit');
    }
    log.debug('scg_apply_propagation', { txn_id, target_symbol_version_id });
    const result = await applyPropagation({ txn_id, target_symbol_version_id, patch: { file_path: p.file_path as string, new_content: p.new_content as string } });
    return textResult(result);
}

// ────────── Tool 52: Review Homolog ──────────

export async function handleReviewHomolog(args: Record<string, unknown>, log: McpLogger): Promise<CallToolResult> {
    const inferred_relation_id = requireString(args, 'inferred_relation_id');
    if (!isUUID(inferred_relation_id)) return errorResult('inferred_relation_id is required and must be a valid UUID');
    const review_state = requireString(args, 'review_state');
    const allowed = ['confirmed', 'rejected', 'flagged'];
    if (!allowed.includes(review_state)) return errorResult(`review_state must be one of: ${allowed.join(', ')}`);
    const reviewer = optionalString(args, 'reviewer') || undefined;
    log.debug('scg_review_homolog', { inferred_relation_id, review_state });
    const result = await reviewHomolog({ inferred_relation_id, review_state: review_state as 'confirmed' | 'rejected' | 'flagged', reviewer });
    return textResult(result);
}

// ════════════════════════════════════════════════════════════════════════════
// ADMIN TOOLS — Retention, Cleanup, Database Stats, System Info
// ════════════════════════════════════════════════════════════════════════════

export async function handleAdminRunRetention(_args: Record<string, unknown>, log: McpLogger): Promise<CallToolResult> {
    log.debug('scg_admin_run_retention');
    const result = await runRetentionPolicy();
    return textResult(result);
}

export async function handleAdminRetentionStats(_args: Record<string, unknown>, log: McpLogger): Promise<CallToolResult> {
    log.debug('scg_admin_retention_stats');
    const stats = await getRetentionStats();
    return textResult(stats);
}

export async function handleAdminCleanupStale(_args: Record<string, unknown>, log: McpLogger): Promise<CallToolResult> {
    log.debug('scg_admin_cleanup_stale');
    const cleaned = await cleanupStaleTransactions();
    const stale = await listStaleTransactions();
    return textResult({ cleaned_count: cleaned, remaining_stale: stale });
}

export async function handleAdminDbStats(_args: Record<string, unknown>, log: McpLogger): Promise<CallToolResult> {
    log.debug('scg_admin_db_stats');

    const [tableStats, indexStats, dbSize, connStats] = await Promise.all([
        db.query(`
            SELECT relname AS table_name,
                   n_live_tup AS row_count,
                   pg_size_pretty(pg_total_relation_size(relid)) AS total_size
            FROM pg_stat_user_tables
            ORDER BY pg_total_relation_size(relid) DESC
            LIMIT 30
        `),
        db.query(`
            SELECT indexrelname AS index_name,
                   relname AS table_name,
                   idx_scan AS scans,
                   pg_size_pretty(pg_relation_size(indexrelid)) AS size
            FROM pg_stat_user_indexes
            ORDER BY idx_scan ASC
            LIMIT 20
        `),
        db.query(`SELECT pg_size_pretty(pg_database_size(current_database())) AS db_size`),
        db.query(`
            SELECT count(*) FILTER (WHERE state = 'active') AS active,
                   count(*) FILTER (WHERE state = 'idle') AS idle,
                   count(*) FILTER (WHERE state = 'idle in transaction') AS idle_in_transaction,
                   count(*) AS total
            FROM pg_stat_activity
            WHERE datname = current_database()
        `),
    ]);

    return textResult({
        database_size: (dbSize.rows[0] as Record<string, unknown>)?.db_size,
        connections: connStats.rows[0],
        tables: tableStats.rows,
        least_used_indexes: indexStats.rows,
    });
}

export async function handleAdminSystemInfo(_args: Record<string, unknown>, log: McpLogger): Promise<CallToolResult> {
    log.debug('scg_admin_system_info');

    const [repoCount, snapshotCount, symbolCount, relationCount] = await Promise.all([
        db.query(`SELECT COUNT(*)::int AS count FROM repositories`),
        db.query(`SELECT COUNT(*)::int AS count FROM snapshots`),
        db.query(`SELECT COUNT(*)::int AS count FROM symbols`),
        db.query(`SELECT COUNT(*)::int AS count FROM structural_relations`),
    ]);

    const health = await db.healthCheck();

    const cacheStats = {
        symbol: symbolCache.stats(),
        profile: profileCache.stats(),
        capsule: capsuleCache.stats(),
        homolog: adminHomologCache.stats(),
        query: queryCache.stats(),
    };

    return textResult({
        server: {
            uptime_seconds: Math.floor(process.uptime()),
            memory_mb: Math.round(process.memoryUsage().rss / 1_048_576),
            node_version: process.version,
        },
        database: {
            connected: health.connected,
            latency_ms: health.latency_ms,
            repositories: parseCountField(repoCount.rows[0] as Record<string, unknown>, 'count'),
            snapshots: parseCountField(snapshotCount.rows[0] as Record<string, unknown>, 'count'),
            symbols: parseCountField(symbolCount.rows[0] as Record<string, unknown>, 'count'),
            structural_relations: parseCountField(relationCount.rows[0] as Record<string, unknown>, 'count'),
        },
        caches: cacheStats,
    });
}
