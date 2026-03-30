import type { QueryResult } from 'pg';
import { Logger } from '../logger';
import type {
    BehavioralProfile, ContractProfile, StructuralRelation,
    PurityClass, StructuralRelationType, Visibility,
} from '../types';

const log = new Logger('db-result');

// ─── Core Row Utilities ──────────────────────────────────────────────────────

export type QueryRow = Record<string, unknown>;

export function firstRow(result: Pick<QueryResult, 'rows'>): QueryRow | undefined {
    const row = result.rows[0];
    if (!row || typeof row !== 'object') {
        return undefined;
    }
    return row as QueryRow;
}

export function requireFirstRow(
    result: Pick<QueryResult, 'rows'>,
    context: string,
): QueryRow {
    const row = firstRow(result);
    if (!row) {
        throw new Error(`${context}: query returned no rows`);
    }
    return row;
}

// ─── Scalar Field Extractors ─────────────────────────────────────────────────

export function optionalStringField(row: QueryRow | undefined, field: string): string | undefined {
    const value = row?.[field];
    return typeof value === 'string' ? value : undefined;
}

export function requireStringField(row: QueryRow | undefined, field: string, context: string): string {
    const value = optionalStringField(row, field);
    if (!value) {
        throw new Error(`${context}: expected string field "${field}"`);
    }
    return value;
}

export function booleanField(row: QueryRow | undefined, field: string): boolean | undefined {
    const value = row?.[field];
    return typeof value === 'boolean' ? value : undefined;
}

export function numberField(row: QueryRow | undefined, field: string): number | undefined {
    const value = row?.[field];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
        const parsed = parseFloat(value);
        if (Number.isFinite(parsed)) return parsed;
    }
    return undefined;
}

export function stringArrayField(row: QueryRow | undefined, field: string): string[] {
    const value = row?.[field];
    if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
    if (typeof value === 'string') {
        // PostgreSQL text[] is sometimes returned as a comma-delimited string
        try {
            return JSON.parse(value) as string[];
        } catch (err) {
            log.debug('Failed to parse string array field as JSON, returning empty array', {
                field,
                error: err instanceof Error ? err.message : String(err),
            });
            return [];
        }
    }
    return [];
}

export function parseCountField(row: QueryRow | undefined, field = 'cnt'): number {
    const value = row?.[field];
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }
    if (typeof value === 'string') {
        const parsed = parseInt(value, 10);
        if (Number.isFinite(parsed)) {
            return parsed;
        }
    }
    return 0;
}

// ─── JSON Field Parser ───────────────────────────────────────────────────────

/**
 * Safely parse a field that may be a JSON string or already-parsed object.
 * Returns undefined on parse failure instead of throwing.
 */
export function jsonField<T>(row: QueryRow | undefined, field: string): T | undefined {
    const value = row?.[field];
    if (value == null) return undefined;
    if (typeof value === 'object') return value as T;
    if (typeof value === 'string') {
        try {
            return JSON.parse(value) as T;
        } catch (err) {
            log.debug('Failed to parse JSON field', { field, error: err instanceof Error ? err.message : String(err) });
            return undefined;
        }
    }
    return undefined;
}

// ─── Typed Row Validators ────────────────────────────────────────────────────
//
// These functions validate that a database row matches the expected shape
// and return a properly typed object. They provide a type-safe boundary
// between the untyped pg driver output and our domain types.

/** Safely extract a SymbolVersionRow from a query result row. */
export interface SymbolVersionRow {
    symbol_version_id: string;
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
    summary: string;
    body_source: string | null;
    visibility: Visibility;
    language: string;
    uncertainty_flags: string[];
    // Joined fields — always present in standard queries (JOIN symbols + files)
    canonical_name: string;
    kind: string;
    stable_key: string;
    repo_id: string;
    file_path: string;
}

export function validateSymbolVersionRow(row: QueryRow): SymbolVersionRow | null {
    const svId = row['symbol_version_id'];
    if (typeof svId !== 'string') {
        log.debug('Invalid symbol_version row: missing symbol_version_id');
        return null;
    }
    return {
        symbol_version_id: svId,
        symbol_id: typeof row['symbol_id'] === 'string' ? row['symbol_id'] : '',
        snapshot_id: typeof row['snapshot_id'] === 'string' ? row['snapshot_id'] : '',
        file_id: typeof row['file_id'] === 'string' ? row['file_id'] : '',
        range_start_line: typeof row['range_start_line'] === 'number' ? row['range_start_line'] : 0,
        range_start_col: typeof row['range_start_col'] === 'number' ? row['range_start_col'] : 0,
        range_end_line: typeof row['range_end_line'] === 'number' ? row['range_end_line'] : 0,
        range_end_col: typeof row['range_end_col'] === 'number' ? row['range_end_col'] : 0,
        signature: typeof row['signature'] === 'string' ? row['signature'] : '',
        ast_hash: typeof row['ast_hash'] === 'string' ? row['ast_hash'] : '',
        body_hash: typeof row['body_hash'] === 'string' ? row['body_hash'] : '',
        summary: typeof row['summary'] === 'string' ? row['summary'] : '',
        body_source: typeof row['body_source'] === 'string' ? row['body_source'] : null,
        visibility: (typeof row['visibility'] === 'string' ? row['visibility'] : 'public') as Visibility,
        language: typeof row['language'] === 'string' ? row['language'] : '',
        uncertainty_flags: stringArrayField(row, 'uncertainty_flags'),
        // Joined fields (from standard symbol_versions + symbols + files queries)
        canonical_name: typeof row['canonical_name'] === 'string' ? row['canonical_name'] : '',
        kind: typeof row['kind'] === 'string' ? row['kind'] : '',
        stable_key: typeof row['stable_key'] === 'string' ? row['stable_key'] : '',
        repo_id: typeof row['repo_id'] === 'string' ? row['repo_id'] : '',
        file_path: typeof row['file_path'] === 'string' ? row['file_path'] : '',
    };
}

