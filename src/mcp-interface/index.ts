/**
 * ContextZero — API Interface (Express HTTP Server)
 *
 * API layer exposing all ContextZero tools as HTTP endpoints.
 *
 * Security:
 * - API key authentication (fail-closed)
 * - Per-route rate limiting
 * - validateBody() on EVERY route — zero ad-hoc validation
 * - No raw filesystem paths accepted from API requests
 * - Repository paths resolved from DB (registered via scg_register_repo)
 * - Allowed base paths enforced via SCG_ALLOWED_BASE_PATHS env var
 * - CORS with configurable origins
 * - Error responses sanitized — no stack traces, no internal paths
 * - Structured logging on all requests
 */

import * as fsp from 'fs/promises';
import * as crypto from 'crypto';
import express, { Request, Response, NextFunction } from 'express';
import { Logger } from '../logger';
import { db } from '../db-driver';
import { destroyAllCaches } from '../cache';
import { coreDataService } from '../db-driver/core_data';
import { structuralGraphEngine } from '../analysis-engine';
import { behavioralEngine } from '../analysis-engine/behavioral';
import { contractEngine } from '../analysis-engine/contracts';
import { blastRadiusEngine } from '../analysis-engine/blast-radius';
import { capsuleCompiler } from '../analysis-engine/capsule-compiler';
import { uncertaintyTracker } from '../analysis-engine/uncertainty';
import { homologInferenceEngine } from '../homolog-engine';
import { transactionalChangeEngine } from '../transactional-editor';
import { ingestor } from '../ingestor';
import { authMiddleware, destroyAuthCleanup, isRequestAuthenticated, requireAdminKey } from '../middleware/auth';
import { rateLimitMiddleware, limiter } from '../middleware/rate-limiter';
import {
    validateBody,
    requireUUID, requireUUIDArray, requireString,
    optionalUUID, optionalString, optionalEnum, optionalConfidence,
    optionalBoundedInt, requireAbsolutePath,
    requirePatchArray, requireSafePathArray,
    requireEnum,
    MAX_GRAPH_DEPTH, MAX_LIST_LIMIT, MAX_TOKEN_BUDGET,
} from '../middleware/validation';
import type { CapsuleMode, ValidationMode, TracePack } from '../types';
import { renderMetrics, metricsMiddleware, setGauge } from '../metrics';
import { runPendingMigrations } from '../db-driver/migrate';
import { firstRow, optionalStringField, parseCountField } from '../db-driver/result';
import { isPathWithinBase, resolveExistingPath, resolvePathWithinBase } from '../path-security';
import { deriveWorkspaceSnapshotIdentity } from '../workspace-native';
import { UserFacingError } from '../types';
import { isProduction, security, server as serverConfig, retention as retentionConfig, validateConfiguration, getConfigSummary } from '../config';
// ────────── Service Layer (shared with MCP bridge) ──────────
import {
    resolveSymbol,
    getSymbolDetails,
    getCodebaseOverview,
    compileSmartContext,
    searchCode,
    listRepos as listReposService,
    listSnapshots as listSnapshotsService,
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
} from '../services';

const log = new Logger('mcp-interface');
const app = express();
app.disable('x-powered-by');

function parseTrustProxy(value: string | undefined): boolean | number | string | undefined {
    if (!value) return undefined;
    const normalized = value.trim().toLowerCase();
    if (!normalized) return undefined;
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
    if (/^\d+$/.test(normalized)) return parseInt(normalized, 10);
    return value;
}

const trustProxy = parseTrustProxy(serverConfig.trustProxy);
if (trustProxy !== undefined) {
    app.set('trust proxy', trustProxy);
}

const HSTS_MAX_AGE_SECONDS = serverConfig.hstsMaxAge;

function isHttpsRequest(req: Request): boolean {
    if (req.secure) return true;
    const forwardedProto = req.headers['x-forwarded-proto'];
    if (typeof forwardedProto !== 'string') return false;
    const commaIdx = forwardedProto.indexOf(',');
    const first = commaIdx === -1 ? forwardedProto : forwardedProto.substring(0, commaIdx);
    return first.trim() === 'https';
}

// ────────── Allowed Base Paths for Repository Registration ──────────
// Resolved allowlist used by repo registration. If empty/unset, ALL paths are
// rejected (fail-closed).
const ALLOWED_BASE_PATHS: string[] = security.allowedBasePaths.flatMap(p => {
        try {
            return [resolveExistingPath(p)];
        } catch (error) {
            log.warn('Ignoring inaccessible allowed base path', {
                path: p,
                error: error instanceof Error ? error.message : String(error),
            });
            return [];
        }
    });

function isPathAllowed(repoPath: string): boolean {
    if (ALLOWED_BASE_PATHS.length === 0) {
        log.warn('No SCG_ALLOWED_BASE_PATHS configured — rejecting all repository registrations');
        return false;
    }
    let resolved: string;
    try {
        resolved = resolveExistingPath(repoPath);
    } catch (error) {
        log.warn('Rejecting repository path that cannot be resolved', {
            repoPath,
            error: error instanceof Error ? error.message : String(error),
        });
        return false;
    }
    return ALLOWED_BASE_PATHS.some(base => isPathWithinBase(base, resolved));
}

// ────────── CORS Middleware ──────────

const CORS_ORIGINS = serverConfig.corsOrigins;

app.use((req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    if (origin && (CORS_ORIGINS.length > 0 && CORS_ORIGINS.includes(origin))) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');
        const CORS_MAX_AGE_SECONDS = 86_400; // 24 hours
        res.setHeader('Access-Control-Max-Age', String(CORS_MAX_AGE_SECONDS));
    }
    if (req.method === 'OPTIONS') {
        res.status(204).end();
        return;
    }
    next();
});

// ────────── Per-Route Body Size Tiers ──────────

const JSON_INGEST  = express.json({ limit: '10mb' });
const JSON_PATCH   = express.json({ limit: '5mb' });
const JSON_QUERY   = express.json({ limit: '100kb' });
const JSON_DEFAULT = express.json({ limit: '1mb' });

// ────────── Core Middleware ──────────
// NOTE: No global JSON parser here — body size limits are enforced per-route
// via JSON_INGEST, JSON_PATCH, JSON_QUERY, or JSON_DEFAULT as the first
// route middleware. A global parser would silently cap all routes at its limit.

// ────────── Request Correlation ID Middleware ──────────
// Extracts X-Request-ID from incoming request headers or generates a UUID.
// Stored on req.correlationId for use by downstream handlers and error responses.
app.use((req: Request, res: Response, next: NextFunction) => {
    let correlationId = (req.headers['x-request-id'] as string) || crypto.randomUUID();
    const MAX_CORRELATION_ID_LENGTH = 128;
    if (correlationId.length > MAX_CORRELATION_ID_LENGTH) {
        correlationId = correlationId.substring(0, MAX_CORRELATION_ID_LENGTH);
    }
    req.correlationId = correlationId;
    res.setHeader('X-Request-ID', correlationId);
    next();
});

// ────────── Security Headers ──────────
app.use((req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    if (HSTS_MAX_AGE_SECONDS > 0 && isHttpsRequest(req)) {
        res.setHeader('Strict-Transport-Security', `max-age=${HSTS_MAX_AGE_SECONDS}; includeSubDomains`);
    }
    next();
});

app.use(metricsMiddleware);

// Request logging (includes correlation ID)
app.use((req: Request, _res: Response, next: NextFunction) => {
    log.info('Request', { method: req.method, path: req.path, ip: req.ip, correlationId: req.correlationId });
    next();
});

app.use(authMiddleware);
app.use(rateLimitMiddleware);

// ────────── Error Handler ──────────

