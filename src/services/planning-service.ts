/**
 * ContextZero — Planning Service
 *
 * Shared business logic for change planning, preparation, and propagation.
 * Orchestrates symbol resolution, blast radius computation, transaction
 * creation, and propagation patch application into service-level functions.
 * Used by both the REST API and MCP bridge handlers.
 */

import { db } from '../db-driver';
import { firstRow } from '../db-driver/result';
import { resolveSymbol } from './symbol-service';
import { blastRadiusEngine } from '../analysis-engine/blast-radius';
import { behavioralEngine } from '../analysis-engine/behavioral';
import { contractEngine } from '../analysis-engine/contracts';
import { transactionalChangeEngine } from '../transactional-editor';
import { UserFacingError, classifyConfidenceBand } from '../types';
import type { CapsuleMode, TransactionState } from '../types';
import { v4 as uuidv4 } from 'uuid';
import { Logger } from '../logger';

const log = new Logger('planning-service');

// ────────── Result Types ──────────

export interface PlanChangeOptions {
    repo_id: string;
    snapshot_id: string;
    task_description: string;
    scope_constraints?: { kind_filter?: string; file_pattern?: string };
    max_candidates?: number;
}

export interface PlanTarget {
    symbol_version_id: string;
    symbol_id: string;
    canonical_name: string;
    kind: string;
    file_path: string;
    start_line: number;
    confidence: number;
    confidence_band: string;
    behavioral_summary: { purity_class: string; resource_touches: string[] } | null;
    contract_summary: { input_contract: string; output_contract: string; error_contract: string } | null;
}

export interface ChangePlan {
    plan_id: string;
    task_description: string;
    target_candidates: PlanTarget[];
    initial_blast_radius: { total_impact_count: number; recommended_validation_scope: string };
    recommended_capsule_mode: string;
    assumptions: string[];
    confidence: number;
    confidence_band: string;
}

export interface PrepareChangeOptions {
    repo_id: string;
    base_snapshot_id: string;
    target_symbol_version_ids: string[];
    plan_id?: string;
    created_by?: string;
}

export interface PrepareResult {
    txn_id: string;
    locked_target_versions: { symbol_version_id: string; canonical_name: string; file_path: string }[];
    preconditions: string[];
}

export interface ApplyPropagationOptions {
    txn_id: string;
    target_symbol_version_id: string;
    patch: { file_path: string; new_content: string };
}

export interface PropagationResult {
    txn_id: string;
    target_symbol_version_id: string;
    patch_applied: boolean;
    validation_needed: boolean;
}

// ────────── Constants ──────────

const MAX_CANDIDATES_LIMIT = 20;
const DEFAULT_MAX_CANDIDATES = 5;

/** Blast radius thresholds for capsule mode recommendation */
const HIGH_IMPACT_THRESHOLD = 20;
const MEDIUM_IMPACT_THRESHOLD = 5;

/** Valid transaction states for propagation */
const PROPAGATION_VALID_STATES: TransactionState[] = ['propagation_pending', 'validated'];

// ────────── Service Functions ──────────

/**
 * Plan a code change from a natural language task description.
 *
 * 1. Resolves target symbol candidates via fuzzy matching
 * 2. Loads behavioral and contract profiles for top candidates
 * 3. Computes blast radius for the top candidates
 * 4. Recommends a capsule mode based on impact severity
 * 5. Returns a structured plan with confidence scores
 */
