/**
 * Unit tests for src/db-driver/result.ts — row validators and scalar helpers.
 */
import {
    validateSymbolVersionRow,
    validateBehavioralProfile,
    validateContractProfile,
    validateStructuralRelation,
    validateRows,
    numberField,
    stringArrayField,
    jsonField,
    type QueryRow,
} from '../db-driver/result';

// ─── validateSymbolVersionRow ─────────────────────────────────────────────────

describe('validateSymbolVersionRow', () => {
    const validRow: QueryRow = {
        symbol_version_id: 'sv-1',
        symbol_id: 'sym-1',
        snapshot_id: 'snap-1',
        file_id: 'file-1',
        range_start_line: 10,
        range_start_col: 0,
        range_end_line: 20,
        range_end_col: 5,
        signature: 'function foo()',
        ast_hash: 'abc123',
        body_hash: 'def456',
        summary: 'Does a thing',
        body_source: 'function foo() {}',
        visibility: 'public',
        language: 'typescript',
        uncertainty_flags: ['stale'],
        canonical_name: 'mod.foo',
        kind: 'function',
        stable_key: 'sk-1',
        repo_id: 'repo-1',
        file_path: '/src/foo.ts',
    };

    test('valid row with all fields returns typed object', () => {
        const result = validateSymbolVersionRow(validRow);
        expect(result).not.toBeNull();
        expect(result!.symbol_version_id).toBe('sv-1');
        expect(result!.symbol_id).toBe('sym-1');
        expect(result!.snapshot_id).toBe('snap-1');
        expect(result!.file_id).toBe('file-1');
        expect(result!.range_start_line).toBe(10);
        expect(result!.range_start_col).toBe(0);
        expect(result!.range_end_line).toBe(20);
        expect(result!.range_end_col).toBe(5);
        expect(result!.signature).toBe('function foo()');
        expect(result!.ast_hash).toBe('abc123');
        expect(result!.body_hash).toBe('def456');
        expect(result!.summary).toBe('Does a thing');
        expect(result!.body_source).toBe('function foo() {}');
        expect(result!.visibility).toBe('public');
        expect(result!.language).toBe('typescript');
        expect(result!.uncertainty_flags).toEqual(['stale']);
        expect(result!.canonical_name).toBe('mod.foo');
        expect(result!.kind).toBe('function');
        expect(result!.stable_key).toBe('sk-1');
        expect(result!.repo_id).toBe('repo-1');
        expect(result!.file_path).toBe('/src/foo.ts');
    });

    test('missing symbol_version_id returns null', () => {
        const row: QueryRow = { ...validRow };
        delete row['symbol_version_id'];
        expect(validateSymbolVersionRow(row)).toBeNull();
    });

    test('non-string symbol_version_id returns null', () => {
        expect(validateSymbolVersionRow({ ...validRow, symbol_version_id: 42 })).toBeNull();
    });

    test('wrong type for numeric fields uses defaults (0)', () => {
        const row: QueryRow = {
            symbol_version_id: 'sv-1',
            range_start_line: 'not-a-number',
            range_start_col: null,
            range_end_line: undefined,
            range_end_col: true,
        };
        const result = validateSymbolVersionRow(row);
        expect(result).not.toBeNull();
        expect(result!.range_start_line).toBe(0);
        expect(result!.range_start_col).toBe(0);
        expect(result!.range_end_line).toBe(0);
        expect(result!.range_end_col).toBe(0);
    });

    test('missing optional joined fields default to empty string', () => {
        const row: QueryRow = { symbol_version_id: 'sv-1' };
        const result = validateSymbolVersionRow(row);
        expect(result).not.toBeNull();
        expect(result!.canonical_name).toBe('');
        expect(result!.kind).toBe('');
        expect(result!.stable_key).toBe('');
        expect(result!.repo_id).toBe('');
        expect(result!.file_path).toBe('');
    });

    test('string arrays come as actual arrays — preserved', () => {
        const row: QueryRow = {
            symbol_version_id: 'sv-1',
            uncertainty_flags: ['stale', 'ambiguous'],
        };
        const result = validateSymbolVersionRow(row);
        expect(result!.uncertainty_flags).toEqual(['stale', 'ambiguous']);
    });

    test('string arrays come as JSON strings — parsed', () => {
        const row: QueryRow = {
            symbol_version_id: 'sv-1',
            uncertainty_flags: '["stale","ambiguous"]',
        };
        const result = validateSymbolVersionRow(row);
        expect(result!.uncertainty_flags).toEqual(['stale', 'ambiguous']);
    });
});