/**
 * Classifies errors into user-facing (400-level) vs internal (500-level).
 * Only known, safe error classes expose their message to the client.
 * All others return a generic "Internal server error" to prevent information leakage.
 *
 * Uses the shared SAFE_ERROR_PREFIXES from handlers.ts — single source of truth
 * for both the REST API and MCP bridge.
 */
import { SAFE_ERROR_PREFIXES } from '../mcp-bridge/handlers';

function isUserFacingError(err: unknown): boolean {
    if (err instanceof UserFacingError) return true;
    if (!(err instanceof Error)) return false;
    return SAFE_ERROR_PREFIXES.some(prefix => err.message.startsWith(prefix));
}

function safeHandler(
    handler: (req: Request, res: Response) => Promise<void>
): (req: Request, res: Response) => void {
    return (req: Request, res: Response) => {
        handler(req, res).catch((err: unknown) => {
            const correlationId = req.correlationId;
            log.error('Unhandled endpoint error', err, { path: req.path, correlationId });
            if (isUserFacingError(err)) {
                const statusCode = err instanceof UserFacingError ? err.statusCode : 422;
                res.status(statusCode).json({ error: (err as Error).message, correlationId });
            } else {
                res.status(500).json({ error: 'Internal server error', correlationId });
            }
        });
    };
}

/**
 * Resolves the repository base path from the DB for a given transaction.
 * Returns null if not configured, allowing the caller to respond with 400.
 */
async function resolveRepoBasePathForTxn(txnId: string): Promise<string | null> {
    const result = await db.query(
        `SELECT r.base_path FROM change_transactions ct
         JOIN repositories r ON r.repo_id = ct.repo_id
         WHERE ct.txn_id = $1`,
        [txnId]
    );
    return optionalStringField(firstRow(result), 'base_path') ?? null;
}

// ────────── Health & Readiness ──────────

app.get('/health', safeHandler(async (req, res) => {
    const health = await db.healthCheck();
    const status = health.connected ? 200 : 503;

    // Minimal response for unauthenticated callers (k8s probes, load balancers).
    // Detailed diagnostics only for requests carrying a valid API key.
    if (!isRequestAuthenticated(req)) {
        res.status(status).json({
            status: health.connected ? 'healthy' : 'degraded',
        });
        return;
    }

    const { symbolCache, profileCache, capsuleCache, homologCache, queryCache } = await import('../cache');
    const cacheStats = {
        symbol: symbolCache.stats(),
        profile: profileCache.stats(),
        capsule: capsuleCache.stats(),
        homolog: homologCache.stats(),
        query: queryCache.stats(),
    };

    // Pool pressure indicator
    const poolStats = db.getPoolStats();
    const poolPressure = poolStats.waiting > 0 ? 'elevated' : 'normal';

    // Stale transaction count (lightweight query)
    let staleTransactionCount = 0;
    try {
        const staleResult = await db.query(
            `SELECT COUNT(*)::int AS cnt FROM change_transactions
             WHERE state NOT IN ('committed', 'rolled_back', 'failed')
               AND updated_at < NOW() - INTERVAL '1 minute' * $1`,
            [retentionConfig.staleTransactionTimeoutMinutes],
        );
        staleTransactionCount = (staleResult.rows[0] as { cnt: number })?.cnt ?? 0;
    } catch { /* best-effort */ }

    res.status(status).json({
        status: health.connected ? 'healthy' : 'degraded',
        version: serverConfig.version,
        uptime_seconds: Math.floor(process.uptime()),
        memory_mb: Math.round(process.memoryUsage().rss / 1_048_576),
        db: {
            connected: health.connected,
            latency_ms: health.latency_ms,
        },
        extensions: health.extensions,
        pool: { ...poolStats, pressure: poolPressure },
        stale_transactions: staleTransactionCount,
        retention: {
            enabled: retentionConfig.retentionEnabled,
            interval_minutes: retentionConfig.retentionIntervalMinutes,
        },
        cache: cacheStats,
    });
}));

app.get('/ready', safeHandler(async (req, res) => {
    const health = await db.healthCheck();

    if (!isRequestAuthenticated(req)) {
        res.status(health.connected ? 200 : 503).json({
            ready: health.connected,
        });
        return;
    }

    // Migration currency check
    let migrationCount = 0;
    try {
        const migResult = await db.query('SELECT COUNT(*) as cnt FROM _migrations');
        migrationCount = parseCountField(firstRow(migResult));
    } catch (error) {
        // Table may not exist — treat as 0 migrations
        log.debug('Readiness check could not read migrations table', {
            error: error instanceof Error ? error.message : String(error),
        });
        migrationCount = 0;
    }

    // Check repo base path accessibility (lightweight stat check)
    let accessiblePaths = 0;
    for (const bp of ALLOWED_BASE_PATHS) {
        try {
            await fsp.access(bp);
            accessiblePaths++;
        } catch { /* path not accessible */ }
    }

    res.status(health.connected ? 200 : 503).json({
        ready: health.connected,
        migrations: migrationCount,
        base_paths: { configured: ALLOWED_BASE_PATHS.length, accessible: accessiblePaths },
    });
}));

// ────────── Prometheus Metrics ──────────

app.get('/metrics', safeHandler(async (_req, res) => {
    // Update DB pool gauges before rendering
    const poolStats = db.getPoolStats();
    setGauge('scg_db_pool_total', poolStats.total);
    setGauge('scg_db_pool_idle', poolStats.idle);
    setGauge('scg_db_pool_waiting', poolStats.waiting);

    res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.send(renderMetrics());
}));

// ────────── Tool 0: Register Repository (security-critical) ──────────

app.post('/scg_register_repo',
    JSON_DEFAULT,
    validateBody({
        repo_name: requireString,
        repo_path: requireAbsolutePath,
        default_branch: optionalString,
        visibility: optionalEnum('public', 'private'),
    }),
    safeHandler(async (req, res) => {
        const { repo_name, repo_path, default_branch, visibility } = req.body;

        let resolvedPath: string;
        try {
            resolvedPath = resolveExistingPath(repo_path);
            const stat = await fsp.stat(resolvedPath);
            if (!stat.isDirectory()) {
                res.status(400).json({ error: 'repo_path must be a directory' });
                return;
            }
        } catch (error) {
            log.warn('Repository registration rejected: path not accessible', {
                repo_path,
                error: error instanceof Error ? error.message : String(error),
            });
            res.status(400).json({ error: 'repo_path does not exist or is not accessible' });
            return;
        }

        if (!isPathAllowed(resolvedPath)) {
            res.status(403).json({
                error: 'Allowed base path violation: repo_path is not under any configured SCG_ALLOWED_BASE_PATHS',
            });
            return;
        }

        // Create or reuse repository — deduplicate by base_path to prevent
        // orphaning data when a repo is re-registered after restart (BUG-001).
        const repoId = await coreDataService.createRepository({
            name: repo_name,
            default_branch: default_branch || 'main',
            visibility: visibility || 'private',
            language_set: [],
            base_path: resolvedPath,
        });

        log.info('Repository registered', { repo_id: repoId, name: repo_name, path: resolvedPath });
        res.json({ repo_id: repoId, registered_path: resolvedPath });
    })
);

// ────────── Tool 1: Resolve Symbol ──────────

app.post('/scg_resolve_symbol',
    JSON_QUERY,
    validateBody({
        query: requireString,
        repo_id: requireUUID,
        snapshot_id: optionalUUID,
        kind_filter: optionalString,
        limit: optionalBoundedInt(1, MAX_LIST_LIMIT),
    }),
    safeHandler(async (req, res) => {
        const { query, repo_id, snapshot_id, kind_filter, limit = 10 } = req.body;

        const result = await resolveSymbol(query, repo_id, snapshot_id, kind_filter, limit);
        res.json(result);
    })
);

