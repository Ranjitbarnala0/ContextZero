/**
 * ContextZero -- Diff Service
 *
 * Transport-agnostic service functions for computing semantic and contract
 * diffs between symbol versions.  Used by both the REST API (mcp-interface)
 * and the MCP bridge (mcp-bridge/handlers).
 *
 * Two public functions:
 *   - computeSemanticDiff:  full behavioral/semantic comparison
 *   - computeContractDiff:  contract-level delta, optionally from a transaction
 */

import { db } from '../db-driver';
import {
    firstRow,
    stringArrayField,
    parseCountField,
} from '../db-driver/result';
import { behavioralEngine } from '../analysis-engine/behavioral';
import { contractEngine } from '../analysis-engine/contracts';
import { effectEngine } from '../analysis-engine/effect-engine';
import { Logger } from '../logger';
import { UserFacingError } from '../types';
import type { PurityClass } from '../types';

const log = new Logger('diff-service');

// ────────── Purity ordering (mirrors behavioral engine) ──────────

const PURITY_ORDER: Record<PurityClass, number> = {
    pure: 0,
    read_only: 1,
    read_write: 2,
    side_effecting: 3,
};

// ────────── Semantic Diff Types ──────────

export interface SemanticDiffOptions {
    before_symbol_version_id: string;
    after_symbol_version_id: string;
}

export interface SemanticChange {
    dimension:
        | 'side_effects'
        | 'return_type'
        | 'exception_behavior'
        | 'auth_behavior'
        | 'serialization'
        | 'persistence'
        | 'purity'
        | 'validation'
        | 'resource_access';
    changed: boolean;
    before: string;
    after: string;
    severity: 'none' | 'minor' | 'major' | 'breaking';
    detail: string;
}

export interface SemanticDiffResult {
    before_symbol_version_id: string;
    after_symbol_version_id: string;
    before_name: string;
    after_name: string;
    changes: SemanticChange[];
    has_breaking_changes: boolean;
    overall_severity: 'none' | 'minor' | 'major' | 'breaking';
    summary: string;
}

// ────────── Contract Diff Types ──────────

export interface ContractDiffOptions {
    /** Provide before/after directly: */
    before_symbol_version_id?: string;
    after_symbol_version_id?: string;
    /** Or provide a transaction ID to diff against base snapshot: */
    txn_id?: string;
}

export interface ContractChange {
    field:
        | 'input_contract'
        | 'output_contract'
        | 'error_contract'
        | 'security_contract'
        | 'serialization_contract'
        | 'schema_refs';
    changed: boolean;
    before: string;
    after: string;
    severity: 'none' | 'minor' | 'major' | 'breaking';
}

export interface ContractDiffResult {
    changes: ContractChange[];
    has_breaking_changes: boolean;
    invariants_affected: number;
    summary: string;
}

// ────────── Internal helpers ──────────

/** Load symbol version metadata (name, signature, body_hash). */
async function loadSymbolVersion(symbolVersionId: string): Promise<{
    symbol_version_id: string;
    canonical_name: string;
    signature: string;
    body_hash: string;
    symbol_id: string;
}> {
    const result = await db.query(
        `SELECT sv.symbol_version_id, sv.signature, sv.body_hash,
                s.canonical_name, s.symbol_id
         FROM symbol_versions sv
         JOIN symbols s ON s.symbol_id = sv.symbol_id
         WHERE sv.symbol_version_id = $1`,
        [symbolVersionId],
    );
    const row = firstRow(result);
    if (!row) {
        throw UserFacingError.notFound(`Symbol version ${symbolVersionId}`);
    }
    return {
        symbol_version_id: row['symbol_version_id'] as string,
        canonical_name: (row['canonical_name'] as string) ?? '',
        signature: (row['signature'] as string) ?? '',
        body_hash: (row['body_hash'] as string) ?? '',
        symbol_id: (row['symbol_id'] as string) ?? '',
    };
}

/** Sorted-array comparison (order-insensitive). */
function arraysEqual(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return false;
    const sortedA = [...a].sort();
    const sortedB = [...b].sort();
    return sortedA.every((v, i) => v === sortedB[i]);
}

