/**
 * ContextZero — Deep Contract Synthesis Engine (V2)
 *
 * Mines contracts and invariants directly from source code bodies, type
 * signatures, decorators, and ORM/schema definitions — WITHOUT depending
 * on test files.
 *
 * V1 (contracts.ts) mines from tests, behavioral profiles, and contract
 * profiles. This V2 companion mines from the code itself:
 *
 *   1. Code body analysis: asserts, guards, type guards, null checks,
 *      range checks, regex validators, enum restrictions, normalization.
 *   2. Signature analysis: param types, return types, generics, unions,
 *      optional params.
 *   3. Decorator analysis: validation, auth, schema, rate-limit decorators.
 *   4. ORM/schema definitions: Prisma, TypeORM, Mongoose, Zod/Yup/Joi.
 *   5. Cross-symbol pattern mining: family invariants from repeated patterns.
 *   6. Closure/nested function contracts: captured vars, return path analysis.
 *
 * Call AFTER the V1 ContractEngine to layer deeper invariants on top.
 */

import { v4 as uuidv4 } from 'uuid';
import { db } from '../db-driver';
import { Logger } from '../logger';
import type { InvariantSourceType, InvariantScopeLevel } from '../types';

const log = new Logger('deep-contracts');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface InvariantCandidate {
    expression: string;
    source_type: InvariantSourceType;
    strength: number;
    validation_method: string;
    scope_level: InvariantScopeLevel;
    /** When null, the invariant is global or module-scoped. */
    scope_symbol_id: string | null;
    /** Category tag for cross-symbol aggregation. */
    category: string;
}

/** Aggregated pattern bucket for cross-symbol mining. */
interface PatternBucket {
    pattern: string;
    category: string;
    symbol_ids: string[];
    strength: number;
    validation_method: string;
}

// ---------------------------------------------------------------------------
// Regex libraries — compiled once, reused across all symbols
// ---------------------------------------------------------------------------