// ────────── Tool 2: Get Symbol Details ──────────

app.post('/scg_get_symbol_details',
    JSON_QUERY,
    validateBody({
        symbol_version_id: requireUUID,
        view_mode: optionalEnum('code', 'summary', 'signature'),
    }),
    safeHandler(async (req, res) => {
        const { symbol_version_id, view_mode = 'summary' } = req.body;

        const result = await getSymbolDetails(symbol_version_id, view_mode as 'code' | 'summary' | 'signature');
        res.json(result);
    })
);

// ────────── Tool 3: Get Symbol Relations ──────────

app.post('/scg_get_symbol_relations',
    JSON_QUERY,
    validateBody({
        symbol_version_id: requireUUID,
        direction: optionalEnum('inbound', 'outbound', 'both'),
    }),
    safeHandler(async (req, res) => {
        const { symbol_version_id, direction = 'both' } = req.body;

        let relations;
        if (direction === 'inbound') {
            relations = await structuralGraphEngine.getCallers(symbol_version_id);
        } else if (direction === 'outbound') {
            relations = await structuralGraphEngine.getCallees(symbol_version_id);
        } else {
            relations = await structuralGraphEngine.getRelationsForSymbol(symbol_version_id);
        }

        res.json({ relations, count: relations.length });
    })
);

// ────────── Tool 4: Get Behavioral Profile ──────────

app.post('/scg_get_behavioral_profile',
    JSON_QUERY,
    validateBody({ symbol_version_id: requireUUID }),
    safeHandler(async (req, res) => {
        const profile = await behavioralEngine.getProfile(req.body.symbol_version_id);
        if (!profile) {
            res.status(404).json({ error: 'Behavioral profile not found' });
            return;
        }
        res.json({ profile });
    })
);

// ────────── Tool 5: Get Contract Profile ──────────

app.post('/scg_get_contract_profile',
    JSON_QUERY,
    validateBody({ symbol_version_id: requireUUID }),
    safeHandler(async (req, res) => {
        const profile = await contractEngine.getProfile(req.body.symbol_version_id);
        if (!profile) {
            res.status(404).json({ error: 'Contract profile not found' });
            return;
        }
        res.json({ profile });
    })
);

// ────────── Tool 6: Get Invariants ──────────

app.post('/scg_get_invariants',
    JSON_QUERY,
    validateBody({ symbol_id: requireUUID }),
    safeHandler(async (req, res) => {
        const invariants = await contractEngine.getInvariantsForSymbol(req.body.symbol_id);
        res.json({ invariants, count: invariants.length });
    })
);

// ────────── Tool 7: Find Homologs ──────────

app.post('/scg_find_homologs',
    JSON_QUERY,
    validateBody({
        symbol_version_id: requireUUID,
        snapshot_id: requireUUID,
        confidence_threshold: optionalConfidence,
    }),
    safeHandler(async (req, res) => {
        const { symbol_version_id, snapshot_id, confidence_threshold = 0.70 } = req.body;

        const homologs = await homologInferenceEngine.findHomologs(
            symbol_version_id, snapshot_id, confidence_threshold
        );

        res.json({ homologs, count: homologs.length });
    })
);

// ────────── Tool 8: Blast Radius ──────────

app.post('/scg_blast_radius',
    JSON_QUERY,
    validateBody({
        symbol_version_ids: requireUUIDArray,
        snapshot_id: requireUUID,
        depth: optionalBoundedInt(1, MAX_GRAPH_DEPTH),
    }),
    safeHandler(async (req, res) => {
        const { symbol_version_ids, snapshot_id, depth = 2 } = req.body;

        const report = await blastRadiusEngine.computeBlastRadius(
            snapshot_id, symbol_version_ids, depth
        );

        res.json({ report });
    })
);

// ────────── Tool 9: Compile Context Capsule ──────────

app.post('/scg_compile_context_capsule',
    JSON_QUERY,
    validateBody({
        symbol_version_id: requireUUID,
        snapshot_id: requireUUID,
        mode: optionalEnum('minimal', 'standard', 'strict'),
        token_budget: optionalBoundedInt(100, MAX_TOKEN_BUDGET),
    }),
    safeHandler(async (req, res) => {
        const { symbol_version_id, snapshot_id, mode = 'standard', token_budget } = req.body;

        // Resolve repo base path from DB — never from request body
        const basePathResult = await db.query(
            `SELECT r.base_path FROM repositories r
             JOIN symbols s ON s.repo_id = r.repo_id
             JOIN symbol_versions sv ON sv.symbol_id = s.symbol_id
             WHERE sv.symbol_version_id = $1`,
            [symbol_version_id]
        );
        const repoBasePath = optionalStringField(firstRow(basePathResult), 'base_path');

        const capsule = await capsuleCompiler.compile(
            symbol_version_id, snapshot_id, mode as CapsuleMode, token_budget, repoBasePath
        );

        res.json({ capsule });
    })
);

// ────────── Tool 10: Get Uncertainty Report ──────────

app.post('/scg_get_uncertainty',
    JSON_QUERY,
    validateBody({ snapshot_id: requireUUID }),
    safeHandler(async (req, res) => {
        const report = await uncertaintyTracker.getSnapshotUncertainty(req.body.snapshot_id);
        res.json({ report });
    })
);

// ────────── Tool 11: Ingest Repository ──────────
// Requires prior registration via scg_register_repo.
// Accepts repo_id (not raw path) — path resolved from DB.

app.post('/scg_ingest_repo',
    JSON_INGEST,
    validateBody({
        repo_id: requireUUID,
        commit_sha: optionalString,
        branch: optionalString,
    }),
    safeHandler(async (req, res) => {
        const { repo_id, commit_sha, branch } = req.body;

        // Resolve repo path from DB — never from request body
        const repo = await coreDataService.getRepository(repo_id);
        if (!repo) {
            res.status(404).json({ error: 'Repository not found. Register it first via /scg_register_repo' });
            return;
        }

        const repoBasePath = repo.base_path as string | undefined;
        if (!repoBasePath) {
            res.status(400).json({
                error: 'Repository base path not configured. Register it first via /scg_register_repo',
            });
            return;
        }

        const repoName = repo.name as string;
        const branchName = (branch as string | undefined)
            || (repo.default_branch as string | undefined)
            || 'main';
        const identity = await deriveWorkspaceSnapshotIdentity(repoBasePath, {
            commitSha: typeof commit_sha === 'string' ? commit_sha : undefined,
            branch: branchName,
        });

        const result = await ingestor.ingestRepo(repoBasePath, repoName, identity.commit_sha, identity.branch);
        res.json({
            result: {
                ...result,
                commit_sha: identity.commit_sha,
                commit_source: identity.source,
                branch: identity.branch,
                fingerprint_truncated: identity.truncated,
                fingerprint_files_considered: identity.files_considered,
            },
        });
    })
);

// ────────── Tool 12: Create Change Transaction ──────────

app.post('/scg_create_change_transaction',
    JSON_DEFAULT,
    validateBody({
        repo_id: requireUUID,
        base_snapshot_id: requireUUID,
        created_by: optionalString,
        target_symbol_version_ids: requireUUIDArray,
        task_description: optionalString,
    }),
    safeHandler(async (req, res) => {
        const { repo_id, base_snapshot_id, created_by, target_symbol_version_ids, task_description } = req.body;

        const txnId = await transactionalChangeEngine.createTransaction(
            repo_id, base_snapshot_id, created_by || 'api',
            target_symbol_version_ids
        );

        if (task_description) {
            await db.query(`
                UPDATE change_transactions
                SET impact_report_ref = $1, updated_at = NOW()
                WHERE txn_id = $2
            `, [JSON.stringify({ task_description }), txnId]);
        }

        res.json({ txn_id: txnId, state: 'planned' });
    })
);