// ─── validateBehavioralProfile ────────────────────────────────────────────────

describe('validateBehavioralProfile', () => {
    const validRow: QueryRow = {
        behavior_profile_id: 'bp-1',
        symbol_version_id: 'sv-1',
        purity_class: 'pure',
        resource_touches: ['db'],
        db_reads: ['users'],
        db_writes: [],
        network_calls: [],
        cache_ops: [],
        file_io: [],
        auth_operations: [],
        validation_operations: [],
        exception_profile: [],
        state_mutation_profile: [],
        transaction_profile: [],
    };

    test('valid row returns typed object', () => {
        const result = validateBehavioralProfile(validRow);
        expect(result).not.toBeNull();
        expect(result!.behavior_profile_id).toBe('bp-1');
        expect(result!.symbol_version_id).toBe('sv-1');
        expect(result!.purity_class).toBe('pure');
        expect(result!.resource_touches).toEqual(['db']);
        expect(result!.db_reads).toEqual(['users']);
    });

    test('missing behavior_profile_id returns null', () => {
        const row: QueryRow = { ...validRow };
        delete row['behavior_profile_id'];
        expect(validateBehavioralProfile(row)).toBeNull();
    });

    test('missing symbol_version_id returns null', () => {
        const row: QueryRow = { ...validRow };
        delete row['symbol_version_id'];
        expect(validateBehavioralProfile(row)).toBeNull();
    });

    test('accepts "behavioral_profile_id" column name', () => {
        const row: QueryRow = {
            behavioral_profile_id: 'bp-alt',
            symbol_version_id: 'sv-1',
        };
        const result = validateBehavioralProfile(row);
        expect(result).not.toBeNull();
        expect(result!.behavior_profile_id).toBe('bp-alt');
    });

    test('prefers "behavior_profile_id" over "behavioral_profile_id"', () => {
        const row: QueryRow = {
            behavior_profile_id: 'bp-primary',
            behavioral_profile_id: 'bp-fallback',
            symbol_version_id: 'sv-1',
        };
        const result = validateBehavioralProfile(row);
        expect(result!.behavior_profile_id).toBe('bp-primary');
    });

    test('empty arrays for all array fields returns empty arrays', () => {
        const row: QueryRow = {
            behavior_profile_id: 'bp-1',
            symbol_version_id: 'sv-1',
            resource_touches: [],
            db_reads: [],
            db_writes: [],
            network_calls: [],
            cache_ops: [],
            file_io: [],
            auth_operations: [],
            validation_operations: [],
            exception_profile: [],
            state_mutation_profile: [],
            transaction_profile: [],
        };
        const result = validateBehavioralProfile(row);
        expect(result).not.toBeNull();
        expect(result!.resource_touches).toEqual([]);
        expect(result!.db_reads).toEqual([]);
        expect(result!.db_writes).toEqual([]);
        expect(result!.network_calls).toEqual([]);
        expect(result!.cache_ops).toEqual([]);
        expect(result!.file_io).toEqual([]);
        expect(result!.auth_operations).toEqual([]);
        expect(result!.validation_operations).toEqual([]);
        expect(result!.exception_profile).toEqual([]);
        expect(result!.state_mutation_profile).toEqual([]);
        expect(result!.transaction_profile).toEqual([]);
    });

    test('missing array fields default to empty arrays', () => {
        const row: QueryRow = {
            behavior_profile_id: 'bp-1',
            symbol_version_id: 'sv-1',
        };
        const result = validateBehavioralProfile(row);
        expect(result).not.toBeNull();
        expect(result!.resource_touches).toEqual([]);
        expect(result!.db_reads).toEqual([]);
        expect(result!.network_calls).toEqual([]);
    });
});

// ─── validateContractProfile ──────────────────────────────────────────────────