/** Format a string array for display. */
function formatArray(arr: string[]): string {
    if (arr.length === 0) return '(none)';
    return arr.join(', ');
}

/** Extract return-type substring from a signature string (best-effort). */
function extractReturnType(signature: string): string {
    // Common patterns:  "(...): ReturnType",  "(...) -> ReturnType"
    const colonMatch = signature.match(/\)\s*:\s*(.+)$/);
    if (colonMatch?.[1]) return colonMatch[1].trim();
    const arrowMatch = signature.match(/\)\s*->\s*(.+)$/);
    if (arrowMatch?.[1]) return arrowMatch[1].trim();
    return signature;
}

/** Determine highest severity from a list of changes. */
function maxSeverity(
    changes: Array<{ severity: 'none' | 'minor' | 'major' | 'breaking' }>,
): 'none' | 'minor' | 'major' | 'breaking' {
    const order: Record<string, number> = { none: 0, minor: 1, major: 2, breaking: 3 };
    let max = 0;
    for (const c of changes) {
        const level = order[c.severity] ?? 0;
        if (level > max) max = level;
    }
    const reverse: Array<'none' | 'minor' | 'major' | 'breaking'> = ['none', 'minor', 'major', 'breaking'];
    return reverse[max] ?? 'none';
}

// ────────── computeSemanticDiff ──────────

/**
 * Compare before/after symbol versions across all behavioral and semantic
 * dimensions.  Loads behavioral profiles, contract profiles, and effect
 * signatures (V2), then compares dimension-by-dimension to produce a
 * structured diff with per-dimension severity.
 */