// ────────── Tool 13: Apply Patch ──────────

app.post('/scg_apply_patch',
    JSON_PATCH,
    validateBody({
        txn_id: requireUUID,
        patches: requirePatchArray,
    }),
    safeHandler(async (req, res) => {
        const { txn_id, patches } = req.body;

        const repoBasePath = await resolveRepoBasePathForTxn(txn_id);
        if (!repoBasePath) {
            res.status(400).json({ error: 'Repository base path not configured' });
            return;
        }

        await transactionalChangeEngine.applyPatch(txn_id, patches, repoBasePath);
        res.json({ txn_id, state: 'patched' });
    })
);

// ────────── Tool 14: Validate Change ──────────

app.post('/scg_validate_change',
    JSON_DEFAULT,
    validateBody({
        txn_id: requireUUID,
        mode: optionalEnum('quick', 'standard', 'strict'),
    }),
    safeHandler(async (req, res) => {
        const { txn_id, mode = 'standard' } = req.body;

        const repoBasePath = await resolveRepoBasePathForTxn(txn_id);
        if (!repoBasePath) {
            res.status(400).json({ error: 'Repository base path not configured' });
            return;
        }

        const report = await transactionalChangeEngine.validate(txn_id, repoBasePath, mode as ValidationMode);
        res.json({ report });
    })
);

// ────────── Tool 15: Commit Change ──────────

app.post('/scg_commit_change',
    JSON_DEFAULT,
    validateBody({ txn_id: requireUUID }),
    safeHandler(async (req, res) => {
        await transactionalChangeEngine.commit(req.body.txn_id);
        res.json({ txn_id: req.body.txn_id, state: 'committed' });
    })
);

// ────────── Tool 16: Rollback Change ──────────

app.post('/scg_rollback_change',
    JSON_DEFAULT,
    validateBody({ txn_id: requireUUID }),
    safeHandler(async (req, res) => {
        await transactionalChangeEngine.rollback(req.body.txn_id);
        res.json({ txn_id: req.body.txn_id, state: 'rolled_back' });
    })
);

// ────────── Tool 17: Get Transaction Status ──────────

app.post('/scg_get_transaction',
    JSON_QUERY,
    validateBody({ txn_id: requireUUID }),
    safeHandler(async (req, res) => {
        const txn = await transactionalChangeEngine.getTransaction(req.body.txn_id);
        if (!txn) {
            res.status(404).json({ error: 'Transaction not found' });
            return;
        }
        res.json({ transaction: txn });
    })
);

// ────────── Tool 18: Compute Propagation Proposals ──────────

app.post('/scg_propagation_proposals',
    JSON_QUERY,
    validateBody({
        txn_id: requireUUID,
        snapshot_id: requireUUID,
    }),
    safeHandler(async (req, res) => {
        const { txn_id, snapshot_id } = req.body;

        const proposals = await transactionalChangeEngine.computePropagationProposals(
            txn_id, snapshot_id
        );

        res.json({ proposals, count: proposals.length });
    })
);

// ────────── Tool 19: Incremental Index ──────────

app.post('/scg_incremental_index',
    JSON_DEFAULT,
    validateBody({
        repo_id: requireUUID,
        snapshot_id: requireUUID,
        changed_paths: requireSafePathArray(),
    }),
    safeHandler(async (req, res) => {
        const { repo_id, snapshot_id, changed_paths } = req.body;
        const result = await ingestor.ingestIncremental(repo_id, snapshot_id, changed_paths);
        res.json({ result });
    })
);

// ────────── Tool 20: Batch Embed Snapshot ──────────

app.post('/scg_batch_embed',
    JSON_INGEST,
    validateBody({ snapshot_id: requireUUID }),
    safeHandler(async (req, res) => {
        const { semanticEngine } = await import('../semantic-engine');
        const embedded = await semanticEngine.batchEmbedSnapshot(req.body.snapshot_id);
        res.json({ snapshot_id: req.body.snapshot_id, symbols_embedded: embedded });
    })
);

// ────────── Tool 21: Cache Stats ──────────

app.get('/scg_cache_stats', safeHandler(async (_req, res) => {
    const { symbolCache, profileCache, capsuleCache, homologCache, queryCache } = await import('../cache');
    res.json({
        symbol: symbolCache.stats(),
        profile: profileCache.stats(),
        capsule: capsuleCache.stats(),
        homolog: homologCache.stats(),
        query: queryCache.stats(),
    });
}));

// ────────── Utility: List Snapshots ──────────

app.post('/scg_list_snapshots',
    JSON_QUERY,
    validateBody({
        repo_id: requireUUID,
        limit: optionalBoundedInt(1, MAX_LIST_LIMIT),
        offset: optionalBoundedInt(0, 100_000),
    }),
    safeHandler(async (req, res) => {
        const { repo_id, limit = 20, offset = 0 } = req.body;

        const result = await listSnapshotsService(repo_id, limit, offset);
        res.json(result);
    })
);

// ────────── Utility: List Repositories ──────────

app.post('/scg_list_repos',
    JSON_QUERY,
    validateBody({
        limit: optionalBoundedInt(1, MAX_LIST_LIMIT),
        offset: optionalBoundedInt(0, 100_000),
    }),
    safeHandler(async (req, res) => {
        const { limit = 20, offset = 0 } = req.body;

        const result = await listReposService(limit, offset);
        res.json(result);
    })
);

// ────────── Utility: Get Snapshot Stats ──────────