describe('validateContractProfile', () => {
    const validRow: QueryRow = {
        contract_profile_id: 'cp-1',
        symbol_version_id: 'sv-1',
        input_contract: 'takes string',
        output_contract: 'returns number',
        error_contract: 'throws Error',
        schema_refs: ['schema-1'],
        api_contract_refs: ['api-1'],
        serialization_contract: 'JSON',
        security_contract: 'auth-required',
        derived_invariants_count: 5,
    };

    test('valid row returns typed object', () => {
        const result = validateContractProfile(validRow);
        expect(result).not.toBeNull();
        expect(result!.contract_profile_id).toBe('cp-1');
        expect(result!.symbol_version_id).toBe('sv-1');
        expect(result!.input_contract).toBe('takes string');
        expect(result!.output_contract).toBe('returns number');
        expect(result!.error_contract).toBe('throws Error');
        expect(result!.schema_refs).toEqual(['schema-1']);
        expect(result!.api_contract_refs).toEqual(['api-1']);
        expect(result!.serialization_contract).toBe('JSON');
        expect(result!.security_contract).toBe('auth-required');
        expect(result!.derived_invariants_count).toBe(5);
    });

    test('missing contract_profile_id returns null', () => {
        const row: QueryRow = { ...validRow };
        delete row['contract_profile_id'];
        expect(validateContractProfile(row)).toBeNull();
    });

    test('missing symbol_version_id returns null', () => {
        const row: QueryRow = { ...validRow };
        delete row['symbol_version_id'];
        expect(validateContractProfile(row)).toBeNull();
    });

    test('derived_invariants_count defaults to 0', () => {
        const row: QueryRow = {
            contract_profile_id: 'cp-1',
            symbol_version_id: 'sv-1',
        };
        const result = validateContractProfile(row);
        expect(result).not.toBeNull();
        expect(result!.derived_invariants_count).toBe(0);
    });

    test('non-numeric derived_invariants_count defaults to 0', () => {
        const row: QueryRow = {
            contract_profile_id: 'cp-1',
            symbol_version_id: 'sv-1',
            derived_invariants_count: 'five',
        };
        const result = validateContractProfile(row);
        expect(result!.derived_invariants_count).toBe(0);
    });
});

// ─── validateStructuralRelation ───────────────────────────────────────────────

describe('validateStructuralRelation', () => {
    const validRow: QueryRow = {
        relation_id: 'rel-1',
        src_symbol_version_id: 'sv-src',
        dst_symbol_version_id: 'sv-dst',
        relation_type: 'calls',
        strength: 0.8,
        source: 'runtime_trace',
        confidence: 0.9,
        provenance: 'explicit',
    };

    test('valid row returns typed object', () => {
        const result = validateStructuralRelation(validRow);
        expect(result).not.toBeNull();
        expect(result!.relation_id).toBe('rel-1');
        expect(result!.src_symbol_version_id).toBe('sv-src');
        expect(result!.dst_symbol_version_id).toBe('sv-dst');
        expect(result!.relation_type).toBe('calls');
        expect(result!.strength).toBe(0.8);
        expect(result!.source).toBe('runtime_trace');
        expect(result!.confidence).toBe(0.9);
    });

    test('missing relation_id returns null', () => {
        const row: QueryRow = { ...validRow };
        delete row['relation_id'];
        expect(validateStructuralRelation(row)).toBeNull();
    });

    test('missing src_symbol_version_id returns null', () => {
        const row: QueryRow = { ...validRow };
        delete row['src_symbol_version_id'];
        expect(validateStructuralRelation(row)).toBeNull();
    });

    test('missing dst_symbol_version_id returns null', () => {
        const row: QueryRow = { ...validRow };
        delete row['dst_symbol_version_id'];
        expect(validateStructuralRelation(row)).toBeNull();
    });

    test('defaults: strength=1.0, source="static_analysis", confidence=1.0', () => {
        const row: QueryRow = {
            relation_id: 'rel-1',
            src_symbol_version_id: 'sv-src',
            dst_symbol_version_id: 'sv-dst',
        };
        const result = validateStructuralRelation(row);
        expect(result).not.toBeNull();
        expect(result!.strength).toBe(1.0);
        expect(result!.source).toBe('static_analysis');
        expect(result!.confidence).toBe(1.0);
    });

    test('defaults relation_type to "calls" when missing', () => {
        const row: QueryRow = {
            relation_id: 'rel-1',
            src_symbol_version_id: 'sv-src',
            dst_symbol_version_id: 'sv-dst',
        };
        const result = validateStructuralRelation(row);
        expect(result!.relation_type).toBe('calls');
    });
});

// ─── validateRows ─────────────────────────────────────────────────────────────

