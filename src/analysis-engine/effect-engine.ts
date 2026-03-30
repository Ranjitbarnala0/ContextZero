/**
 * ContextZero — Effect Semantics Engine
 *
 * Formalizes behavioral profiling into a typed effect system. Instead of
 * coarse purity classes (pure/read_only/read_write/side_effecting), this
 * engine produces precise typed effect signatures for every symbol:
 *
 *   reads(db.users), writes(db.billing), emits(event.user_created),
 *   calls_external(network.stripe), requires(auth.admin), throws(ValidationError)
 *
 * Effect classification ladder (5 tiers):
 *   pure → reader → writer → io → full_side_effect
 *
 * Effect sources:
 *   1. Behavioral profiles (upgrade path from V1)
 *   2. Contract profiles (security_contract → requires effects)
 *   3. Framework-specific pattern maps (known library behaviors)
 *   4. Runtime evidence (when available)
 *
 * Transitive propagation: walks the call graph bottom-up via Kahn's
 * topological sort in O(V+E), propagating callee effects to callers.
 * Each propagated effect is tagged as transitive with its originating symbol.
 *
 * Effect diffing: compares before/after effect signatures to detect new,
 * removed, escalated, and deescalated effects for change validation.
 */

import { v4 as uuidv4 } from 'uuid';
import { db } from '../db-driver';
import { jsonField, validateRows, validateBehavioralProfile, validateContractProfile } from '../db-driver/result';
import { Logger } from '../logger';
import type { BehaviorHint, BehavioralProfile, ContractProfile } from '../types';

const log = new Logger('effect-engine');

// ── Types ────────────────────────────────────────────────────────────────────

export type EffectKind =
    | 'reads' | 'writes' | 'emits' | 'calls_external'
    | 'mutates' | 'requires' | 'throws' | 'opens'
    | 'normalizes' | 'acquires_lock' | 'logs';

/**
 * A single typed effect entry. Every effect has a kind plus a domain-specific
 * descriptor field (resource, event, target, etc.) and a human-readable detail.
 */
export interface EffectEntry {
    kind: EffectKind;
    /** Domain key — resource path, event name, error type, etc. */
    descriptor: string;
    /** Human-readable detail string for display/debugging */
    detail: string;
    /** Whether this effect was observed directly or propagated from a callee */
    provenance: 'direct' | 'transitive';
    /** If transitive, the originating symbol version ID */
    origin_symbol_version_id?: string;
}

/**
 * Effect class — 5-tier classification derived from the effect set.
 */
export type EffectClass = 'pure' | 'reader' | 'writer' | 'io' | 'full_side_effect';

/**
 * Full effect signature for a symbol version (mirrors the DB table).
 */
export interface EffectSignature {
    effect_signature_id: string;
    symbol_version_id: string;
    effects: EffectEntry[];
    effect_class: EffectClass;
    reads_resources: string[];
    writes_resources: string[];
    emits_events: string[];
    calls_external: string[];
    mutates_state: string[];
    requires_auth: string[];
    throws_errors: string[];
    source: string;
    confidence: number;
}

/**
 * Diff between two effect signatures.
 */
export interface EffectDiff {
    before_sv_id: string;
    after_sv_id: string;
    added_effects: EffectEntry[];
    removed_effects: EffectEntry[];
    class_before: EffectClass;
    class_after: EffectClass;
    class_direction: 'escalated' | 'deescalated' | 'unchanged';
    new_resources: string[];
    removed_resources: string[];
    summary: string;
}

// ── Effect class ordering ────────────────────────────────────────────────────

const EFFECT_CLASS_ORDER: Record<EffectClass, number> = {
    pure: 0,
    reader: 1,
    writer: 2,
    io: 3,
    full_side_effect: 4,
};

// ── Framework behavior map ───────────────────────────────────────────────────
// Known library function patterns → effect entries.
// Keys are regex-tested against call target names.

interface FrameworkPattern {
    pattern: RegExp;
    effects: Omit<EffectEntry, 'provenance' | 'origin_symbol_version_id'>[];
    /** If set, only apply this pattern to code in these languages. If not set, apply to all languages. */
    languages?: string[];
}

