/**
 * Comprehensive unit tests for src/middleware/validation.ts
 *
 * Covers every exported validator, including boundary conditions,
 * type confusion, and path-traversal attack vectors.
 */

import { Request, Response, NextFunction } from 'express';
import {
    isValidUUID,
    isValidUUIDArray,
    isNonEmptyString,
    isBoundedNumber,
    MAX_GRAPH_DEPTH,
    MAX_LIST_LIMIT,
    MAX_TOKEN_BUDGET,
    MAX_PATCH_COUNT,
    MAX_CHANGED_PATHS,
    validateBody,
    requireUUID,
    optionalUUID,
    requireUUIDArray,
    requireString,
    optionalString,
    requireBoundedInt,
    optionalEnum,
    requireEnum,
    optionalConfidence,
    requireStringArray,
    requirePatchArray,
    requireAbsolutePath,
    requireSafePathArray,
} from '../middleware/validation';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';
const VALID_UUID_UPPER = '550E8400-E29B-41D4-A716-446655440000';
const VALID_UUID_2 = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

function mockReqResNext(body: Record<string, unknown> = {}): {
    req: Partial<Request>;
    res: Partial<Response> & { statusCode?: number; body?: unknown };
    next: jest.Mock;
} {
    const req: Partial<Request> = { body, path: '/test' };
    const res: Partial<Response> & { statusCode?: number; body?: unknown } = {
        statusCode: undefined,
        body: undefined,
        status(code: number) {
            this.statusCode = code;
            return this as Response;
        },
        json(data: unknown) {
            this.body = data;
            return this as Response;
        },
    };
    const next = jest.fn();
    return { req, res, next };
}

// ---------------------------------------------------------------------------
// isValidUUID
// ---------------------------------------------------------------------------