// --- Assert / Guard patterns ---
const ASSERT_CALL = /\bassert\s*\(/g;
const CONSOLE_ASSERT = /\bconsole\s*\.\s*assert\s*\(/g;
const IF_THROW = /if\s*\(\s*(![\w.[\]?]+|[\w.[\]?]+\s*(?:===?|!==?)\s*(?:null|undefined|false|0|''|""|``)|![\w.[\]?]+)\s*\)\s*\{?\s*throw\b/g;
const IF_RETURN_GUARD = /if\s*\(\s*(![\w.[\]?]+|[\w.[\]?]+\s*(?:===?|!==?)\s*(?:null|undefined|false|0|''|""|``)|![\w.[\]?]+)\s*\)\s*\{?\s*return\b/g;
const INVARIANT_CALL = /\binvariant\s*\(/g;
const PRECONDITION_CALL = /\bprecondition\s*\(/g;

// --- Type guard patterns ---
const TYPEOF_GUARD = /typeof\s+([\w.]+)\s*(?:===?|!==?)\s*['"](string|number|boolean|function|object|undefined|bigint|symbol)['"]/g;
const INSTANCEOF_GUARD = /([\w.]+)\s+instanceof\s+([\w.]+)/g;
const ARRAY_IS_ARRAY = /Array\s*\.\s*isArray\s*\(\s*([\w.]+)\s*\)/g;
const IS_NAN_CHECK = /(?:Number\s*\.\s*)?isNaN\s*\(\s*([\w.]+)\s*\)/g;
const IS_FINITE_CHECK = /(?:Number\s*\.\s*)?isFinite\s*\(\s*([\w.]+)\s*\)/g;

// --- Null / undefined checks ---
const NULLISH_COALESCE = /([\w.]+)\s*\?\?\s*([^;,\n]+)/g;
const OPTIONAL_CHAIN = /([\w.]+)\s*\?\.\s*([\w.]+)/g;
const NULL_CHECK_IF = /if\s*\(\s*([\w.]+)\s*(?:!==?|===?)\s*(?:null|undefined)\s*\)/g;
const NOT_NULL_CHECK_IF = /if\s*\(\s*([\w.]+)\s*(?:!=)\s*(?:null)\s*\)/g;

// --- Range / boundary checks ---
const RANGE_CHECK = /if\s*\(\s*([\w.]+)\s*(<|>|<=|>=)\s*(-?\d+(?:\.\d+)?)\s*(?:\|\||&&)\s*\1\s*(<|>|<=|>=)\s*(-?\d+(?:\.\d+)?)\s*\)/g;
const MATH_CLAMP_MIN = /Math\s*\.\s*max\s*\(\s*(-?\d+(?:\.\d+)?)\s*,\s*([\w.]+)\s*\)/g;
const MATH_CLAMP_MAX = /Math\s*\.\s*min\s*\(\s*(-?\d+(?:\.\d+)?)\s*,\s*([\w.]+)\s*\)/g;
const MATH_CLAMP_FULL = /Math\s*\.\s*max\s*\(\s*(-?\d+(?:\.\d+)?)\s*,\s*Math\s*\.\s*min\s*\(\s*(-?\d+(?:\.\d+)?)\s*,\s*([\w.]+)\s*\)\s*\)/g;
const SINGLE_BOUND_CHECK = /if\s*\(\s*([\w.]+)\s*(<|>|<=|>=)\s*(-?\d+(?:\.\d+)?)\s*\)/g;
const LENGTH_CHECK = /if\s*\(\s*([\w.]+)\s*\.\s*length\s*(<|>|<=|>=|===?|!==?)\s*(\d+)\s*\)/g;

// --- Regex validators ---
const REGEX_TEST = /(\/(?:[^/\\]|\\.)+\/[gimsuy]*)\s*\.\s*test\s*\(\s*([\w.]+)\s*\)/g;
const REGEX_MATCH = /([\w.]+)\s*\.\s*match\s*\(\s*(\/(?:[^/\\]|\\.)+\/[gimsuy]*)\s*\)/g;
const EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
const URL_PATTERN = /https?:\/\/[^\s'"]+/;
const PHONE_PATTERN = /\(\d{3}\)\s*\d{3}-?\d{4}|\d{3}-\d{3}-\d{4}/;
const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const IPV4_PATTERN = /(?:\d{1,3}\.){3}\d{1,3}/;

// --- Enum restrictions ---
const SWITCH_CASE = /switch\s*\(\s*([\w.]+)\s*\)\s*\{/g;
const CASE_VALUE = /case\s+['"`]?([\w.]+)['"`]?\s*:/g;
const INCLUDES_CHECK = /\[\s*([^\]]+)\s*\]\s*\.\s*includes\s*\(\s*([\w.]+)\s*\)/g;

// --- Input normalization ---
const TRIM_CALL = /([\w.]+)\s*\.\s*trim\s*\(\s*\)/g;
const LOWER_CALL = /([\w.]+)\s*\.\s*toLowerCase\s*\(\s*\)/g;
const UPPER_CALL = /([\w.]+)\s*\.\s*toUpperCase\s*\(\s*\)/g;
const REPLACE_CALL = /([\w.]+)\s*\.\s*replace\s*\(\s*(\/(?:[^/\\]|\\.)+\/[gimsuy]*|['"][^'"]*['"])\s*,/g;
const PARSE_INT_CALL = /parseInt\s*\(\s*([\w.]+)\s*(?:,\s*\d+)?\s*\)/g;
const PARSE_FLOAT_CALL = /parseFloat\s*\(\s*([\w.]+)\s*\)/g;
const NUMBER_CALL = /Number\s*\(\s*([\w.]+)\s*\)/g;
const JSON_PARSE = /JSON\s*\.\s*parse\s*\(\s*([\w.]+)\s*\)/g;

// --- Decorator patterns ---
const DECORATOR_IS_EMAIL = /@IsEmail\s*\(/i;
const DECORATOR_IS_URL = /@IsUrl\s*\(/i;
const DECORATOR_IS_UUID = /@IsUUID\s*\(/i;
const DECORATOR_IS_INT = /@IsInt\s*\(/i;
const DECORATOR_IS_NUMBER = /@IsNumber\s*\(/i;
const DECORATOR_IS_STRING = /@IsString\s*\(/i;
const DECORATOR_IS_BOOLEAN = /@IsBoolean\s*\(/i;
const DECORATOR_IS_DATE = /@IsDate\s*\(/i;
const DECORATOR_IS_ENUM = /@IsEnum\s*\(/i;
const DECORATOR_IS_NOT_EMPTY = /@IsNotEmpty\s*\(/i;
const DECORATOR_IS_OPTIONAL = /@IsOptional\s*\(/i;
const DECORATOR_IS_ARRAY = /@IsArray\s*\(/i;
const DECORATOR_MIN = /@Min\s*\(\s*(-?\d+(?:\.\d+)?)\s*\)/i;
const DECORATOR_MAX = /@Max\s*\(\s*(-?\d+(?:\.\d+)?)\s*\)/i;
const DECORATOR_MIN_LENGTH = /@MinLength\s*\(\s*(\d+)\s*\)/i;
const DECORATOR_MAX_LENGTH = /@MaxLength\s*\(\s*(\d+)\s*\)/i;
const DECORATOR_LENGTH = /@Length\s*\(\s*(\d+)\s*(?:,\s*(\d+))?\s*\)/i;
const DECORATOR_MATCHES = /@Matches\s*\(\s*(\/(?:[^/\\]|\\.)+\/[gimsuy]*)\s*\)/i;
const DECORATOR_REQUIRES_ROLE = /@(?:RequiresRole|Roles?|HasRole)\s*\(\s*['"]([^'"]+)['"]\s*\)/i;
const DECORATOR_AUTHENTICATED = /@(?:Authenticated|UseGuards|Auth|RequireAuth)\s*\(/i;
const DECORATOR_COLUMN = /@Column\s*\(\s*\{([^}]*)\}\s*\)/i;

// --- Rust-specific patterns ---
const RUST_UNWRAP = /\.\s*unwrap\s*\(\s*\)/g;
const RUST_EXPECT = /\.\s*expect\s*\(\s*["']([^"']+)["']\s*\)/g;
const RUST_PANIC = /panic!\s*\(\s*["']([^"']+)["']/g;
const RUST_ASSERT = /assert!\s*\(\s*([^)]+)\)/g;
const RUST_ASSERT_EQ = /assert_eq!\s*\(\s*([^,]+),\s*([^)]+)\)/g;
const RUST_QUESTION_MARK = /(\w[\w.]*)\s*\?/g; // error propagation
const RUST_UNSAFE = /unsafe\s*\{/g;

// --- Java-specific patterns ---
const JAVA_ASSERT = /assert\s+([^;:]+)\s*(?::\s*["']([^"']+)["'])?\s*;/g;
const JAVA_OBJECTS_REQUIRE = /Objects\s*\.\s*requireNonNull\s*\(\s*([\w.]+)/g;
const JAVA_ANNOTATION_NOT_NULL = /@(?:NotNull|NonNull|Nonnull)\b/g;
const JAVA_ANNOTATION_SIZE = /@Size\s*\(\s*(?:min\s*=\s*(\d+))?\s*,?\s*(?:max\s*=\s*(\d+))?\s*\)/i;
const JAVA_ANNOTATION_PATTERN = /@Pattern\s*\(\s*regexp\s*=\s*["']([^"']+)["']\s*\)/i;

// --- C#-specific patterns ---
const CSHARP_THROW_IF = /ArgumentNullException\s*\.\s*ThrowIfNull\s*\(\s*([\w.]+)/g;
const CSHARP_DATA_ANNOTATION_REQUIRED = /\[Required\]/g;
const CSHARP_DATA_ANNOTATION_RANGE = /\[Range\s*\(\s*(-?\d+)\s*,\s*(-?\d+)\s*\)\]/g;
const CSHARP_DATA_ANNOTATION_STRING_LENGTH = /\[StringLength\s*\(\s*(\d+)\s*(?:,\s*MinimumLength\s*=\s*(\d+))?\s*\)\]/g;

// --- Ruby-specific patterns ---
const RUBY_RAISE = /raise\s+(\w[\w:]*)/g;
const RUBY_VALIDATES = /validates\s+:(\w+)\s*,\s*([^\n]+)/g;
const RUBY_VALIDATES_PRESENCE = /validates_presence_of\s+:(\w+)/g;
const RUBY_GUARD_CLAUSE = /return\s+(?:nil|false)?\s+(?:if|unless)\s+/g;
const DECORATOR_RATE_LIMIT = /@(?:RateLimit|Throttle|RateLimiter)\s*\(\s*(\d+)\s*(?:,\s*['"]([^'"]+)['"])?\s*\)/i;
const DECORATOR_VALIDATE = /@(?:Validate|ValidateNested|ValidateIf)\s*\(/i;

// --- ORM / Schema definitions ---
const PRISMA_MODEL_FIELD = /([\w]+)\s+(String|Int|Float|Boolean|DateTime|BigInt|Decimal|Json|Bytes)\s*(\?)?\s*(.*)/g;
const TYPEORM_COLUMN = /@Column\s*\(\s*\{[^}]*type\s*:\s*['"](\w+)['"][^}]*\}\s*\)/g;
const TYPEORM_PRIMARY = /@PrimaryGeneratedColumn\s*\(/g;
const TYPEORM_CREATE_DATE = /@CreateDateColumn\s*\(/g;
const TYPEORM_UPDATE_DATE = /@UpdateDateColumn\s*\(/g;
const MONGOOSE_SCHEMA_TYPE = /(\w+)\s*:\s*\{\s*type\s*:\s*(String|Number|Boolean|Date|Buffer|ObjectId|Array|Map|Schema\.Types\.\w+)/g;
const MONGOOSE_REQUIRED = /required\s*:\s*true/g;
const MONGOOSE_UNIQUE = /unique\s*:\s*true/g;
const MONGOOSE_ENUM = /enum\s*:\s*\[([^\]]+)\]/g;
const MONGOOSE_MIN = /min\s*:\s*(-?\d+(?:\.\d+)?)/g;
const MONGOOSE_MAX = /max\s*:\s*(-?\d+(?:\.\d+)?)/g;
const MONGOOSE_MINLENGTH = /minlength\s*:\s*(\d+)/g;
const MONGOOSE_MAXLENGTH = /maxlength\s*:\s*(\d+)/g;
const MONGOOSE_MATCH = /match\s*:\s*(\/(?:[^/\\]|\\.)+\/[gimsuy]*)/g;

// --- Zod / Yup / Joi ---
const ZOD_STRING = /z\s*\.\s*string\s*\(\s*\)/g;
const ZOD_NUMBER = /z\s*\.\s*number\s*\(\s*\)/g;
const ZOD_BOOLEAN = /z\s*\.\s*boolean\s*\(\s*\)/g;
const ZOD_ENUM = /z\s*\.\s*enum\s*\(\s*\[([^\]]+)\]\s*\)/g;
const ZOD_MIN = /\.min\s*\(\s*(-?\d+(?:\.\d+)?)\s*\)/g;
const ZOD_MAX = /\.max\s*\(\s*(-?\d+(?:\.\d+)?)\s*\)/g;
const ZOD_EMAIL = /\.email\s*\(\s*\)/g;
const ZOD_URL = /\.url\s*\(\s*\)/g;
const ZOD_UUID = /\.uuid\s*\(\s*\)/g;
const ZOD_REGEX = /\.regex\s*\(\s*(\/(?:[^/\\]|\\.)+\/[gimsuy]*)\s*\)/g;
const ZOD_OPTIONAL = /\.optional\s*\(\s*\)/g;
const ZOD_NULLABLE = /\.nullable\s*\(\s*\)/g;
const ZOD_NONNEGATIVE = /\.nonnegative\s*\(\s*\)/g;
const ZOD_POSITIVE = /\.positive\s*\(\s*\)/g;
const ZOD_INT = /\.int\s*\(\s*\)/g;

const YUP_STRING = /yup\s*\.\s*string\s*\(\s*\)/g;
const YUP_NUMBER = /yup\s*\.\s*number\s*\(\s*\)/g;
const YUP_BOOLEAN = /yup\s*\.\s*boolean\s*\(\s*\)/g;
const YUP_REQUIRED = /\.required\s*\(\s*\)/g;
const YUP_EMAIL = /\.email\s*\(\s*\)/g;
const YUP_URL = /\.url\s*\(\s*\)/g;
const YUP_MIN = /\.min\s*\(\s*(-?\d+(?:\.\d+)?)\s*\)/g;
const YUP_MAX = /\.max\s*\(\s*(-?\d+(?:\.\d+)?)\s*\)/g;

const JOI_STRING = /Joi\s*\.\s*string\s*\(\s*\)/g;
const JOI_NUMBER = /Joi\s*\.\s*number\s*\(\s*\)/g;
const JOI_BOOLEAN = /Joi\s*\.\s*boolean\s*\(\s*\)/g;
const JOI_REQUIRED = /\.required\s*\(\s*\)/g;
const JOI_EMAIL = /\.email\s*\(\s*\)/g;
const JOI_URI = /\.uri\s*\(\s*\)/g;
const JOI_MIN = /\.min\s*\(\s*(-?\d+(?:\.\d+)?)\s*\)/g;
const JOI_MAX = /\.max\s*\(\s*(-?\d+(?:\.\d+)?)\s*\)/g;
const JOI_PATTERN = /\.pattern\s*\(\s*(\/(?:[^/\\]|\\.)+\/[gimsuy]*)\s*\)/g;
const JOI_VALID = /\.valid\s*\(\s*([^)]+)\s*\)/g;

// --- Signature type patterns ---
// TS_PARAM parsing is handled by the splitParams + inline regex approach below.
const TS_RETURN_TYPE = /\)\s*:\s*(.+?)(?:\s*\{|=>|$)/;
const TS_GENERIC_CONSTRAINT = /<\s*(\w+)\s+extends\s+([^>,]+)/g;
const TS_UNION_TYPE = /(\w+(?:\s*\|\s*\w+)+)/g;

// --- Closure / nested function patterns ---
const ARROW_FN = /(?:const|let|var)\s+(\w+)\s*=\s*(?:\([^)]*\)|[\w]+)\s*=>/g;
const NESTED_FUNCTION = /function\s+(\w+)\s*\(/g;
const RETURN_STATEMENT = /return\s+([^;]+)/g;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Reset a global regex's lastIndex so it scans from the start. */
function resetRegex(r: RegExp): RegExp {
    r.lastIndex = 0;
    return r;
}

/** Run a global regex and collect all matches. */
function allMatches(re: RegExp, text: string): RegExpExecArray[] {
    resetRegex(re);
    const results: RegExpExecArray[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
        results.push(m);
    }
    return results;
}

/** Count global regex matches. */
function countMatches(re: RegExp, text: string): number {
    return allMatches(re, text).length;
}

/** Classify a regex literal into a human-readable domain name. */
function classifyRegex(pattern: string): string {
    if (EMAIL_PATTERN.test(pattern)) return 'email';
    if (URL_PATTERN.test(pattern)) return 'url';
    if (PHONE_PATTERN.test(pattern)) return 'phone';
    if (UUID_PATTERN.test(pattern)) return 'uuid';
    if (IPV4_PATTERN.test(pattern)) return 'ipv4';
    if (/^\^?\[a-z/.test(pattern) || /^\^?\[A-Z/.test(pattern)) return 'alpha';
    if (/^\^?\[0-9/.test(pattern) || /^\^?\\d/.test(pattern)) return 'numeric';
    if (/date|time|yyyy|mm|dd/i.test(pattern)) return 'datetime';
    return 'custom_pattern';
}

/** Truncate a string for safe embedding in invariant expressions. */
function truncExpr(s: string, maxLen: number = 120): string {
    const cleaned = s.replace(/\s+/g, ' ').trim();
    if (cleaned.length <= maxLen) return cleaned;
    return cleaned.substring(0, maxLen - 3) + '...';
}

// ---------------------------------------------------------------------------
// Deep Contract Synthesizer
// ---------------------------------------------------------------------------

export class DeepContractSynthesizer {

    // -----------------------------------------------------------------------
    // Public API
    // -----------------------------------------------------------------------

    /**
     * Mine deep contracts from ALL symbols in a snapshot.
     * Returns total number of new invariants persisted.
     */
    public async synthesizeContracts(
        repoId: string,
        snapshotId: string
    ): Promise<number> {
        const timer = log.startTimer('synthesizeContracts', { repoId, snapshotId });

        // Count total symbols for logging, without loading body_source
        const countResult = await db.query(
            `SELECT COUNT(*) as cnt FROM symbol_versions WHERE snapshot_id = $1`,
            [snapshotId]
        );
        const totalSymbols = parseInt((countResult.rows[0] as { cnt: string }).cnt, 10);
        log.info('Deep contract synthesis starting', {
            repoId, snapshotId, symbols: totalSymbols,
        });

        let totalCandidates = 0;
        let persisted = 0;
        const BATCH_SIZE = 500;

        // Phase 1: per-symbol body + signature + decorator mining in batches
        // Uses LIMIT/OFFSET to avoid loading all body_source columns at once
        for (let offset = 0; offset < totalSymbols; offset += BATCH_SIZE) {
            const batchResult = await db.query(`
                SELECT sv.*, s.canonical_name, s.kind, s.stable_key, s.repo_id, f.path as file_path
                FROM symbol_versions sv
                JOIN symbols s ON s.symbol_id = sv.symbol_id
                JOIN files f ON f.file_id = sv.file_id
                WHERE sv.snapshot_id = $1
                ORDER BY sv.symbol_version_id
                LIMIT $2 OFFSET $3
            `, [snapshotId, BATCH_SIZE, offset]);

            const svRows = batchResult.rows as import('../db-driver/core_data').SymbolVersionRow[];
            const batchCandidates: InvariantCandidate[] = [];

            for (const sv of svRows) {
                const symbolCandidates: InvariantCandidate[] = [];

                // Mine from body source
                if (sv.body_source) {
                    const bodyCandidates = await this.mineFromBody(
                        sv.symbol_version_id, sv.body_source,
                        sv.symbol_id, repoId, snapshotId, sv.language
                    );
                    symbolCandidates.push(...bodyCandidates);
                }

                // Mine from signature
                if (sv.signature) {
                    const sigCandidates = await this.mineFromSignature(
                        sv.symbol_version_id, sv.signature,
                        sv.symbol_id, repoId, snapshotId
                    );
                    symbolCandidates.push(...sigCandidates);
                }

                // Mine from decorators stored on contract profiles
                const decoratorCandidates = await this.mineFromDecorators(
                    sv.symbol_version_id, sv.symbol_id, repoId, snapshotId
                );
                symbolCandidates.push(...decoratorCandidates);

                batchCandidates.push(...symbolCandidates);
                totalCandidates += symbolCandidates.length;
            }

            // Flush candidates to DB after each batch to bound memory usage
            if (batchCandidates.length > 0) {
                persisted += await this.persistInvariants(batchCandidates, repoId, snapshotId);
            }
        }

        // Phase 3: cross-symbol pattern mining (family-level invariants)
        const crossSymbolCount = await this.mineCrossSymbolPatterns(repoId, snapshotId);

        // Phase 4: update derived_invariants_count on contract profiles
        if (persisted + crossSymbolCount > 0) {
            await db.query(`
                UPDATE contract_profiles cp
                SET derived_invariants_count = sub.cnt
                FROM (
                    SELECT i.scope_symbol_id, COUNT(*) as cnt
                    FROM invariants i
                    WHERE i.repo_id = $1
                    AND i.scope_symbol_id IS NOT NULL
                    GROUP BY i.scope_symbol_id
                ) sub
                JOIN symbol_versions sv ON sv.symbol_id = sub.scope_symbol_id
                WHERE cp.symbol_version_id = sv.symbol_version_id
                AND sv.snapshot_id = $2
            `, [repoId, snapshotId]);
        }

        const totalPersisted = persisted + crossSymbolCount;
        timer({
            candidates_generated: totalCandidates,
            invariants_persisted: persisted,
            cross_symbol_invariants: crossSymbolCount,
            total_persisted: totalPersisted,
        });
        return totalPersisted;
    }

    /**
     * Mine invariant candidates from a single symbol's body source code.
     */
    public async mineFromBody(
        symbolVersionId: string,
        bodySource: string,
        symbolId: string,
        _repoId: string,
        _snapshotId: string,
        language: string = ''
    ): Promise<InvariantCandidate[]> {
        const candidates: InvariantCandidate[] = [];

        this.mineAssertions(bodySource, symbolId, candidates);
        this.mineGuardClauses(bodySource, symbolId, candidates);
        this.mineTypeGuards(bodySource, symbolId, candidates);
        this.mineNullChecks(bodySource, symbolId, candidates);
        this.mineRangeChecks(bodySource, symbolId, candidates);
        this.mineRegexValidators(bodySource, symbolId, candidates);
        this.mineEnumRestrictions(bodySource, symbolId, candidates);
        this.mineInputNormalization(bodySource, symbolId, candidates);
        this.mineOrmSchemaDefinitions(bodySource, symbolId, candidates);
        this.mineZodYupJoiSchemas(bodySource, symbolId, candidates);
        this.mineClosureContracts(bodySource, symbolId, candidates);
        this.mineLanguageSpecificContracts(bodySource, symbolId, candidates, language);

        return candidates;
    }

    /**
     * Mine invariant candidates from a symbol's type/signature info.
     */
    public async mineFromSignature(
        symbolVersionId: string,
        signature: string,
        symbolId: string,
        _repoId: string,
        _snapshotId: string
    ): Promise<InvariantCandidate[]> {
        const candidates: InvariantCandidate[] = [];

        this.mineParamTypes(signature, symbolId, candidates);
        this.mineReturnType(signature, symbolId, candidates);
        this.mineGenericConstraints(signature, symbolId, candidates);
        this.mineUnionTypes(signature, symbolId, candidates);
        this.mineOptionalParams(signature, symbolId, candidates);

        return candidates;
    }

    /**
     * Mine cross-symbol patterns to discover family-level invariants.
     * Looks for repeated validation, auth, normalization, and error patterns.
     * Returns number of family invariants persisted.
     */
    public async mineCrossSymbolPatterns(
        repoId: string,
        snapshotId: string
    ): Promise<number> {
        const timer = log.startTimer('mineCrossSymbolPatterns', { repoId, snapshotId });

        // Query all deep-contract invariants we just created for this snapshot
        const result = await db.query(`
            SELECT i.expression, i.scope_symbol_id, i.validation_method, i.strength
            FROM invariants i
            JOIN symbol_versions sv ON sv.symbol_id = i.scope_symbol_id
            WHERE i.repo_id = $1
            AND sv.snapshot_id = $2
            AND i.source_type = 'assertion'
        `, [repoId, snapshotId]);

        const rows = result.rows as {
            expression: string;
            scope_symbol_id: string;
            validation_method: string;
            strength: number;
        }[];

        // Group invariants by their category prefix (the text before the first colon)
        const buckets = new Map<string, PatternBucket>();

        for (const row of rows) {
            // Extract category from expression like "guard_clause:foo !== null"
            const colonIdx = row.expression.indexOf(':');
            if (colonIdx === -1) continue;
            const category = row.expression.substring(0, colonIdx);
            // Normalize the predicate portion for grouping
            const predicate = row.expression.substring(colonIdx + 1).trim();
            // Normalize away specific variable names to find structural duplicates
            const normalizedPredicate = this.normalizePredicateForGrouping(predicate, category);
            const bucketKey = `${category}::${normalizedPredicate}`;

            const existing = buckets.get(bucketKey);
            if (existing) {
                if (row.scope_symbol_id && !existing.symbol_ids.includes(row.scope_symbol_id)) {
                    existing.symbol_ids.push(row.scope_symbol_id);
                }
                existing.strength = Math.max(existing.strength, row.strength);
            } else {
                buckets.set(bucketKey, {
                    pattern: normalizedPredicate,
                    category,
                    symbol_ids: row.scope_symbol_id ? [row.scope_symbol_id] : [],
                    strength: row.strength,
                    validation_method: row.validation_method,
                });
            }
        }

        // Family invariants require at least FAMILY_THRESHOLD symbols sharing the pattern
        const FAMILY_THRESHOLD = 3;
        const statements: { text: string; params: unknown[] }[] = [];
        let count = 0;

        for (const [, bucket] of buckets) {
            if (bucket.symbol_ids.length < FAMILY_THRESHOLD) continue;

            // Create a module-level family invariant
            const familyExpr = `family_pattern:${bucket.category}:${bucket.pattern} (observed in ${bucket.symbol_ids.length} symbols)`;

            // Boost strength: more symbols observing same pattern = higher confidence
            const boostedStrength = Math.min(0.95, bucket.strength + 0.05 * Math.log2(bucket.symbol_ids.length));

            statements.push({
                text: `INSERT INTO invariants (invariant_id, repo_id, scope_symbol_id, scope_level, expression, source_type, strength, validation_method, last_verified_snapshot_id)
                       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                       ON CONFLICT (repo_id, COALESCE(scope_symbol_id, '00000000-0000-0000-0000-000000000000'::uuid), expression)
                       DO UPDATE SET strength = GREATEST(invariants.strength, EXCLUDED.strength),
                                     last_verified_snapshot_id = EXCLUDED.last_verified_snapshot_id`,
                params: [
                    uuidv4(), repoId, null, 'module',
                    truncExpr(familyExpr, 500),
                    'derived', boostedStrength,
                    'cross_symbol_pattern_mining', snapshotId,
                ],
            });
            count++;

            // Also check for global-level patterns (10+ symbols)
            if (bucket.symbol_ids.length >= 10) {
                const globalExpr = `global_invariant:${bucket.category}:${bucket.pattern} (universal pattern across ${bucket.symbol_ids.length} symbols)`;
                statements.push({
                    text: `INSERT INTO invariants (invariant_id, repo_id, scope_symbol_id, scope_level, expression, source_type, strength, validation_method, last_verified_snapshot_id)
                           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                           ON CONFLICT (repo_id, COALESCE(scope_symbol_id, '00000000-0000-0000-0000-000000000000'::uuid), expression)
                           DO UPDATE SET strength = GREATEST(invariants.strength, EXCLUDED.strength),
                                         last_verified_snapshot_id = EXCLUDED.last_verified_snapshot_id`,
                    params: [
                        uuidv4(), repoId, null, 'global',
                        truncExpr(globalExpr, 500),
                        'derived', Math.min(0.98, boostedStrength + 0.05),
                        'cross_symbol_pattern_mining', snapshotId,
                    ],
                });
                count++;
            }
        }

        // Mine auth pattern: if most route handlers / API symbols check auth,
        // infer global auth invariant
        const authStatementsStart = statements.length;
        await this.mineGlobalAuthPattern(repoId, snapshotId, statements);
        const authCount = statements.length - authStatementsStart;

        if (statements.length > 0) {
            await db.batchInsert(statements);
        }

        const totalCount = count + authCount;
        timer({ family_invariants: totalCount });
        return totalCount;
    }

    /**
     * Persist an array of invariant candidates to the database.
     * Deduplicates by (repo_id, scope_symbol_id, expression).
     * Returns number of invariants persisted.
     */
    public async persistInvariants(
        candidates: InvariantCandidate[],
        repoId: string,
        snapshotId: string
    ): Promise<number> {
        if (candidates.length === 0) return 0;

        const timer = log.startTimer('persistInvariants', {
            repoId, candidates: candidates.length,
        });

        // Deduplicate candidates in memory before hitting DB
        const seen = new Set<string>();
        const unique: InvariantCandidate[] = [];
        for (const c of candidates) {
            const key = `${c.scope_symbol_id ?? 'null'}::${c.expression}`;
            if (!seen.has(key)) {
                seen.add(key);
                unique.push(c);
            }
        }

        const BATCH_SIZE = 500;
        let persisted = 0;

        for (let i = 0; i < unique.length; i += BATCH_SIZE) {
            const batch = unique.slice(i, i + BATCH_SIZE);
            const statements: { text: string; params: unknown[] }[] = [];

            for (const c of batch) {
                statements.push({
                    text: `INSERT INTO invariants (invariant_id, repo_id, scope_symbol_id, scope_level, expression, source_type, strength, validation_method, last_verified_snapshot_id)
                           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                           ON CONFLICT (repo_id, COALESCE(scope_symbol_id, '00000000-0000-0000-0000-000000000000'::uuid), expression)
                           DO UPDATE SET strength = GREATEST(invariants.strength, EXCLUDED.strength),
                                         last_verified_snapshot_id = EXCLUDED.last_verified_snapshot_id`,
                    params: [
                        uuidv4(), repoId, c.scope_symbol_id, c.scope_level,
                        c.expression, c.source_type, c.strength,
                        c.validation_method, snapshotId,
                    ],
                });
            }

            await db.batchInsert(statements);
            persisted += batch.length;
        }

        timer({ persisted, deduplicated: candidates.length - unique.length });
        return persisted;
    }

    // -----------------------------------------------------------------------
    // Body Mining — Assertions
    // -----------------------------------------------------------------------

    private mineAssertions(
        body: string,
        symbolId: string,
        out: InvariantCandidate[]
    ): void {
        // assert(expr)
        for (const m of allMatches(ASSERT_CALL, body)) {
            const exprStart = m.index + m[0].length;
            const assertExpr = this.extractBalancedParenContent(body, exprStart - 1);
            if (assertExpr) {
                out.push({
                    expression: `assert:${truncExpr(assertExpr)}`,
                    source_type: 'assertion',
                    strength: 0.90,
                    validation_method: 'code_body_assert',
                    scope_level: 'symbol',
                    scope_symbol_id: symbolId,
                    category: 'assert',
                });
            }
        }

        // console.assert(expr)
        for (const m of allMatches(CONSOLE_ASSERT, body)) {
            const exprStart = m.index + m[0].length;
            const assertExpr = this.extractBalancedParenContent(body, exprStart - 1);
            if (assertExpr) {
                out.push({
                    expression: `console_assert:${truncExpr(assertExpr)}`,
                    source_type: 'assertion',
                    strength: 0.85,
                    validation_method: 'code_body_assert',
                    scope_level: 'symbol',
                    scope_symbol_id: symbolId,
                    category: 'assert',
                });
            }
        }

        // invariant(expr) — common in React/Relay codebases
        for (const m of allMatches(INVARIANT_CALL, body)) {
            const exprStart = m.index + m[0].length;
            const assertExpr = this.extractBalancedParenContent(body, exprStart - 1);
            if (assertExpr) {
                out.push({
                    expression: `invariant_call:${truncExpr(assertExpr)}`,
                    source_type: 'assertion',
                    strength: 0.92,
                    validation_method: 'code_body_invariant',
                    scope_level: 'symbol',
                    scope_symbol_id: symbolId,
                    category: 'assert',
                });
            }
        }

        // precondition(expr)
        for (const m of allMatches(PRECONDITION_CALL, body)) {
            const exprStart = m.index + m[0].length;
            const assertExpr = this.extractBalancedParenContent(body, exprStart - 1);
            if (assertExpr) {
                out.push({
                    expression: `precondition:${truncExpr(assertExpr)}`,
                    source_type: 'assertion',
                    strength: 0.93,
                    validation_method: 'code_body_precondition',
                    scope_level: 'symbol',
                    scope_symbol_id: symbolId,
                    category: 'precondition',
                });
            }
        }
    }

    // -----------------------------------------------------------------------
    // Body Mining — Guard Clauses
    // -----------------------------------------------------------------------

    private mineGuardClauses(
        body: string,
        symbolId: string,
        out: InvariantCandidate[]
    ): void {
        // if (!x) throw / if (x === null) throw
        for (const m of allMatches(IF_THROW, body)) {
            const condition = m[1] ?? '';
            if (!condition) continue;
            out.push({
                expression: `guard_clause:${truncExpr(condition)} => throw`,
                source_type: 'assertion',
                strength: 0.88,
                validation_method: 'code_body_guard_throw',
                scope_level: 'symbol',
                scope_symbol_id: symbolId,
                category: 'guard_clause',
            });
        }

        // if (!x) return / if (x === null) return — early exit guard
        for (const m of allMatches(IF_RETURN_GUARD, body)) {
            const condition = m[1] ?? '';
            if (!condition) continue;
            out.push({
                expression: `guard_clause:${truncExpr(condition)} => early_return`,
                source_type: 'assertion',
                strength: 0.75,
                validation_method: 'code_body_guard_return',
                scope_level: 'symbol',
                scope_symbol_id: symbolId,
                category: 'guard_clause',
            });
        }
    }

    // -----------------------------------------------------------------------
    // Body Mining — Type Guards
    // -----------------------------------------------------------------------

    private mineTypeGuards(
        body: string,
        symbolId: string,
        out: InvariantCandidate[]
    ): void {
        // typeof x === 'string'
        for (const m of allMatches(TYPEOF_GUARD, body)) {
            out.push({
                expression: `type_guard:typeof ${m[1]} === '${m[2]}'`,
                source_type: 'assertion',
                strength: 0.82,
                validation_method: 'code_body_typeof',
                scope_level: 'symbol',
                scope_symbol_id: symbolId,
                category: 'type_guard',
            });
        }

        // x instanceof Foo
        for (const m of allMatches(INSTANCEOF_GUARD, body)) {
            out.push({
                expression: `type_guard:${m[1]} instanceof ${m[2]}`,
                source_type: 'assertion',
                strength: 0.82,
                validation_method: 'code_body_instanceof',
                scope_level: 'symbol',
                scope_symbol_id: symbolId,
                category: 'type_guard',
            });
        }

        // Array.isArray(x)
        for (const m of allMatches(ARRAY_IS_ARRAY, body)) {
            out.push({
                expression: `type_guard:Array.isArray(${m[1]})`,
                source_type: 'assertion',
                strength: 0.82,
                validation_method: 'code_body_isarray',
                scope_level: 'symbol',
                scope_symbol_id: symbolId,
                category: 'type_guard',
            });
        }

        // isNaN(x) check
        for (const m of allMatches(IS_NAN_CHECK, body)) {
            out.push({
                expression: `type_guard:isNaN(${m[1]}) checked`,
                source_type: 'assertion',
                strength: 0.78,
                validation_method: 'code_body_isnan',
                scope_level: 'symbol',
                scope_symbol_id: symbolId,
                category: 'type_guard',
            });
        }

        // isFinite(x) check
        for (const m of allMatches(IS_FINITE_CHECK, body)) {
            out.push({
                expression: `type_guard:isFinite(${m[1]}) checked`,
                source_type: 'assertion',
                strength: 0.78,
                validation_method: 'code_body_isfinite',
                scope_level: 'symbol',
                scope_symbol_id: symbolId,
                category: 'type_guard',
            });
        }
    }

    // -----------------------------------------------------------------------
    // Body Mining — Null Checks
    // -----------------------------------------------------------------------

    private mineNullChecks(
        body: string,
        symbolId: string,
        out: InvariantCandidate[]
    ): void {
        // x ?? default
        for (const m of allMatches(NULLISH_COALESCE, body)) {
            out.push({
                expression: `null_safety:${m[1]} has nullish fallback ${truncExpr(m[2] ?? '', 60)}`,
                source_type: 'assertion',
                strength: 0.72,
                validation_method: 'code_body_nullish_coalesce',
                scope_level: 'symbol',
                scope_symbol_id: symbolId,
                category: 'null_safety',
            });
        }

        // x?.method()
        for (const m of allMatches(OPTIONAL_CHAIN, body)) {
            out.push({
                expression: `null_safety:${m[1]} optional-chained to ${m[2]}`,
                source_type: 'assertion',
                strength: 0.68,
                validation_method: 'code_body_optional_chain',
                scope_level: 'symbol',
                scope_symbol_id: symbolId,
                category: 'null_safety',
            });
        }

        // if (x !== null) / if (x === undefined)
        for (const m of allMatches(NULL_CHECK_IF, body)) {
            out.push({
                expression: `null_check:${m[1]} explicitly checked against null/undefined`,
                source_type: 'assertion',
                strength: 0.80,
                validation_method: 'code_body_null_check',
                scope_level: 'symbol',
                scope_symbol_id: symbolId,
                category: 'null_check',
            });
        }

        // if (x != null) — loose null check covers both null and undefined
        for (const m of allMatches(NOT_NULL_CHECK_IF, body)) {
            out.push({
                expression: `null_check:${m[1]} loosely checked (covers null + undefined)`,
                source_type: 'assertion',
                strength: 0.80,
                validation_method: 'code_body_loose_null_check',
                scope_level: 'symbol',
                scope_symbol_id: symbolId,
                category: 'null_check',
            });
        }
    }

    // -----------------------------------------------------------------------
    // Body Mining — Range / Boundary Checks
    // -----------------------------------------------------------------------

    private mineRangeChecks(
        body: string,
        symbolId: string,
        out: InvariantCandidate[]
    ): void {
        // Math.max(lo, Math.min(hi, x)) — full clamp
        for (const m of allMatches(MATH_CLAMP_FULL, body)) {
            out.push({
                expression: `range_clamp:${m[3]} clamped to [${m[1]}, ${m[2]}]`,
                source_type: 'assertion',
                strength: 0.88,
                validation_method: 'code_body_math_clamp',
                scope_level: 'symbol',
                scope_symbol_id: symbolId,
                category: 'range_check',
            });
        }

        // if (x < lo || x > hi) — two-sided range check
        for (const m of allMatches(RANGE_CHECK, body)) {
            out.push({
                expression: `range_check:${m[1]} ${m[2]} ${m[3]} and ${m[1]} ${m[4]} ${m[5]}`,
                source_type: 'assertion',
                strength: 0.85,
                validation_method: 'code_body_range_check',
                scope_level: 'symbol',
                scope_symbol_id: symbolId,
                category: 'range_check',
            });
        }

        // Math.max(lo, x) — lower bound clamp
        for (const m of allMatches(MATH_CLAMP_MIN, body)) {
            out.push({
                expression: `range_lower_bound:${m[2]} >= ${m[1]} (clamped)`,
                source_type: 'assertion',
                strength: 0.83,
                validation_method: 'code_body_math_max',
                scope_level: 'symbol',
                scope_symbol_id: symbolId,
                category: 'range_check',
            });
        }

        // Math.min(hi, x) — upper bound clamp
        for (const m of allMatches(MATH_CLAMP_MAX, body)) {
            out.push({
                expression: `range_upper_bound:${m[2]} <= ${m[1]} (clamped)`,
                source_type: 'assertion',
                strength: 0.83,
                validation_method: 'code_body_math_min',
                scope_level: 'symbol',
                scope_symbol_id: symbolId,
                category: 'range_check',
            });
        }

        // if (x > N) — single boundary check
        for (const m of allMatches(SINGLE_BOUND_CHECK, body)) {
            out.push({
                expression: `boundary_check:${m[1]} ${m[2]} ${m[3]}`,
                source_type: 'assertion',
                strength: 0.78,
                validation_method: 'code_body_boundary_check',
                scope_level: 'symbol',
                scope_symbol_id: symbolId,
                category: 'range_check',
            });
        }

        // if (x.length > N) — length check
        for (const m of allMatches(LENGTH_CHECK, body)) {
            out.push({
                expression: `length_check:${m[1]}.length ${m[2]} ${m[3]}`,
                source_type: 'assertion',
                strength: 0.80,
                validation_method: 'code_body_length_check',
                scope_level: 'symbol',
                scope_symbol_id: symbolId,
                category: 'length_check',
            });
        }
    }

    // -----------------------------------------------------------------------
    // Body Mining — Regex Validators
    // -----------------------------------------------------------------------

    private mineRegexValidators(
        body: string,
        symbolId: string,
        out: InvariantCandidate[]
    ): void {
        // /pattern/.test(x)
        for (const m of allMatches(REGEX_TEST, body)) {
            if (!m[1] || !m[2]) continue;
            const pattern = m[1];
            const variable = m[2];
            const domain = classifyRegex(pattern);
            out.push({
                expression: `regex_validation:${variable} must match ${domain} pattern ${truncExpr(pattern, 80)}`,
                source_type: 'assertion',
                strength: domain === 'custom_pattern' ? 0.75 : 0.85,
                validation_method: 'code_body_regex_test',
                scope_level: 'symbol',
                scope_symbol_id: symbolId,
                category: `regex_${domain}`,
            });
        }

        // x.match(/pattern/)
        for (const m of allMatches(REGEX_MATCH, body)) {
            if (!m[1] || !m[2]) continue;
            const variable = m[1];
            const pattern = m[2];
            const domain = classifyRegex(pattern);
            out.push({
                expression: `regex_validation:${variable} matched against ${domain} pattern ${truncExpr(pattern, 80)}`,
                source_type: 'assertion',
                strength: domain === 'custom_pattern' ? 0.72 : 0.82,
                validation_method: 'code_body_regex_match',
                scope_level: 'symbol',
                scope_symbol_id: symbolId,
                category: `regex_${domain}`,
            });
        }
    }

    // -----------------------------------------------------------------------
    // Body Mining — Enum Restrictions
    // -----------------------------------------------------------------------

    private mineEnumRestrictions(
        body: string,
        symbolId: string,
        out: InvariantCandidate[]
    ): void {
        // switch(x) { case A: case B: ... }
        for (const m of allMatches(SWITCH_CASE, body)) {
            if (!m[1]) continue;
            const switchVar = m[1];
            // Extract all case values following the switch
            const switchBody = body.substring(m.index);
            const caseMatches = allMatches(CASE_VALUE, switchBody);
            if (caseMatches.length > 0) {
                const caseValues = caseMatches.map(cm => cm[1] ?? '').filter(Boolean);
                // Only emit if there are a reasonable number of cases (likely enum)
                if (caseValues.length >= 2 && caseValues.length <= 50) {
                    out.push({
                        expression: `enum_restriction:${switchVar} in {${caseValues.join(', ')}}`,
                        source_type: 'assertion',
                        strength: 0.82,
                        validation_method: 'code_body_switch_enum',
                        scope_level: 'symbol',
                        scope_symbol_id: symbolId,
                        category: 'enum_restriction',
                    });
                }
            }
        }

        // [A, B, C].includes(x)
        for (const m of allMatches(INCLUDES_CHECK, body)) {
            if (!m[1] || !m[2]) continue;
            const values = m[1].trim();
            const variable = m[2];
            out.push({
                expression: `enum_restriction:${variable} in [${truncExpr(values, 80)}]`,
                source_type: 'assertion',
                strength: 0.82,
                validation_method: 'code_body_includes_enum',
                scope_level: 'symbol',
                scope_symbol_id: symbolId,
                category: 'enum_restriction',
            });
        }
    }

    // -----------------------------------------------------------------------
    // Body Mining — Input Normalization
    // -----------------------------------------------------------------------

    private mineInputNormalization(
        body: string,
        symbolId: string,
        out: InvariantCandidate[]
    ): void {
        // .trim()
        for (const m of allMatches(TRIM_CALL, body)) {
            out.push({
                expression: `normalization:${m[1]} is trimmed`,
                source_type: 'derived',
                strength: 0.70,
                validation_method: 'code_body_normalization',
                scope_level: 'symbol',
                scope_symbol_id: symbolId,
                category: 'normalization_trim',
            });
        }

        // .toLowerCase()
        for (const m of allMatches(LOWER_CALL, body)) {
            out.push({
                expression: `normalization:${m[1]} is lowercased`,
                source_type: 'derived',
                strength: 0.70,
                validation_method: 'code_body_normalization',
                scope_level: 'symbol',
                scope_symbol_id: symbolId,
                category: 'normalization_lowercase',
            });
        }

        // .toUpperCase()
        for (const m of allMatches(UPPER_CALL, body)) {
            out.push({
                expression: `normalization:${m[1]} is uppercased`,
                source_type: 'derived',
                strength: 0.70,
                validation_method: 'code_body_normalization',
                scope_level: 'symbol',
                scope_symbol_id: symbolId,
                category: 'normalization_uppercase',
            });
        }

        // .replace(pattern, ...)
        for (const m of allMatches(REPLACE_CALL, body)) {
            out.push({
                expression: `normalization:${m[1]} undergoes replace(${truncExpr(m[2] ?? '', 60)})`,
                source_type: 'derived',
                strength: 0.68,
                validation_method: 'code_body_normalization',
                scope_level: 'symbol',
                scope_symbol_id: symbolId,
                category: 'normalization_replace',
            });
        }

        // parseInt / parseFloat / Number() — type coercion normalization
        for (const m of allMatches(PARSE_INT_CALL, body)) {
            out.push({
                expression: `normalization:${m[1]} parsed as integer`,
                source_type: 'derived',
                strength: 0.72,
                validation_method: 'code_body_normalization',
                scope_level: 'symbol',
                scope_symbol_id: symbolId,
                category: 'normalization_parse',
            });
        }

        for (const m of allMatches(PARSE_FLOAT_CALL, body)) {
            out.push({
                expression: `normalization:${m[1]} parsed as float`,
                source_type: 'derived',
                strength: 0.72,
                validation_method: 'code_body_normalization',
                scope_level: 'symbol',
                scope_symbol_id: symbolId,
                category: 'normalization_parse',
            });
        }

        for (const m of allMatches(NUMBER_CALL, body)) {
            out.push({
                expression: `normalization:${m[1]} coerced to Number`,
                source_type: 'derived',
                strength: 0.72,
                validation_method: 'code_body_normalization',
                scope_level: 'symbol',
                scope_symbol_id: symbolId,
                category: 'normalization_parse',
            });
        }

        // JSON.parse() — deserialization contract
        for (const m of allMatches(JSON_PARSE, body)) {
            out.push({
                expression: `deserialization:${m[1]} is JSON-parsed (may throw SyntaxError)`,
                source_type: 'derived',
                strength: 0.75,
                validation_method: 'code_body_json_parse',
                scope_level: 'symbol',
                scope_symbol_id: symbolId,
                category: 'deserialization',
            });
        }
    }

    // -----------------------------------------------------------------------
    // Body Mining — ORM / Schema Definitions
    // -----------------------------------------------------------------------

    private mineOrmSchemaDefinitions(
        body: string,
        symbolId: string,
        out: InvariantCandidate[]
    ): void {
        // TypeORM @Column({ type: 'varchar', ... })
        for (const m of allMatches(TYPEORM_COLUMN, body)) {
            if (!m[1]) continue;
            const columnType = m[1];
            out.push({
                expression: `schema_orm:TypeORM column type=${columnType}`,
                source_type: 'schema',
                strength: 0.90,
                validation_method: 'code_body_typeorm_schema',
                scope_level: 'symbol',
                scope_symbol_id: symbolId,
                category: 'schema_typeorm',
            });

            // Extract additional constraints from the decorator body
            const decoratorBody = m[0];
            if (/nullable\s*:\s*false/.test(decoratorBody)) {
                out.push({
                    expression: `schema_orm:column is NOT NULL`,
                    source_type: 'schema',
                    strength: 0.92,
                    validation_method: 'code_body_typeorm_schema',
                    scope_level: 'symbol',
                    scope_symbol_id: symbolId,
                    category: 'schema_typeorm',
                });
            }
            if (/unique\s*:\s*true/.test(decoratorBody)) {
                out.push({
                    expression: `schema_orm:column is UNIQUE`,
                    source_type: 'schema',
                    strength: 0.92,
                    validation_method: 'code_body_typeorm_schema',
                    scope_level: 'symbol',
                    scope_symbol_id: symbolId,
                    category: 'schema_typeorm',
                });
            }
            const lengthMatch = /length\s*:\s*(\d+)/.exec(decoratorBody);
            if (lengthMatch) {
                out.push({
                    expression: `schema_orm:column max length=${lengthMatch[1]}`,
                    source_type: 'schema',
                    strength: 0.90,
                    validation_method: 'code_body_typeorm_schema',
                    scope_level: 'symbol',
                    scope_symbol_id: symbolId,
                    category: 'schema_typeorm',
                });
            }
            const defaultMatch = /default\s*:\s*([^,}]+)/.exec(decoratorBody);
            if (defaultMatch) {
                out.push({
                    expression: `schema_orm:column default=${truncExpr(defaultMatch[1] ?? '', 60)}`,
                    source_type: 'schema',
                    strength: 0.85,
                    validation_method: 'code_body_typeorm_schema',
                    scope_level: 'symbol',
                    scope_symbol_id: symbolId,
                    category: 'schema_typeorm',
                });
            }
        }

        // TypeORM @PrimaryGeneratedColumn
        if (countMatches(TYPEORM_PRIMARY, body) > 0) {
            out.push({
                expression: `schema_orm:has auto-generated primary key`,
                source_type: 'schema',
                strength: 0.95,
                validation_method: 'code_body_typeorm_schema',
                scope_level: 'symbol',
                scope_symbol_id: symbolId,
                category: 'schema_typeorm',
            });
        }

        // TypeORM @CreateDateColumn / @UpdateDateColumn
        if (countMatches(TYPEORM_CREATE_DATE, body) > 0) {
            out.push({
                expression: `schema_orm:has auto-managed created_at timestamp`,
                source_type: 'schema',
                strength: 0.90,
                validation_method: 'code_body_typeorm_schema',
                scope_level: 'symbol',
                scope_symbol_id: symbolId,
                category: 'schema_typeorm',
            });
        }
        if (countMatches(TYPEORM_UPDATE_DATE, body) > 0) {
            out.push({
                expression: `schema_orm:has auto-managed updated_at timestamp`,
                source_type: 'schema',
                strength: 0.90,
                validation_method: 'code_body_typeorm_schema',
                scope_level: 'symbol',
                scope_symbol_id: symbolId,
                category: 'schema_typeorm',
            });
        }

        // Mongoose schema definitions: { type: String, required: true, ... }
        for (const m of allMatches(MONGOOSE_SCHEMA_TYPE, body)) {
            if (!m[1] || !m[2]) continue;
            const fieldName = m[1];
            const fieldType = m[2];
            out.push({
                expression: `schema_mongoose:${fieldName} type=${fieldType}`,
                source_type: 'schema',
                strength: 0.88,
                validation_method: 'code_body_mongoose_schema',
                scope_level: 'symbol',
                scope_symbol_id: symbolId,
                category: 'schema_mongoose',
            });
        }

        // Mongoose constraints within the same body
        if (countMatches(MONGOOSE_REQUIRED, body) > 0) {
            out.push({
                expression: `schema_mongoose:has required field(s)`,
                source_type: 'schema',
                strength: 0.88,
                validation_method: 'code_body_mongoose_schema',
                scope_level: 'symbol',
                scope_symbol_id: symbolId,
                category: 'schema_mongoose',
            });
        }
        if (countMatches(MONGOOSE_UNIQUE, body) > 0) {
            out.push({
                expression: `schema_mongoose:has unique field(s)`,
                source_type: 'schema',
                strength: 0.88,
                validation_method: 'code_body_mongoose_schema',
                scope_level: 'symbol',
                scope_symbol_id: symbolId,
                category: 'schema_mongoose',
            });
        }

        for (const m of allMatches(MONGOOSE_ENUM, body)) {
            out.push({
                expression: `schema_mongoose:field restricted to enum [${truncExpr(m[1] ?? '', 80)}]`,
                source_type: 'schema',
                strength: 0.88,
                validation_method: 'code_body_mongoose_schema',
                scope_level: 'symbol',
                scope_symbol_id: symbolId,
                category: 'schema_mongoose',
            });
        }

        for (const m of allMatches(MONGOOSE_MIN, body)) {
            out.push({
                expression: `schema_mongoose:field min=${m[1]}`,
                source_type: 'schema',
                strength: 0.85,
                validation_method: 'code_body_mongoose_schema',
                scope_level: 'symbol',
                scope_symbol_id: symbolId,
                category: 'schema_mongoose',
            });
        }

        for (const m of allMatches(MONGOOSE_MAX, body)) {
            out.push({
                expression: `schema_mongoose:field max=${m[1]}`,
                source_type: 'schema',
                strength: 0.85,
                validation_method: 'code_body_mongoose_schema',
                scope_level: 'symbol',
                scope_symbol_id: symbolId,
                category: 'schema_mongoose',
            });
        }

        for (const m of allMatches(MONGOOSE_MINLENGTH, body)) {
            out.push({
                expression: `schema_mongoose:field minlength=${m[1]}`,
                source_type: 'schema',
                strength: 0.85,
                validation_method: 'code_body_mongoose_schema',
                scope_level: 'symbol',
                scope_symbol_id: symbolId,
                category: 'schema_mongoose',
            });
        }

        for (const m of allMatches(MONGOOSE_MAXLENGTH, body)) {
            out.push({
                expression: `schema_mongoose:field maxlength=${m[1]}`,
                source_type: 'schema',
                strength: 0.85,
                validation_method: 'code_body_mongoose_schema',
                scope_level: 'symbol',
                scope_symbol_id: symbolId,
                category: 'schema_mongoose',
            });
        }

        for (const m of allMatches(MONGOOSE_MATCH, body)) {
            out.push({
                expression: `schema_mongoose:field must match ${truncExpr(m[1] ?? '', 80)}`,
                source_type: 'schema',
                strength: 0.85,
                validation_method: 'code_body_mongoose_schema',
                scope_level: 'symbol',
                scope_symbol_id: symbolId,
                category: 'schema_mongoose',
            });
        }

        // Prisma-style model field definitions (detected in body for inline schema refs)
        for (const m of allMatches(PRISMA_MODEL_FIELD, body)) {
            if (!m[1] || !m[2]) continue;
            const fieldName = m[1];
            const fieldType = m[2];
            const isOptional = m[3] === '?';
            const annotations = m[4] || '';
            out.push({
                expression: `schema_prisma:${fieldName} type=${fieldType}${isOptional ? '?' : ''}${annotations ? ` ${truncExpr(annotations, 60)}` : ''}`,
                source_type: 'schema',
                strength: 0.90,
                validation_method: 'code_body_prisma_schema',
                scope_level: 'symbol',
                scope_symbol_id: symbolId,
                category: 'schema_prisma',
            });
        }
    }

    // -----------------------------------------------------------------------
    // Body Mining — Zod / Yup / Joi Schema Expressions
    // -----------------------------------------------------------------------

    private mineZodYupJoiSchemas(
        body: string,
        symbolId: string,
        out: InvariantCandidate[]
    ): void {
        // --- Zod ---
        const hasZod = body.includes('z.string') || body.includes('z.number') ||
                       body.includes('z.boolean') || body.includes('z.object') ||
                       body.includes('z.enum') || body.includes('z.array');

        if (hasZod) {
            if (countMatches(ZOD_STRING, body) > 0) {
                out.push({
                    expression: `schema_zod:validates string type`,
                    source_type: 'schema',
                    strength: 0.88,
                    validation_method: 'code_body_zod_schema',
                    scope_level: 'symbol',
                    scope_symbol_id: symbolId,
                    category: 'schema_zod',
                });
            }
            if (countMatches(ZOD_NUMBER, body) > 0) {
                out.push({
                    expression: `schema_zod:validates number type`,
                    source_type: 'schema',
                    strength: 0.88,
                    validation_method: 'code_body_zod_schema',
                    scope_level: 'symbol',
                    scope_symbol_id: symbolId,
                    category: 'schema_zod',
                });
            }
            if (countMatches(ZOD_BOOLEAN, body) > 0) {
                out.push({
                    expression: `schema_zod:validates boolean type`,
                    source_type: 'schema',
                    strength: 0.88,
                    validation_method: 'code_body_zod_schema',
                    scope_level: 'symbol',
                    scope_symbol_id: symbolId,
                    category: 'schema_zod',
                });
            }

            for (const m of allMatches(ZOD_ENUM, body)) {
                out.push({
                    expression: `schema_zod:enum restricted to [${truncExpr(m[1] ?? '', 80)}]`,
                    source_type: 'schema',
                    strength: 0.90,
                    validation_method: 'code_body_zod_schema',
                    scope_level: 'symbol',
                    scope_symbol_id: symbolId,
                    category: 'schema_zod',
                });
            }

            for (const m of allMatches(ZOD_MIN, body)) {
                out.push({
                    expression: `schema_zod:min=${m[1]}`,
                    source_type: 'schema',
                    strength: 0.87,
                    validation_method: 'code_body_zod_schema',
                    scope_level: 'symbol',
                    scope_symbol_id: symbolId,
                    category: 'schema_zod',
                });
            }

            for (const m of allMatches(ZOD_MAX, body)) {
                out.push({
                    expression: `schema_zod:max=${m[1]}`,
                    source_type: 'schema',
                    strength: 0.87,
                    validation_method: 'code_body_zod_schema',
                    scope_level: 'symbol',
                    scope_symbol_id: symbolId,
                    category: 'schema_zod',
                });
            }

            if (countMatches(ZOD_EMAIL, body) > 0) {
                out.push({
                    expression: `schema_zod:validates email format`,
                    source_type: 'schema',
                    strength: 0.90,
                    validation_method: 'code_body_zod_schema',
                    scope_level: 'symbol',
                    scope_symbol_id: symbolId,
                    category: 'schema_zod',
                });
            }

            if (countMatches(ZOD_URL, body) > 0) {
                out.push({
                    expression: `schema_zod:validates URL format`,
                    source_type: 'schema',
                    strength: 0.90,
                    validation_method: 'code_body_zod_schema',
                    scope_level: 'symbol',
                    scope_symbol_id: symbolId,
                    category: 'schema_zod',
                });
            }

            if (countMatches(ZOD_UUID, body) > 0) {
                out.push({
                    expression: `schema_zod:validates UUID format`,
                    source_type: 'schema',
                    strength: 0.90,
                    validation_method: 'code_body_zod_schema',
                    scope_level: 'symbol',
                    scope_symbol_id: symbolId,
                    category: 'schema_zod',
                });
            }

            for (const m of allMatches(ZOD_REGEX, body)) {
                out.push({
                    expression: `schema_zod:validates against regex ${truncExpr(m[1] ?? '', 80)}`,
                    source_type: 'schema',
                    strength: 0.87,
                    validation_method: 'code_body_zod_schema',
                    scope_level: 'symbol',
                    scope_symbol_id: symbolId,
                    category: 'schema_zod',
                });
            }

            if (countMatches(ZOD_OPTIONAL, body) > 0) {
                out.push({
                    expression: `schema_zod:field(s) marked optional`,
                    source_type: 'schema',
                    strength: 0.80,
                    validation_method: 'code_body_zod_schema',
                    scope_level: 'symbol',
                    scope_symbol_id: symbolId,
                    category: 'schema_zod',
                });
            }

            if (countMatches(ZOD_NULLABLE, body) > 0) {
                out.push({
                    expression: `schema_zod:field(s) marked nullable`,
                    source_type: 'schema',
                    strength: 0.80,
                    validation_method: 'code_body_zod_schema',
                    scope_level: 'symbol',
                    scope_symbol_id: symbolId,
                    category: 'schema_zod',
                });
            }

            if (countMatches(ZOD_NONNEGATIVE, body) > 0) {
                out.push({
                    expression: `schema_zod:number must be non-negative (>= 0)`,
                    source_type: 'schema',
                    strength: 0.88,
                    validation_method: 'code_body_zod_schema',
                    scope_level: 'symbol',
                    scope_symbol_id: symbolId,
                    category: 'schema_zod',
                });
            }

            if (countMatches(ZOD_POSITIVE, body) > 0) {
                out.push({
                    expression: `schema_zod:number must be positive (> 0)`,
                    source_type: 'schema',
                    strength: 0.88,
                    validation_method: 'code_body_zod_schema',
                    scope_level: 'symbol',
                    scope_symbol_id: symbolId,
                    category: 'schema_zod',
                });
            }

            if (countMatches(ZOD_INT, body) > 0) {
                out.push({
                    expression: `schema_zod:number must be integer`,
                    source_type: 'schema',
                    strength: 0.88,
                    validation_method: 'code_body_zod_schema',
                    scope_level: 'symbol',
                    scope_symbol_id: symbolId,
                    category: 'schema_zod',
                });
            }
        }

        // --- Yup ---
        const hasYup = body.includes('yup.string') || body.includes('yup.number') ||
                       body.includes('yup.boolean') || body.includes('yup.object');

        if (hasYup) {
            if (countMatches(YUP_STRING, body) > 0) {
                out.push({
                    expression: `schema_yup:validates string type`,
                    source_type: 'schema',
                    strength: 0.86,
                    validation_method: 'code_body_yup_schema',
                    scope_level: 'symbol',
                    scope_symbol_id: symbolId,
                    category: 'schema_yup',
                });
            }
            if (countMatches(YUP_NUMBER, body) > 0) {
                out.push({
                    expression: `schema_yup:validates number type`,
                    source_type: 'schema',
                    strength: 0.86,
                    validation_method: 'code_body_yup_schema',
                    scope_level: 'symbol',
                    scope_symbol_id: symbolId,
                    category: 'schema_yup',
                });
            }
            if (countMatches(YUP_BOOLEAN, body) > 0) {
                out.push({
                    expression: `schema_yup:validates boolean type`,
                    source_type: 'schema',
                    strength: 0.86,
                    validation_method: 'code_body_yup_schema',
                    scope_level: 'symbol',
                    scope_symbol_id: symbolId,
                    category: 'schema_yup',
                });
            }
            if (countMatches(YUP_REQUIRED, body) > 0) {
                out.push({
                    expression: `schema_yup:field(s) marked required`,
                    source_type: 'schema',
                    strength: 0.88,
                    validation_method: 'code_body_yup_schema',
                    scope_level: 'symbol',
                    scope_symbol_id: symbolId,
                    category: 'schema_yup',
                });
            }
            if (countMatches(YUP_EMAIL, body) > 0) {
                out.push({
                    expression: `schema_yup:validates email format`,
                    source_type: 'schema',
                    strength: 0.88,
                    validation_method: 'code_body_yup_schema',
                    scope_level: 'symbol',
                    scope_symbol_id: symbolId,
                    category: 'schema_yup',
                });
            }
            if (countMatches(YUP_URL, body) > 0) {
                out.push({
                    expression: `schema_yup:validates URL format`,
                    source_type: 'schema',
                    strength: 0.88,
                    validation_method: 'code_body_yup_schema',
                    scope_level: 'symbol',
                    scope_symbol_id: symbolId,
                    category: 'schema_yup',
                });
            }
            for (const m of allMatches(YUP_MIN, body)) {
                out.push({
                    expression: `schema_yup:min=${m[1]}`,
                    source_type: 'schema',
                    strength: 0.85,
                    validation_method: 'code_body_yup_schema',
                    scope_level: 'symbol',
                    scope_symbol_id: symbolId,
                    category: 'schema_yup',
                });
            }
            for (const m of allMatches(YUP_MAX, body)) {
                out.push({
                    expression: `schema_yup:max=${m[1]}`,
                    source_type: 'schema',
                    strength: 0.85,
                    validation_method: 'code_body_yup_schema',
                    scope_level: 'symbol',
                    scope_symbol_id: symbolId,
                    category: 'schema_yup',
                });
            }
        }

        // --- Joi ---
        const hasJoi = body.includes('Joi.string') || body.includes('Joi.number') ||
                       body.includes('Joi.boolean') || body.includes('Joi.object');

        if (hasJoi) {
            if (countMatches(JOI_STRING, body) > 0) {
                out.push({
                    expression: `schema_joi:validates string type`,
                    source_type: 'schema',
                    strength: 0.86,
                    validation_method: 'code_body_joi_schema',
                    scope_level: 'symbol',
                    scope_symbol_id: symbolId,
                    category: 'schema_joi',
                });
            }
            if (countMatches(JOI_NUMBER, body) > 0) {
                out.push({
                    expression: `schema_joi:validates number type`,
                    source_type: 'schema',
                    strength: 0.86,
                    validation_method: 'code_body_joi_schema',
                    scope_level: 'symbol',
                    scope_symbol_id: symbolId,
                    category: 'schema_joi',
                });
            }
            if (countMatches(JOI_BOOLEAN, body) > 0) {
                out.push({
                    expression: `schema_joi:validates boolean type`,
                    source_type: 'schema',
                    strength: 0.86,
                    validation_method: 'code_body_joi_schema',
                    scope_level: 'symbol',
                    scope_symbol_id: symbolId,
                    category: 'schema_joi',
                });
            }
            if (countMatches(JOI_REQUIRED, body) > 0) {
                out.push({
                    expression: `schema_joi:field(s) marked required`,
                    source_type: 'schema',
                    strength: 0.88,
                    validation_method: 'code_body_joi_schema',
                    scope_level: 'symbol',
                    scope_symbol_id: symbolId,
                    category: 'schema_joi',
                });
            }
            if (countMatches(JOI_EMAIL, body) > 0) {
                out.push({
                    expression: `schema_joi:validates email format`,
                    source_type: 'schema',
                    strength: 0.88,
                    validation_method: 'code_body_joi_schema',
                    scope_level: 'symbol',
                    scope_symbol_id: symbolId,
                    category: 'schema_joi',
                });
            }
            if (countMatches(JOI_URI, body) > 0) {
                out.push({
                    expression: `schema_joi:validates URI format`,
                    source_type: 'schema',
                    strength: 0.88,
                    validation_method: 'code_body_joi_schema',
                    scope_level: 'symbol',
                    scope_symbol_id: symbolId,
                    category: 'schema_joi',
                });
            }
            for (const m of allMatches(JOI_MIN, body)) {
                out.push({
                    expression: `schema_joi:min=${m[1]}`,
                    source_type: 'schema',
                    strength: 0.85,
                    validation_method: 'code_body_joi_schema',
                    scope_level: 'symbol',
                    scope_symbol_id: symbolId,
                    category: 'schema_joi',
                });
            }
            for (const m of allMatches(JOI_MAX, body)) {
                out.push({
                    expression: `schema_joi:max=${m[1]}`,
                    source_type: 'schema',
                    strength: 0.85,
                    validation_method: 'code_body_joi_schema',
                    scope_level: 'symbol',
                    scope_symbol_id: symbolId,
                    category: 'schema_joi',
                });
            }
            for (const m of allMatches(JOI_PATTERN, body)) {
                out.push({
                    expression: `schema_joi:validates against pattern ${truncExpr(m[1] ?? '', 80)}`,
                    source_type: 'schema',
                    strength: 0.87,
                    validation_method: 'code_body_joi_schema',
                    scope_level: 'symbol',
                    scope_symbol_id: symbolId,
                    category: 'schema_joi',
                });
            }
            for (const m of allMatches(JOI_VALID, body)) {
                out.push({
                    expression: `schema_joi:valid values restricted to (${truncExpr(m[1] ?? '', 80)})`,
                    source_type: 'schema',
                    strength: 0.88,
                    validation_method: 'code_body_joi_schema',
                    scope_level: 'symbol',
                    scope_symbol_id: symbolId,
                    category: 'schema_joi',
                });
            }
        }
    }

    // -----------------------------------------------------------------------
    // Body Mining — Closure / Nested Function Contracts
    // -----------------------------------------------------------------------

    private mineClosureContracts(
        body: string,
        symbolId: string,
        out: InvariantCandidate[]
    ): void {
        // Detect nested arrow functions and named functions
        const arrowFns = allMatches(ARROW_FN, body);
        const nestedFns = allMatches(NESTED_FUNCTION, body);
        const totalNested = arrowFns.length + nestedFns.length;

        if (totalNested > 0) {
            out.push({
                expression: `closure:contains ${totalNested} nested function(s) (${arrowFns.length} arrow, ${nestedFns.length} named)`,
                source_type: 'derived',
                strength: 0.65,
                validation_method: 'code_body_closure_analysis',
                scope_level: 'symbol',
                scope_symbol_id: symbolId,
                category: 'closure',
            });
        }

        // Analyze return paths to infer return type contract
        const returnStatements = allMatches(RETURN_STATEMENT, body);
        if (returnStatements.length > 0) {
            const returnValues = returnStatements.map(m => (m[1] ?? '').trim()).filter(Boolean);
            const hasNullReturn = returnValues.some(v =>
                v === 'null' || v === 'undefined' || v === 'void 0'
            );
            const hasPromiseReturn = returnValues.some(v =>
                /^(?:new\s+)?Promise|await\s/.test(v)
            );
            const hasObjectReturn = returnValues.some(v =>
                v.startsWith('{')
            );
            const hasArrayReturn = returnValues.some(v =>
                v.startsWith('[')
            );
            const hasBooleanReturn = returnValues.some(v =>
                v === 'true' || v === 'false'
            );
            const hasNumericReturn = returnValues.some(v =>
                /^-?\d+(\.\d+)?$/.test(v)
            );

            // Build return type shape from observed return values
            const shapes: string[] = [];
            if (hasNullReturn) shapes.push('null');
            if (hasPromiseReturn) shapes.push('Promise');
            if (hasObjectReturn) shapes.push('object');
            if (hasArrayReturn) shapes.push('array');
            if (hasBooleanReturn) shapes.push('boolean');
            if (hasNumericReturn) shapes.push('number');

            if (shapes.length > 0) {
                out.push({
                    expression: `return_shape:returns ${shapes.join(' | ')} (observed from ${returnStatements.length} return path(s))`,
                    source_type: 'derived',
                    strength: 0.70,
                    validation_method: 'code_body_return_analysis',
                    scope_level: 'symbol',
                    scope_symbol_id: symbolId,
                    category: 'return_shape',
                });
            }

            if (hasNullReturn && returnValues.some(v => v !== 'null' && v !== 'undefined' && v !== 'void 0')) {
                out.push({
                    expression: `return_nullable:function may return null/undefined on some paths`,
                    source_type: 'derived',
                    strength: 0.78,
                    validation_method: 'code_body_return_analysis',
                    scope_level: 'symbol',
                    scope_symbol_id: symbolId,
                    category: 'return_nullable',
                });
            }
        }

        // Detect higher-order function patterns: accepts or returns functions
        if (/=>\s*\(/.test(body) || /return\s+function\b/.test(body) || /return\s+\([^)]*\)\s*=>/.test(body)) {
            out.push({
                expression: `higher_order:function returns or chains callable`,
                source_type: 'derived',
                strength: 0.68,
                validation_method: 'code_body_higher_order',
                scope_level: 'symbol',
                scope_symbol_id: symbolId,
                category: 'higher_order',
            });
        }

        // Detect captured outer-scope variables (closures referencing 'this')
        if (/\bthis\s*\./.test(body)) {
            out.push({
                expression: `closure_binding:accesses instance state via this`,
                source_type: 'derived',
                strength: 0.65,
                validation_method: 'code_body_closure_binding',
                scope_level: 'symbol',
                scope_symbol_id: symbolId,
                category: 'closure_binding',
            });
        }
    }

    // -----------------------------------------------------------------------
    // Language-Specific Contract Mining (Rust, Java, C#, Ruby)
    // -----------------------------------------------------------------------

    private mineLanguageSpecificContracts(
        body: string,
        symbolId: string,
        out: InvariantCandidate[],
        language: string = ''
    ): void {
        const lang = language.toLowerCase();

        // ── Rust patterns (only for Rust code) ──
        if (lang === 'rust') {
            // unwrap() calls — panics on None/Err, implicit precondition
            for (const m of allMatches(RUST_UNWRAP, body)) {
                const ctx = body.substring(Math.max(0, m.index - 40), m.index).trim();
                const receiver = ctx.split(/\s+/).pop() ?? '';
                out.push({
                    expression: `rust_unwrap:${truncExpr(receiver)}.unwrap() — panics if None/Err`,
                    source_type: 'assertion', strength: 0.85,
                    validation_method: 'rust_unwrap_analysis',
                    scope_level: 'symbol', scope_symbol_id: symbolId, category: 'rust_safety',
                });
            }

            // expect() calls — documented panic
            for (const m of allMatches(RUST_EXPECT, body)) {
                out.push({
                    expression: `rust_expect:expect("${truncExpr(m[1] ?? '', 60)}")`,
                    source_type: 'assertion', strength: 0.88,
                    validation_method: 'rust_expect_analysis',
                    scope_level: 'symbol', scope_symbol_id: symbolId, category: 'rust_safety',
                });
            }

            // panic!() — explicit panic
            for (const m of allMatches(RUST_PANIC, body)) {
                out.push({
                    expression: `rust_panic:panic!("${truncExpr(m[1] ?? '', 60)}")`,
                    source_type: 'assertion', strength: 0.95,
                    validation_method: 'rust_panic_analysis',
                    scope_level: 'symbol', scope_symbol_id: symbolId, category: 'rust_safety',
                });
            }

            // assert!() / assert_eq!() / debug_assert!()
            for (const m of allMatches(RUST_ASSERT, body)) {
                out.push({
                    expression: `rust_assert:assert!(${truncExpr(m[1] ?? '', 80)})`,
                    source_type: 'assertion', strength: 0.92,
                    validation_method: 'rust_assert',
                    scope_level: 'symbol', scope_symbol_id: symbolId, category: 'assert',
                });
            }
            for (const m of allMatches(RUST_ASSERT_EQ, body)) {
                out.push({
                    expression: `rust_assert_eq:assert_eq!(${truncExpr(m[1] ?? '', 40)}, ${truncExpr(m[2] ?? '', 40)})`,
                    source_type: 'assertion', strength: 0.92,
                    validation_method: 'rust_assert_eq',
                    scope_level: 'symbol', scope_symbol_id: symbolId, category: 'assert',
                });
            }

            // ? operator — error propagation contract
            const questionCount = countMatches(RUST_QUESTION_MARK, body);
            if (questionCount > 0) {
                out.push({
                    expression: `rust_error_propagation:${questionCount} ? operators — function returns Result/Option`,
                    source_type: 'type_constraint', strength: 0.80,
                    validation_method: 'rust_question_mark',
                    scope_level: 'symbol', scope_symbol_id: symbolId, category: 'error_contract',
                });
            }

            // unsafe blocks
            if (countMatches(RUST_UNSAFE, body) > 0) {
                out.push({
                    expression: `rust_unsafe:contains unsafe block — memory safety guarantees relaxed`,
                    source_type: 'assertion', strength: 0.95,
                    validation_method: 'rust_unsafe_analysis',
                    scope_level: 'symbol', scope_symbol_id: symbolId, category: 'rust_safety',
                });
            }
        }

        // ── Java patterns (only for Java code) ──
        if (lang === 'java') {
            // Objects.requireNonNull()
            for (const m of allMatches(JAVA_OBJECTS_REQUIRE, body)) {
                out.push({
                    expression: `java_require_nonnull:${truncExpr(m[1] ?? '', 60)} must not be null`,
                    source_type: 'assertion', strength: 0.92,
                    validation_method: 'java_objects_require',
                    scope_level: 'symbol', scope_symbol_id: symbolId, category: 'null_check',
                });
            }

            // Java assert statement
            for (const m of allMatches(JAVA_ASSERT, body)) {
                out.push({
                    expression: `java_assert:assert ${truncExpr(m[1] ?? '', 80)}${m[2] ? ` : "${truncExpr(m[2], 40)}"` : ''}`,
                    source_type: 'assertion', strength: 0.88,
                    validation_method: 'java_assert',
                    scope_level: 'symbol', scope_symbol_id: symbolId, category: 'assert',
                });
            }

            // Java @NotNull, @Nullable annotations
            if (JAVA_ANNOTATION_NOT_NULL.test(body)) {
                JAVA_ANNOTATION_NOT_NULL.lastIndex = 0;
                out.push({
                    expression: `java_annotation:@NotNull — null values rejected`,
                    source_type: 'type_constraint', strength: 0.95,
                    validation_method: 'java_annotation',
                    scope_level: 'symbol', scope_symbol_id: symbolId, category: 'null_contract',
                });
            }

            // Java @Size annotation
            const sizeMatch = body.match(JAVA_ANNOTATION_SIZE);
            if (sizeMatch) {
                const min = sizeMatch[1] ?? '0';
                const max = sizeMatch[2] ?? 'unbounded';
                out.push({
                    expression: `java_size_constraint:size in [${min}, ${max}]`,
                    source_type: 'type_constraint', strength: 0.93,
                    validation_method: 'java_annotation_size',
                    scope_level: 'symbol', scope_symbol_id: symbolId, category: 'range_check',
                });
            }

            // Java @Pattern annotation
            const patternMatch = body.match(JAVA_ANNOTATION_PATTERN);
            if (patternMatch && patternMatch[1]) {
                out.push({
                    expression: `java_pattern_constraint:must match /${truncExpr(patternMatch[1], 60)}/`,
                    source_type: 'type_constraint', strength: 0.93,
                    validation_method: 'java_annotation_pattern',
                    scope_level: 'symbol', scope_symbol_id: symbolId, category: 'regex_validator',
                });
            }
        }

        // ── C# patterns (only for C# code) ──
        if (lang === 'csharp') {
            // ArgumentNullException.ThrowIfNull
            for (const m of allMatches(CSHARP_THROW_IF, body)) {
                out.push({
                    expression: `csharp_throw_if_null:${truncExpr(m[1] ?? '', 60)} must not be null`,
                    source_type: 'assertion', strength: 0.93,
                    validation_method: 'csharp_argument_check',
                    scope_level: 'symbol', scope_symbol_id: symbolId, category: 'null_check',
                });
            }

            // C# [Required]
            if (CSHARP_DATA_ANNOTATION_REQUIRED.test(body)) {
                CSHARP_DATA_ANNOTATION_REQUIRED.lastIndex = 0;
                out.push({
                    expression: `csharp_required:field marked [Required]`,
                    source_type: 'type_constraint', strength: 0.95,
                    validation_method: 'csharp_data_annotation',
                    scope_level: 'symbol', scope_symbol_id: symbolId, category: 'null_contract',
                });
            }

            // C# [Range(min, max)]
            const rangeMatch = body.match(CSHARP_DATA_ANNOTATION_RANGE);
            if (rangeMatch && rangeMatch[1] && rangeMatch[2]) {
                out.push({
                    expression: `csharp_range:value in [${rangeMatch[1]}, ${rangeMatch[2]}]`,
                    source_type: 'type_constraint', strength: 0.93,
                    validation_method: 'csharp_data_annotation_range',
                    scope_level: 'symbol', scope_symbol_id: symbolId, category: 'range_check',
                });
            }

            // C# [StringLength(max, MinimumLength=min)]
            const strLenMatch = body.match(CSHARP_DATA_ANNOTATION_STRING_LENGTH);
            if (strLenMatch && strLenMatch[1]) {
                const max = strLenMatch[1];
                const min = strLenMatch[2] ?? '0';
                out.push({
                    expression: `csharp_string_length:length in [${min}, ${max}]`,
                    source_type: 'type_constraint', strength: 0.93,
                    validation_method: 'csharp_data_annotation_string_length',
                    scope_level: 'symbol', scope_symbol_id: symbolId, category: 'range_check',
                });
            }
        }

        // ── Ruby patterns (only for Ruby code) ──
        if (lang === 'ruby') {
            // ActiveRecord validates
            for (const m of allMatches(RUBY_VALIDATES, body)) {
                out.push({
                    expression: `ruby_validates:${truncExpr(m[1] ?? '', 30)} — ${truncExpr(m[2] ?? '', 60)}`,
                    source_type: 'schema', strength: 0.90,
                    validation_method: 'ruby_activerecord_validates',
                    scope_level: 'symbol', scope_symbol_id: symbolId, category: 'validation',
                });
            }

            // validates_presence_of
            for (const m of allMatches(RUBY_VALIDATES_PRESENCE, body)) {
                out.push({
                    expression: `ruby_validates_presence:${truncExpr(m[1] ?? '', 40)} must be present`,
                    source_type: 'schema', strength: 0.92,
                    validation_method: 'ruby_validates_presence',
                    scope_level: 'symbol', scope_symbol_id: symbolId, category: 'null_contract',
                });
            }

            // Ruby raise — exception contract
            for (const m of allMatches(RUBY_RAISE, body)) {
                out.push({
                    expression: `ruby_raise:raises ${truncExpr(m[1] ?? '', 60)}`,
                    source_type: 'assertion', strength: 0.85,
                    validation_method: 'ruby_raise_analysis',
                    scope_level: 'symbol', scope_symbol_id: symbolId, category: 'error_contract',
                });
            }

            // Ruby guard clause (return if/unless)
            const guardCount = countMatches(RUBY_GUARD_CLAUSE, body);
            if (guardCount > 0) {
                out.push({
                    expression: `ruby_guard_clauses:${guardCount} guard clause(s) — early return on invalid state`,
                    source_type: 'guard_clause', strength: 0.80,
                    validation_method: 'ruby_guard_clause',
                    scope_level: 'symbol', scope_symbol_id: symbolId, category: 'guard',
                });
            }
        }
    }

    // -----------------------------------------------------------------------
    // Signature Mining — Parameter Types
    // -----------------------------------------------------------------------

    private mineParamTypes(
        signature: string,
        symbolId: string,
        out: InvariantCandidate[]
    ): void {
        // Extract content between first ( and last ) for parameters
        const parenStart = signature.indexOf('(');
        const parenEnd = signature.lastIndexOf(')');
        if (parenStart === -1 || parenEnd === -1 || parenEnd <= parenStart) return;

        const paramStr = signature.substring(parenStart + 1, parenEnd);
        if (!paramStr.trim()) return;

        // Parse params handling nested generics/types
        const params = this.splitParams(paramStr);

        for (const param of params) {
            const match = /(\w+)\s*(\?)?:\s*(.+)/.exec(param.trim());
            if (!match) continue;

            if (!match[1] || !match[3]) continue;
            const paramName = match[1];
            const isOptional = match[2] === '?';
            const paramType = match[3].trim();

            // Input predicate from type
            out.push({
                expression: `input_type:${paramName}: ${truncExpr(paramType, 80)}${isOptional ? ' (optional)' : ''}`,
                source_type: 'derived',
                strength: 0.85,
                validation_method: 'signature_type_analysis',
                scope_level: 'symbol',
                scope_symbol_id: symbolId,
                category: 'input_type',
            });

            // Specific type-based invariants
            if (paramType === 'string' || paramType === 'String') {
                out.push({
                    expression: `input_contract:${paramName} must be string`,
                    source_type: 'derived',
                    strength: 0.90,
                    validation_method: 'signature_type_analysis',
                    scope_level: 'symbol',
                    scope_symbol_id: symbolId,
                    category: 'input_contract',
                });
            } else if (paramType === 'number' || paramType === 'Number') {
                out.push({
                    expression: `input_contract:${paramName} must be number`,
                    source_type: 'derived',
                    strength: 0.90,
                    validation_method: 'signature_type_analysis',
                    scope_level: 'symbol',
                    scope_symbol_id: symbolId,
                    category: 'input_contract',
                });
            } else if (paramType === 'boolean' || paramType === 'Boolean') {
                out.push({
                    expression: `input_contract:${paramName} must be boolean`,
                    source_type: 'derived',
                    strength: 0.90,
                    validation_method: 'signature_type_analysis',
                    scope_level: 'symbol',
                    scope_symbol_id: symbolId,
                    category: 'input_contract',
                });
            } else if (/\[\]$/.test(paramType) || /^Array</.test(paramType)) {
                out.push({
                    expression: `input_contract:${paramName} must be array`,
                    source_type: 'derived',
                    strength: 0.88,
                    validation_method: 'signature_type_analysis',
                    scope_level: 'symbol',
                    scope_symbol_id: symbolId,
                    category: 'input_contract',
                });
            } else if (/^Promise</.test(paramType)) {
                out.push({
                    expression: `input_contract:${paramName} must be Promise`,
                    source_type: 'derived',
                    strength: 0.88,
                    validation_method: 'signature_type_analysis',
                    scope_level: 'symbol',
                    scope_symbol_id: symbolId,
                    category: 'input_contract',
                });
            }

            // Nullability from optional/union types
            if (isOptional || /\|\s*(?:null|undefined)/.test(paramType)) {
                out.push({
                    expression: `nullability:${paramName} may be null/undefined`,
                    source_type: 'derived',
                    strength: 0.85,
                    validation_method: 'signature_nullability_analysis',
                    scope_level: 'symbol',
                    scope_symbol_id: symbolId,
                    category: 'nullability',
                });
            }
        }
    }

    // -----------------------------------------------------------------------
    // Signature Mining — Return Type
    // -----------------------------------------------------------------------

    private mineReturnType(
        signature: string,
        symbolId: string,
        out: InvariantCandidate[]
    ): void {
        const match = TS_RETURN_TYPE.exec(signature);
        if (!match) return;

        const returnType = (match[1] ?? '').trim();
        if (!returnType || returnType === 'void' || returnType === 'any') return;

        out.push({
            expression: `output_guarantee:returns ${truncExpr(returnType, 80)}`,
            source_type: 'derived',
            strength: 0.85,
            validation_method: 'signature_return_analysis',
            scope_level: 'symbol',
            scope_symbol_id: symbolId,
            category: 'output_guarantee',
        });

        // Promise return type
        if (/^Promise</.test(returnType)) {
            const innerMatch = /^Promise<(.+)>$/.exec(returnType);
            if (innerMatch) {
                out.push({
                    expression: `output_guarantee:async, resolves to ${truncExpr(innerMatch[1] ?? '', 60)}`,
                    source_type: 'derived',
                    strength: 0.85,
                    validation_method: 'signature_return_analysis',
                    scope_level: 'symbol',
                    scope_symbol_id: symbolId,
                    category: 'output_async',
                });
            }
        }

        // Nullable return type
        if (/\|\s*(?:null|undefined)/.test(returnType)) {
            out.push({
                expression: `output_nullable:return type includes null/undefined`,
                source_type: 'derived',
                strength: 0.85,
                validation_method: 'signature_return_analysis',
                scope_level: 'symbol',
                scope_symbol_id: symbolId,
                category: 'output_nullable',
            });
        }

        // Never return (always throws)
        if (returnType === 'never') {
            out.push({
                expression: `output_guarantee:function always throws (return type: never)`,
                source_type: 'derived',
                strength: 0.95,
                validation_method: 'signature_return_analysis',
                scope_level: 'symbol',
                scope_symbol_id: symbolId,
                category: 'output_never',
            });
        }
    }

    // -----------------------------------------------------------------------
    // Signature Mining — Generic Constraints
    // -----------------------------------------------------------------------

    private mineGenericConstraints(
        signature: string,
        symbolId: string,
        out: InvariantCandidate[]
    ): void {
        for (const m of allMatches(TS_GENERIC_CONSTRAINT, signature)) {
            out.push({
                expression: `type_bound:${m[1]} extends ${truncExpr(m[2] ?? '', 80)}`,
                source_type: 'derived',
                strength: 0.82,
                validation_method: 'signature_generic_analysis',
                scope_level: 'symbol',
                scope_symbol_id: symbolId,
                category: 'type_bound',
            });
        }
    }

    // -----------------------------------------------------------------------
    // Signature Mining — Union Types
    // -----------------------------------------------------------------------

    private mineUnionTypes(
        signature: string,
        symbolId: string,
        out: InvariantCandidate[]
    ): void {
        // Find union type patterns but only outside of function parameter positions
        // to avoid double-counting with param type mining
        const returnMatch = TS_RETURN_TYPE.exec(signature);
        if (returnMatch && returnMatch[1]) {
            const returnType = returnMatch[1].trim();
            const unionMatch = TS_UNION_TYPE.exec(returnType);
            if (unionMatch && unionMatch[0].includes('|')) {
                const members = unionMatch[0].split('|').map(s => s.trim());
                if (members.length >= 2 && members.length <= 20) {
                    out.push({
                        expression: `union_type:return is one of {${members.join(', ')}}`,
                        source_type: 'derived',
                        strength: 0.80,
                        validation_method: 'signature_union_analysis',
                        scope_level: 'symbol',
                        scope_symbol_id: symbolId,
                        category: 'union_type',
                    });
                }
            }
        }
    }

    // -----------------------------------------------------------------------
    // Signature Mining — Optional Parameters
    // -----------------------------------------------------------------------

    private mineOptionalParams(
        signature: string,
        symbolId: string,
        out: InvariantCandidate[]
    ): void {
        const parenStart = signature.indexOf('(');
        const parenEnd = signature.lastIndexOf(')');
        if (parenStart === -1 || parenEnd === -1 || parenEnd <= parenStart) return;

        const paramStr = signature.substring(parenStart + 1, parenEnd);
        if (!paramStr.trim()) return;

        const params = this.splitParams(paramStr);
        const optionalParams: string[] = [];
        let seenOptional = false;

        for (const param of params) {
            const match = /(\w+)\s*(\?)?:\s*(.+)/.exec(param.trim());
            if (!match || !match[1]) continue;

            const isOptional = match[2] === '?' || /=\s*.+/.test(param);
            if (isOptional) {
                optionalParams.push(match[1]);
                seenOptional = true;
            } else if (seenOptional) {
                // A required param after optional ones — unusual and worth flagging
                out.push({
                    expression: `param_ordering:required param '${match[1]}' follows optional params`,
                    source_type: 'derived',
                    strength: 0.60,
                    validation_method: 'signature_param_ordering',
                    scope_level: 'symbol',
                    scope_symbol_id: symbolId,
                    category: 'param_ordering',
                });
            }
        }

        if (optionalParams.length > 0) {
            out.push({
                expression: `optional_params:${optionalParams.join(', ')} are optional`,
                source_type: 'derived',
                strength: 0.80,
                validation_method: 'signature_optional_analysis',
                scope_level: 'symbol',
                scope_symbol_id: symbolId,
                category: 'optional_params',
            });
        }
    }

    // -----------------------------------------------------------------------
    // Decorator Mining
    // -----------------------------------------------------------------------

    /**
     * Mine from decorators stored on contract profiles in the DB.
     * Reads the contract_profiles.schema_refs and security_contract fields,
     * plus re-queries the behavioral_profiles for auth_operations.
     */
    private async mineFromDecorators(
        symbolVersionId: string,
        symbolId: string,
        _repoId: string,
        _snapshotId: string
    ): Promise<InvariantCandidate[]> {
        const candidates: InvariantCandidate[] = [];

        // Fetch contract profile
        const cpResult = await db.query(
            `SELECT schema_refs, security_contract, serialization_contract, input_contract
             FROM contract_profiles WHERE symbol_version_id = $1`,
            [symbolVersionId]
        );
        const cp = cpResult.rows[0] as {
            schema_refs: string[];
            security_contract: string;
            serialization_contract: string;
            input_contract: string;
        } | undefined;

        if (!cp) return candidates;

        // Mine from schema_refs (which contain decorator strings)
        const schemaRefs = Array.isArray(cp.schema_refs) ? cp.schema_refs : [];
        for (const decorator of schemaRefs) {
            this.mineFromDecoratorString(decorator, symbolId, candidates);
        }

        // Mine auth invariants from security_contract
        if (cp.security_contract && cp.security_contract !== 'none') {
            const parts = cp.security_contract.split(';').map(s => s.trim()).filter(Boolean);
            for (const part of parts) {
                this.mineFromDecoratorString(part, symbolId, candidates);
            }
        }

        return candidates;
    }

    /**
     * Parse a single decorator string and emit invariant candidates.
     */
    private mineFromDecoratorString(
        decorator: string,
        symbolId: string,
        out: InvariantCandidate[]
    ): void {
        // Validation decorators
        if (DECORATOR_IS_EMAIL.test(decorator)) {
            out.push({
                expression: `decorator_validation:field must be valid email`,
                source_type: 'assertion',
                strength: 0.92,
                validation_method: 'decorator_analysis',
                scope_level: 'symbol',
                scope_symbol_id: symbolId,
                category: 'decorator_email',
            });
        }

        if (DECORATOR_IS_URL.test(decorator)) {
            out.push({
                expression: `decorator_validation:field must be valid URL`,
                source_type: 'assertion',
                strength: 0.92,
                validation_method: 'decorator_analysis',
                scope_level: 'symbol',
                scope_symbol_id: symbolId,
                category: 'decorator_url',
            });
        }

        if (DECORATOR_IS_UUID.test(decorator)) {
            out.push({
                expression: `decorator_validation:field must be valid UUID`,
                source_type: 'assertion',
                strength: 0.92,
                validation_method: 'decorator_analysis',
                scope_level: 'symbol',
                scope_symbol_id: symbolId,
                category: 'decorator_uuid',
            });
        }

        if (DECORATOR_IS_INT.test(decorator)) {
            out.push({
                expression: `decorator_validation:field must be integer`,
                source_type: 'assertion',
                strength: 0.90,
                validation_method: 'decorator_analysis',
                scope_level: 'symbol',
                scope_symbol_id: symbolId,
                category: 'decorator_int',
            });
        }

        if (DECORATOR_IS_NUMBER.test(decorator)) {
            out.push({
                expression: `decorator_validation:field must be number`,
                source_type: 'assertion',
                strength: 0.90,
                validation_method: 'decorator_analysis',
                scope_level: 'symbol',
                scope_symbol_id: symbolId,
                category: 'decorator_number',
            });
        }

        if (DECORATOR_IS_STRING.test(decorator)) {
            out.push({
                expression: `decorator_validation:field must be string`,
                source_type: 'assertion',
                strength: 0.90,
                validation_method: 'decorator_analysis',
                scope_level: 'symbol',
                scope_symbol_id: symbolId,
                category: 'decorator_string',
            });
        }

        if (DECORATOR_IS_BOOLEAN.test(decorator)) {
            out.push({
                expression: `decorator_validation:field must be boolean`,
                source_type: 'assertion',
                strength: 0.90,
                validation_method: 'decorator_analysis',
                scope_level: 'symbol',
                scope_symbol_id: symbolId,
                category: 'decorator_boolean',
            });
        }

        if (DECORATOR_IS_DATE.test(decorator)) {
            out.push({
                expression: `decorator_validation:field must be Date`,
                source_type: 'assertion',
                strength: 0.90,
                validation_method: 'decorator_analysis',
                scope_level: 'symbol',
                scope_symbol_id: symbolId,
                category: 'decorator_date',
            });
        }

        if (DECORATOR_IS_ENUM.test(decorator)) {
            out.push({
                expression: `decorator_validation:field must be enum value`,
                source_type: 'assertion',
                strength: 0.90,
                validation_method: 'decorator_analysis',
                scope_level: 'symbol',
                scope_symbol_id: symbolId,
                category: 'decorator_enum',
            });
        }

        if (DECORATOR_IS_NOT_EMPTY.test(decorator)) {
            out.push({
                expression: `decorator_validation:field must not be empty`,
                source_type: 'assertion',
                strength: 0.90,
                validation_method: 'decorator_analysis',
                scope_level: 'symbol',
                scope_symbol_id: symbolId,
                category: 'decorator_not_empty',
            });
        }

        if (DECORATOR_IS_OPTIONAL.test(decorator)) {
            out.push({
                expression: `decorator_validation:field is optional`,
                source_type: 'derived',
                strength: 0.80,
                validation_method: 'decorator_analysis',
                scope_level: 'symbol',
                scope_symbol_id: symbolId,
                category: 'decorator_optional',
            });
        }

        if (DECORATOR_IS_ARRAY.test(decorator)) {
            out.push({
                expression: `decorator_validation:field must be array`,
                source_type: 'assertion',
                strength: 0.90,
                validation_method: 'decorator_analysis',
                scope_level: 'symbol',
                scope_symbol_id: symbolId,
                category: 'decorator_array',
            });
        }

        // @Min(N)
        const minMatch = DECORATOR_MIN.exec(decorator);
        if (minMatch) {
            out.push({
                expression: `decorator_range:min=${minMatch[1]}`,
                source_type: 'assertion',
                strength: 0.90,
                validation_method: 'decorator_analysis',
                scope_level: 'symbol',
                scope_symbol_id: symbolId,
                category: 'decorator_range',
            });
        }

        // @Max(N)
        const maxMatch = DECORATOR_MAX.exec(decorator);
        if (maxMatch) {
            out.push({
                expression: `decorator_range:max=${maxMatch[1]}`,
                source_type: 'assertion',
                strength: 0.90,
                validation_method: 'decorator_analysis',
                scope_level: 'symbol',
                scope_symbol_id: symbolId,
                category: 'decorator_range',
            });
        }

        // @MinLength(N)
        const minLenMatch = DECORATOR_MIN_LENGTH.exec(decorator);
        if (minLenMatch) {
            out.push({
                expression: `decorator_length:minLength=${minLenMatch[1]}`,
                source_type: 'assertion',
                strength: 0.90,
                validation_method: 'decorator_analysis',
                scope_level: 'symbol',
                scope_symbol_id: symbolId,
                category: 'decorator_length',
            });
        }

        // @MaxLength(N)
        const maxLenMatch = DECORATOR_MAX_LENGTH.exec(decorator);
        if (maxLenMatch) {
            out.push({
                expression: `decorator_length:maxLength=${maxLenMatch[1]}`,
                source_type: 'assertion',
                strength: 0.90,
                validation_method: 'decorator_analysis',
                scope_level: 'symbol',
                scope_symbol_id: symbolId,
                category: 'decorator_length',
            });
        }

        // @Length(min, max)
        const lenMatch = DECORATOR_LENGTH.exec(decorator);
        if (lenMatch && lenMatch[1]) {
            const minLen = lenMatch[1];
            const maxLen = lenMatch[2];
            out.push({
                expression: `decorator_length:length=[${minLen}${maxLen ? `, ${maxLen}` : ''}]`,
                source_type: 'assertion',
                strength: 0.90,
                validation_method: 'decorator_analysis',
                scope_level: 'symbol',
                scope_symbol_id: symbolId,
                category: 'decorator_length',
            });
        }

        // @Matches(/regex/)
        const matchesMatch = DECORATOR_MATCHES.exec(decorator);
        if (matchesMatch) {
            out.push({
                expression: `decorator_pattern:must match ${truncExpr(matchesMatch[1] ?? '', 80)}`,
                source_type: 'assertion',
                strength: 0.88,
                validation_method: 'decorator_analysis',
                scope_level: 'symbol',
                scope_symbol_id: symbolId,
                category: 'decorator_pattern',
            });
        }

        // Auth decorators: @RequiresRole('admin')
        const roleMatch = DECORATOR_REQUIRES_ROLE.exec(decorator);
        if (roleMatch) {
            out.push({
                expression: `decorator_auth:requires role '${roleMatch[1]}'`,
                source_type: 'assertion',
                strength: 0.93,
                validation_method: 'decorator_auth_analysis',
                scope_level: 'symbol',
                scope_symbol_id: symbolId,
                category: 'decorator_auth',
            });
        }

        // @Authenticated
        if (DECORATOR_AUTHENTICATED.test(decorator)) {
            out.push({
                expression: `decorator_auth:requires authentication`,
                source_type: 'assertion',
                strength: 0.93,
                validation_method: 'decorator_auth_analysis',
                scope_level: 'symbol',
                scope_symbol_id: symbolId,
                category: 'decorator_auth',
            });
        }

        // @Column({ type: 'varchar', length: 255 })
        const columnMatch = DECORATOR_COLUMN.exec(decorator);
        if (columnMatch && columnMatch[1]) {
            const colBody = columnMatch[1];
            const typeMatch = /type\s*:\s*['"](\w+)['"]/.exec(colBody);
            const colLenMatch = /length\s*:\s*(\d+)/.exec(colBody);
            if (typeMatch) {
                out.push({
                    expression: `decorator_schema:column type=${typeMatch[1]}${colLenMatch ? ` length=${colLenMatch[1]}` : ''}`,
                    source_type: 'schema',
                    strength: 0.90,
                    validation_method: 'decorator_schema_analysis',
                    scope_level: 'symbol',
                    scope_symbol_id: symbolId,
                    category: 'decorator_schema',
                });
            }
        }

        // Rate limiting: @RateLimit(100, '1m')
        const rateLimitMatch = DECORATOR_RATE_LIMIT.exec(decorator);
        if (rateLimitMatch) {
            out.push({
                expression: `decorator_rate_limit:limit=${rateLimitMatch[1]}${rateLimitMatch[2] ? ` per ${rateLimitMatch[2]}` : ''}`,
                source_type: 'assertion',
                strength: 0.88,
                validation_method: 'decorator_rate_limit_analysis',
                scope_level: 'symbol',
                scope_symbol_id: symbolId,
                category: 'decorator_rate_limit',
            });
        }

        // @Validate / @ValidateNested
        if (DECORATOR_VALIDATE.test(decorator)) {
            out.push({
                expression: `decorator_validation:input undergoes validation`,
                source_type: 'assertion',
                strength: 0.85,
                validation_method: 'decorator_analysis',
                scope_level: 'symbol',
                scope_symbol_id: symbolId,
                category: 'decorator_validate',
            });
        }
    }

    // -----------------------------------------------------------------------
    // Cross-Symbol: Global Auth Pattern
    // -----------------------------------------------------------------------

    /**
     * If >= 70% of route_handler / API symbols have auth invariants,
     * emit a global "auth required" invariant.
     */
    private async mineGlobalAuthPattern(
        repoId: string,
        snapshotId: string,
        statements: { text: string; params: unknown[] }[]
    ): Promise<void> {
        const routeResult = await db.query(`
            SELECT s.symbol_id
            FROM symbols s
            JOIN symbol_versions sv ON sv.symbol_id = s.symbol_id
            WHERE s.repo_id = $1 AND sv.snapshot_id = $2
            AND s.kind IN ('route_handler', 'method')
        `, [repoId, snapshotId]);

        const routeSymbolIds = new Set(
            (routeResult.rows as { symbol_id: string }[]).map(r => r.symbol_id)
        );

        if (routeSymbolIds.size < 3) return; // Too few to draw conclusions

        // Count how many of those have auth-related invariants
        const authResult = await db.query(`
            SELECT DISTINCT i.scope_symbol_id
            FROM invariants i
            WHERE i.repo_id = $1
            AND i.scope_symbol_id = ANY($2::uuid[])
            AND (i.expression LIKE 'decorator_auth:%'
                 OR i.expression LIKE 'security:%'
                 OR i.expression LIKE '%requires authentication%'
                 OR i.expression LIKE '%requires role%')
        `, [repoId, Array.from(routeSymbolIds)]);

        const authSymbolCount = authResult.rowCount ?? 0;
        const authRatio = authSymbolCount / routeSymbolIds.size;

        if (authRatio >= 0.70) {
            statements.push({
                text: `INSERT INTO invariants (invariant_id, repo_id, scope_symbol_id, scope_level, expression, source_type, strength, validation_method, last_verified_snapshot_id)
                       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                       ON CONFLICT (repo_id, COALESCE(scope_symbol_id, '00000000-0000-0000-0000-000000000000'::uuid), expression)
                       DO UPDATE SET strength = GREATEST(invariants.strength, EXCLUDED.strength),
                                     last_verified_snapshot_id = EXCLUDED.last_verified_snapshot_id`,
                params: [
                    uuidv4(), repoId, null, 'global',
                    `global_auth:${Math.round(authRatio * 100)}% of route handlers require authentication (${authSymbolCount}/${routeSymbolIds.size})`,
                    'derived', Math.min(0.95, 0.80 + authRatio * 0.15),
                    'cross_symbol_auth_pattern', snapshotId,
                ],
            });
        }
    }

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    /**
     * Extract balanced parenthesis content starting at position `start`
     * (which should point to the opening paren).
     * Returns the content between the parens, or null if unbalanced.
     */
    private extractBalancedParenContent(text: string, start: number): string | null {
        if (start < 0 || start >= text.length || text[start] !== '(') return null;
        let depth = 0;
        let i = start;
        while (i < text.length) {
            const ch = text[i];
            if (ch === '(') depth++;
            else if (ch === ')') {
                depth--;
                if (depth === 0) {
                    // Return content between the parens (exclusive)
                    const content = text.substring(start + 1, i).trim();
                    return content || null;
                }
            }
            // Skip string literals to avoid false paren matches
            if (ch === '"' || ch === "'" || ch === '`') {
                const quote = ch;
                i++;
                while (i < text.length && text[i] !== quote) {
                    if (text[i] === '\\') i++; // skip escaped char
                    i++;
                }
            }
            i++;
        }
        return null;
    }

    /**
     * Split a parameter string by commas, respecting nested generics and parens.
     * e.g. "a: Map<string, number>, b: string" => ["a: Map<string, number>", "b: string"]
     */
    private splitParams(paramStr: string): string[] {
        const result: string[] = [];
        let depth = 0;
        let current = '';

        for (let i = 0; i < paramStr.length; i++) {
            const ch = paramStr[i]!;
            if (ch === '<' || ch === '(' || ch === '[' || ch === '{') {
                depth++;
                current += ch;
            } else if (ch === '>' || ch === ')' || ch === ']' || ch === '}') {
                depth--;
                current += ch;
            } else if (ch === ',' && depth === 0) {
                if (current.trim()) result.push(current.trim());
                current = '';
            } else {
                current += ch;
            }
        }

        if (current.trim()) result.push(current.trim());
        return result;
    }

    /**
     * Normalize a predicate expression for cross-symbol grouping.
     * Strips specific variable names to find structurally identical patterns.
     */
    private normalizePredicateForGrouping(predicate: string, category: string): string {
        switch (category) {
            case 'guard_clause':
                // Normalize "x !== null => throw" → "_VAR !== null => throw"
                return predicate
                    .replace(/\b[a-z_]\w*\b/gi, '_VAR')
                    .replace(/_VAR\s*\.\s*_VAR/g, '_VAR._VAR')
                    .replace(/\s+/g, ' ')
                    .trim();

            case 'type_guard':
                // Normalize "typeof x === 'string'" → "typeof _VAR === 'string'"
                return predicate
                    .replace(/typeof\s+\w+/g, 'typeof _VAR')
                    .replace(/\w+\s+instanceof\s+/g, '_VAR instanceof ')
                    .replace(/\s+/g, ' ')
                    .trim();

            case 'null_check':
            case 'null_safety':
                return predicate
                    .replace(/\b[a-z_]\w*\b/gi, '_VAR')
                    .replace(/\s+/g, ' ')
                    .trim();

            case 'range_check':
            case 'length_check':
                // Keep the numeric bounds but normalize variable names
                return predicate
                    .replace(/\b(?![0-9])[a-z_]\w*\b/gi, '_VAR')
                    .replace(/\s+/g, ' ')
                    .trim();

            case 'normalization_trim':
            case 'normalization_lowercase':
            case 'normalization_uppercase':
            case 'normalization_replace':
            case 'normalization_parse':
                // All normalization of same type groups together
                return category;

            case 'assert':
            case 'precondition':
                return predicate
                    .replace(/\b[a-z_]\w*\b/gi, '_VAR')
                    .replace(/\s+/g, ' ')
                    .trim();

            default:
                // For regex, enum, schema categories, use the category as-is
                // since the specific pattern matters
                return predicate.replace(/\s+/g, ' ').trim();
        }
    }
}

export const deepContractSynthesizer = new DeepContractSynthesizer();