const FRAMEWORK_BEHAVIOR_MAP: FrameworkPattern[] = [
    // Database ORMs
    { pattern: /\.(find|findOne|findMany|findById|select|get|query|count|aggregate)\b/i, effects: [{ kind: 'reads', descriptor: 'db.query', detail: 'ORM read operation' }] },
    { pattern: /\.(save|insert|create|upsert|bulkCreate|insertMany)\b/i, effects: [{ kind: 'writes', descriptor: 'db.write', detail: 'ORM write operation' }] },
    { pattern: /\.(update|updateOne|updateMany|increment|decrement)\b/i, effects: [{ kind: 'writes', descriptor: 'db.update', detail: 'ORM update operation' }] },
    { pattern: /\.(delete|destroy|remove|deleteOne|deleteMany|truncate)\b/i, effects: [{ kind: 'writes', descriptor: 'db.delete', detail: 'ORM delete operation' }] },
    { pattern: /\.(transaction|beginTransaction|startTransaction)\b/i, effects: [{ kind: 'writes', descriptor: 'db.transaction', detail: 'Database transaction' }, { kind: 'acquires_lock', descriptor: 'db.transaction_lock', detail: 'Transaction lock acquired' }] },

    // HTTP / Network
    { pattern: /\b(fetch|axios|got|superagent|request)\b/i, effects: [{ kind: 'calls_external', descriptor: 'network.http', detail: 'HTTP client call' }] },
    { pattern: /\b(axios|http|https|fetch|got|superagent|request|client|api|restClient|httpClient)\.(get|post|put|patch|delete)\s*\(/i, effects: [{ kind: 'calls_external', descriptor: 'network.http', detail: 'HTTP method call' }] },
    { pattern: /\b(requests)\.(get|post|put|patch|delete|head|options)\s*\(/i, effects: [{ kind: 'calls_external', descriptor: 'network.http', detail: 'Python requests HTTP call' }], languages: ['python'] },
    { pattern: /\b(HttpClient|RestTemplate|OkHttpClient|WebClient)\.(get|post|put|patch|delete)\s*\(/i, effects: [{ kind: 'calls_external', descriptor: 'network.http', detail: 'HTTP client method call' }], languages: ['java', 'csharp', 'kotlin'] },
    { pattern: /\breqwest::Client\b.*\.(get|post|put|patch|delete)\s*\(/i, effects: [{ kind: 'calls_external', descriptor: 'network.http', detail: 'Rust reqwest HTTP call' }], languages: ['rust'] },

    // Event emission
    { pattern: /\.(emit|publish|dispatch|send|broadcast|trigger)\b/i, effects: [{ kind: 'emits', descriptor: 'event.generic', detail: 'Event emission' }] },
    { pattern: /\b(EventEmitter|PubSub|MessageQueue|kafka|rabbitmq|sns|sqs)\b/i, effects: [{ kind: 'emits', descriptor: 'event.messaging', detail: 'Message queue interaction' }] },

    // File system
    { pattern: /\bfs\.(readFile|readFileSync|readdir|readdirSync|stat|statSync|access)\b/i, effects: [{ kind: 'reads', descriptor: 'file.read', detail: 'File system read' }] },
    { pattern: /\bfs\.(writeFile|writeFileSync|appendFile|mkdir|mkdirSync|unlink|rename|copyFile)\b/i, effects: [{ kind: 'writes', descriptor: 'file.write', detail: 'File system write' }, { kind: 'opens', descriptor: 'file.path', detail: 'File opened for writing' }] },
    { pattern: /\bcreateReadStream\b/i, effects: [{ kind: 'opens', descriptor: 'file.stream.read', detail: 'Read stream opened' }] },
    { pattern: /\bcreateWriteStream\b/i, effects: [{ kind: 'opens', descriptor: 'file.stream.write', detail: 'Write stream opened' }, { kind: 'writes', descriptor: 'file.stream', detail: 'Write stream' }] },

    // Cache
    { pattern: /\bredis\.(get|mget|hget|hgetall|lrange|smembers)\b/i, effects: [{ kind: 'reads', descriptor: 'cache.redis.read', detail: 'Redis read' }] },
    { pattern: /\bredis\.(set|mset|hset|lpush|rpush|sadd|del|expire|incr|decr)\b/i, effects: [{ kind: 'writes', descriptor: 'cache.redis.write', detail: 'Redis write' }] },

    // Logging
    { pattern: /\b(console|logger|log)\.(log|info|warn|error|debug|trace|fatal)\b/i, effects: [{ kind: 'logs', descriptor: 'log.generic', detail: 'Logging call' }] },

    // Auth
    { pattern: /\b(authenticate|authorize|verifyToken|checkPermission|requireRole|guardRoute)\b/i, effects: [{ kind: 'requires', descriptor: 'auth.check', detail: 'Authentication/authorization check' }] },
    { pattern: /\b(jwt|passport|session)\.(verify|sign|authenticate|decode)\b/i, effects: [{ kind: 'requires', descriptor: 'auth.token', detail: 'Token verification' }] },

    // Locking / concurrency
    { pattern: /\b(mutex|semaphore|lock|acquire|acquireLock)\b/i, effects: [{ kind: 'acquires_lock', descriptor: 'concurrency.lock', detail: 'Lock acquisition' }] },

    // Validation / normalization
    { pattern: /\b(validate|sanitize|normalize|trim|toLowerCase|toUpperCase|slugify)\b/i, effects: [{ kind: 'normalizes', descriptor: 'data.normalize', detail: 'Data normalization/validation' }] },

    // Payment / external services
    { pattern: /\bstripe\b/i, effects: [{ kind: 'calls_external', descriptor: 'network.stripe', detail: 'Stripe payment API' }] },
    { pattern: /\b(twilio|sendgrid|mailgun|ses)\b/i, effects: [{ kind: 'calls_external', descriptor: 'network.email_sms', detail: 'Email/SMS service' }] },
    { pattern: /\b(s3|gcs|azure\.storage|cloudStorage)\b/i, effects: [{ kind: 'calls_external', descriptor: 'network.cloud_storage', detail: 'Cloud storage API' }] },

    // ── Rust-specific ──
    { pattern: /\btokio::(spawn|block_on|select!)\b/, languages: ['rust'], effects: [{ kind: 'calls_external', descriptor: 'runtime.tokio', detail: 'Tokio async runtime' }] },
    { pattern: /\breqwest::(get|Client)\b/, languages: ['rust'], effects: [{ kind: 'calls_external', descriptor: 'network.reqwest', detail: 'Reqwest HTTP client' }] },
    { pattern: /\bstd::fs::/, languages: ['rust'], effects: [{ kind: 'opens', descriptor: 'file.rust_fs', detail: 'Rust std::fs file operation' }] },
    { pattern: /\bFile::(open|create)\b/, languages: ['rust'], effects: [{ kind: 'opens', descriptor: 'file.rust_file', detail: 'Rust File open/create' }] },
    { pattern: /\b(diesel|sqlx|sea_orm)::.*(select|find|load|get)\b/i, languages: ['rust'], effects: [{ kind: 'reads', descriptor: 'db.rust_orm_read', detail: 'Rust ORM read' }] },
    { pattern: /\b(diesel|sqlx|sea_orm)::.*(insert|update|delete|execute)\b/i, languages: ['rust'], effects: [{ kind: 'writes', descriptor: 'db.rust_orm_write', detail: 'Rust ORM write' }] },
    { pattern: /\bArc::(new|clone)\b/, languages: ['rust'], effects: [{ kind: 'mutates', descriptor: 'state.arc_shared', detail: 'Arc shared state' }] },
    { pattern: /\bMutex::(new|lock)\b/, languages: ['rust'], effects: [{ kind: 'acquires_lock', descriptor: 'concurrency.mutex', detail: 'Mutex lock' }] },
    { pattern: /\bRwLock::(new|read|write)\b/, languages: ['rust'], effects: [{ kind: 'acquires_lock', descriptor: 'concurrency.rwlock', detail: 'RwLock' }] },
    { pattern: /\bunsafe\s*\{/, languages: ['rust'], effects: [{ kind: 'mutates', descriptor: 'state.unsafe_block', detail: 'Unsafe memory operations' }] },
    { pattern: /\bpanic!\b/, languages: ['rust'], effects: [{ kind: 'throws', descriptor: 'error.panic', detail: 'Rust panic' }] },
    { pattern: /\b\.unwrap\(\)/, languages: ['rust'], effects: [{ kind: 'throws', descriptor: 'error.unwrap_panic', detail: 'Potential panic on unwrap' }] },
    { pattern: /\bserde(_json)?::(to_string|from_str|serialize|deserialize)\b/, languages: ['rust'], effects: [{ kind: 'normalizes', descriptor: 'data.serde', detail: 'Serde serialization/deserialization' }] },
    { pattern: /\btracing::(info|warn|error|debug|trace)!?\b/, languages: ['rust'], effects: [{ kind: 'logs', descriptor: 'log.tracing', detail: 'Tracing log' }] },
    { pattern: /\blog::(info|warn|error|debug|trace)!?\b/, languages: ['rust'], effects: [{ kind: 'logs', descriptor: 'log.rust_log', detail: 'Rust log crate' }] },

    // ── Java-specific ──
    { pattern: /\b(JdbcTemplate|NamedParameterJdbcTemplate)\.(query|queryForObject|queryForList)\b/, languages: ['java'], effects: [{ kind: 'reads', descriptor: 'db.jdbc_read', detail: 'JDBC query' }] },
    { pattern: /\b(JdbcTemplate|NamedParameterJdbcTemplate)\.(update|batchUpdate|execute)\b/, languages: ['java'], effects: [{ kind: 'writes', descriptor: 'db.jdbc_write', detail: 'JDBC update' }] },
    { pattern: /\bEntityManager\.(find|createQuery|createNamedQuery|getReference)\b/, languages: ['java'], effects: [{ kind: 'reads', descriptor: 'db.jpa_read', detail: 'JPA read' }] },
    { pattern: /\bEntityManager\.(persist|merge|remove|flush)\b/, languages: ['java'], effects: [{ kind: 'writes', descriptor: 'db.jpa_write', detail: 'JPA write' }] },
    { pattern: /\b(HttpClient|OkHttpClient|RestTemplate|WebClient)\b/, languages: ['java'], effects: [{ kind: 'calls_external', descriptor: 'network.java_http', detail: 'Java HTTP client' }] },
    { pattern: /\bFiles\.(read|write|copy|move|delete|walk|list|newInputStream|newOutputStream)\b/, languages: ['java'], effects: [{ kind: 'opens', descriptor: 'file.java_nio', detail: 'Java NIO file operation' }] },
    { pattern: /\b(FileInputStream|FileOutputStream|BufferedReader|BufferedWriter)\b/, languages: ['java'], effects: [{ kind: 'opens', descriptor: 'file.java_io', detail: 'Java IO file operation' }] },
    { pattern: /\bsynchronized\b/, languages: ['java'], effects: [{ kind: 'acquires_lock', descriptor: 'concurrency.java_synchronized', detail: 'Java synchronized block' }] },
    { pattern: /\b(ReentrantLock|StampedLock|CountDownLatch|Semaphore)\b/, languages: ['java'], effects: [{ kind: 'acquires_lock', descriptor: 'concurrency.java_lock', detail: 'Java concurrency lock' }] },
    { pattern: /\b@Transactional\b/, languages: ['java'], effects: [{ kind: 'writes', descriptor: 'db.transaction', detail: 'Spring @Transactional' }, { kind: 'acquires_lock', descriptor: 'db.transaction_lock', detail: 'Transaction lock' }] },
    { pattern: /\bLogger\.(info|warn|error|debug|trace)\b/, languages: ['java'], effects: [{ kind: 'logs', descriptor: 'log.java_logger', detail: 'Java Logger' }] },

    // ── C#-specific ──
    { pattern: /\bDbContext\b/, languages: ['csharp'], effects: [{ kind: 'reads', descriptor: 'db.ef_context', detail: 'Entity Framework DbContext' }] },
    { pattern: /\b(DbSet|IQueryable)\.(Where|Select|Include|FirstOrDefault|ToList|Any|Count)\b/, languages: ['csharp'], effects: [{ kind: 'reads', descriptor: 'db.ef_read', detail: 'EF LINQ query' }] },
    { pattern: /\b(SaveChanges|SaveChangesAsync|Add|Remove|Update)\b/, languages: ['csharp'], effects: [{ kind: 'writes', descriptor: 'db.ef_write', detail: 'EF write operation' }] },
    { pattern: /\bHttpClient\.(GetAsync|PostAsync|PutAsync|DeleteAsync|SendAsync)\b/, languages: ['csharp'], effects: [{ kind: 'calls_external', descriptor: 'network.csharp_http', detail: 'C# HttpClient' }] },
    { pattern: /\b(File|Directory)\.(Read|Write|Create|Delete|Move|Copy|Exists)\b/, languages: ['csharp'], effects: [{ kind: 'opens', descriptor: 'file.csharp_io', detail: 'C# file I/O' }] },
    { pattern: /\block\s*\(/, languages: ['csharp'], effects: [{ kind: 'acquires_lock', descriptor: 'concurrency.csharp_lock', detail: 'C# lock statement' }] },
    { pattern: /\b(SemaphoreSlim|Monitor|Mutex)\b/, languages: ['csharp'], effects: [{ kind: 'acquires_lock', descriptor: 'concurrency.csharp_sync', detail: 'C# synchronization primitive' }] },
    { pattern: /\bILogger\.(Log|Info|Warn|Error|Debug|Trace)\b/i, languages: ['csharp'], effects: [{ kind: 'logs', descriptor: 'log.csharp_ilogger', detail: 'C# ILogger' }] },

    // ── Ruby-specific ──
    { pattern: /\b(ActiveRecord|ApplicationRecord)/, languages: ['ruby'], effects: [{ kind: 'reads', descriptor: 'db.activerecord', detail: 'ActiveRecord model' }] },
    { pattern: /\.(where|find|find_by|pluck|select|joins|includes|eager_load)\b/, languages: ['ruby'], effects: [{ kind: 'reads', descriptor: 'db.ar_read', detail: 'ActiveRecord read' }] },
    { pattern: /\.(create|update|destroy|save|delete|insert)\b/, languages: ['ruby'], effects: [{ kind: 'writes', descriptor: 'db.ar_write', detail: 'ActiveRecord write' }] },
    { pattern: /\b(Net::HTTP|HTTParty|Faraday|RestClient)\b/, languages: ['ruby'], effects: [{ kind: 'calls_external', descriptor: 'network.ruby_http', detail: 'Ruby HTTP client' }] },
    { pattern: /\bFile\.(open|read|write|delete)\b/, languages: ['ruby'], effects: [{ kind: 'opens', descriptor: 'file.ruby_io', detail: 'Ruby File I/O' }] },
    { pattern: /\bRails\.cache\b/, languages: ['ruby'], effects: [{ kind: 'reads', descriptor: 'cache.rails', detail: 'Rails cache' }] },
    { pattern: /\bRedis\b/, languages: ['ruby'], effects: [{ kind: 'reads', descriptor: 'cache.redis', detail: 'Redis client' }] },
    { pattern: /\braise\s+\w/, languages: ['ruby'], effects: [{ kind: 'throws', descriptor: 'error.ruby_raise', detail: 'Ruby exception raised' }] },
    { pattern: /\bRails\.logger\b/, languages: ['ruby'], effects: [{ kind: 'logs', descriptor: 'log.rails', detail: 'Rails logger' }] },

    // ── Go-specific ──
    { pattern: /\bhttp\.(Get|Post|Head|NewRequest)\b/, languages: ['go'], effects: [{ kind: 'calls_external', descriptor: 'network.go_http', detail: 'Go HTTP client' }] },
    { pattern: /\bsql\.(Open|DB)\b/, languages: ['go'], effects: [{ kind: 'reads', descriptor: 'db.go_sql', detail: 'Go database/sql' }] },
    { pattern: /\bos\.(Open|Create|Remove|Mkdir)\b/, languages: ['go'], effects: [{ kind: 'opens', descriptor: 'file.go_os', detail: 'Go os file operation' }] },
    { pattern: /\bsync\.(Mutex|RWMutex|WaitGroup)\b/, languages: ['go'], effects: [{ kind: 'acquires_lock', descriptor: 'concurrency.go_sync', detail: 'Go sync primitive' }] },
    { pattern: /\bgo\s+\w+\(/, languages: ['go'], effects: [{ kind: 'calls_external', descriptor: 'runtime.goroutine', detail: 'Goroutine launched' }] },
    { pattern: /\b(log|slog)\.(Print|Fatal|Panic|Info|Warn|Error|Debug)\b/, languages: ['go'], effects: [{ kind: 'logs', descriptor: 'log.go', detail: 'Go logger' }] },

    // ── C++-specific ──
    { pattern: /\bstd::thread\b/, languages: ['cpp'], effects: [{ kind: 'calls_external', descriptor: 'runtime.cpp_thread', detail: 'C++ thread' }] },
    { pattern: /\bstd::(mutex|shared_mutex|lock_guard|unique_lock)\b/, languages: ['cpp'], effects: [{ kind: 'acquires_lock', descriptor: 'concurrency.cpp_mutex', detail: 'C++ mutex' }] },
    { pattern: /\bstd::(ifstream|ofstream|fstream)\b/, languages: ['cpp'], effects: [{ kind: 'opens', descriptor: 'file.cpp_fstream', detail: 'C++ file stream' }] },
    { pattern: /\bboost::asio\b/, languages: ['cpp'], effects: [{ kind: 'calls_external', descriptor: 'network.boost_asio', detail: 'Boost.Asio network' }] },
    { pattern: /\bstd::cout\b/, languages: ['cpp'], effects: [{ kind: 'logs', descriptor: 'log.cpp_cout', detail: 'C++ stdout' }] },
    { pattern: /\bstd::cerr\b/, languages: ['cpp'], effects: [{ kind: 'logs', descriptor: 'log.cpp_cerr', detail: 'C++ stderr' }] },
];

// ── Engine ───────────────────────────────────────────────────────────────────

export class EffectEngine {

    // ── Batch computation ────────────────────────────────────────────────

    /**
     * Compute effect signatures for all symbol versions in a snapshot.
     * Pulls behavioral profiles and contract profiles from the DB,
     * converts them to typed effects, and persists effect signatures.
     *
     * Returns the number of signatures computed.
     */
    public async computeEffectSignatures(snapshotId: string): Promise<number> {
        const timer = log.startTimer('computeEffectSignatures', { snapshotId });

        // Load all symbol versions for the snapshot
        const svResult = await db.query(`
            SELECT sv.symbol_version_id, sv.body_source, sv.signature, sv.summary,
                   sv.language, s.canonical_name, s.kind
            FROM symbol_versions sv
            JOIN symbols s ON s.symbol_id = sv.symbol_id
            WHERE sv.snapshot_id = $1
        `, [snapshotId]);

        const symbolVersions = svResult.rows as {
            symbol_version_id: string;
            body_source: string | null;
            signature: string;
            summary: string;
            language: string;
            canonical_name: string;
            kind: string;
        }[];

        if (symbolVersions.length === 0) {
            timer({ computed: 0 });
            return 0;
        }

        // Batch-load all behavioral profiles for this snapshot
        const bpResult = await db.query(`
            SELECT bp.*
            FROM behavioral_profiles bp
            JOIN symbol_versions sv ON sv.symbol_version_id = bp.symbol_version_id
            WHERE sv.snapshot_id = $1
        `, [snapshotId]);

        const behavioralBySymbol = new Map<string, BehavioralProfile>();
        for (const row of validateRows(bpResult.rows, validateBehavioralProfile, 'effectEngine.batchBehavioral')) {
            behavioralBySymbol.set(row.symbol_version_id, row);
        }

        // Batch-load all contract profiles for this snapshot
        const cpResult = await db.query(`
            SELECT cp.*
            FROM contract_profiles cp
            JOIN symbol_versions sv ON sv.symbol_version_id = cp.symbol_version_id
            WHERE sv.snapshot_id = $1
        `, [snapshotId]);

        const contractBySymbol = new Map<string, ContractProfile>();
        for (const row of validateRows(cpResult.rows, validateContractProfile, 'effectEngine.batchContract')) {
            contractBySymbol.set(row.symbol_version_id, row);
        }

        // Compute effect signatures for each symbol version
        const statements: { text: string; params: unknown[] }[] = [];
        let computed = 0;

        for (const sv of symbolVersions) {
            const bp = behavioralBySymbol.get(sv.symbol_version_id);
            const cp = contractBySymbol.get(sv.symbol_version_id);

            const effects: EffectEntry[] = [];

            // Mine from behavioral profile
            if (bp) {
                effects.push(...this.mineFromBehavioralProfile(bp));
            }

            // Mine from contract profile
            if (cp) {
                effects.push(...this.mineFromContractProfile(cp));
            }

            // Mine from framework patterns (body source + signature)
            // Skip framework pattern mining for class/interface/type_alias symbols:
            // their body_source contains ALL member code, so patterns like .query()
            // or .get() inside methods would be falsely attributed to the class itself.
            // Individual methods get their own effect signatures.
            const isContainerKind = sv.kind === 'class' || sv.kind === 'interface' || sv.kind === 'type_alias';
            if (!isContainerKind) {
                const codeText = [sv.body_source || '', sv.signature || '', sv.summary || ''].join('\n');
                effects.push(...this.mineFromFrameworkPatterns(codeText, sv.language));
            }

            // Deduplicate effects by kind+descriptor
            const deduped = this.deduplicateEffects(effects);

            // Classify
            const effectClass = this.classifyEffectClass(deduped);

            // Compute confidence based on source data availability
            const confidence = this.computeConfidence(bp !== undefined, cp !== undefined, sv.body_source !== null);

            // Build summary arrays
            const readsResources = this.collectDescriptors(deduped, 'reads');
            const writesResources = this.collectDescriptors(deduped, 'writes');
            const emitsEvents = this.collectDescriptors(deduped, 'emits');
            const callsExternal = this.collectDescriptors(deduped, 'calls_external');
            const mutatesState = this.collectDescriptors(deduped, 'mutates');
            const requiresAuth = this.collectDescriptors(deduped, 'requires');
            const throwsErrors = this.collectDescriptors(deduped, 'throws');

            const sigId = uuidv4();
            statements.push({
                text: `INSERT INTO effect_signatures (
                    effect_signature_id, symbol_version_id, effects, effect_class,
                    reads_resources, writes_resources, emits_events, calls_external,
                    mutates_state, requires_auth, throws_errors, source, confidence
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
                ON CONFLICT (symbol_version_id, source)
                DO UPDATE SET
                    effects = EXCLUDED.effects,
                    effect_class = EXCLUDED.effect_class,
                    reads_resources = EXCLUDED.reads_resources,
                    writes_resources = EXCLUDED.writes_resources,
                    emits_events = EXCLUDED.emits_events,
                    calls_external = EXCLUDED.calls_external,
                    mutates_state = EXCLUDED.mutates_state,
                    requires_auth = EXCLUDED.requires_auth,
                    throws_errors = EXCLUDED.throws_errors,
                    confidence = EXCLUDED.confidence`,
                params: [
                    sigId, sv.symbol_version_id, JSON.stringify(deduped), effectClass,
                    readsResources, writesResources, emitsEvents, callsExternal,
                    mutatesState, requiresAuth, throwsErrors, 'static_analysis', confidence,
                ],
            });
            computed++;
        }

        // Batch-persist in chunks to avoid oversized transactions
        const CHUNK_SIZE = 500;
        for (let i = 0; i < statements.length; i += CHUNK_SIZE) {
            const chunk = statements.slice(i, i + CHUNK_SIZE);
            await db.batchInsert(chunk);
        }

        timer({ computed, total_symbols: symbolVersions.length });
        return computed;
    }

    // ── Single-symbol computation ────────────────────────────────────────

    /**
     * Compute typed effect signature for a single symbol version.
     * Accepts behavior hints directly (e.g., from adapter extraction pipeline)
     * and also pulls contract data from the DB.
     */
    public async computeForSymbol(
        symbolVersionId: string,
        behaviorHints: BehaviorHint[]
    ): Promise<EffectSignature> {
        const timer = log.startTimer('computeForSymbol', {
            symbolVersionId,
            hintCount: behaviorHints.length,
        });

        const effects: EffectEntry[] = [];

        // Mine from raw behavior hints
        effects.push(...this.mineFromBehaviorHints(behaviorHints));

        // Mine from existing behavioral profile in DB (if any)
        const bpResult = await db.query(
            `SELECT * FROM behavioral_profiles WHERE symbol_version_id = $1`,
            [symbolVersionId]
        );
        const bp = bpResult.rows[0] as BehavioralProfile | undefined;
        if (bp) {
            effects.push(...this.mineFromBehavioralProfile(bp));
        }

        // Mine from contract profile in DB (if any)
        const cpResult = await db.query(
            `SELECT * FROM contract_profiles WHERE symbol_version_id = $1`,
            [symbolVersionId]
        );
        const cp = cpResult.rows[0] as ContractProfile | undefined;
        if (cp) {
            effects.push(...this.mineFromContractProfile(cp));
        }

        // Mine from framework patterns (body source)
        // Query kind alongside body_source to gate container-kind symbols
        const svResult = await db.query(
            `SELECT sv.body_source, sv.signature, sv.summary, sv.language, s.kind
             FROM symbol_versions sv
             JOIN symbols s ON s.symbol_id = sv.symbol_id
             WHERE sv.symbol_version_id = $1`,
            [symbolVersionId]
        );
        const sv = svResult.rows[0] as { body_source: string | null; signature: string; summary: string; language: string; kind: string } | undefined;
        if (sv) {
            // Skip framework pattern mining for class/interface/type_alias symbols
            const isContainerKind = sv.kind === 'class' || sv.kind === 'interface' || sv.kind === 'type_alias';
            if (!isContainerKind) {
                const codeText = [sv.body_source || '', sv.signature || '', sv.summary || ''].join('\n');
                effects.push(...this.mineFromFrameworkPatterns(codeText, sv.language));
            }
        }

        // Deduplicate
        const deduped = this.deduplicateEffects(effects);
        const effectClass = this.classifyEffectClass(deduped);
        const confidence = this.computeConfidence(bp !== undefined, cp !== undefined, sv?.body_source !== null && sv?.body_source !== undefined);

        const readsResources = this.collectDescriptors(deduped, 'reads');
        const writesResources = this.collectDescriptors(deduped, 'writes');
        const emitsEvents = this.collectDescriptors(deduped, 'emits');
        const callsExternal = this.collectDescriptors(deduped, 'calls_external');
        const mutatesState = this.collectDescriptors(deduped, 'mutates');
        const requiresAuth = this.collectDescriptors(deduped, 'requires');
        const throwsErrors = this.collectDescriptors(deduped, 'throws');

        const sigId = uuidv4();

        // Persist
        await db.query(`
            INSERT INTO effect_signatures (
                effect_signature_id, symbol_version_id, effects, effect_class,
                reads_resources, writes_resources, emits_events, calls_external,
                mutates_state, requires_auth, throws_errors, source, confidence
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
            ON CONFLICT (symbol_version_id, source)
            DO UPDATE SET
                effects = EXCLUDED.effects,
                effect_class = EXCLUDED.effect_class,
                reads_resources = EXCLUDED.reads_resources,
                writes_resources = EXCLUDED.writes_resources,
                emits_events = EXCLUDED.emits_events,
                calls_external = EXCLUDED.calls_external,
                mutates_state = EXCLUDED.mutates_state,
                requires_auth = EXCLUDED.requires_auth,
                throws_errors = EXCLUDED.throws_errors,
                confidence = EXCLUDED.confidence
        `, [
            sigId, symbolVersionId, JSON.stringify(deduped), effectClass,
            readsResources, writesResources, emitsEvents, callsExternal,
            mutatesState, requiresAuth, throwsErrors, 'static_analysis', confidence,
        ]);

        const signature: EffectSignature = {
            effect_signature_id: sigId,
            symbol_version_id: symbolVersionId,
            effects: deduped,
            effect_class: effectClass,
            reads_resources: readsResources,
            writes_resources: writesResources,
            emits_events: emitsEvents,
            calls_external: callsExternal,
            mutates_state: mutatesState,
            requires_auth: requiresAuth,
            throws_errors: throwsErrors,
            source: 'static_analysis',
            confidence,
        };

        timer({ effectClass, effectCount: deduped.length });
        return signature;
    }

    // ── Transitive propagation ───────────────────────────────────────────

    /**
     * Propagate typed effects transitively through the call graph.
     *
     * Like BehavioralEngine.propagateTransitive but for typed effects:
     *   1. Load all effect signatures for the snapshot
     *   2. Load the call graph
     *   3. Kahn's topological sort: walk bottom-up from leaf nodes in O(V+E)
     *   4. Each propagated effect is tagged as transitive
     *   5. Re-classify effect class after merging
     *   6. Persist only changed signatures
     *   7. Cycles are detected and skipped (nodes with remaining in-degree > 0)
     *
     * Returns the number of signatures updated.
     */
    public async propagateEffectsTransitive(snapshotId: string): Promise<number> {
        const timer = log.startTimer('propagateEffectsTransitive', { snapshotId });

        // Load all effect signatures for this snapshot
        const sigResult = await db.query(`
            SELECT es.*
            FROM effect_signatures es
            JOIN symbol_versions sv ON sv.symbol_version_id = es.symbol_version_id
            WHERE sv.snapshot_id = $1
            AND es.source = 'static_analysis'
        `, [snapshotId]);

        const signatures = new Map<string, {
            effects: EffectEntry[];
            effect_class: EffectClass;
        }>();

        for (const row of sigResult.rows as {
            symbol_version_id: string;
            effects: EffectEntry[] | string;
            effect_class: EffectClass;
        }[]) {
            // JSONB may come back as a string or parsed object depending on driver
            const effects: EffectEntry[] = Array.isArray(row.effects)
                ? row.effects
                : (jsonField<EffectEntry[]>(row as Record<string, unknown>, 'effects') ?? []);
            signatures.set(row.symbol_version_id, {
                effects: [...effects],
                effect_class: row.effect_class,
            });
        }

        if (signatures.size === 0) {
            timer({ propagated: 0 });
            return 0;
        }

        // Load call graph edges for this snapshot
        const callResult = await db.query(`
            SELECT sr.src_symbol_version_id, sr.dst_symbol_version_id
            FROM structural_relations sr
            JOIN symbol_versions sv ON sv.symbol_version_id = sr.src_symbol_version_id
            WHERE sv.snapshot_id = $1
            AND sr.relation_type = 'calls'
        `, [snapshotId]);

        // Build adjacency: caller → [callees]
        const callGraph = new Map<string, string[]>();
        for (const row of callResult.rows as { src_symbol_version_id: string; dst_symbol_version_id: string }[]) {
            const existing = callGraph.get(row.src_symbol_version_id) || [];
            existing.push(row.dst_symbol_version_id);
            callGraph.set(row.src_symbol_version_id, existing);
        }

        // Topological propagation via Kahn's algorithm: walk the call graph
        // bottom-up in a single O(V+E) pass instead of bounded fixed-point iteration.
        //
        // Strategy:
        //   1. Compute in-degree for each node (how many profiled callees it has)
        //   2. Start from leaf nodes (zero in-degree — no callees with signatures)
        //   3. Propagate effects upward through the graph
        //   4. Nodes stuck with in-degree > 0 after traversal are in cycles — skipped
        //
        // This replaces the old fixed-point loop (MAX_ITERATIONS=10) which:
        //   - Could silently fail for deep call chains >10 levels
        //   - Used O(n) Array.some() for effect deduplication per merge
        //   - Ran multiple full passes over the entire graph

        const changedSvIds = new Set<string>();

        // Build reverse graph: callee → [callers]
        const reverseGraph = new Map<string, string[]>();
        const inDegree = new Map<string, number>();

        // Initialize in-degrees for all nodes in the call graph
        for (const callerId of callGraph.keys()) {
            if (!inDegree.has(callerId)) inDegree.set(callerId, 0);
        }

        for (const [callerId, callees] of callGraph) {
            for (const calleeId of callees) {
                if (!signatures.has(calleeId)) continue; // Skip unresolved callees
                // Count how many profiled callees each caller has
                inDegree.set(callerId, (inDegree.get(callerId) || 0) + 1);
                // Build reverse: callee → callers
                const callers = reverseGraph.get(calleeId) || [];
                callers.push(callerId);
                reverseGraph.set(calleeId, callers);
                if (!inDegree.has(calleeId)) inDegree.set(calleeId, 0);
            }
        }

        // Build per-signature effect key Sets for O(1) membership checks
        const effectKeySets = new Map<string, Set<string>>();
        for (const [svId, sig] of signatures) {
            effectKeySets.set(svId, new Set(
                sig.effects.map(e => `${e.kind}:${e.descriptor}`)
            ));
        }

        // Kahn's algorithm: start with nodes that have no profiled callees (in-degree 0)
        const queue: string[] = [];
        let queueIdx = 0;
        for (const [svId, degree] of inDegree) {
            if (degree === 0 && signatures.has(svId)) queue.push(svId);
        }

        const processed = new Set<string>();
        while (queueIdx < queue.length) {
            const calleeId = queue[queueIdx++]!;
            if (processed.has(calleeId)) continue;
            processed.add(calleeId);

            const calleeSig = signatures.get(calleeId);
            if (!calleeSig) continue;

            // Propagate this callee's effects to all its callers
            const callers = reverseGraph.get(calleeId) || [];
            for (const callerId of callers) {
                const callerSig = signatures.get(callerId);
                if (!callerSig) continue;
                const callerKeys = effectKeySets.get(callerId);
                if (!callerKeys) continue;

                let callerChanged = false;

                // Propagate each callee effect into the caller
                for (const calleeEffect of calleeSig.effects) {
                    const transitiveKey = `${calleeEffect.kind}:${calleeEffect.descriptor}`;

                    if (!callerKeys.has(transitiveKey)) {
                        callerSig.effects.push({
                            kind: calleeEffect.kind,
                            descriptor: calleeEffect.descriptor,
                            detail: `[transitive from ${calleeId}] ${calleeEffect.detail}`,
                            provenance: 'transitive',
                            origin_symbol_version_id: calleeEffect.provenance === 'transitive'
                                ? calleeEffect.origin_symbol_version_id
                                : calleeId,
                        });
                        callerKeys.add(transitiveKey);
                        callerChanged = true;
                    }
                }

                // Escalate effect class if callee is higher
                const calleeLevel = EFFECT_CLASS_ORDER[calleeSig.effect_class];
                const callerLevel = EFFECT_CLASS_ORDER[callerSig.effect_class];
                if (calleeLevel > callerLevel) {
                    callerSig.effect_class = calleeSig.effect_class;
                    callerChanged = true;
                }

                if (callerChanged) changedSvIds.add(callerId);

                // Decrement caller's in-degree; when 0, all its callees are processed
                const newDegree = (inDegree.get(callerId) || 1) - 1;
                inDegree.set(callerId, newDegree);
                if (newDegree <= 0) queue.push(callerId);
            }
        }

        // ── Cycle recovery ──────────────────────────────────────────────
        // Nodes involved in cycles (including self-recursive functions) never
        // reach in-degree 0, so Kahn's algorithm silently skips them. Detect
        // unprocessed nodes, cluster them via BFS on the restricted subgraph,
        // then compute the union of all effects within each cluster and assign
        // the most impure effect_class to every member.
        const unprocessed = Array.from(signatures.keys()).filter(svId => !processed.has(svId) && inDegree.has(svId));
        if (unprocessed.length > 0) {
            log.debug('Effect propagation: recovering cycle members', { count: unprocessed.length });

            // Discover connected cycle clusters via BFS on the call graph
            // restricted to unprocessed nodes
            const unprocessedSet = new Set(unprocessed);
            const visited = new Set<string>();

            for (const startNode of unprocessed) {
                if (visited.has(startNode)) continue;

                // BFS to find all nodes in this cycle cluster
                const cluster: string[] = [];
                const bfsQueue: string[] = [startNode];
                let bfsIdx = 0;
                while (bfsIdx < bfsQueue.length) {
                    const node = bfsQueue[bfsIdx++]!;
                    if (visited.has(node)) continue;
                    visited.add(node);
                    cluster.push(node);

                    // Follow forward edges (callees) restricted to unprocessed
                    const callees = callGraph.get(node) || [];
                    for (const c of callees) {
                        if (unprocessedSet.has(c) && !visited.has(c)) bfsQueue.push(c);
                    }
                    // Follow reverse edges (callers) restricted to unprocessed
                    const callers = reverseGraph.get(node) || [];
                    for (const c of callers) {
                        if (unprocessedSet.has(c) && !visited.has(c)) bfsQueue.push(c);
                    }
                }

                // Compute the union of all effects and the max effect_class across the cluster
                const clusterEffectKeys = new Set<string>();
                const clusterEffects: EffectEntry[] = [];
                let clusterMaxClass: EffectClass = 'pure';

                for (const nodeId of cluster) {
                    const sig = signatures.get(nodeId);
                    if (!sig) continue;
                    for (const effect of sig.effects) {
                        const key = `${effect.kind}:${effect.descriptor}`;
                        if (!clusterEffectKeys.has(key)) {
                            clusterEffectKeys.add(key);
                            clusterEffects.push(effect);
                        }
                    }
                    if (EFFECT_CLASS_ORDER[sig.effect_class] > EFFECT_CLASS_ORDER[clusterMaxClass]) {
                        clusterMaxClass = sig.effect_class;
                    }
                }

                // Assign the union to every member of the cluster
                for (const nodeId of cluster) {
                    const sig = signatures.get(nodeId);
                    if (!sig) continue;
                    const nodeKeys = effectKeySets.get(nodeId);
                    if (!nodeKeys) continue;

                    let changed = false;

                    // Merge cluster effects into this node
                    for (const effect of clusterEffects) {
                        const key = `${effect.kind}:${effect.descriptor}`;
                        if (!nodeKeys.has(key)) {
                            sig.effects.push({
                                kind: effect.kind,
                                descriptor: effect.descriptor,
                                detail: `[cycle-propagated] ${effect.detail}`,
                                provenance: 'transitive',
                                origin_symbol_version_id: effect.provenance === 'transitive'
                                    ? effect.origin_symbol_version_id
                                    : nodeId,
                            });
                            nodeKeys.add(key);
                            changed = true;
                        }
                    }

                    // Escalate effect class to cluster maximum
                    if (EFFECT_CLASS_ORDER[clusterMaxClass] > EFFECT_CLASS_ORDER[sig.effect_class]) {
                        sig.effect_class = clusterMaxClass;
                        changed = true;
                    }

                    if (changed) changedSvIds.add(nodeId);
                }
            }
        }

        // Re-classify and persist changed signatures
        const statements: { text: string; params: unknown[] }[] = [];

        for (const svId of changedSvIds) {
            const sig = signatures.get(svId);
            if (!sig) continue;

            // Reclassify based on full (now merged) effect set
            const reclassified = this.classifyEffectClass(sig.effects);
            sig.effect_class = reclassified;

            const readsResources = this.collectDescriptors(sig.effects, 'reads');
            const writesResources = this.collectDescriptors(sig.effects, 'writes');
            const emitsEvents = this.collectDescriptors(sig.effects, 'emits');
            const callsExternal = this.collectDescriptors(sig.effects, 'calls_external');
            const mutatesState = this.collectDescriptors(sig.effects, 'mutates');
            const requiresAuth = this.collectDescriptors(sig.effects, 'requires');
            const throwsErrors = this.collectDescriptors(sig.effects, 'throws');

            statements.push({
                text: `UPDATE effect_signatures SET
                    effects = $1,
                    effect_class = $2,
                    reads_resources = $3,
                    writes_resources = $4,
                    emits_events = $5,
                    calls_external = $6,
                    mutates_state = $7,
                    requires_auth = $8,
                    throws_errors = $9
                WHERE symbol_version_id = $10 AND source = 'static_analysis'`,
                params: [
                    JSON.stringify(sig.effects), reclassified,
                    readsResources, writesResources, emitsEvents, callsExternal,
                    mutatesState, requiresAuth, throwsErrors, svId,
                ],
            });
        }

        if (statements.length > 0) {
            const CHUNK_SIZE = 500;
            for (let i = 0; i < statements.length; i += CHUNK_SIZE) {
                const chunk = statements.slice(i, i + CHUNK_SIZE);
                await db.batchInsert(chunk);
            }
        }

        timer({ propagated: changedSvIds.size, total_signatures: signatures.size });
        return changedSvIds.size;
    }

    // ── Diffing ──────────────────────────────────────────────────────────

    /**
     * Compare effect signatures between two symbol versions.
     * Used for change validation: detect new, removed, escalated, deescalated effects.
     */
    public async diffEffects(beforeSvId: string, afterSvId: string): Promise<EffectDiff> {
        const [before, after] = await Promise.all([
            this.getEffectSignature(beforeSvId),
            this.getEffectSignature(afterSvId),
        ]);

        // If either is null, create an empty stand-in
        const emptyEffects: EffectEntry[] = [];
        const beforeEffects = before?.effects ?? emptyEffects;
        const afterEffects = after?.effects ?? emptyEffects;
        const beforeClass: EffectClass = before?.effect_class ?? 'pure';
        const afterClass: EffectClass = after?.effect_class ?? 'pure';

        // Build keyed sets for comparison
        const effectKey = (e: EffectEntry): string => `${e.kind}:${e.descriptor}`;

        const beforeKeys = new Set(beforeEffects.map(effectKey));
        const afterKeys = new Set(afterEffects.map(effectKey));

        const addedEffects = afterEffects.filter(e => !beforeKeys.has(effectKey(e)));
        const removedEffects = beforeEffects.filter(e => !afterKeys.has(effectKey(e)));

        // Resource diff (union of all resource-touching descriptors)
        const beforeResources = new Set([
            ...(before?.reads_resources ?? []),
            ...(before?.writes_resources ?? []),
            ...(before?.calls_external ?? []),
        ]);
        const afterResources = new Set([
            ...(after?.reads_resources ?? []),
            ...(after?.writes_resources ?? []),
            ...(after?.calls_external ?? []),
        ]);

        const newResources = [...afterResources].filter(r => !beforeResources.has(r));
        const removedResources = [...beforeResources].filter(r => !afterResources.has(r));

        // Class direction
        const beforeLevel = EFFECT_CLASS_ORDER[beforeClass];
        const afterLevel = EFFECT_CLASS_ORDER[afterClass];
        const classDirection: 'escalated' | 'deescalated' | 'unchanged' =
            afterLevel > beforeLevel ? 'escalated'
                : afterLevel < beforeLevel ? 'deescalated'
                : 'unchanged';

        // Build summary
        const parts: string[] = [];
        if (addedEffects.length > 0) {
            parts.push(`+${addedEffects.length} effect(s) added`);
        }
        if (removedEffects.length > 0) {
            parts.push(`-${removedEffects.length} effect(s) removed`);
        }
        if (classDirection !== 'unchanged') {
            parts.push(`class ${classDirection}: ${beforeClass} -> ${afterClass}`);
        }
        if (newResources.length > 0) {
            parts.push(`+${newResources.length} new resource(s)`);
        }
        if (removedResources.length > 0) {
            parts.push(`-${removedResources.length} resource(s) dropped`);
        }
        const summary = parts.length > 0 ? parts.join('; ') : 'No effect changes detected';

        return {
            before_sv_id: beforeSvId,
            after_sv_id: afterSvId,
            added_effects: addedEffects,
            removed_effects: removedEffects,
            class_before: beforeClass,
            class_after: afterClass,
            class_direction: classDirection,
            new_resources: newResources,
            removed_resources: removedResources,
            summary,
        };
    }

    // ── Retrieval ────────────────────────────────────────────────────────

    /**
     * Get the stored effect signature for a symbol version.
     * Returns null if no signature exists.
     */
    public async getEffectSignature(symbolVersionId: string): Promise<EffectSignature | null> {
        const result = await db.query(
            `SELECT * FROM effect_signatures WHERE symbol_version_id = $1 ORDER BY confidence DESC LIMIT 1`,
            [symbolVersionId]
        );

        if (result.rows.length === 0) return null;

        const row = result.rows[0] as {
            effect_signature_id: string;
            symbol_version_id: string;
            effects: EffectEntry[] | string;
            effect_class: EffectClass;
            reads_resources: string[];
            writes_resources: string[];
            emits_events: string[];
            calls_external: string[];
            mutates_state: string[];
            requires_auth: string[];
            throws_errors: string[];
            source: string;
            confidence: number;
        };

        return {
            effect_signature_id: row.effect_signature_id,
            symbol_version_id: row.symbol_version_id,
            effects: Array.isArray(row.effects)
                ? row.effects
                : (jsonField<EffectEntry[]>(row as Record<string, unknown>, 'effects') ?? []),
            effect_class: row.effect_class,
            reads_resources: row.reads_resources || [],
            writes_resources: row.writes_resources || [],
            emits_events: row.emits_events || [],
            calls_external: row.calls_external || [],
            mutates_state: row.mutates_state || [],
            requires_auth: row.requires_auth || [],
            throws_errors: row.throws_errors || [],
            source: row.source,
            confidence: row.confidence,
        };
    }

    // ── Classification ───────────────────────────────────────────────────

    /**
     * Classify the effect class for a set of effects.
     *
     * 5-tier ladder:
     *   pure           — no effects at all
     *   reader         — only reads (db reads, cache reads, config reads)
     *   writer         — reads + writes (db writes, state mutations, file writes)
     *   io             — network calls, external system interaction
     *   full_side_effect — transactions, event emission, auth changes, locks
     */
    public classifyEffectClass(effects: EffectEntry[]): EffectClass {
        if (effects.length === 0) return 'pure';

        const kinds = new Set(effects.map(e => e.kind));

        // Tier 5: full_side_effect — events, locks, or external calls + writes
        if (kinds.has('emits') || kinds.has('acquires_lock')) {
            return 'full_side_effect';
        }

        // Check for transaction patterns in write descriptors
        const hasTransaction = effects.some(e =>
            e.kind === 'writes' && e.descriptor.includes('transaction')
        );
        if (hasTransaction) {
            return 'full_side_effect';
        }

        // Tier 4: io — network calls / external system interaction
        if (kinds.has('calls_external')) {
            return 'io';
        }

        // Tier 3: writer — writes, mutations, file writes, opens
        if (kinds.has('writes') || kinds.has('mutates') || kinds.has('opens')) {
            return 'writer';
        }

        // Tier 2: reader — only reads, requires, throws, normalizes, logs
        // These are all non-mutating observations
        if (kinds.has('reads') || kinds.has('requires') || kinds.has('throws')
            || kinds.has('normalizes') || kinds.has('logs')) {
            return 'reader';
        }

        // Tier 1: pure — no recognized effects
        return 'pure';
    }

    // ── Mining: behavioral profile → effects ─────────────────────────────

    /**
     * Convert a V1 behavioral profile into typed effect entries.
     * This is the upgrade path from the existing purity-class system.
     */
    private mineFromBehavioralProfile(bp: BehavioralProfile): EffectEntry[] {
        const effects: EffectEntry[] = [];

        // DB reads
        for (const read of bp.db_reads) {
            effects.push({
                kind: 'reads',
                descriptor: `db.${read}`,
                detail: `DB read: ${read}`,
                provenance: 'direct',
            });
        }

        // DB writes
        for (const write of bp.db_writes) {
            effects.push({
                kind: 'writes',
                descriptor: `db.${write}`,
                detail: `DB write: ${write}`,
                provenance: 'direct',
            });
        }

        // Network calls
        for (const call of bp.network_calls) {
            effects.push({
                kind: 'calls_external',
                descriptor: `network.${call}`,
                detail: `Network call: ${call}`,
                provenance: 'direct',
            });
        }

        // File I/O
        for (const file of bp.file_io) {
            effects.push({
                kind: 'opens',
                descriptor: `file.${file}`,
                detail: `File I/O: ${file}`,
                provenance: 'direct',
            });
        }

        // Cache ops — classify as reads or writes based on content
        for (const op of bp.cache_ops) {
            const isWrite = /write|set|put|del|expire|incr|decr|invalidate/i.test(op);
            effects.push({
                kind: isWrite ? 'writes' : 'reads',
                descriptor: `cache.${op}`,
                detail: `Cache ${isWrite ? 'write' : 'read'}: ${op}`,
                provenance: 'direct',
            });
        }

        // Auth operations
        for (const auth of bp.auth_operations) {
            effects.push({
                kind: 'requires',
                descriptor: `auth.${auth}`,
                detail: `Auth check: ${auth}`,
                provenance: 'direct',
            });
        }

        // State mutations
        for (const mutation of bp.state_mutation_profile) {
            effects.push({
                kind: 'mutates',
                descriptor: `state.${mutation}`,
                detail: `State mutation: ${mutation}`,
                provenance: 'direct',
            });
        }

        // Transactions — writes + lock
        for (const txn of bp.transaction_profile) {
            effects.push({
                kind: 'writes',
                descriptor: `db.transaction.${txn}`,
                detail: `Transaction: ${txn}`,
                provenance: 'direct',
            });
            effects.push({
                kind: 'acquires_lock',
                descriptor: `db.transaction_lock.${txn}`,
                detail: `Transaction lock: ${txn}`,
                provenance: 'direct',
            });
        }

        // Exception profile — mine throws
        for (const ex of bp.exception_profile) {
            if (typeof ex === 'string' && ex.startsWith('throws:')) {
                const errorType = ex.replace('throws:', '').trim();
                effects.push({
                    kind: 'throws',
                    descriptor: `error.${errorType}`,
                    detail: `Throws: ${errorType}`,
                    provenance: 'direct',
                });
            }
        }

        // Validation operations → normalizes
        for (const val of bp.validation_operations) {
            effects.push({
                kind: 'normalizes',
                descriptor: `validation.${val}`,
                detail: `Validation: ${val}`,
                provenance: 'direct',
            });
        }

        return effects;
    }

    // ── Mining: contract profile → effects ───────────────────────────────

    /**
     * Extract typed effects from contract profiles.
     * Security contracts → requires effects.
     * Error contracts → throws effects.
     */
    private mineFromContractProfile(cp: ContractProfile): EffectEntry[] {
        const effects: EffectEntry[] = [];

        // Security contract → requires effects
        if (cp.security_contract && cp.security_contract !== 'none') {
            // Split on semicolons (multiple decorators joined with '; ')
            const secParts = cp.security_contract.split(';').map(s => s.trim()).filter(Boolean);
            for (const part of secParts) {
                effects.push({
                    kind: 'requires',
                    descriptor: `auth.${this.normalizeDescriptor(part)}`,
                    detail: `Security contract: ${part}`,
                    provenance: 'direct',
                });
            }
        }

        // Error contract → throws effects
        if (cp.error_contract && cp.error_contract !== 'never') {
            // Error contracts may be union types: "TypeError | ValidationError"
            const errorParts = cp.error_contract.split('|').map(s => s.trim()).filter(Boolean);
            for (const errorType of errorParts) {
                effects.push({
                    kind: 'throws',
                    descriptor: `error.${this.normalizeDescriptor(errorType)}`,
                    detail: `Error contract: ${errorType}`,
                    provenance: 'direct',
                });
            }
        }

        // API contract refs → calls_external (route handlers are IO endpoints)
        if (cp.api_contract_refs && cp.api_contract_refs.length > 0) {
            for (const api of cp.api_contract_refs) {
                effects.push({
                    kind: 'reads',
                    descriptor: `api.${this.normalizeDescriptor(api)}`,
                    detail: `API endpoint: ${api}`,
                    provenance: 'direct',
                });
            }
        }

        return effects;
    }

    // ── Mining: raw behavior hints → effects ─────────────────────────────

    /**
     * Convert raw adapter behavior hints into typed effects.
     * This is used during the per-symbol computation path when
     * hints are available directly from the adapter.
     */
    private mineFromBehaviorHints(hints: BehaviorHint[]): EffectEntry[] {
        const effects: EffectEntry[] = [];

        for (const hint of hints) {
            switch (hint.hint_type) {
                case 'db_read':
                    effects.push({
                        kind: 'reads',
                        descriptor: `db.${hint.detail}`,
                        detail: `DB read: ${hint.detail}`,
                        provenance: 'direct',
                    });
                    break;
                case 'db_write':
                    effects.push({
                        kind: 'writes',
                        descriptor: `db.${hint.detail}`,
                        detail: `DB write: ${hint.detail}`,
                        provenance: 'direct',
                    });
                    break;
                case 'network_call':
                    effects.push({
                        kind: 'calls_external',
                        descriptor: `network.${hint.detail}`,
                        detail: `Network call: ${hint.detail}`,
                        provenance: 'direct',
                    });
                    break;
                case 'file_io':
                    effects.push({
                        kind: 'opens',
                        descriptor: `file.${hint.detail}`,
                        detail: `File I/O: ${hint.detail}`,
                        provenance: 'direct',
                    });
                    break;
                case 'cache_op': {
                    const isWrite = /write|set|put|del|expire|incr|decr|invalidate/i.test(hint.detail);
                    effects.push({
                        kind: isWrite ? 'writes' : 'reads',
                        descriptor: `cache.${hint.detail}`,
                        detail: `Cache ${isWrite ? 'write' : 'read'}: ${hint.detail}`,
                        provenance: 'direct',
                    });
                    break;
                }
                case 'auth_check':
                    effects.push({
                        kind: 'requires',
                        descriptor: `auth.${hint.detail}`,
                        detail: `Auth check: ${hint.detail}`,
                        provenance: 'direct',
                    });
                    break;
                case 'validation':
                    effects.push({
                        kind: 'normalizes',
                        descriptor: `validation.${hint.detail}`,
                        detail: `Validation: ${hint.detail}`,
                        provenance: 'direct',
                    });
                    break;
                case 'throws':
                    effects.push({
                        kind: 'throws',
                        descriptor: `error.${hint.detail}`,
                        detail: `Throws: ${hint.detail}`,
                        provenance: 'direct',
                    });
                    break;
                case 'catches':
                    // Catches are informational — they don't add a new effect
                    // but could attenuate a throw. For now, we skip them.
                    break;
                case 'state_mutation':
                    effects.push({
                        kind: 'mutates',
                        descriptor: `state.${hint.detail}`,
                        detail: `State mutation: ${hint.detail}`,
                        provenance: 'direct',
                    });
                    break;
                case 'transaction':
                    effects.push({
                        kind: 'writes',
                        descriptor: `db.transaction.${hint.detail}`,
                        detail: `Transaction: ${hint.detail}`,
                        provenance: 'direct',
                    });
                    effects.push({
                        kind: 'acquires_lock',
                        descriptor: `db.transaction_lock.${hint.detail}`,
                        detail: `Transaction lock: ${hint.detail}`,
                        provenance: 'direct',
                    });
                    break;
                case 'logging':
                    effects.push({
                        kind: 'logs',
                        descriptor: `log.${hint.detail}`,
                        detail: `Logging: ${hint.detail}`,
                        provenance: 'direct',
                    });
                    break;
                case 'acquires_lock':
                    effects.push({
                        kind: 'acquires_lock',
                        descriptor: `lock.${hint.detail}`,
                        detail: `Acquires lock: ${hint.detail}`,
                        provenance: 'direct',
                    });
                    break;
                case 'concurrency':
                    effects.push({
                        kind: 'calls_external',
                        descriptor: `concurrency.${hint.detail}`,
                        detail: `Concurrency: ${hint.detail}`,
                        provenance: 'direct',
                    });
                    break;
                case 'serialization':
                    effects.push({
                        kind: 'normalizes',
                        descriptor: `serialization.${hint.detail}`,
                        detail: `Serialization: ${hint.detail}`,
                        provenance: 'direct',
                    });
                    break;
                case 'cache_write':
                    effects.push({
                        kind: 'writes',
                        descriptor: `cache.${hint.detail}`,
                        detail: `Cache write: ${hint.detail}`,
                        provenance: 'direct',
                    });
                    break;
                default: {
                    const exhaustiveCheck: never = hint.hint_type;
                    log.warn('Unhandled behavior hint type', { type: String(exhaustiveCheck) });
                    break;
                }
            }
        }

        return effects;
    }

    // ── Mining: framework patterns ───────────────────────────────────────

    /**
     * Scan code text against known library/framework behavior patterns.
     * Returns effects for recognized API calls.
     */
    private mineFromFrameworkPatterns(codeText: string, language: string = ''): EffectEntry[] {
        if (!codeText || codeText.length === 0) return [];

        const effects: EffectEntry[] = [];
        const seen = new Set<string>();
        const lang = language.toLowerCase();

        for (const entry of FRAMEWORK_BEHAVIOR_MAP) {
            if (entry.languages && !entry.languages.includes(lang)) continue;
            if (entry.pattern.test(codeText)) {
                for (const template of entry.effects) {
                    const key = `${template.kind}:${template.descriptor}`;
                    if (!seen.has(key)) {
                        seen.add(key);
                        effects.push({
                            kind: template.kind,
                            descriptor: template.descriptor,
                            detail: template.detail,
                            provenance: 'direct',
                        });
                    }
                }
            }
        }

        return effects;
    }

    // ── Utility ──────────────────────────────────────────────────────────

    /**
     * Deduplicate effects by kind+descriptor, preferring direct over transitive.
     */
    private deduplicateEffects(effects: EffectEntry[]): EffectEntry[] {
        const byKey = new Map<string, EffectEntry>();

        for (const effect of effects) {
            const key = `${effect.kind}:${effect.descriptor}`;
            const existing = byKey.get(key);

            if (!existing) {
                byKey.set(key, effect);
            } else if (existing.provenance === 'transitive' && effect.provenance === 'direct') {
                // Direct provenance wins over transitive
                byKey.set(key, effect);
            }
            // If both are direct or both are transitive, keep the first one
        }

        return Array.from(byKey.values());
    }

    /**
     * Collect descriptors for a given effect kind.
     */
    private collectDescriptors(effects: EffectEntry[], kind: EffectKind): string[] {
        return [...new Set(
            effects
                .filter(e => e.kind === kind)
                .map(e => e.descriptor)
        )];
    }

    /**
     * Compute confidence based on available data sources.
     * More sources → higher confidence.
     */
    private computeConfidence(
        hasBehavioral: boolean,
        hasContract: boolean,
        hasBodySource: boolean
    ): number {
        let confidence = 0.50; // base confidence for framework pattern matching alone

        if (hasBehavioral) confidence += 0.20;
        if (hasContract) confidence += 0.15;
        if (hasBodySource) confidence += 0.10;

        // Cap at 0.95 — never claim perfect confidence for static analysis
        return Math.min(0.95, confidence);
    }

    /**
     * Normalize a descriptor string: lowercase, replace whitespace with underscores,
     * strip special characters that would break downstream consumers.
     */
    private normalizeDescriptor(raw: string): string {
        return raw
            .trim()
            .toLowerCase()
            .replace(/\s+/g, '_')
            .replace(/[^a-z0-9_.-]/g, '');
    }
}

export const effectEngine = new EffectEngine();