/** Validate a behavioral profile from a query result row. */
export function validateBehavioralProfile(row: QueryRow): BehavioralProfile | null {
    const bpId = row['behavior_profile_id'] ?? row['behavioral_profile_id'];
    const svId = row['symbol_version_id'];
    if (typeof bpId !== 'string' || typeof svId !== 'string') {
        log.debug('Invalid behavioral_profile row: missing IDs');
        return null;
    }
    return {
        behavior_profile_id: bpId,
        symbol_version_id: svId,
        purity_class: (typeof row['purity_class'] === 'string' ? row['purity_class'] : 'read_write') as PurityClass,
        resource_touches: stringArrayField(row, 'resource_touches'),
        db_reads: stringArrayField(row, 'db_reads'),
        db_writes: stringArrayField(row, 'db_writes'),
        network_calls: stringArrayField(row, 'network_calls'),
        cache_ops: stringArrayField(row, 'cache_ops'),
        file_io: stringArrayField(row, 'file_io'),
        auth_operations: stringArrayField(row, 'auth_operations'),
        validation_operations: stringArrayField(row, 'validation_operations'),
        exception_profile: stringArrayField(row, 'exception_profile'),
        state_mutation_profile: stringArrayField(row, 'state_mutation_profile'),
        transaction_profile: stringArrayField(row, 'transaction_profile'),
    };
}

/** Validate a contract profile from a query result row. */
export function validateContractProfile(row: QueryRow): ContractProfile | null {
    const cpId = row['contract_profile_id'];
    const svId = row['symbol_version_id'];
    if (typeof cpId !== 'string' || typeof svId !== 'string') {
        log.debug('Invalid contract_profile row: missing IDs');
        return null;
    }
    return {
        contract_profile_id: cpId,
        symbol_version_id: svId,
        input_contract: typeof row['input_contract'] === 'string' ? row['input_contract'] : '',
        output_contract: typeof row['output_contract'] === 'string' ? row['output_contract'] : '',
        error_contract: typeof row['error_contract'] === 'string' ? row['error_contract'] : '',
        schema_refs: stringArrayField(row, 'schema_refs'),
        api_contract_refs: stringArrayField(row, 'api_contract_refs'),
        serialization_contract: typeof row['serialization_contract'] === 'string' ? row['serialization_contract'] : '',
        security_contract: typeof row['security_contract'] === 'string' ? row['security_contract'] : '',
        derived_invariants_count: typeof row['derived_invariants_count'] === 'number' ? row['derived_invariants_count'] : 0,
    };
}

/** Validate a structural relation from a query result row. */
export function validateStructuralRelation(row: QueryRow): StructuralRelation | null {
    const relId = row['relation_id'];
    const src = row['src_symbol_version_id'];
    const dst = row['dst_symbol_version_id'];
    if (typeof relId !== 'string' || typeof src !== 'string' || typeof dst !== 'string') {
        log.debug('Invalid structural_relation row: missing IDs');
        return null;
    }
    return {
        relation_id: relId,
        src_symbol_version_id: src,
        dst_symbol_version_id: dst,
        relation_type: (typeof row['relation_type'] === 'string' ? row['relation_type'] : 'calls') as StructuralRelationType,
        strength: typeof row['strength'] === 'number' ? row['strength'] : 1.0,
        source: (typeof row['source'] === 'string' ? row['source'] : 'static_analysis') as 'static_analysis' | 'runtime_trace' | 'heuristic' | 'manual',
        confidence: typeof row['confidence'] === 'number' ? row['confidence'] : 1.0,
        provenance: typeof row['provenance'] === 'string' ? row['provenance'] as StructuralRelation['provenance'] : undefined,
    };
}

/**
 * Validate and filter an array of rows, logging any invalid entries.
 * Returns only rows that pass validation.
 */
export function validateRows<T>(
    rows: unknown[],
    validator: (row: QueryRow) => T | null,
    context: string,
): T[] {
    const results: T[] = [];
    let invalidCount = 0;
    for (const raw of rows) {
        if (!raw || typeof raw !== 'object') {
            invalidCount++;
            continue;
        }
        const validated = validator(raw as QueryRow);
        if (validated) {
            results.push(validated);
        } else {
            invalidCount++;
        }
    }
    if (invalidCount > 0) {
        log.warn(`${context}: ${invalidCount} invalid row(s) skipped out of ${rows.length}`);
    }
    return results;
}