app.post('/scg_snapshot_stats',
    JSON_QUERY,
    validateBody({ snapshot_id: requireUUID }),
    safeHandler(async (req, res) => {
        const { snapshot_id } = req.body;

        // BUG-001 fix: Verify the snapshot actually exists before running stats
        const snapshotCheck = await db.query(
            `SELECT snapshot_id, index_status FROM snapshots WHERE snapshot_id = $1`,
            [snapshot_id],
        );
        if (snapshotCheck.rows.length === 0) {
            res.status(404).json({ error: `Snapshot not found: ${snapshot_id}` });
            return;
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

        // BUG-001 fix: Detect orphaned snapshots (superseded by newer ingestion)
        if (files === 0 && symbols === 0) {
            const status = optionalStringField(firstRow(snapshotCheck), 'index_status') ?? '';
            if (status === 'complete' || status === 'partial') {
                res.status(410).json({
                    error: `Snapshot ${snapshot_id} is orphaned — it was superseded by a newer ingestion. Re-ingest the repository to get a fresh snapshot.`,
                });
                return;
            }
        }

        res.json({
            snapshot_id,
            files,
            symbols,
            relations: parseCountField(firstRow(relationCount)),
            uncertainty: uncertaintyReport,
        });
    })
);

// ────────── Utility: Persist Homologs ──────────

app.post('/scg_persist_homologs',
    JSON_QUERY,
    validateBody({
        source_symbol_version_id: requireUUID,
        snapshot_id: requireUUID,
        confidence_threshold: optionalConfidence,
    }),
    safeHandler(async (req, res) => {
        const { source_symbol_version_id, snapshot_id, confidence_threshold = 0.70 } = req.body;

        const homologs = await homologInferenceEngine.findHomologs(
            source_symbol_version_id, snapshot_id, confidence_threshold
        );

        const persisted = await homologInferenceEngine.persistHomologs(
            source_symbol_version_id, homologs, snapshot_id
        );

        res.json({ homologs_found: homologs.length, persisted });
    })
);

// ────────── Tool 23: Read Source Code ──────────

app.post('/scg_read_source',
    JSON_QUERY,
    validateBody({
        repo_id: requireUUID,
        symbol_version_id: optionalUUID,
        symbol_version_ids: (value: unknown): string | null => {
            if (value === undefined || value === null) return null;
            if (!Array.isArray(value)) return 'must be an array';
            if (value.length > 20) return 'must have at most 20 items';
            for (let i = 0; i < value.length; i++) {
                if (typeof value[i] !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value[i] as string)) {
                    return `item at index ${i}: must be a valid UUID`;
                }
            }
            return null;
        },
        file_path: optionalString,
    }),
    safeHandler(async (req, res) => {
        const { repo_id, symbol_version_id, symbol_version_ids,
                file_path: reqFilePath } = req.body;

        // Batch mode: multiple symbol_version_ids served from DB (capped at 20)
        const ids: string[] = [];
        if (Array.isArray(symbol_version_ids)) {
            for (const id of symbol_version_ids) {
                if (typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
                    ids.push(id);
                }
            }
        } else if (symbol_version_id) {
            ids.push(symbol_version_id);
        }

        if (ids.length === 0 && !reqFilePath) {
            res.status(400).json({ error: 'Either symbol_version_id, symbol_version_ids, or file_path is required' });
            return;
        }

        // Symbol-scoped DB serving (batch)
        if (ids.length > 0) {
            const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
            const svResult = await db.query(`
                SELECT sv.symbol_version_id, sv.range_start_line, sv.range_end_line,
                       sv.signature, sv.summary, sv.body_source,
                       s.canonical_name, s.kind, f.path as file_path
                FROM symbol_versions sv
                JOIN symbols s ON s.symbol_id = sv.symbol_id
                JOIN files f ON f.file_id = sv.file_id
                WHERE sv.symbol_version_id IN (${placeholders})
            `, ids);

            if (svResult.rows.length === 0) { res.status(404).json({ error: 'No symbol versions found' }); return; }

            const symbols = (svResult.rows as Record<string, unknown>[]).map(sv => {
                const source = (sv.body_source as string | null) ?? null;
                return {
                    symbol_version_id: sv.symbol_version_id,
                    canonical_name: sv.canonical_name,
                    kind: sv.kind,
                    signature: sv.signature,
                    summary: sv.summary,
                    file_path: sv.file_path,
                    start_line: sv.range_start_line,
                    end_line: sv.range_end_line,
                    source: source ?? '[source unavailable]',
                    token_estimate: source ? Math.ceil(source.length / 4) : 0,
                };
            });

            res.json({ symbols, count: symbols.length });
            return;
        }

        // File-path mode (disk read)
        const repo = await coreDataService.getRepository(repo_id);
        if (!repo) { res.status(404).json({ error: 'Repository not found' }); return; }
        const basePath = repo.base_path as string;
        if (!basePath) { res.status(400).json({ error: 'Repository base path not configured' }); return; }

        try {
            const safePath = resolvePathWithinBase(basePath, reqFilePath);
            const resolvedPath = safePath.realPath;
            const content = await fsp.readFile(resolvedPath, 'utf-8');
            const lines = content.split('\n');
            const cap = Math.min(lines.length, 500);
            const outputLines = lines.slice(0, cap).map((line, i) => `${i + 1}: ${line}`);
            if (lines.length > 500) outputLines.push(`... (${lines.length - 500} more lines truncated)`);
            res.json({ file_path: reqFilePath, total_lines: lines.length, source: outputLines.join('\n') });
        } catch (error) {
            log.warn('Source read failed', {
                repo_id,
                file_path: reqFilePath,
                error: error instanceof Error ? error.message : String(error),
            });
            res.status(404).json({ error: 'File not readable' });
        }
    })
);

// ────────── Tool 24: Search Code ──────────

app.post('/scg_search_code',
    JSON_QUERY,
    validateBody({
        repo_id: requireUUID,
        pattern: requireString,
        file_pattern: optionalString,
        max_results: optionalBoundedInt(1, 100),
        context_lines: optionalBoundedInt(0, 5),
    }),
    safeHandler(async (req, res) => {
        const { repo_id, pattern, file_pattern, max_results = 30, context_lines: ctxLines = 2 } = req.body;

        const result = await searchCode(repo_id, pattern, {
            filePattern: file_pattern,
            maxResults: max_results,
            contextLines: ctxLines,
        }, log);
        res.json(result);
    })
);

// ────────── Tool 25: Codebase Overview ──────────

app.post('/scg_codebase_overview',
    JSON_QUERY,
    validateBody({
        repo_id: requireUUID,
        snapshot_id: requireUUID,
    }),
    safeHandler(async (req, res) => {
        const { snapshot_id } = req.body;

        const overview = await getCodebaseOverview(snapshot_id);
        res.json(overview);
    })
);

// ────────── Tool 26: Semantic Search ──────────

app.post('/scg_semantic_search',
    JSON_QUERY,
    validateBody({
        query: requireString,
        snapshot_id: requireUUID,
    }),
    safeHandler(async (req, res) => {
        const { query, snapshot_id, limit: rawLimit, include_source } = req.body;
        const limit = typeof rawLimit === 'number' ? Math.min(Math.max(rawLimit, 1), 50) : 15;

        // Delegate to SemanticEngine.searchByQuery — uses LSH candidate narrowing
        // with batched fallback. Never loads more than ~1000 vectors at a time.
        const { semanticEngine } = await import('../semantic-engine');
        const topResults = await semanticEngine.searchByQuery(query, snapshot_id, limit);

        if (topResults.length === 0) {
            res.json({ matches: [], total: 0, note: 'No semantic matches found' });
            return;
        }

        const topIds = topResults.map(r => r.svId);
        const placeholders = topIds.map((_, i) => `$${i + 1}`).join(',');
        const metaResult = await db.query(`
            SELECT sv.symbol_version_id, s.canonical_name, s.kind,
                   sv.signature, sv.summary, sv.body_source,
                   f.path as file_path, sv.range_start_line, sv.range_end_line
            FROM symbol_versions sv JOIN symbols s ON s.symbol_id = sv.symbol_id JOIN files f ON f.file_id = sv.file_id
            WHERE sv.symbol_version_id IN (${placeholders})
        `, topIds);

        const metaMap = new Map<string, Record<string, unknown>>();
        for (const row of metaResult.rows) metaMap.set(row.symbol_version_id as string, row as Record<string, unknown>);

        const matches = topResults.map(r => {
            const meta = metaMap.get(r.svId);
            if (!meta) return null;
            return {
                symbol_version_id: r.svId,
                canonical_name: meta.canonical_name,
                kind: meta.kind,
                file_path: meta.file_path,
                start_line: meta.range_start_line,
                end_line: meta.range_end_line,
                signature: meta.signature,
                similarity: parseFloat(r.similarity.toFixed(4)),
                ...(include_source !== false && meta.body_source ? {
                    source: meta.body_source,
                    token_estimate: Math.ceil((meta.body_source as string).length / 4),
                } : {}),
            };
        }).filter(Boolean);

        res.json({ query, total: matches.length, matches });
    })
);

// ────────── Tool 27: Smart Context ──────────

app.post('/scg_smart_context',
    JSON_QUERY,
    validateBody({
        task_description: requireString,
        target_symbol_version_ids: requireUUIDArray,
        snapshot_id: requireUUID,
    }),
    safeHandler(async (req, res) => {
        const { task_description, target_symbol_version_ids, snapshot_id,
                token_budget: rawBudget, depth: rawDepth } = req.body;
        const token_budget = typeof rawBudget === 'number' ? Math.min(rawBudget, 100_000) : 20_000;
        const depth = typeof rawDepth === 'number' ? Math.min(Math.max(rawDepth, 1), 5) : 2;

        const result = await compileSmartContext(task_description, target_symbol_version_ids, snapshot_id, {
            tokenBudget: token_budget,
            depth,
        });
        res.json(result);
    })
);