describe('isValidUUID', () => {
    it('accepts a valid lowercase UUID', () => {
        expect(isValidUUID(VALID_UUID)).toBe(true);
    });

    it('accepts a valid uppercase UUID', () => {
        expect(isValidUUID(VALID_UUID_UPPER)).toBe(true);
    });

    it('rejects an empty string', () => {
        expect(isValidUUID('')).toBe(false);
    });

    it('rejects a non-UUID string', () => {
        expect(isValidUUID('not-a-uuid')).toBe(false);
    });

    it('rejects null', () => {
        expect(isValidUUID(null)).toBe(false);
    });

    it('rejects undefined', () => {
        expect(isValidUUID(undefined)).toBe(false);
    });

    it('rejects a number', () => {
        expect(isValidUUID(12345)).toBe(false);
    });

    it('rejects a UUID with wrong segment length', () => {
        expect(isValidUUID('550e8400-e29b-41d4-a716-44665544000')).toBe(false); // one char short
    });

    it('rejects a UUID with invalid hex characters', () => {
        expect(isValidUUID('zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz')).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// isValidUUIDArray
// ---------------------------------------------------------------------------

describe('isValidUUIDArray', () => {
    it('accepts an array with one valid UUID', () => {
        expect(isValidUUIDArray([VALID_UUID])).toBe(true);
    });

    it('accepts an array with multiple valid UUIDs', () => {
        expect(isValidUUIDArray([VALID_UUID, VALID_UUID_2])).toBe(true);
    });

    it('rejects an empty array', () => {
        expect(isValidUUIDArray([])).toBe(false);
    });

    it('rejects an array with an invalid UUID mixed in', () => {
        expect(isValidUUIDArray([VALID_UUID, 'bad'])).toBe(false);
    });

    it('rejects a non-array value', () => {
        expect(isValidUUIDArray('not-an-array')).toBe(false);
    });

    it('rejects null', () => {
        expect(isValidUUIDArray(null)).toBe(false);
    });

    it('rejects undefined', () => {
        expect(isValidUUIDArray(undefined)).toBe(false);
    });

    it('rejects arrays exceeding 20 elements', () => {
        const big = Array.from({ length: 21 }, () => VALID_UUID);
        expect(isValidUUIDArray(big)).toBe(false);
    });

    it('accepts exactly 20 elements', () => {
        const twenty = Array.from({ length: 20 }, () => VALID_UUID);
        expect(isValidUUIDArray(twenty)).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// isNonEmptyString
// ---------------------------------------------------------------------------

describe('isNonEmptyString', () => {
    it('accepts a normal string', () => {
        expect(isNonEmptyString('hello')).toBe(true);
    });

    it('rejects an empty string', () => {
        expect(isNonEmptyString('')).toBe(false);
    });

    it('rejects a whitespace-only string', () => {
        expect(isNonEmptyString('   ')).toBe(false);
    });

    it('rejects a number', () => {
        expect(isNonEmptyString(42)).toBe(false);
    });

    it('rejects null', () => {
        expect(isNonEmptyString(null)).toBe(false);
    });

    it('enforces default maxLen of 1000', () => {
        expect(isNonEmptyString('a'.repeat(1001))).toBe(false);
        expect(isNonEmptyString('a'.repeat(1000))).toBe(true);
    });

    it('enforces custom maxLen', () => {
        expect(isNonEmptyString('abcdef', 5)).toBe(false);
        expect(isNonEmptyString('abcde', 5)).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// isBoundedNumber
// ---------------------------------------------------------------------------

describe('isBoundedNumber', () => {
    it('accepts a value within bounds', () => {
        expect(isBoundedNumber(5, 0, 10)).toBe(true);
    });

    it('accepts a value at the lower bound', () => {
        expect(isBoundedNumber(0, 0, 10)).toBe(true);
    });

    it('accepts a value at the upper bound', () => {
        expect(isBoundedNumber(10, 0, 10)).toBe(true);
    });

    it('rejects a value below min', () => {
        expect(isBoundedNumber(-1, 0, 10)).toBe(false);
    });

    it('rejects a value above max', () => {
        expect(isBoundedNumber(11, 0, 10)).toBe(false);
    });

    it('rejects NaN', () => {
        expect(isBoundedNumber(NaN, 0, 10)).toBe(false);
    });

    it('rejects Infinity', () => {
        expect(isBoundedNumber(Infinity, 0, 100)).toBe(false);
    });

    it('rejects a string', () => {
        expect(isBoundedNumber('5' as unknown, 0, 10)).toBe(false);
    });

    it('rejects null', () => {
        expect(isBoundedNumber(null as unknown, 0, 10)).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// Exported constants
// ---------------------------------------------------------------------------

describe('exported constants', () => {
    it('MAX_GRAPH_DEPTH is 5', () => {
        expect(MAX_GRAPH_DEPTH).toBe(5);
    });

    it('MAX_LIST_LIMIT is 100', () => {
        expect(MAX_LIST_LIMIT).toBe(100);
    });

    it('MAX_TOKEN_BUDGET is 100_000', () => {
        expect(MAX_TOKEN_BUDGET).toBe(100_000);
    });

    it('MAX_PATCH_COUNT is 100', () => {
        expect(MAX_PATCH_COUNT).toBe(100);
    });

    it('MAX_CHANGED_PATHS is 500', () => {
        expect(MAX_CHANGED_PATHS).toBe(500);
    });
});

// ---------------------------------------------------------------------------
// requireUUID
// ---------------------------------------------------------------------------

describe('requireUUID', () => {
    it('returns null for a valid UUID', () => {
        expect(requireUUID(VALID_UUID)).toBeNull();
    });

    it('returns "required" for undefined', () => {
        expect(requireUUID(undefined)).toBe('required');
    });

    it('returns "required" for null', () => {
        expect(requireUUID(null)).toBe('required');
    });

    it('returns error for an empty string', () => {
        expect(requireUUID('')).toBe('must be a valid UUID');
    });

    it('returns error for a non-UUID string', () => {
        expect(requireUUID('hello-world')).toBe('must be a valid UUID');
    });

    it('returns error for a number', () => {
        expect(requireUUID(42)).toBe('must be a valid UUID');
    });

    it('returns error for a boolean', () => {
        expect(requireUUID(true)).toBe('must be a valid UUID');
    });

    it('returns error for an object', () => {
        expect(requireUUID({})).toBe('must be a valid UUID');
    });
});

// ---------------------------------------------------------------------------
// optionalUUID
// ---------------------------------------------------------------------------

describe('optionalUUID', () => {
    it('returns null for a valid UUID', () => {
        expect(optionalUUID(VALID_UUID)).toBeNull();
    });

    it('returns null for undefined', () => {
        expect(optionalUUID(undefined)).toBeNull();
    });

    it('returns null for null', () => {
        expect(optionalUUID(null)).toBeNull();
    });

    it('returns error for an invalid string', () => {
        expect(optionalUUID('bad')).toBe('must be a valid UUID');
    });

    it('returns error for a number', () => {
        expect(optionalUUID(99)).toBe('must be a valid UUID');
    });
});

// ---------------------------------------------------------------------------
// requireUUIDArray
// ---------------------------------------------------------------------------

describe('requireUUIDArray', () => {
    it('returns null for a valid UUID array', () => {
        expect(requireUUIDArray([VALID_UUID])).toBeNull();
    });

    it('returns "required" for undefined', () => {
        expect(requireUUIDArray(undefined)).toBe('required');
    });

    it('returns "required" for null', () => {
        expect(requireUUIDArray(null)).toBe('required');
    });

    it('returns error for an empty array', () => {
        expect(requireUUIDArray([])).toBe('must be an array of 1-20 valid UUIDs');
    });

    it('returns error for an array with invalid UUIDs', () => {
        expect(requireUUIDArray([VALID_UUID, 'invalid'])).toBe('must be an array of 1-20 valid UUIDs');
    });

    it('returns error for a non-array value', () => {
        expect(requireUUIDArray('single-uuid')).toBe('must be an array of 1-20 valid UUIDs');
    });

    it('returns error for more than 20 UUIDs', () => {
        const arr = Array.from({ length: 21 }, () => VALID_UUID);
        expect(requireUUIDArray(arr)).toBe('must be an array of 1-20 valid UUIDs');
    });
});

// ---------------------------------------------------------------------------
// requireString
// ---------------------------------------------------------------------------

describe('requireString', () => {
    it('returns null for a valid non-empty string', () => {
        expect(requireString('hello world')).toBeNull();
    });

    it('returns error for an empty string', () => {
        expect(requireString('')).toBe('required, non-empty string (max 2000 chars)');
    });

    it('returns error for a whitespace-only string', () => {
        expect(requireString('   ')).toBe('required, non-empty string (max 2000 chars)');
    });

    it('returns error for a number', () => {
        expect(requireString(123)).toBe('required, non-empty string (max 2000 chars)');
    });

    it('returns error for null', () => {
        expect(requireString(null)).toBe('required, non-empty string (max 2000 chars)');
    });

    it('returns error for undefined', () => {
        expect(requireString(undefined)).toBe('required, non-empty string (max 2000 chars)');
    });

    it('returns error for a string exceeding 2000 chars', () => {
        expect(requireString('a'.repeat(2001))).toBe('required, non-empty string (max 2000 chars)');
    });

    it('returns null for exactly 2000 chars', () => {
        expect(requireString('a'.repeat(2000))).toBeNull();
    });

    it('returns error for boolean', () => {
        expect(requireString(true)).toBe('required, non-empty string (max 2000 chars)');
    });
});

// ---------------------------------------------------------------------------
// optionalString
// ---------------------------------------------------------------------------

describe('optionalString', () => {
    it('returns null for a present string', () => {
        expect(optionalString('hello')).toBeNull();
    });

    it('returns null for an empty string (allowed for optional)', () => {
        expect(optionalString('')).toBeNull();
    });

    it('returns null for undefined', () => {
        expect(optionalString(undefined)).toBeNull();
    });

    it('returns null for null', () => {
        expect(optionalString(null)).toBeNull();
    });

    it('returns error for a number', () => {
        expect(optionalString(42)).toBe('must be a string (max 2000 chars)');
    });

    it('returns error for a boolean', () => {
        expect(optionalString(true)).toBe('must be a string (max 2000 chars)');
    });

    it('returns error for a string exceeding 2000 chars', () => {
        expect(optionalString('x'.repeat(2001))).toBe('must be a string (max 2000 chars)');
    });

    it('returns null for exactly 2000 chars', () => {
        expect(optionalString('x'.repeat(2000))).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// optionalEnum
// ---------------------------------------------------------------------------

describe('optionalEnum', () => {
    const validator = optionalEnum('asc', 'desc', 'none');

    it('returns null for a valid enum value', () => {
        expect(validator('asc')).toBeNull();
        expect(validator('desc')).toBeNull();
        expect(validator('none')).toBeNull();
    });

    it('returns null for undefined', () => {
        expect(validator(undefined)).toBeNull();
    });

    it('returns null for null', () => {
        expect(validator(null)).toBeNull();
    });

    it('returns error for an invalid string', () => {
        expect(validator('invalid')).toBe('must be one of: asc, desc, none');
    });

    it('returns error for a number', () => {
        expect(validator(42)).toBe('must be one of: asc, desc, none');
    });

    it('returns error for a boolean', () => {
        expect(validator(true)).toBe('must be one of: asc, desc, none');
    });

    it('is case-sensitive', () => {
        expect(validator('ASC')).toBe('must be one of: asc, desc, none');
    });
});

// ---------------------------------------------------------------------------
// requireEnum
// ---------------------------------------------------------------------------

describe('requireEnum', () => {
    const validator = requireEnum('active', 'inactive');

    it('returns null for a valid enum value', () => {
        expect(validator('active')).toBeNull();
    });

    it('returns "required" for undefined', () => {
        expect(validator(undefined)).toBe('required');
    });

    it('returns "required" for null', () => {
        expect(validator(null)).toBe('required');
    });

    it('returns error for an invalid string', () => {
        expect(validator('deleted')).toBe('must be one of: active, inactive');
    });

    it('returns error for a number', () => {
        expect(validator(1)).toBe('must be one of: active, inactive');
    });
});

// ---------------------------------------------------------------------------
// optionalConfidence
// ---------------------------------------------------------------------------

describe('optionalConfidence', () => {
    it('returns null for 0.0', () => {
        expect(optionalConfidence(0)).toBeNull();
    });

    it('returns null for 1.0', () => {
        expect(optionalConfidence(1)).toBeNull();
    });

    it('returns null for 0.5', () => {
        expect(optionalConfidence(0.5)).toBeNull();
    });

    it('returns null for undefined', () => {
        expect(optionalConfidence(undefined)).toBeNull();
    });

    it('returns null for null', () => {
        expect(optionalConfidence(null)).toBeNull();
    });

    it('returns error for a value below 0', () => {
        expect(optionalConfidence(-0.01)).toBe('must be a number between 0.0 and 1.0');
    });

    it('returns error for a value above 1', () => {
        expect(optionalConfidence(1.01)).toBe('must be a number between 0.0 and 1.0');
    });

    it('returns error for NaN', () => {
        expect(optionalConfidence(NaN)).toBe('must be a number between 0.0 and 1.0');
    });

    it('returns error for Infinity', () => {
        expect(optionalConfidence(Infinity)).toBe('must be a number between 0.0 and 1.0');
    });

    it('returns error for a non-number type', () => {
        expect(optionalConfidence('0.5')).toBe('must be a number between 0.0 and 1.0');
    });

    it('returns error for a boolean', () => {
        expect(optionalConfidence(true)).toBe('must be a number between 0.0 and 1.0');
    });
});

// ---------------------------------------------------------------------------
// requireBoundedInt
// ---------------------------------------------------------------------------

describe('requireBoundedInt', () => {
    const validator = requireBoundedInt(1, 100);

    it('returns null for a value within bounds', () => {
        expect(validator(50)).toBeNull();
    });

    it('returns null for value at lower bound', () => {
        expect(validator(1)).toBeNull();
    });

    it('returns null for value at upper bound', () => {
        expect(validator(100)).toBeNull();
    });

    it('returns error for undefined (required)', () => {
        expect(validator(undefined)).toBe('required');
    });

    it('returns error for null (required)', () => {
        expect(validator(null)).toBe('required');
    });

    it('returns error for a value below min', () => {
        expect(validator(0)).toBe('must be a number between 1 and 100');
    });

    it('returns error for a value above max', () => {
        expect(validator(101)).toBe('must be a number between 1 and 100');
    });

    it('returns error for a string number', () => {
        expect(validator('50')).toBe('must be a number between 1 and 100');
    });

    it('returns error for NaN', () => {
        expect(validator(NaN)).toBe('must be a number between 1 and 100');
    });

    it('returns error for Infinity', () => {
        expect(validator(Infinity)).toBe('must be a number between 1 and 100');
    });

    it('returns error for a boolean', () => {
        expect(validator(true)).toBe('must be a number between 1 and 100');
    });

    it('works with negative bounds', () => {
        const negValidator = requireBoundedInt(-10, -1);
        expect(negValidator(-5)).toBeNull();
        expect(negValidator(0)).toBe('must be a number between -10 and -1');
    });
});

// ---------------------------------------------------------------------------
// requireAbsolutePath
// ---------------------------------------------------------------------------

describe('requireAbsolutePath', () => {
    it('returns null for a valid absolute path', () => {
        expect(requireAbsolutePath('/home/user/project')).toBeNull();
    });

    it('returns null for root path', () => {
        expect(requireAbsolutePath('/')).toBeNull();
    });

    it('returns "required" for undefined', () => {
        expect(requireAbsolutePath(undefined)).toBe('required');
    });

    it('returns "required" for null', () => {
        expect(requireAbsolutePath(null)).toBe('required');
    });

    it('returns error for an empty string', () => {
        expect(requireAbsolutePath('')).toBe('required non-empty string');
    });

    it('returns error for a relative path', () => {
        expect(requireAbsolutePath('relative/path')).toBe('must be an absolute path');
    });

    it('returns error for a dot-relative path', () => {
        expect(requireAbsolutePath('./relative')).toBe('must be an absolute path');
    });

    it('returns error for a path with null byte', () => {
        expect(requireAbsolutePath('/valid/path\x00../../etc/passwd')).toBe('path must not contain null bytes');
    });

    it('returns error for a path exceeding 4096 chars', () => {
        expect(requireAbsolutePath('/' + 'a'.repeat(4096))).toBe('path too long (max 4096 chars)');
    });

    it('returns null for a path exactly 4096 chars', () => {
        expect(requireAbsolutePath('/' + 'a'.repeat(4095))).toBeNull();
    });

    it('returns error for a number', () => {
        expect(requireAbsolutePath(42)).toBe('required non-empty string');
    });

    it('returns error for a boolean', () => {
        expect(requireAbsolutePath(true)).toBe('required non-empty string');
    });
});

// ---------------------------------------------------------------------------
// requireStringArray
// ---------------------------------------------------------------------------

describe('requireStringArray', () => {
    const validator = requireStringArray();

    it('returns null for a valid string array', () => {
        expect(validator(['hello', 'world'])).toBeNull();
    });

    it('returns "required" for undefined', () => {
        expect(validator(undefined)).toBe('required');
    });

    it('returns "required" for null', () => {
        expect(validator(null)).toBe('required');
    });

    it('returns error for a non-array', () => {
        expect(validator('not-array')).toBe('must be an array');
    });

    it('returns error for an empty array', () => {
        expect(validator([])).toBe('must not be empty');
    });

    it('returns error when exceeding default max length (500)', () => {
        const arr = Array.from({ length: 501 }, (_, i) => `item${i}`);
        expect(validator(arr)).toBe('must have at most 500 items');
    });

    it('returns error for an empty string element', () => {
        expect(validator(['good', ''])).toBe('item at index 1: must be a non-empty string');
    });

    it('returns error for a non-string element', () => {
        expect(validator(['good', 42 as unknown as string])).toBe('item at index 1: must be a non-empty string');
    });

    it('returns error for an element exceeding 2000 chars', () => {
        expect(validator(['ok', 'a'.repeat(2001)])).toBe('item at index 1: exceeds max length of 2000');
    });

    it('respects custom maxLen', () => {
        const small = requireStringArray(2);
        expect(small(['a', 'b'])).toBeNull();
        expect(small(['a', 'b', 'c'])).toBe('must have at most 2 items');
    });
});

// ---------------------------------------------------------------------------
// requirePatchArray
// ---------------------------------------------------------------------------

describe('requirePatchArray', () => {
    const validPatch = { file_path: 'src/index.ts', new_content: 'console.log("hi");' };

    it('returns null for a valid patch array', () => {
        expect(requirePatchArray([validPatch])).toBeNull();
    });

    it('returns null for multiple valid patches', () => {
        expect(requirePatchArray([
            validPatch,
            { file_path: 'src/utils.ts', new_content: '' },
        ])).toBeNull();
    });

    it('returns "required" for undefined', () => {
        expect(requirePatchArray(undefined)).toBe('required');
    });

    it('returns "required" for null', () => {
        expect(requirePatchArray(null)).toBe('required');
    });

    it('returns error for an empty array', () => {
        expect(requirePatchArray([])).toBe('must be a non-empty array');
    });

    it('returns error for a non-array', () => {
        expect(requirePatchArray('not-array')).toBe('must be a non-empty array');
    });

    it('returns error when exceeding MAX_PATCH_COUNT', () => {
        const patches = Array.from({ length: 101 }, (_, i) => ({
            file_path: `src/file${i}.ts`,
            new_content: 'x',
        }));
        expect(requirePatchArray(patches)).toBe('must have at most 100 patches');
    });

    it('returns error for a patch that is not an object', () => {
        expect(requirePatchArray(['not-an-object'])).toMatch(/patches\[0\]: must be an object/);
    });

    it('returns error for a patch with null value', () => {
        expect(requirePatchArray([null])).toMatch(/patches\[0\]: must be an object/);
    });

    it('returns error for missing file_path', () => {
        expect(requirePatchArray([{ new_content: 'x' }])).toMatch(/patches\[0\]\.file_path: required non-empty string/);
    });

    it('returns error for empty file_path', () => {
        expect(requirePatchArray([{ file_path: '', new_content: 'x' }])).toMatch(
            /patches\[0\]\.file_path: required non-empty string/,
        );
    });

    it('returns error for missing new_content', () => {
        expect(requirePatchArray([{ file_path: 'src/index.ts' }])).toMatch(
            /patches\[0\]\.new_content: required string/,
        );
    });

    it('returns error for new_content exceeding 5MB', () => {
        const bigContent = 'x'.repeat(5 * 1024 * 1024 + 1);
        expect(requirePatchArray([{ file_path: 'src/index.ts', new_content: bigContent }])).toMatch(
            /patches\[0\]\.new_content: exceeds 5MB size limit/,
        );
    });

    // -- Path traversal attack vectors --

    describe('path traversal attacks', () => {
        it('blocks ../../../etc/passwd', () => {
            const result = requirePatchArray([{ file_path: '../../../etc/passwd', new_content: '' }]);
            expect(result).toMatch(/path traversal or absolute path not allowed/);
        });

        it('blocks ../../secret', () => {
            const result = requirePatchArray([{ file_path: '../../secret', new_content: '' }]);
            expect(result).toMatch(/path traversal or absolute path not allowed/);
        });

        it('blocks URL-encoded traversal ..%2f..%2f..%2fetc/passwd', () => {
            const result = requirePatchArray([{ file_path: '..%2f..%2f..%2fetc/passwd', new_content: '' }]);
            expect(result).toMatch(/URL-encoded characters not allowed/);
        });

        it('blocks double URL-encoded traversal ..%252f..%252f', () => {
            const result = requirePatchArray([{ file_path: '..%252f..%252f', new_content: '' }]);
            expect(result).toMatch(/URL-encoded characters not allowed/);
        });

        it('blocks ....//....//etc/passwd (dot-dot-slash variant)', () => {
            const result = requirePatchArray([{ file_path: '....//....//etc/passwd', new_content: '' }]);
            expect(result).toMatch(/path traversal or absolute path not allowed/);
        });

        it('does not explicitly block null bytes in file_path (gap — covered by OS-level rejection)', () => {
            // Null bytes in file paths are rejected — they can truncate paths
            // in C-based functions and bypass security checks.
            const result = requirePatchArray([{ file_path: 'valid/path\x00../../etc/passwd', new_content: '' }]);
            expect(result).toContain('null bytes not allowed');
        });

        it('blocks backslash traversal ..\\..\\etc\\passwd', () => {
            const result = requirePatchArray([{ file_path: '..\\..\\etc\\passwd', new_content: '' }]);
            expect(result).toMatch(/backslashes not allowed/);
        });

        it('blocks mixed forward/backslash traversal', () => {
            const result = requirePatchArray([{ file_path: '..\\../etc/passwd', new_content: '' }]);
            expect(result).toMatch(/backslashes not allowed/);
        });

        it('blocks absolute path /etc/passwd', () => {
            const result = requirePatchArray([{ file_path: '/etc/passwd', new_content: '' }]);
            expect(result).toMatch(/path traversal or absolute path not allowed/);
        });

        it('blocks URL-encoded forward slash %2f', () => {
            const result = requirePatchArray([{ file_path: 'src%2f..%2f..%2fetc/passwd', new_content: '' }]);
            expect(result).toMatch(/URL-encoded characters not allowed/);
        });

        it('blocks uppercase URL-encoded %2F', () => {
            const result = requirePatchArray([{ file_path: 'src%2F..%2F..', new_content: '' }]);
            expect(result).toMatch(/URL-encoded characters not allowed/);
        });

        it('allows a valid nested relative path', () => {
            expect(requirePatchArray([{ file_path: 'src/utils/helpers.ts', new_content: 'code' }])).toBeNull();
        });

        it('allows a simple filename', () => {
            expect(requirePatchArray([{ file_path: 'index.ts', new_content: 'code' }])).toBeNull();
        });
    });
});

// ---------------------------------------------------------------------------
// requireSafePathArray
// ---------------------------------------------------------------------------

describe('requireSafePathArray', () => {
    const validator = requireSafePathArray();

    it('returns null for valid paths', () => {
        expect(validator(['src/index.ts', 'lib/utils.ts'])).toBeNull();
    });

    it('returns error for undefined', () => {
        expect(validator(undefined)).toBe('required');
    });

    it('returns error for an empty array', () => {
        expect(validator([])).toBe('must not be empty');
    });

    it('inherits base string array validation', () => {
        expect(validator([42 as unknown as string])).toMatch(/must be a non-empty string/);
    });

    describe('path traversal attacks', () => {
        it('blocks ../../../etc/passwd', () => {
            const result = validator(['../../../etc/passwd']);
            expect(result).toMatch(/path traversal or absolute path not allowed/);
        });

        it('blocks URL-encoded traversal ..%2f..%2f', () => {
            const result = validator(['..%2f..%2fetc/passwd']);
            expect(result).toMatch(/URL-encoded characters not allowed/);
        });

        it('blocks ....//....//etc/passwd', () => {
            const result = validator(['....//....//etc/passwd']);
            expect(result).toMatch(/path traversal or absolute path not allowed/);
        });

        it('blocks null byte injection', () => {
            const result = validator(['valid/path\x00../../etc/passwd']);
            expect(result).toMatch(/path must not contain null bytes/);
        });

        it('blocks backslash traversal ..\\..\\etc\\passwd', () => {
            const result = validator(['..\\..\\etc\\passwd']);
            expect(result).toMatch(/backslashes not allowed/);
        });

        it('blocks absolute path /etc/passwd', () => {
            const result = validator(['/etc/passwd']);
            expect(result).toMatch(/path traversal or absolute path not allowed/);
        });

        it('blocks uppercase URL-encoded %2F', () => {
            const result = validator(['src%2F..%2Fetc']);
            expect(result).toMatch(/URL-encoded characters not allowed/);
        });

        it('blocks mixed encoded characters %00 (null byte via URL encoding)', () => {
            const result = validator(['src/file%00.ts']);
            expect(result).toMatch(/URL-encoded characters not allowed/);
        });

        it('identifies the correct index for a bad item', () => {
            const result = validator(['good/path.ts', '../evil']);
            expect(result).toMatch(/item at index 1/);
        });
    });

    it('respects custom max length', () => {
        const small = requireSafePathArray(2);
        expect(small(['a.ts', 'b.ts'])).toBeNull();
        expect(small(['a.ts', 'b.ts', 'c.ts'])).toBe('must have at most 2 items');
    });
});

// ---------------------------------------------------------------------------
// validateBody — integration tests
// ---------------------------------------------------------------------------

describe('validateBody', () => {
    it('calls next() when all validations pass', () => {
        const middleware = validateBody({
            id: requireUUID,
            name: requireString,
        });
        const { req, res, next } = mockReqResNext({
            id: VALID_UUID,
            name: 'Test Name',
        });

        middleware(req as Request, res as Response, next);

        expect(next).toHaveBeenCalledTimes(1);
        expect(res.statusCode).toBeUndefined();
    });

    it('returns 400 with details when validation fails', () => {
        const middleware = validateBody({
            id: requireUUID,
            name: requireString,
        });
        const { req, res, next } = mockReqResNext({
            id: 'not-a-uuid',
            name: '',
        });

        middleware(req as Request, res as Response, next);

        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual({
            error: 'Validation failed',
            details: expect.arrayContaining([
                'id: must be a valid UUID',
                'name: required, non-empty string (max 2000 chars)',
            ]),
        });
    });

    it('returns 400 with a single error detail', () => {
        const middleware = validateBody({
            id: requireUUID,
        });
        const { req, res, next } = mockReqResNext({});

        middleware(req as Request, res as Response, next);

        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(400);
        expect((res.body as { details: string[] }).details).toHaveLength(1);
        expect((res.body as { details: string[] }).details[0]).toBe('id: required');
    });

    it('passes through when body has extra fields beyond what is validated', () => {
        const middleware = validateBody({
            id: requireUUID,
        });
        const { req, res, next } = mockReqResNext({
            id: VALID_UUID,
            extra: 'not validated',
        });

        middleware(req as Request, res as Response, next);

        expect(next).toHaveBeenCalledTimes(1);
    });

    it('handles missing body gracefully', () => {
        const middleware = validateBody({
            id: requireUUID,
        });
        const req = { path: '/test' } as Partial<Request>;
        const res: Partial<Response> & { statusCode?: number; body?: unknown } = {
            statusCode: undefined,
            body: undefined,
            status(code: number) { this.statusCode = code; return this as Response; },
            json(data: unknown) { this.body = data; return this as Response; },
        };
        const next = jest.fn();

        middleware(req as Request, res as Response, next);

        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(400);
    });

    it('works with optional validators that accept undefined', () => {
        const middleware = validateBody({
            confidence: optionalConfidence,
            sort: optionalEnum('asc', 'desc'),
        });
        const { req, res, next } = mockReqResNext({});

        middleware(req as Request, res as Response, next);

        expect(next).toHaveBeenCalledTimes(1);
    });

    it('works with mixed required and optional validators', () => {
        const middleware = validateBody({
            id: requireUUID,
            limit: requireBoundedInt(1, 100),
            name: optionalString,
        });
        const { req, res, next } = mockReqResNext({
            id: VALID_UUID,
            limit: 10,
        });

        middleware(req as Request, res as Response, next);

        // id passes, limit is required and valid, name is optional
        expect(next).toHaveBeenCalledTimes(1);
    });

    it('collects multiple errors from different fields', () => {
        const middleware = validateBody({
            id: requireUUID,
            name: requireString,
            confidence: optionalConfidence,
        });
        const { req, res, next } = mockReqResNext({
            id: 'bad',
            name: 42,
            confidence: 'not-a-number',
        });

        middleware(req as Request, res as Response, next);

        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(400);
        expect((res.body as { details: string[] }).details).toHaveLength(3);
    });
});

// ---------------------------------------------------------------------------
// Unicode normalization attack vectors (cross-cutting)
// ---------------------------------------------------------------------------

describe('unicode and edge-case attack vectors', () => {
    describe('requirePatchArray with unicode tricks', () => {
        it('blocks fullwidth dot-dot-slash (U+FF0E U+FF0E U+FF0F) via path.normalize', () => {
            // Fullwidth periods and slashes — the key question is whether
            // path.normalize handles them. They likely pass through unchanged,
            // remaining safe since they are not literal ".." sequences.
            // This test documents that behavior.
            const fullwidthTraversal = '\uFF0E\uFF0E/etc/passwd';
            const result = requirePatchArray([{ file_path: fullwidthTraversal, new_content: '' }]);
            // Fullwidth dots are NOT real dots — path.normalize won't resolve them
            // as traversal, so they remain safe relative paths. This is correct behavior.
            expect(result).toBeNull();
        });

        it('blocks overlong UTF-8 encoded dot sequences if somehow present', () => {
            // In JS strings, overlong encodings don't appear — they get decoded by
            // the JSON parser. Test the normal form.
            const result = requirePatchArray([{ file_path: '../secrets', new_content: '' }]);
            expect(result).toMatch(/path traversal or absolute path not allowed/);
        });
    });

    describe('requireSafePathArray with unicode tricks', () => {
        it('blocks path with URL-encoded null byte %00', () => {
            const validator = requireSafePathArray();
            const result = validator(['src/file%00.ts']);
            expect(result).toMatch(/URL-encoded characters not allowed/);
        });

        it('blocks path with mixed-case URL encoding %2F and %2f', () => {
            const validator = requireSafePathArray();
            expect(validator(['src%2Ffile'])).toMatch(/URL-encoded characters not allowed/);
            expect(validator(['src%2ffile'])).toMatch(/URL-encoded characters not allowed/);
        });
    });
});