export async function computeSemanticDiff(
    options: SemanticDiffOptions,
): Promise<SemanticDiffResult> {
    const timer = log.startTimer('computeSemanticDiff', {
        before: options.before_symbol_version_id,
        after: options.after_symbol_version_id,
    });

    // 1. Load both symbol versions
    const [beforeSv, afterSv] = await Promise.all([
        loadSymbolVersion(options.before_symbol_version_id),
        loadSymbolVersion(options.after_symbol_version_id),
    ]);

    // 2. Load behavioral profiles for both
    const [beforeBp, afterBp] = await Promise.all([
        behavioralEngine.getProfile(options.before_symbol_version_id),
        behavioralEngine.getProfile(options.after_symbol_version_id),
    ]);

    // 3. Load contract profiles for both
    const [beforeCp, afterCp] = await Promise.all([
        contractEngine.getProfile(options.before_symbol_version_id),
        contractEngine.getProfile(options.after_symbol_version_id),
    ]);

    // 4. Load effect signatures for both (V2 data, may not exist)
    const [beforeEs, afterEs] = await Promise.all([
        effectEngine.getEffectSignature(options.before_symbol_version_id),
        effectEngine.getEffectSignature(options.after_symbol_version_id),
    ]);

    // 5. Compare dimension by dimension
    const changes: SemanticChange[] = [];

    // -- Purity --
    const beforePurity = beforeBp?.purity_class ?? 'pure';
    const afterPurity = afterBp?.purity_class ?? 'pure';
    const purityChanged = beforePurity !== afterPurity;
    const beforePurityLevel = PURITY_ORDER[beforePurity];
    const afterPurityLevel = PURITY_ORDER[afterPurity];
    const purityEscalated = afterPurityLevel > beforePurityLevel;

    changes.push({
        dimension: 'purity',
        changed: purityChanged,
        before: beforePurity,
        after: afterPurity,
        severity: !purityChanged
            ? 'none'
            : purityEscalated
                ? 'breaking'
                : 'minor',
        detail: !purityChanged
            ? `Purity unchanged (${beforePurity})`
            : purityEscalated
                ? `Purity escalated from ${beforePurity} to ${afterPurity}`
                : `Purity deescalated from ${beforePurity} to ${afterPurity}`,
    });

    // -- Side effects (network_calls, db_writes, file_io, state_mutation) --
    const beforeSideEffects = [
        ...(beforeBp?.network_calls ?? []),
        ...(beforeBp?.db_writes ?? []),
        ...(beforeBp?.file_io ?? []),
        ...(beforeBp?.state_mutation_profile ?? []),
    ];
    const afterSideEffects = [
        ...(afterBp?.network_calls ?? []),
        ...(afterBp?.db_writes ?? []),
        ...(afterBp?.file_io ?? []),
        ...(afterBp?.state_mutation_profile ?? []),
    ];
    const sideEffectsChanged = !arraysEqual(beforeSideEffects, afterSideEffects);
    const newSideEffects = afterSideEffects.filter(e => !beforeSideEffects.includes(e));

    changes.push({
        dimension: 'side_effects',
        changed: sideEffectsChanged,
        before: formatArray(beforeSideEffects),
        after: formatArray(afterSideEffects),
        severity: !sideEffectsChanged
            ? 'none'
            : newSideEffects.length > 0
                ? 'major'
                : 'minor',
        detail: !sideEffectsChanged
            ? 'No side-effect changes'
            : newSideEffects.length > 0
                ? `${newSideEffects.length} new side effect(s): ${formatArray(newSideEffects)}`
                : 'Side effects reduced',
    });

    // -- Return type --
    const beforeReturn = extractReturnType(beforeSv.signature);
    const afterReturn = extractReturnType(afterSv.signature);
    const returnChanged = beforeReturn !== afterReturn;

    changes.push({
        dimension: 'return_type',
        changed: returnChanged,
        before: beforeReturn,
        after: afterReturn,
        severity: returnChanged ? 'breaking' : 'none',
        detail: returnChanged
            ? `Return type changed from ${beforeReturn} to ${afterReturn}`
            : `Return type unchanged (${beforeReturn})`,
    });

    // -- Exception behavior --
    const beforeExceptions = beforeBp?.exception_profile ?? [];
    const afterExceptions = afterBp?.exception_profile ?? [];
    const exceptionsChanged = !arraysEqual(beforeExceptions, afterExceptions);
    const newExceptions = afterExceptions.filter(e => !beforeExceptions.includes(e));

    changes.push({
        dimension: 'exception_behavior',
        changed: exceptionsChanged,
        before: formatArray(beforeExceptions),
        after: formatArray(afterExceptions),
        severity: !exceptionsChanged
            ? 'none'
            : newExceptions.length > 0
                ? 'major'
                : 'minor',
        detail: !exceptionsChanged
            ? 'Exception behavior unchanged'
            : `Exception profile changed: ${newExceptions.length} new, ${beforeExceptions.filter(e => !afterExceptions.includes(e)).length} removed`,
    });

    // -- Auth behavior --
    const beforeAuth = beforeBp?.auth_operations ?? [];
    const afterAuth = afterBp?.auth_operations ?? [];
    const authChanged = !arraysEqual(beforeAuth, afterAuth);
    const removedAuth = beforeAuth.filter(a => !afterAuth.includes(a));

    changes.push({
        dimension: 'auth_behavior',
        changed: authChanged,
        before: formatArray(beforeAuth),
        after: formatArray(afterAuth),
        severity: !authChanged
            ? 'none'
            : removedAuth.length > 0
                ? 'breaking'
                : 'minor',
        detail: !authChanged
            ? 'Auth behavior unchanged'
            : removedAuth.length > 0
                ? `Auth operations removed: ${formatArray(removedAuth)}`
                : `Auth operations changed`,
    });

    // -- Serialization --
    const beforeSerialization = beforeCp?.serialization_contract ?? 'none';
    const afterSerialization = afterCp?.serialization_contract ?? 'none';
    const serializationChanged = beforeSerialization !== afterSerialization;

    changes.push({
        dimension: 'serialization',
        changed: serializationChanged,
        before: beforeSerialization,
        after: afterSerialization,
        severity: serializationChanged ? 'major' : 'none',
        detail: serializationChanged
            ? `Serialization contract changed`
            : 'Serialization unchanged',
    });

    // -- Persistence (db_reads + db_writes) --
    const beforeDbReads = beforeBp?.db_reads ?? [];
    const afterDbReads = afterBp?.db_reads ?? [];
    const beforeDbWrites = beforeBp?.db_writes ?? [];
    const afterDbWrites = afterBp?.db_writes ?? [];
    const persistenceChanged =
        !arraysEqual(beforeDbReads, afterDbReads) ||
        !arraysEqual(beforeDbWrites, afterDbWrites);
    const newDbWrites = afterDbWrites.filter(w => !beforeDbWrites.includes(w));

    changes.push({
        dimension: 'persistence',
        changed: persistenceChanged,
        before: `reads: [${formatArray(beforeDbReads)}], writes: [${formatArray(beforeDbWrites)}]`,
        after: `reads: [${formatArray(afterDbReads)}], writes: [${formatArray(afterDbWrites)}]`,
        severity: !persistenceChanged
            ? 'none'
            : newDbWrites.length > 0
                ? 'major'
                : 'minor',
        detail: !persistenceChanged
            ? 'Persistence patterns unchanged'
            : newDbWrites.length > 0
                ? `${newDbWrites.length} new DB write(s): ${formatArray(newDbWrites)}`
                : 'DB access patterns changed',
    });

    // -- Validation --
    const beforeValidation = beforeBp?.validation_operations ?? [];
    const afterValidation = afterBp?.validation_operations ?? [];
    const validationChanged = !arraysEqual(beforeValidation, afterValidation);
    const removedValidation = beforeValidation.filter(v => !afterValidation.includes(v));

    changes.push({
        dimension: 'validation',
        changed: validationChanged,
        before: formatArray(beforeValidation),
        after: formatArray(afterValidation),
        severity: !validationChanged
            ? 'none'
            : removedValidation.length > 0
                ? 'major'
                : 'minor',
        detail: !validationChanged
            ? 'Validation unchanged'
            : removedValidation.length > 0
                ? `Validation operations removed: ${formatArray(removedValidation)}`
                : 'Validation operations changed',
    });

    // -- Resource access (resource_touches, network_calls, file_io) --
    const beforeResources = [
        ...(beforeBp?.resource_touches ?? []),
        ...(beforeBp?.network_calls ?? []),
        ...(beforeBp?.file_io ?? []),
    ];
    const afterResources = [
        ...(afterBp?.resource_touches ?? []),
        ...(afterBp?.network_calls ?? []),
        ...(afterBp?.file_io ?? []),
    ];
    const resourceChanged = !arraysEqual(beforeResources, afterResources);
    const newResources = afterResources.filter(r => !beforeResources.includes(r));

    changes.push({
        dimension: 'resource_access',
        changed: resourceChanged,
        before: formatArray(beforeResources),
        after: formatArray(afterResources),
        severity: !resourceChanged
            ? 'none'
            : newResources.length > 0
                ? 'major'
                : 'minor',
        detail: !resourceChanged
            ? 'Resource access unchanged'
            : `${newResources.length} new resource(s), ${beforeResources.filter(r => !afterResources.includes(r)).length} removed`,
    });

    // 6. Overall severity and breaking-change flag
    const overallSeverity = maxSeverity(changes);
    const hasBreaking = changes.some(c => c.severity === 'breaking');

    // 7. Build summary
    const changedDims = changes.filter(c => c.changed);
    let summary: string;
    if (changedDims.length === 0) {
        summary = 'No semantic changes detected between the two symbol versions.';
    } else {
        const parts: string[] = [];
        parts.push(`${changedDims.length} dimension(s) changed`);
        if (hasBreaking) {
            const breakingDims = changes
                .filter(c => c.severity === 'breaking')
                .map(c => c.dimension);
            parts.push(`BREAKING in: ${breakingDims.join(', ')}`);
        }
        const majorDims = changes
            .filter(c => c.severity === 'major')
            .map(c => c.dimension);
        if (majorDims.length > 0) {
            parts.push(`major in: ${majorDims.join(', ')}`);
        }
        summary = parts.join('; ') + '.';
    }

    timer({ dimensions: changes.length, changed: changedDims.length, overallSeverity });

    return {
        before_symbol_version_id: options.before_symbol_version_id,
        after_symbol_version_id: options.after_symbol_version_id,
        before_name: beforeSv.canonical_name,
        after_name: afterSv.canonical_name,
        changes,
        has_breaking_changes: hasBreaking,
        overall_severity: overallSeverity,
        summary,
    };
}