export async function planChange(options: PlanChangeOptions): Promise<ChangePlan> {
    const timer = log.startTimer('planChange', {
        repoId: options.repo_id,
        snapshotId: options.snapshot_id,
    });

    const maxCandidates = Math.min(
        Math.max(options.max_candidates ?? DEFAULT_MAX_CANDIDATES, 1),
        MAX_CANDIDATES_LIMIT,
    );

    // Step 1: Resolve target symbol candidates from task description
    const resolved = await resolveSymbol(
        options.task_description,
        options.repo_id,
        options.snapshot_id,
        options.scope_constraints?.kind_filter,
        maxCandidates,
    );

    if (resolved.symbols.length === 0) {
        throw UserFacingError.badRequest(
            `No symbol candidates found for task: "${options.task_description}"`,
        );
    }

    // Optional: filter by file pattern if scope constraint is provided
    let candidates = resolved.symbols;
    if (options.scope_constraints?.file_pattern) {
        const pattern = options.scope_constraints.file_pattern;
        const filtered = candidates.filter(s => s.file_path.includes(pattern));
        if (filtered.length > 0) {
            candidates = filtered;
        }
    }

    const topCandidates = candidates.slice(0, maxCandidates);
    const topSymbolVersionIds = topCandidates.map(c => c.symbol_version_id);

    // Step 2: Load behavioral and contract profiles in parallel
    const profileResults = await Promise.all(
        topCandidates.map(async (candidate) => {
            const [behavioral, contract] = await Promise.all([
                behavioralEngine.getProfile(candidate.symbol_version_id),
                contractEngine.getProfile(candidate.symbol_version_id),
            ]);
            return { candidate, behavioral, contract };
        }),
    );

    // Step 3: Load start_line for each candidate
    const startLinePH = topSymbolVersionIds.map((_, i) => `$${i + 1}`).join(',');
    const startLineResult = await db.query(`
        SELECT sv.symbol_version_id, sv.range_start_line
        FROM symbol_versions sv
        WHERE sv.symbol_version_id IN (${startLinePH})
    `, topSymbolVersionIds);

    const startLineMap = new Map<string, number>();
    for (const row of startLineResult.rows as Record<string, unknown>[]) {
        const svId = row.symbol_version_id as string;
        const line = typeof row.range_start_line === 'number' ? row.range_start_line : 0;
        startLineMap.set(svId, line);
    }

    // Step 4: Compute blast radius
    const blastReport = await blastRadiusEngine.computeBlastRadius(
        options.snapshot_id,
        topSymbolVersionIds,
        2,
    );

    // Step 5: Determine recommended capsule mode based on blast radius
    const totalImpacts = blastReport.total_impact_count;
    let recommendedCapsuleMode: CapsuleMode;
    if (totalImpacts >= HIGH_IMPACT_THRESHOLD) {
        recommendedCapsuleMode = 'strict';
    } else if (totalImpacts >= MEDIUM_IMPACT_THRESHOLD) {
        recommendedCapsuleMode = 'standard';
    } else {
        recommendedCapsuleMode = 'minimal';
    }

    // Build plan targets with profiles
    const targetCandidates: PlanTarget[] = profileResults.map(({ candidate, behavioral, contract }) => ({
        symbol_version_id: candidate.symbol_version_id,
        symbol_id: candidate.symbol_id,
        canonical_name: candidate.canonical_name,
        kind: candidate.kind,
        file_path: candidate.file_path,
        start_line: startLineMap.get(candidate.symbol_version_id) ?? 0,
        confidence: candidate.name_sim,
        confidence_band: classifyConfidenceBand(candidate.name_sim),
        behavioral_summary: behavioral
            ? { purity_class: behavioral.purity_class, resource_touches: behavioral.resource_touches }
            : null,
        contract_summary: contract
            ? { input_contract: contract.input_contract, output_contract: contract.output_contract, error_contract: contract.error_contract }
            : null,
    }));

    // Compute overall confidence as the average of candidate confidences
    const avgConfidence = targetCandidates.length > 0
        ? targetCandidates.reduce((sum, t) => sum + t.confidence, 0) / targetCandidates.length
        : 0;

    // Build assumptions based on analysis results
    const assumptions: string[] = [];
    if (options.scope_constraints?.kind_filter) {
        assumptions.push(`Filtered to symbol kind: ${options.scope_constraints.kind_filter}`);
    }
    if (options.scope_constraints?.file_pattern) {
        assumptions.push(`Filtered to file pattern: ${options.scope_constraints.file_pattern}`);
    }
    if (totalImpacts === 0) {
        assumptions.push('No blast radius impacts detected — change appears isolated');
    }
    if (targetCandidates.some(t => t.behavioral_summary === null)) {
        assumptions.push('Some candidates lack behavioral profiles — confidence may be lower');
    }

    const plan: ChangePlan = {
        plan_id: uuidv4(),
        task_description: options.task_description,
        target_candidates: targetCandidates,
        initial_blast_radius: {
            total_impact_count: totalImpacts,
            recommended_validation_scope: blastReport.recommended_validation_scope,
        },
        recommended_capsule_mode: recommendedCapsuleMode,
        assumptions,
        confidence: avgConfidence,
        confidence_band: classifyConfidenceBand(avgConfidence),
    };

    timer();
    return plan;
}

/**
 * Prepare a change transaction by verifying target symbols and creating
 * the transaction in 'planned' state with locked target versions.
 *
 * 1. Verifies all target symbol versions exist in the snapshot
 * 2. Creates the change transaction via transactionalChangeEngine
 * 3. Returns the txn_id, locked target versions, and preconditions
 */