describe('validateRows', () => {
    test('array of mixed valid/invalid rows filters correctly', () => {
        const rows = [
            { symbol_version_id: 'sv-1' },     // valid
            { not_an_sv: true },                 // invalid — missing required ID
            { symbol_version_id: 'sv-2' },     // valid
            null,                                // invalid — null
        ];
        const result = validateRows(rows as unknown[], validateSymbolVersionRow, 'test');
        expect(result).toHaveLength(2);
        expect(result[0]!.symbol_version_id).toBe('sv-1');
        expect(result[1]!.symbol_version_id).toBe('sv-2');
    });

    test('empty array returns empty', () => {
        const result = validateRows([], validateSymbolVersionRow, 'test');
        expect(result).toEqual([]);
    });

    test('all invalid returns empty', () => {
        const rows = [
            { no_id: true },
            null,
            undefined,
            42,
        ];
        const result = validateRows(rows as unknown[], validateSymbolVersionRow, 'test');
        expect(result).toEqual([]);
    });

    test('non-object entries are skipped', () => {
        const rows = ['string', 123, true, null, undefined];
        const result = validateRows(rows as unknown[], validateSymbolVersionRow, 'test');
        expect(result).toEqual([]);
    });
});

// ─── Scalar helpers ───────────────────────────────────────────────────────────

describe('numberField', () => {
    test('number input returns number', () => {
        expect(numberField({ val: 42 }, 'val')).toBe(42);
    });

    test('string numeric input returns parsed number', () => {
        expect(numberField({ val: '3.14' }, 'val')).toBe(3.14);
    });

    test('NaN returns undefined', () => {
        expect(numberField({ val: NaN }, 'val')).toBeUndefined();
    });

    test('Infinity returns undefined', () => {
        expect(numberField({ val: Infinity }, 'val')).toBeUndefined();
    });

    test('undefined row returns undefined', () => {
        expect(numberField(undefined, 'val')).toBeUndefined();
    });

    test('missing field returns undefined', () => {
        expect(numberField({}, 'val')).toBeUndefined();
    });

    test('non-numeric string returns undefined', () => {
        expect(numberField({ val: 'abc' }, 'val')).toBeUndefined();
    });

    test('zero is valid', () => {
        expect(numberField({ val: 0 }, 'val')).toBe(0);
    });

    test('negative numbers are valid', () => {
        expect(numberField({ val: -5 }, 'val')).toBe(-5);
    });
});

describe('stringArrayField', () => {
    test('actual array is preserved (filters non-strings)', () => {
        expect(stringArrayField({ arr: ['a', 'b', 'c'] }, 'arr')).toEqual(['a', 'b', 'c']);
    });

    test('array with non-string elements filters them out', () => {
        expect(stringArrayField({ arr: ['a', 42, null, 'b'] as unknown[] }, 'arr')).toEqual(['a', 'b']);
    });

    test('JSON string array is parsed', () => {
        expect(stringArrayField({ arr: '["x","y"]' }, 'arr')).toEqual(['x', 'y']);
    });

    test('non-array, non-string returns empty array', () => {
        expect(stringArrayField({ arr: 42 }, 'arr')).toEqual([]);
    });

    test('corrupt JSON string returns empty array', () => {
        expect(stringArrayField({ arr: '{not json[' }, 'arr')).toEqual([]);
    });

    test('missing field returns empty array', () => {
        expect(stringArrayField({}, 'arr')).toEqual([]);
    });

    test('undefined row returns empty array', () => {
        expect(stringArrayField(undefined, 'arr')).toEqual([]);
    });

    test('empty array passes through', () => {
        expect(stringArrayField({ arr: [] }, 'arr')).toEqual([]);
    });
});

describe('jsonField', () => {
    test('object is passed through', () => {
        const obj = { key: 'value' };
        expect(jsonField({ data: obj }, 'data')).toEqual({ key: 'value' });
    });

    test('JSON string is parsed', () => {
        expect(jsonField({ data: '{"key":"value"}' }, 'data')).toEqual({ key: 'value' });
    });

    test('corrupt JSON returns undefined', () => {
        expect(jsonField({ data: '{bad json' }, 'data')).toBeUndefined();
    });

    test('null value returns undefined', () => {
        expect(jsonField({ data: null }, 'data')).toBeUndefined();
    });

    test('undefined value returns undefined', () => {
        expect(jsonField({}, 'data')).toBeUndefined();
    });

    test('undefined row returns undefined', () => {
        expect(jsonField(undefined, 'data')).toBeUndefined();
    });

    test('numeric value returns undefined (not object or string)', () => {
        expect(jsonField({ data: 42 }, 'data')).toBeUndefined();
    });

    test('array value is treated as object (passed through)', () => {
        const arr = [1, 2, 3];
        expect(jsonField({ data: arr }, 'data')).toEqual([1, 2, 3]);
    });

    test('JSON string array is parsed', () => {
        expect(jsonField({ data: '[1,2,3]' }, 'data')).toEqual([1, 2, 3]);
    });
});