// ────────── V2 Tools — Dispatch, Lineage, Effects, Families, Temporal, Runtime ──────────

app.post('/scg_get_dispatch_edges',
    JSON_QUERY,
    validateBody({ symbol_version_id: requireUUID }),
    safeHandler(async (req, res) => {
        const { symbol_version_id } = req.body;
        const { dispatchResolver } = await import('../analysis-engine/dispatch-resolver');
        const edges = await dispatchResolver.getDispatchEdges(symbol_version_id);
        res.json({ symbol_version_id, edges, total: edges.length });
    })
);

app.post('/scg_get_class_hierarchy',
    JSON_QUERY,
    validateBody({ symbol_version_id: requireUUID, snapshot_id: requireUUID }),
    safeHandler(async (req, res) => {
        const { symbol_version_id, snapshot_id } = req.body;
        const { dispatchResolver } = await import('../analysis-engine/dispatch-resolver');
        const mro = await dispatchResolver.getMRO(snapshot_id, symbol_version_id);
        res.json({ symbol_version_id, method_resolution_order: mro });
    })
);

app.post('/scg_get_symbol_lineage',
    JSON_QUERY,
    validateBody({ symbol_id: requireUUID }),
    safeHandler(async (req, res) => {
        const { symbol_id } = req.body;
        const { symbolLineageEngine } = await import('../analysis-engine/symbol-lineage');
        const history = await symbolLineageEngine.getLineageHistory(symbol_id);
        res.json({ symbol_id, lineage_history: history });
    })
);