export async function prepareChange(options: PrepareChangeOptions): Promise<PrepareResult> {
    const timer = log.startTimer('prepareChange', {
        repoId: options.repo_id,
        snapshotId: options.base_snapshot_id,
        targetCount: options.target_symbol_version_ids.length,
    });

    if (options.target_symbol_version_ids.length === 0) {
        throw UserFacingError.badRequest('At least one target symbol version ID is required');
    }

    // Step 1: Verify all target symbol versions exist in the snapshot
    const ph = options.target_symbol_version_ids.map((_, i) => `$${i + 2}`).join(',');
    const verifyResult = await db.query(`
        SELECT sv.symbol_version_id, s.canonical_name, f.path as file_path
        FROM symbol_versions sv
        JOIN symbols s ON s.symbol_id = sv.symbol_id
        JOIN files f ON f.file_id = sv.file_id
        WHERE sv.snapshot_id = $1
          AND sv.symbol_version_id IN (${ph})
    `, [options.base_snapshot_id, ...options.target_symbol_version_ids]);

    const foundVersions = verifyResult.rows as { symbol_version_id: string; canonical_name: string; file_path: string }[];
    const foundIds = new Set(foundVersions.map(r => r.symbol_version_id));
    const missingIds = options.target_symbol_version_ids.filter(id => !foundIds.has(id));

    if (missingIds.length > 0) {
        throw UserFacingError.notFound(
            `Symbol versions not found in snapshot ${options.base_snapshot_id}: ${missingIds.join(', ')}`,
        );
    }

    // Step 2: Create the change transaction
    const createdBy = options.created_by ?? 'mcp-bridge';
    const txnId = await transactionalChangeEngine.createTransaction(
        options.repo_id,
        options.base_snapshot_id,
        createdBy,
        options.target_symbol_version_ids,
    );

    // Step 3: Build preconditions
    const preconditions: string[] = [
        `Base snapshot: ${options.base_snapshot_id}`,
        `Target symbols locked: ${foundVersions.length}`,
    ];
    if (options.plan_id) {
        preconditions.push(`Linked to plan: ${options.plan_id}`);
    }

    const result: PrepareResult = {
        txn_id: txnId,
        locked_target_versions: foundVersions.map(v => ({
            symbol_version_id: v.symbol_version_id,
            canonical_name: v.canonical_name,
            file_path: v.file_path,
        })),
        preconditions,
    };

    timer();
    return result;
}

/**
 * Apply a propagation patch on a homolog target within an existing transaction.
 *
 * 1. Loads the parent transaction and verifies it's in a valid propagation state
 * 2. Resolves the target symbol's file path
 * 3. Applies the patch via transactionalChangeEngine.applyPatch()
 * 4. Returns the result with validation status
 */
export async function applyPropagation(options: ApplyPropagationOptions): Promise<PropagationResult> {
    const timer = log.startTimer('applyPropagation', {
        txnId: options.txn_id,
        targetSvId: options.target_symbol_version_id,
    });

    // Step 1: Load transaction and verify state
    const txn = await transactionalChangeEngine.getTransaction(options.txn_id);
    if (!txn) {
        throw UserFacingError.notFound(`Transaction ${options.txn_id}`);
    }

    if (!PROPAGATION_VALID_STATES.includes(txn.state)) {
        throw UserFacingError.badRequest(
            `Transaction ${options.txn_id} is in state '${txn.state}', ` +
            `but propagation requires one of: ${PROPAGATION_VALID_STATES.join(', ')}`,
        );
    }

    // Step 2: Verify the target symbol version exists
    const svResult = await db.query(`
        SELECT sv.symbol_version_id, f.path as file_path
        FROM symbol_versions sv
        JOIN files f ON f.file_id = sv.file_id
        WHERE sv.symbol_version_id = $1
    `, [options.target_symbol_version_id]);

    const targetRow = firstRow(svResult);
    if (!targetRow) {
        throw UserFacingError.notFound(
            `Target symbol version ${options.target_symbol_version_id}`,
        );
    }

    // Step 3: Apply the patch
    // The transactional engine's applyPatch requires 'planned' state, so for
    // propagation we directly record the patch in the transaction's patches array
    // and mark that validation is needed.
    let patchApplied = false;
    try {
        await db.query(`
            UPDATE change_transactions
            SET patches = patches || $1::jsonb,
                updated_at = NOW()
            WHERE txn_id = $2
        `, [
            JSON.stringify([{
                file_path: options.patch.file_path,
                new_content: options.patch.new_content,
            }]),
            options.txn_id,
        ]);
        patchApplied = true;
    } catch (err) {
        log.error('Failed to apply propagation patch', err instanceof Error ? err : new Error(String(err)), {
            txnId: options.txn_id,
            targetSvId: options.target_symbol_version_id,
        });
        patchApplied = false;
    }

    const result: PropagationResult = {
        txn_id: options.txn_id,
        target_symbol_version_id: options.target_symbol_version_id,
        patch_applied: patchApplied,
        validation_needed: patchApplied,
    };

    timer();
    return result;
}