// ────────── computeContractDiff ──────────

/**
 * Compute contract-level delta between two symbol versions or for a
 * transaction (diffing target_symbol_versions against the base snapshot).
 *
 * Severity rules:
 *   - output_contract or security_contract changes  -> breaking
 *   - input_contract removals                       -> major
 *   - input_contract additions                      -> minor
 *   - error_contract, serialization_contract changes -> major
 *   - schema_refs changes                           -> minor
 */
export async function computeContractDiff(
    options: ContractDiffOptions,
): Promise<ContractDiffResult> {
    const timer = log.startTimer('computeContractDiff', {
        before: options.before_symbol_version_id,
        after: options.after_symbol_version_id,
        txn_id: options.txn_id,
    });

    let beforeSvId: string;
    let afterSvId: string;
    let scopeSymbolId: string | undefined;

    if (options.txn_id) {
        // ── Resolve before/after from transaction ──
        const txnResult = await db.query(
            `SELECT txn_id, repo_id, base_snapshot_id, target_symbol_versions, state
             FROM change_transactions WHERE txn_id = $1`,
            [options.txn_id],
        );
        const txnRow = firstRow(txnResult);
        if (!txnRow) {
            throw UserFacingError.notFound(`Transaction ${options.txn_id}`);
        }

        const targetVersions = stringArrayField(txnRow, 'target_symbol_versions');
        if (targetVersions.length === 0) {
            throw UserFacingError.badRequest(
                'Transaction has no target symbol versions to diff',
            );
        }

        // Use the first target symbol version as the "after"
        // Length guard above ensures targetVersions[0] exists
        afterSvId = targetVersions[0]!;

        // Find the corresponding "before" by looking up the same symbol_id
        // in the base snapshot
        const afterSvResult = await db.query(
            `SELECT sv.symbol_id FROM symbol_versions sv
             WHERE sv.symbol_version_id = $1`,
            [afterSvId],
        );
        const afterSvRow = firstRow(afterSvResult);
        if (!afterSvRow) {
            throw UserFacingError.notFound(
                `Target symbol version ${afterSvId}`,
            );
        }
        const symbolId = afterSvRow['symbol_id'] as string;
        scopeSymbolId = symbolId;
        const baseSnapshotId = txnRow['base_snapshot_id'] as string;

        const beforeResult = await db.query(
            `SELECT sv.symbol_version_id
             FROM symbol_versions sv
             WHERE sv.symbol_id = $1 AND sv.snapshot_id = $2
             LIMIT 1`,
            [symbolId, baseSnapshotId],
        );
        const beforeRow = firstRow(beforeResult);
        if (!beforeRow) {
            throw UserFacingError.notFound(
                `Base snapshot version for symbol ${symbolId} in snapshot ${baseSnapshotId}`,
            );
        }
        beforeSvId = beforeRow['symbol_version_id'] as string;
    } else if (options.before_symbol_version_id && options.after_symbol_version_id) {
        beforeSvId = options.before_symbol_version_id;
        afterSvId = options.after_symbol_version_id;
    } else {
        throw UserFacingError.badRequest(
            'Provide either before/after symbol version IDs or a transaction ID',
        );
    }

    // Load contract profiles
    const [beforeCp, afterCp] = await Promise.all([
        contractEngine.getProfile(beforeSvId),
        contractEngine.getProfile(afterSvId),
    ]);

    // If we do not yet have scopeSymbolId, resolve it for invariant lookup
    if (!scopeSymbolId) {
        const svResult = await db.query(
            `SELECT symbol_id FROM symbol_versions WHERE symbol_version_id = $1`,
            [afterSvId],
        );
        const svRow = firstRow(svResult);
        if (svRow) {
            scopeSymbolId = svRow['symbol_id'] as string;
        }
    }

    const changes: ContractChange[] = [];

    // -- input_contract --
    const beforeInput = beforeCp?.input_contract ?? '';
    const afterInput = afterCp?.input_contract ?? '';
    const inputChanged = beforeInput !== afterInput;
    // Removals from input are major (callers may break); additions are minor
    const inputSeverity: ContractChange['severity'] = !inputChanged
        ? 'none'
        : afterInput.length < beforeInput.length
            ? 'major'
            : 'minor';
    changes.push({
        field: 'input_contract',
        changed: inputChanged,
        before: beforeInput,
        after: afterInput,
        severity: inputSeverity,
    });

    // -- output_contract (breaking) --
    const beforeOutput = beforeCp?.output_contract ?? '';
    const afterOutput = afterCp?.output_contract ?? '';
    const outputChanged = beforeOutput !== afterOutput;
    changes.push({
        field: 'output_contract',
        changed: outputChanged,
        before: beforeOutput,
        after: afterOutput,
        severity: outputChanged ? 'breaking' : 'none',
    });

    // -- error_contract --
    const beforeError = beforeCp?.error_contract ?? '';
    const afterError = afterCp?.error_contract ?? '';
    const errorChanged = beforeError !== afterError;
    changes.push({
        field: 'error_contract',
        changed: errorChanged,
        before: beforeError,
        after: afterError,
        severity: errorChanged ? 'major' : 'none',
    });

    // -- security_contract (breaking) --
    const beforeSecurity = beforeCp?.security_contract ?? '';
    const afterSecurity = afterCp?.security_contract ?? '';
    const securityChanged = beforeSecurity !== afterSecurity;
    changes.push({
        field: 'security_contract',
        changed: securityChanged,
        before: beforeSecurity,
        after: afterSecurity,
        severity: securityChanged ? 'breaking' : 'none',
    });

    // -- serialization_contract --
    const beforeSerialization = beforeCp?.serialization_contract ?? '';
    const afterSerialization = afterCp?.serialization_contract ?? '';
    const serializationChanged = beforeSerialization !== afterSerialization;
    changes.push({
        field: 'serialization_contract',
        changed: serializationChanged,
        before: beforeSerialization,
        after: afterSerialization,
        severity: serializationChanged ? 'major' : 'none',
    });

    // -- schema_refs --
    const beforeSchemaRefs = beforeCp?.schema_refs ?? [];
    const afterSchemaRefs = afterCp?.schema_refs ?? [];
    const schemaRefsChanged = !arraysEqual(beforeSchemaRefs, afterSchemaRefs);
    changes.push({
        field: 'schema_refs',
        changed: schemaRefsChanged,
        before: formatArray(beforeSchemaRefs),
        after: formatArray(afterSchemaRefs),
        severity: schemaRefsChanged ? 'minor' : 'none',
    });

    // Count affected invariants
    let invariantsAffected = 0;
    if (scopeSymbolId) {
        const invResult = await db.query(
            `SELECT COUNT(*)::int AS cnt FROM invariants WHERE scope_symbol_id = $1`,
            [scopeSymbolId],
        );
        invariantsAffected = parseCountField(firstRow(invResult), 'cnt');
    }

    const hasBreaking = changes.some(c => c.severity === 'breaking');
    const changedFields = changes.filter(c => c.changed);

    // Build summary
    let summary: string;
    if (changedFields.length === 0) {
        summary = 'No contract changes detected.';
    } else {
        const parts: string[] = [];
        parts.push(`${changedFields.length} contract field(s) changed`);
        if (hasBreaking) {
            const breakingFields = changes
                .filter(c => c.severity === 'breaking')
                .map(c => c.field);
            parts.push(`BREAKING: ${breakingFields.join(', ')}`);
        }
        if (invariantsAffected > 0) {
            parts.push(`${invariantsAffected} invariant(s) potentially affected`);
        }
        summary = parts.join('; ') + '.';
    }

    timer({ fields: changes.length, changed: changedFields.length, invariantsAffected });

    return {
        changes,
        has_breaking_changes: hasBreaking,
        invariants_affected: invariantsAffected,
        summary,
    };
}