app.post('/scg_get_effect_signature',
    JSON_QUERY,
    validateBody({ symbol_version_id: requireUUID }),
    safeHandler(async (req, res) => {
        const { symbol_version_id } = req.body;
        const { effectEngine } = await import('../analysis-engine/effect-engine');
        const signature = await effectEngine.getEffectSignature(symbol_version_id);
        if (!signature) {
            res.json({ symbol_version_id, effect_signature: null });
            return;
        }
        res.json({
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
    })
);

app.post('/scg_diff_effects',
    JSON_QUERY,
    validateBody({
        before_symbol_version_id: requireUUID,
        after_symbol_version_id: requireUUID,
    }),
    safeHandler(async (req, res) => {
        const { before_symbol_version_id, after_symbol_version_id } = req.body;
        const { effectEngine } = await import('../analysis-engine/effect-engine');
        const diff = await effectEngine.diffEffects(before_symbol_version_id, after_symbol_version_id);
        res.json({ before_symbol_version_id, after_symbol_version_id, diff });
    })
);

app.post('/scg_get_concept_family',
    JSON_QUERY,
    validateBody({ symbol_version_id: requireUUID }),
    safeHandler(async (req, res) => {
        const { symbol_version_id } = req.body;
        const { conceptFamilyEngine } = await import('../analysis-engine/concept-families');
        const family = await conceptFamilyEngine.getFamilyForSymbol(symbol_version_id);
        res.json({ symbol_version_id, family });
    })
);

app.post('/scg_list_concept_families',
    JSON_QUERY,
    validateBody({ snapshot_id: requireUUID }),
    safeHandler(async (req, res) => {
        const { snapshot_id } = req.body;
        const { conceptFamilyEngine } = await import('../analysis-engine/concept-families');
        const families = await conceptFamilyEngine.getFamilies(snapshot_id);
        res.json({ snapshot_id, families, total: families.length });
    })
);

app.post('/scg_get_temporal_risk',
    JSON_QUERY,
    validateBody({ symbol_id: requireUUID, snapshot_id: requireUUID }),
    safeHandler(async (req, res) => {
        const { symbol_id, snapshot_id } = req.body;
        const { temporalEngine } = await import('../analysis-engine/temporal-engine');
        const risk = await temporalEngine.getRiskScore(symbol_id, snapshot_id);
        res.json({ symbol_id, snapshot_id, risk });
    })
);

app.post('/scg_get_co_change_partners',
    JSON_QUERY,
    validateBody({ symbol_id: requireUUID, repo_id: requireUUID }),
    safeHandler(async (req, res) => {
        const { symbol_id, repo_id, min_jaccard } = req.body;
        const { temporalEngine } = await import('../analysis-engine/temporal-engine');
        const rawJaccard = typeof min_jaccard === 'number' ? min_jaccard : 0.3;
        const minJaccard = Math.max(0, Math.min(1, Number.isFinite(rawJaccard) ? rawJaccard : 0.3));
        const partners = await temporalEngine.getCoChangePartners(symbol_id, repo_id, minJaccard);
        res.json({ symbol_id, repo_id, partners, total: partners.length });
    })
);

app.post('/scg_ingest_runtime_trace',
    JSON_INGEST,
    validateBody({
        repo_id: requireUUID,
        snapshot_id: requireUUID,
    }),
    safeHandler(async (req, res) => {
        const { repo_id, snapshot_id, trace_pack: rawTracePack } = req.body;
        if (!rawTracePack || typeof rawTracePack !== 'object') {
            res.status(400).json({ error: 'trace_pack is required and must be an object' });
            return;
        }
        // Validate trace_pack internals
        const validSources = ['test_execution', 'dev_run', 'ci_trace', 'production_sample'];
        if (!rawTracePack.source || typeof rawTracePack.source !== 'string' || !validSources.includes(rawTracePack.source)) {
            res.status(400).json({ error: 'trace_pack.source must be one of: ' + validSources.join(', ') });
            return;
        }
        if (!rawTracePack.timestamp || typeof rawTracePack.timestamp !== 'string' || isNaN(Date.parse(rawTracePack.timestamp))) {
            res.status(400).json({ error: 'trace_pack.timestamp must be a valid ISO 8601 date string' });
            return;
        }
        if (rawTracePack.call_edges !== undefined && rawTracePack.call_edges !== null) {
            if (!Array.isArray(rawTracePack.call_edges)) {
                res.status(400).json({ error: 'trace_pack.call_edges must be an array' });
                return;
            }
            for (let i = 0; i < rawTracePack.call_edges.length; i++) {
                const edge = rawTracePack.call_edges[i];
                if (!edge || typeof edge.caller_key !== 'string' || typeof edge.callee_key !== 'string' ||
                    typeof edge.call_count !== 'number' || !Number.isInteger(edge.call_count) || edge.call_count < 1) {
                    res.status(400).json({ error: `trace_pack.call_edges[${i}] must have caller_key:string, callee_key:string, call_count:integer>=1` });
                    return;
                }
            }
        }
        const trace_pack: TracePack = {
            source: rawTracePack.source,
            timestamp: new Date(rawTracePack.timestamp),
            call_edges: rawTracePack.call_edges ?? [],
            dynamic_routes: rawTracePack.dynamic_routes ?? [],
            observed_types: rawTracePack.observed_types ?? [],
            framework_events: rawTracePack.framework_events ?? [],
        };
        const { runtimeEvidenceEngine } = await import('../analysis-engine/runtime-evidence');
        const result = await runtimeEvidenceEngine.ingestTrace(repo_id, snapshot_id, trace_pack);
        res.json({ repo_id, snapshot_id, ingestion_result: result });
    })
);

app.post('/scg_get_runtime_evidence',
    JSON_QUERY,
    validateBody({ symbol_version_id: requireUUID }),
    safeHandler(async (req, res) => {
        const { symbol_version_id } = req.body;
        const { runtimeEvidenceEngine } = await import('../analysis-engine/runtime-evidence');
        const evidence = await runtimeEvidenceEngine.getEvidenceForSymbol(symbol_version_id);
        res.json({ symbol_version_id, runtime_evidence: evidence });
    })
);

// ────────── Tool 30: Get Tests ──────────

app.post('/scg_get_tests',
    JSON_QUERY,
    validateBody({
        symbol_id: requireUUID,
        snapshot_id: requireUUID,
    }),
    async (req: Request, res: Response, next: NextFunction) => {
        try {
            const result = await getTests({
                symbol_id: req.body.symbol_id,
                snapshot_id: req.body.snapshot_id,
            });
            res.json({ data: result });
        } catch (e) { next(e); }
    },
);

// ────────── Tool 31: Explain Relation ──────────

app.post('/scg_explain_relation',
    JSON_QUERY,
    validateBody({
        src_symbol_version_id: requireUUID,
        dst_symbol_version_id: requireUUID,
        snapshot_id: requireUUID,
    }),
    async (req: Request, res: Response, next: NextFunction) => {
        try {
            const result = await explainRelation({
                src_symbol_version_id: req.body.src_symbol_version_id,
                dst_symbol_version_id: req.body.dst_symbol_version_id,
                snapshot_id: req.body.snapshot_id,
            });
            res.json({ data: result });
        } catch (e) { next(e); }
    },
);

// ────────── Tool 32: Get Neighbors ──────────

app.post('/scg_get_neighbors',
    JSON_QUERY,
    validateBody({
        symbol_version_id: requireUUID,
        snapshot_id: requireUUID,
        direction: optionalEnum('inbound', 'outbound', 'both'),
        depth: optionalBoundedInt(1, MAX_GRAPH_DEPTH),
        max_nodes: optionalBoundedInt(1, 500),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
        try {
            const relation_types = Array.isArray(req.body.relation_types)
                ? (req.body.relation_types as unknown[]).filter((t): t is string => typeof t === 'string')
                : undefined;
            const result = await getNeighbors({
                symbol_version_id: req.body.symbol_version_id,
                snapshot_id: req.body.snapshot_id,
                direction: req.body.direction || 'both',
                depth: req.body.depth || 2,
                max_nodes: req.body.max_nodes || 100,
                relation_types,
            });
            res.json({ data: result });
        } catch (e) { next(e); }
    },
);

// ────────── Tool 33: Find Concept ──────────

app.post('/scg_find_concept',
    JSON_QUERY,
    validateBody({
        concept: requireString,
        repo_id: requireUUID,
        snapshot_id: requireUUID,
        kind_filter: optionalString,
        language_filter: optionalString,
        limit: optionalBoundedInt(1, MAX_LIST_LIMIT),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
        try {
            const result = await findConcept({
                concept: req.body.concept,
                repo_id: req.body.repo_id,
                snapshot_id: req.body.snapshot_id,
                kind_filter: req.body.kind_filter,
                language_filter: req.body.language_filter,
                limit: req.body.limit || 20,
            });
            res.json({ data: result });
        } catch (e) { next(e); }
    },
);

// ────────── Tool 34: Semantic Diff ──────────

app.post('/scg_semantic_diff',
    JSON_QUERY,
    validateBody({
        before_symbol_version_id: requireUUID,
        after_symbol_version_id: requireUUID,
    }),
    async (req: Request, res: Response, next: NextFunction) => {
        try {
            const result = await computeSemanticDiff({
                before_symbol_version_id: req.body.before_symbol_version_id,
                after_symbol_version_id: req.body.after_symbol_version_id,
            });
            res.json({ data: result });
        } catch (e) { next(e); }
    },
);

// ────────── Tool 35: Contract Diff ──────────

app.post('/scg_contract_diff',
    JSON_QUERY,
    validateBody({
        before_symbol_version_id: optionalUUID,
        after_symbol_version_id: optionalUUID,
        txn_id: optionalUUID,
    }),
    async (req: Request, res: Response, next: NextFunction) => {
        try {
            if (!req.body.txn_id && (!req.body.before_symbol_version_id || !req.body.after_symbol_version_id)) {
                res.status(400).json({ error: 'Either txn_id or both before/after symbol_version_ids are required' });
                return;
            }
            const result = await computeContractDiff({
                before_symbol_version_id: req.body.before_symbol_version_id,
                after_symbol_version_id: req.body.after_symbol_version_id,
                txn_id: req.body.txn_id,
            });
            res.json({ data: result });
        } catch (e) { next(e); }
    },
);

// ────────── Tool 36: Plan Change ──────────

app.post('/scg_plan_change',
    JSON_QUERY,
    validateBody({
        repo_id: requireUUID,
        snapshot_id: requireUUID,
        task_description: requireString,
        max_candidates: optionalBoundedInt(1, 20),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
        try {
            const result = await planChange({
                repo_id: req.body.repo_id,
                snapshot_id: req.body.snapshot_id,
                task_description: req.body.task_description,
                max_candidates: req.body.max_candidates || 5,
                scope_constraints: req.body.scope_constraints,
            });
            res.json({ data: result });
        } catch (e) { next(e); }
    },
);

// ────────── Tool 37: Prepare Change ──────────

app.post('/scg_prepare_change',
    JSON_QUERY,
    validateBody({
        repo_id: requireUUID,
        base_snapshot_id: requireUUID,
        target_symbol_version_ids: requireUUIDArray,
        plan_id: optionalUUID,
        created_by: optionalString,
    }),
    async (req: Request, res: Response, next: NextFunction) => {
        try {
            const result = await prepareChange({
                repo_id: req.body.repo_id,
                base_snapshot_id: req.body.base_snapshot_id,
                target_symbol_version_ids: req.body.target_symbol_version_ids,
                plan_id: req.body.plan_id,
                created_by: req.body.created_by || 'api',
            });
            res.json({ data: result });
        } catch (e) { next(e); }
    },
);

// ────────── Tool 38: Apply Propagation ──────────

app.post('/scg_apply_propagation',
    JSON_PATCH,
    validateBody({
        txn_id: requireUUID,
        target_symbol_version_id: requireUUID,
    }),
    async (req: Request, res: Response, next: NextFunction) => {
        try {
            const patch = req.body.patch;
            if (!patch || typeof patch !== 'object' || typeof patch.file_path !== 'string' || typeof patch.new_content !== 'string') {
                res.status(400).json({ error: 'patch must be an object with file_path and new_content' });
                return;
            }
            const result = await applyPropagation({
                txn_id: req.body.txn_id,
                target_symbol_version_id: req.body.target_symbol_version_id,
                patch: { file_path: patch.file_path, new_content: patch.new_content },
            });
            res.json({ data: result });
        } catch (e) { next(e); }
    },
);

// ────────── Tool 39: Review Homolog ──────────

app.post('/scg_review_homolog',
    JSON_QUERY,
    validateBody({
        inferred_relation_id: requireUUID,
        review_state: requireEnum('confirmed', 'rejected', 'flagged'),
        reviewer: optionalString,
    }),
    async (req: Request, res: Response, next: NextFunction) => {
        try {
            const result = await reviewHomolog({
                inferred_relation_id: req.body.inferred_relation_id,
                review_state: req.body.review_state,
                reviewer: req.body.reviewer,
            });
            res.json({ data: result });
        } catch (e) { next(e); }
    },
);

// ────────── Admin Tools (Retention, Stats, Diagnostics) ──────────

import {
    getRetentionStats,
    listStaleTransactions,
} from '../services/retention-service';

app.post('/scg_admin_run_retention',
    requireAdminKey,
    JSON_QUERY,
    safeHandler(async (_req, res) => {
        const result = await runRetentionPolicy();
        res.json({ data: result });
    }),
);

app.get('/scg_admin_retention_stats', requireAdminKey, safeHandler(async (_req, res) => {
    const stats = await getRetentionStats();
    res.json({ data: stats });
}));

app.post('/scg_admin_cleanup_stale',
    requireAdminKey,
    JSON_QUERY,
    safeHandler(async (_req, res) => {
        const { cleanupStaleTransactions } = await import('../services/retention-service');
        const cleaned = await cleanupStaleTransactions();
        const stale = await listStaleTransactions();
        res.json({ data: { cleaned_count: cleaned, remaining_stale: stale } });
    }),
);

app.get('/scg_admin_db_stats', requireAdminKey, safeHandler(async (_req, res) => {
    const [tableStats, dbSize, connStats] = await Promise.all([
        db.query(`
            SELECT relname AS table_name,
                   n_live_tup AS row_count,
                   pg_size_pretty(pg_total_relation_size(relid)) AS total_size
            FROM pg_stat_user_tables
            ORDER BY pg_total_relation_size(relid) DESC
            LIMIT 30
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
    res.json({
        data: {
            database_size: (dbSize.rows[0] as Record<string, unknown>)?.db_size,
            connections: connStats.rows[0],
            tables: tableStats.rows,
        },
    });
}));

app.get('/scg_admin_system_info', requireAdminKey, safeHandler(async (_req, res) => {
    const [repoCount, snapshotCount, symbolCount] = await Promise.all([
        db.query(`SELECT COUNT(*)::int AS count FROM repositories`),
        db.query(`SELECT COUNT(*)::int AS count FROM snapshots`),
        db.query(`SELECT COUNT(*)::int AS count FROM symbols`),
    ]);
    const health = await db.healthCheck();
    res.json({
        data: {
            server: {
                uptime_seconds: Math.floor(process.uptime()),
                memory_mb: Math.round(process.memoryUsage().rss / 1_048_576),
                version: serverConfig.version,
                node_version: process.version,
            },
            database: {
                connected: health.connected,
                latency_ms: health.latency_ms,
                repositories: (repoCount.rows[0] as { count: number })?.count ?? 0,
                snapshots: (snapshotCount.rows[0] as { count: number })?.count ?? 0,
                symbols: (symbolCount.rows[0] as { count: number })?.count ?? 0,
            },
        },
    });
}));

// ────────── Server Start ──────────

const DEFAULT_PORT = 3100;
const PORT = serverConfig.port > 0 && serverConfig.port <= 65_535 ? serverConfig.port : DEFAULT_PORT;
const HOST = serverConfig.host;

let server: ReturnType<typeof app.listen>;
let retentionTimer: ReturnType<typeof setInterval> | null = null;

function validateStartupConfiguration(): void {
    validateConfiguration();
    const errors: string[] = [];

    if (isProduction && security.apiKeys.length === 0) {
        errors.push('SCG_API_KEYS must be configured in production.');
    }

    if (isProduction && ALLOWED_BASE_PATHS.length === 0) {
        errors.push('SCG_ALLOWED_BASE_PATHS must resolve to at least one accessible directory in production.');
    }

    if (errors.length > 0) {
        throw new Error(errors.join(' '));
    }

    if (HSTS_MAX_AGE_SECONDS > 0 && trustProxy === undefined) {
        log.warn('SCG_TRUST_PROXY is not configured; HTTPS detection may be wrong behind a reverse proxy.');
    }
}

async function startServer(): Promise<void> {
    validateStartupConfiguration();

    // Run pending migrations before accepting traffic
    try {
        await runPendingMigrations();
    } catch (err) {
        log.fatal('Migration failed — refusing to start', err instanceof Error ? err : new Error(String(err)));
        process.exit(1);
    }

    try {
        const recoverySummary = await transactionalChangeEngine.recoverStaleTransactions();
        if (recoverySummary.scanned > 0 || recoverySummary.cleaned_terminal_backups > 0) {
            log.warn('Transactional recovery completed during startup', { ...recoverySummary });
        }
    } catch (err) {
        log.fatal('Transactional recovery failed — refusing to start', err instanceof Error ? err : new Error(String(err)));
        process.exit(1);
    }

    server = await new Promise<ReturnType<typeof app.listen>>((resolve, reject) => {
        const candidate = app.listen(PORT, HOST);
        const onListening = () => {
            candidate.off('error', onError);
            resolve(candidate);
        };
        const onError = (err: Error) => {
            candidate.off('listening', onListening);
            reject(err);
        };
        candidate.once('listening', onListening);
        candidate.once('error', onError);
    });

    // Schedule periodic retention policy if enabled
    if (retentionConfig.retentionEnabled && retentionConfig.retentionIntervalMinutes > 0) {
        const intervalMs = retentionConfig.retentionIntervalMinutes * 60_000;
        retentionTimer = setInterval(() => {
            runRetentionPolicy().catch(err => {
                log.error('Scheduled retention policy failed', err instanceof Error ? err : new Error(String(err)));
            });
        }, intervalMs);
        retentionTimer.unref(); // don't prevent shutdown
        log.info('Retention policy scheduled', { intervalMinutes: retentionConfig.retentionIntervalMinutes });
    }

    log.info('ContextZero API interface started', {
        host: HOST,
        port: PORT,
        version: serverConfig.version,
        allowed_base_paths: ALLOWED_BASE_PATHS.length > 0 ? ALLOWED_BASE_PATHS : ['NONE — repos will be rejected'],
        cors_origins: CORS_ORIGINS.length > 0 ? CORS_ORIGINS : ['NONE — all origins rejected'],
        retention: retentionConfig.retentionEnabled ? 'enabled' : 'disabled',
        config: getConfigSummary(),
    });
}

startServer().catch((err) => {
    log.fatal('Failed to start server', err instanceof Error ? err : new Error(String(err)));
    process.exit(1);
});

// Graceful shutdown
const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 10_000; // 10 seconds
const EMERGENCY_SHUTDOWN_TIMEOUT_MS = 3_000; // 3 seconds
let shutdownInProgress = false;

function shutdown(signal: string): void {
    if (shutdownInProgress) {
        log.warn(`Duplicate shutdown signal (${signal}) ignored — shutdown already in progress`);
        return;
    }
    shutdownInProgress = true;
    const forceExitTimer = setTimeout(() => {
        log.fatal('Graceful shutdown timed out, forcing exit');
        process.exit(1);
    }, GRACEFUL_SHUTDOWN_TIMEOUT_MS);
    forceExitTimer.unref();

    log.info(`Received ${signal}, shutting down gracefully`);
    if (retentionTimer) {
        clearInterval(retentionTimer);
        retentionTimer = null;
    }
    if (!server) {
        destroyAllCaches();
        limiter.destroy();
        destroyAuthCleanup();
        db.close().catch(() => { /* best-effort during early shutdown */ }).finally(() => {
            process.exit(0);
        });
        return;
    }
    server.close(async () => {
        try {
            destroyAllCaches();
            limiter.destroy();
            destroyAuthCleanup();
            await db.close();
            log.info('Server closed');
        } catch (err) {
            log.error('Error during server close', err instanceof Error ? err : new Error(String(err)));
        }
        process.exit(0);
    });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Global error boundaries — prevent silent crashes
process.on('uncaughtException', (err: Error) => {
    log.error('Uncaught exception - initiating emergency shutdown', err);
    const emergencyTimer = setTimeout(() => process.exit(1), EMERGENCY_SHUTDOWN_TIMEOUT_MS);
    emergencyTimer.unref();
    shutdown('uncaughtException');
});
process.on('unhandledRejection', (reason: unknown) => {
    log.error('Unhandled promise rejection - initiating emergency shutdown', reason instanceof Error ? reason : new Error(String(reason)));
    const emergencyTimer = setTimeout(() => process.exit(1), EMERGENCY_SHUTDOWN_TIMEOUT_MS);
    emergencyTimer.unref();
    shutdown('unhandledRejection');
});

export { app };
