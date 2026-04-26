/**
 * ContextZero — MCP Stdio Bridge
 *
 * Entry point for the Model Context Protocol stdio transport.
 * Creates an MCP Server, registers the ContextZero tools, and
 * connects via StdioServerTransport (JSON-RPC over stdin/stdout).
 *
 * All logging goes to stderr — stdout is reserved for the MCP protocol.
 *
 * Usage:
 *   node dist/mcp-bridge/index.js
 *
 * In MCP client config:
 *   { "command": "node", "args": ["dist/mcp-bridge/index.js"] }
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as path from 'path';
import { db } from '../db-driver';
import { destroyAllCaches } from '../cache';
import { runPendingMigrations } from '../db-driver/migrate';
import { transactionalChangeEngine } from '../transactional-editor';
import { features, logging, server as serverConfig } from '../config';
import {
    handleResolveSymbol,
    handleGetSymbolDetails,
    handleGetSymbolRelations,
    handleGetBehavioralProfile,
    handleGetContractProfile,
    handleGetInvariants,
    handleGetUncertainty,
    handleFindHomologs,
    handleBlastRadius,
    handleCompileContextCapsule,
    handleCreateChangeTransaction,
    handleApplyPatch,
    handleValidateChange,
    handleCommitChange,
    handleRollbackChange,
    handlePropagationProposals,
    handleGetTransaction,
    handleRegisterRepo,
    handleIngestRepo,
    handleListRepos,
    handleListSnapshots,
    handleSnapshotStats,
    handlePersistHomologs,
    handleReadSource,
    handleSearchCode,
    handleCodebaseOverview,
    handleNativeCodebaseOverview,
    handleNativeSymbolSearch,
    handleNativeSearchCode,
    handleSemanticSearch,
    handleSmartContext,
    // V2 handlers
    handleGetDispatchEdges,
    handleGetClassHierarchy,
    handleGetSymbolLineage,
    handleGetEffectSignature,
    handleDiffEffects,
    handleGetConceptFamily,
    handleListConceptFamilies,
    handleGetTemporalRisk,
    handleGetCoChangePartners,
    handleIngestRuntimeTrace,
    handleGetRuntimeEvidence,
    handleHealthCheck,
    // Tools 40-42: missing from bridge (parity with HTTP interface)
    handleIncrementalIndex,
    handleBatchEmbed,
    handleCacheStats,
    // Tools 43-52: V3 tools
    handleGetTests,
    handleExplainRelation,
    handleGetNeighbors,
    handleFindConcept,
    handleSemanticDiff,
    handleContractDiff,
    handlePlanChange,
    handlePrepareChange,
    handleApplyPropagation,
    handleReviewHomolog,
    // Admin tools
    handleAdminRunRetention,
    handleAdminRetentionStats,
    handleAdminCleanupStale,
    handleAdminDbStats,
    handleAdminSystemInfo,
    SAFE_ERROR_PREFIXES,
} from './handlers';

// ────────── MCP-Safe Logger (stderr only) ──────────
//
// The standard Logger writes info/debug to stdout, which would corrupt
// the MCP JSON-RPC stream. This logger writes everything to stderr.

export interface McpLogger {
    debug(message: string, data?: Record<string, unknown>): void;
    info(message: string, data?: Record<string, unknown>): void;
    warn(message: string, data?: Record<string, unknown>): void;
    error(message: string, err?: unknown, data?: Record<string, unknown>): void;
}

function createMcpLogger(subsystem: string): McpLogger {
    const minLevel = logging.level;
    const LEVELS: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3, fatal: 4 };
    const minOrd = LEVELS[minLevel] ?? 1;

    function emit(level: string, message: string, data?: Record<string, unknown>, err?: unknown): void {
        if ((LEVELS[level] ?? 0) < minOrd) return;
        const entry: Record<string, unknown> = {
            timestamp: new Date().toISOString(),
            level,
            subsystem,
            message,
        };
        if (data && Object.keys(data).length > 0) entry.data = data;
        if (err instanceof Error) {
            entry.error = err.message;
            entry.stack = err.stack;
        } else if (err !== undefined) {
            entry.error = String(err);
        }
        process.stderr.write(JSON.stringify(entry) + '\n');
    }

    return {
        debug: (msg, data) => emit('debug', msg, data),
        info: (msg, data) => emit('info', msg, data),
        warn: (msg, data) => emit('warn', msg, data),
        error: (msg, err, data) => emit('error', msg, data, err),
    };
}

const log = createMcpLogger('mcp-bridge');

// ────────── Authentication ──────────
//
// If SCG_MCP_SECRET is set, every tool call must include an _auth_token
// argument that matches the secret. When unset, auth is skipped for
// backwards compatibility with local / development setups.
//
// SCG_MCP_ADMIN_SECRET (optional) gates scg_admin_* tools separately. If set,
// admin tools require _auth_token to match SCG_MCP_ADMIN_SECRET. If unset,
// admin tools fall back to SCG_MCP_SECRET (current behaviour).

const MCP_SECRET = features.mcpSecret;
const MCP_ADMIN_SECRET = features.mcpAdminSecret;

// ────────── Per-Tool Rate Limiting ──────────

class McpRateLimiter {
    private readonly windowMs: number;
    private readonly maxRequests: number;
    private requests: Map<string, { count: number; windowStart: number }> = new Map();

    constructor(windowMs: number, maxRequests: number) {
        this.windowMs = windowMs;
        this.maxRequests = maxRequests;
    }

    check(toolName: string): boolean {
        const now = Date.now();
        const entry = this.requests.get(toolName);
        if (!entry || now - entry.windowStart > this.windowMs) {
            this.requests.set(toolName, { count: 1, windowStart: now });
            return true;
        }
        if (entry.count >= this.maxRequests) return false;
        entry.count++;
        return true;
    }
}

/** Rate limits for expensive tools: toolName -> McpRateLimiter */
const rateLimiters: Record<string, McpRateLimiter> = {
    scg_ingest_repo: new McpRateLimiter(5 * 60 * 1000, 3),           // 3 per 5 minutes
    scg_blast_radius: new McpRateLimiter(60 * 1000, 30),              // 30 per minute
    scg_find_homologs: new McpRateLimiter(60 * 1000, 20),             // 20 per minute
    scg_compile_context_capsule: new McpRateLimiter(60 * 1000, 30),   // 30 per minute
    scg_plan_change: new McpRateLimiter(60 * 1000, 20),              // 20 per minute
    scg_find_concept: new McpRateLimiter(60 * 1000, 30),             // 30 per minute
};

// ────────── MCP Result Type ──────────

interface McpTextContent {
    type: 'text';
    text: string;
}

interface McpCallToolResult {
    content: McpTextContent[];
    isError?: boolean;
    [key: string]: unknown;
}

// ────────── Safe Tool Execution Wrapper ──────────

type ToolHandler = (args: Record<string, unknown>, log: McpLogger) => Promise<McpCallToolResult>;

// SAFE_ERROR_PREFIXES is imported from ./handlers — single source of truth

function safeTool(handler: ToolHandler): (args: Record<string, unknown>) => Promise<McpCallToolResult> {
    return async (args: Record<string, unknown>) => {
        try {
            return await handler(args, log);
        } catch (err: unknown) {
            const rawMessage = err instanceof Error ? err.message : String(err);
            log.error('Tool execution failed', err);
            // Only expose error messages that match known safe prefixes; sanitize internal errors
            const isSafe = SAFE_ERROR_PREFIXES.some(prefix => rawMessage.startsWith(prefix));
            const message = isSafe ? rawMessage : 'Internal server error';
            return {
                content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
                isError: true,
            };
        }
    };
}

// ────────── MCP Server Setup ──────────

const SERVER_NAME = 'contextzero';
const SERVER_VERSION = serverConfig.version;

/** Tracks actual tool registration count — derived, never hardcoded */
let toolsRegistered = 0;
let healthCheckTimerRef: ReturnType<typeof setInterval> | null = null;

const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
        capabilities: {
            tools: {},
        },
    },
);

// ────────── Tool Registration ──────────
//
// Each tool is registered with:
//   - name: matches the REST endpoint name (scg_*)
//   - description: what the tool does
//   - inputSchema: zod shape for argument validation
//   - callback: safeTool-wrapped handler from handlers.ts

/**
 * Wrapper that delegates to server.registerTool, tracks count, and injects
 * the tool name into safeTool callbacks so that auth and rate limiting work
 * without requiring each callsite to pass the name explicitly.
 *
 * The handler is expected to be `async (args) => safeTool(fn)(args)`.
 * We wrap it so that safeTool receives the tool name automatically.
 */
interface McpToolConfig {
    description: string;
    inputSchema: Record<string, z.ZodTypeAny>;
}

interface McpToolResult {
    content: Array<{ type: 'text'; text: string }>;
    isError?: boolean;
}

type McpToolHandler = (args: Record<string, unknown>) => Promise<McpToolResult>;

function registerTool(name: string, config: McpToolConfig, handler: McpToolHandler): void {
    // Inject _auth_token into the input schema so the MCP SDK does not strip it
    // before our auth wrapper runs (default zod object behaviour is to strip
    // unknown keys).
    const inputSchemaWithAuth: Record<string, z.ZodTypeAny> = {
        ...config.inputSchema,
        _auth_token: z.string().optional().describe('Authentication token (required when SCG_MCP_SECRET is set)'),
    };
    const finalConfig: McpToolConfig = { ...config, inputSchema: inputSchemaWithAuth };

    // Wrap the handler to inject tool-name-aware auth + rate limiting
    const wrappedHandler: McpToolHandler = async (args: Record<string, unknown>) => {
        // ── Authentication gate ──
        // Admin tools require admin secret when configured; otherwise fall back to MCP_SECRET.
        const isAdminTool = name.startsWith('scg_admin_');
        const requiredSecret = isAdminTool && MCP_ADMIN_SECRET ? MCP_ADMIN_SECRET : MCP_SECRET;
        if (requiredSecret) {
            const token = args['_auth_token'];
            const cleanArgs = { ...args };
            delete cleanArgs['_auth_token'];
            if (token !== requiredSecret) {
                log.warn('Authentication failed for tool call', {
                    tool: name,
                    admin_gate: isAdminTool && Boolean(MCP_ADMIN_SECRET),
                });
                return {
                    content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Authentication failed: invalid or missing _auth_token' }) }],
                    isError: true,
                };
            }
            args = cleanArgs;
        }

        // ── Rate-limit gate ──
        if (rateLimiters[name]) {
            if (!rateLimiters[name].check(name)) {
                log.warn('Rate limit exceeded', { tool: name });
                return {
                    content: [{ type: 'text' as const, text: JSON.stringify({ error: `Rate limit exceeded for ${name}. Please wait and try again.` }) }],
                    isError: true,
                };
            }
        }

        return handler(args);
    };
    // @ts-expect-error — McpServer.registerTool uses recursive Zod generics (TS2589);
    // our config/handler types are verified correct at each call site
    server.registerTool(name, finalConfig, wrappedHandler);
    toolsRegistered++;
}

// Tool 1: Resolve Symbol
registerTool(
    'scg_resolve_symbol',
    {
        description: 'Fuzzy symbol search — find symbols by name in a repository. Returns ranked matches with similarity scores.',
        inputSchema: {
            query: z.string().describe('Search query string (symbol name or partial name)'),
            repo_id: z.string().uuid().describe('Repository UUID'),
            snapshot_id: z.string().uuid().optional().describe('Optional snapshot UUID to scope the search'),
            kind_filter: z.enum(['function', 'method', 'class', 'interface', 'type_alias', 'variable', 'constant', 'enum', 'enum_member', 'property', 'module', 'namespace', 'trait', 'struct', 'protocol', 'extension', 'impl_block', 'constructor', 'destructor', 'operator', 'decorator', 'annotation', 'macro', 'closure', 'generator', 'coroutine', 'test', 'fixture', 'hook', 'middleware', 'route_handler', 'signal', 'slot', 'delegate', 'event', 'other']).optional().describe('Filter by symbol kind'),
            limit: z.number().int().min(1).max(100).optional().describe('Max results to return (default 10, max 100)'),
        },
    },
    async (args: Record<string, unknown>) => safeTool(handleResolveSymbol)(args),
);

// Tool 2: Get Symbol Details
registerTool(
    'scg_get_symbol_details',
    {
        description: 'Get detailed information about a symbol version, including behavioral and contract profiles.',
        inputSchema: {
            symbol_version_id: z.string().uuid().describe('Symbol version UUID'),
            view_mode: z.enum(['code', 'summary', 'signature']).optional().describe('Detail level: code (full), summary (with profiles), or signature (minimal). Default: summary'),
        },
    },
    async (args: Record<string, unknown>) => safeTool(handleGetSymbolDetails)(args),
);

// Tool 3: Get Symbol Relations
registerTool(
    'scg_get_symbol_relations',
    {
        description: 'Get structural relations (calls, imports, inherits, etc.) for a symbol version.',
        inputSchema: {
            symbol_version_id: z.string().uuid().describe('Symbol version UUID'),
            direction: z.enum(['inbound', 'outbound', 'both']).optional().describe('Relation direction filter. Default: both'),
        },
    },
    async (args: Record<string, unknown>) => safeTool(handleGetSymbolRelations)(args),
);

// Tool 4: Get Behavioral Profile
registerTool(
    'scg_get_behavioral_profile',
    {
        description: 'Get the behavioral profile of a symbol — purity class, resource touches, DB ops, network calls, side effects.',
        inputSchema: {
            symbol_version_id: z.string().uuid().describe('Symbol version UUID'),
        },
    },
    async (args: Record<string, unknown>) => safeTool(handleGetBehavioralProfile)(args),
);

// Tool 5: Get Contract Profile
registerTool(
    'scg_get_contract_profile',
    {
        description: 'Get the contract profile of a symbol — input/output contracts, error contracts, schema refs, security contract.',
        inputSchema: {
            symbol_version_id: z.string().uuid().describe('Symbol version UUID'),
        },
    },
    async (args: Record<string, unknown>) => safeTool(handleGetContractProfile)(args),
);

// Tool 6: Get Invariants
registerTool(
    'scg_get_invariants',
    {
        description: 'Get invariants scoped to a symbol — explicit tests, derived constraints, assertions.',
        inputSchema: {
            symbol_id: z.string().uuid().describe('Symbol UUID (not symbol_version_id)'),
        },
    },
    async (args: Record<string, unknown>) => safeTool(handleGetInvariants)(args),
);

// Tool 7: Get Uncertainty Report
registerTool(
    'scg_get_uncertainty',
    {
        description: 'Get the uncertainty report for a snapshot — areas where analysis confidence is low or evidence is insufficient.',
        inputSchema: {
            snapshot_id: z.string().uuid().describe('Snapshot UUID'),
        },
    },
    async (args: Record<string, unknown>) => safeTool(handleGetUncertainty)(args),
);

// Tool 8: Find Homologs
registerTool(
    'scg_find_homologs',
    {
        description: 'Find homologous symbols — code clones, near-duplicates, validators with parallel logic, co-changed peers.',
        inputSchema: {
            symbol_version_id: z.string().uuid().describe('Source symbol version UUID to find homologs for'),
            snapshot_id: z.string().uuid().describe('Snapshot UUID defining the search scope'),
            confidence_threshold: z.number().min(0).max(1).optional().describe('Minimum confidence score (0-1). Default: 0.70'),
        },
    },
    async (args: Record<string, unknown>) => safeTool(handleFindHomologs)(args),
);

// Tool 9: Blast Radius
registerTool(
    'scg_blast_radius',
    {
        description: 'Compute blast radius — impact analysis showing structural, behavioral, contract, and homolog impacts of changing symbols.',
        inputSchema: {
            symbol_version_ids: z.array(z.string().uuid()).min(1).describe('Array of symbol version UUIDs to analyze impact for'),
            snapshot_id: z.string().uuid().describe('Snapshot UUID'),
            depth: z.number().int().min(1).max(5).optional().describe('Graph traversal depth (1-5). Default: 2'),
        },
    },
    async (args: Record<string, unknown>) => safeTool(handleBlastRadius)(args),
);

// Tool 10: Compile Context Capsule
registerTool(
    'scg_compile_context_capsule',
    {
        description: 'Compile a token-budgeted context capsule for a symbol — includes code, dependencies, callers, tests, contracts, and homologs, prioritized to fit within a token budget.',
        inputSchema: {
            symbol_version_id: z.string().uuid().describe('Target symbol version UUID'),
            snapshot_id: z.string().uuid().describe('Snapshot UUID'),
            mode: z.enum(['minimal', 'standard', 'strict']).optional().describe('Capsule compilation mode. Default: standard'),
            token_budget: z.number().int().min(100).max(100000).optional().describe('Maximum token budget (100-100000). Default: 8000'),
        },
    },
    async (args: Record<string, unknown>) => safeTool(handleCompileContextCapsule)(args),
);

// Tool 11: Create Change Transaction
registerTool(
    'scg_create_change_transaction',
    {
        description: 'Create a new change transaction — a tracked unit of work targeting specific symbols in a repository.',
        inputSchema: {
            repo_id: z.string().uuid().describe('Repository UUID'),
            base_snapshot_id: z.string().uuid().describe('Base snapshot UUID for the change'),
            created_by: z.string().max(200).optional().describe('Creator identifier. Default: mcp'),
            target_symbol_version_ids: z.array(z.string().uuid()).min(1).describe('Symbol version UUIDs being modified'),
            task_description: z.string().optional().describe('Human-readable description of the change task'),
        },
    },
    async (args: Record<string, unknown>) => safeTool(handleCreateChangeTransaction)(args),
);

// Tool 12: Apply Patch
registerTool(
    'scg_apply_patch',
    {
        description: 'Apply file patches to a change transaction — provides new file content for changed files.',
        inputSchema: {
            txn_id: z.string().uuid().describe('Transaction UUID'),
            patches: z.array(z.object({
                file_path: z.string().describe('Relative file path within the repository'),
                new_content: z.string().describe('Complete new content for the file'),
            })).min(1).describe('Array of file patches to apply'),
        },
    },
    async (args: Record<string, unknown>) => safeTool(handleApplyPatch)(args),
);

// Tool 13: Validate Change
registerTool(
    'scg_validate_change',
    {
        description: 'Run 6-level validation on a change transaction — syntax, semantic, contract, invariant, behavioral, and propagation checks.',
        inputSchema: {
            txn_id: z.string().uuid().describe('Transaction UUID'),
            mode: z.enum(['quick', 'standard', 'strict']).optional().describe('Validation thoroughness. Default: standard'),
        },
    },
    async (args: Record<string, unknown>) => safeTool(handleValidateChange)(args),
);

// Tool 14: Commit Change
registerTool(
    'scg_commit_change',
    {
        description: 'Commit a validated change transaction, finalizing all patches.',
        inputSchema: {
            txn_id: z.string().uuid().describe('Transaction UUID'),
        },
    },
    async (args: Record<string, unknown>) => safeTool(handleCommitChange)(args),
);

// Tool 15: Rollback Change
registerTool(
    'scg_rollback_change',
    {
        description: 'Rollback a change transaction, reverting all patches.',
        inputSchema: {
            txn_id: z.string().uuid().describe('Transaction UUID'),
        },
    },
    async (args: Record<string, unknown>) => safeTool(handleRollbackChange)(args),
);

// Tool 16: Propagation Proposals
registerTool(
    'scg_propagation_proposals',
    {
        description: 'Compute homolog co-change proposals — suggests changes to homologous symbols that may need parallel updates.',
        inputSchema: {
            txn_id: z.string().uuid().describe('Transaction UUID'),
            snapshot_id: z.string().uuid().describe('Snapshot UUID'),
        },
    },
    async (args: Record<string, unknown>) => safeTool(handlePropagationProposals)(args),
);

// Tool 17: Get Transaction
registerTool(
    'scg_get_transaction',
    {
        description: 'Get the current status and details of a change transaction.',
        inputSchema: {
            txn_id: z.string().uuid().describe('Transaction UUID'),
        },
    },
    async (args: Record<string, unknown>) => safeTool(handleGetTransaction)(args),
);

// MCP Tool: Register Repository
registerTool(
    'scg_register_repo',
    {
        description: 'Register a repository for indexed workflows. In MCP mode, if SCG_ALLOWED_BASE_PATHS is unset, access falls back to the current working directory only.',
        inputSchema: {
            repo_name: z.string().describe('Human-readable repository name'),
            repo_path: z.string().refine(v => path.isAbsolute(v), { message: 'repo_path must be an absolute path' }).describe('Absolute repository path'),
            default_branch: z.string().optional().describe('Default branch name. Default: main'),
            visibility: z.enum(['public', 'private']).optional().describe('Repository visibility. Default: private'),
        },
    },
    async (args: Record<string, unknown>) => safeTool(handleRegisterRepo)(args),
);

// Tool 18: Ingest Repository
registerTool(
    'scg_ingest_repo',
    {
        description: 'Ingest (index) a repository by registered repo_id or direct repo_path. If commit_sha is omitted, MCP derives it from git HEAD or a workspace fingerprint for non-git repos.',
        inputSchema: {
            repo_id: z.string().uuid().optional().describe('Registered repository UUID'),
            repo_path: z.string().optional().describe('Raw repository path for direct ingestion'),
            repo_name: z.string().optional().describe('Repository name when using repo_path (defaults to folder name)'),
            commit_sha: z.string().optional().describe('Explicit commit SHA or snapshot label'),
            branch: z.string().optional().describe('Branch name. Default: repo default branch, git branch, or main/workspace'),
        },
    },
    async (args: Record<string, unknown>) => safeTool(handleIngestRepo)(args),
);

// Tool 19: List Repositories
registerTool(
    'scg_list_repos',
    {
        description: 'List registered repositories, ordered by most recently updated.',
        inputSchema: {
            limit: z.number().int().min(1).max(100).optional().describe('Max results (default 20, max 100)'),
            offset: z.number().int().min(0).max(100000).optional().describe('Pagination offset (default 0)'),
        },
    },
    async (args: Record<string, unknown>) => safeTool(handleListRepos)(args),
);

// Tool 20: List Snapshots
registerTool(
    'scg_list_snapshots',
    {
        description: 'List snapshots for a repository, ordered by most recent.',
        inputSchema: {
            repo_id: z.string().uuid().describe('Repository UUID'),
            limit: z.number().int().min(1).max(100).optional().describe('Max results (default 20, max 100)'),
            offset: z.number().int().min(0).max(100000).optional().describe('Pagination offset (default 0)'),
        },
    },
    async (args: Record<string, unknown>) => safeTool(handleListSnapshots)(args),
);

// Tool 21: Snapshot Stats
registerTool(
    'scg_snapshot_stats',
    {
        description: 'Get statistics for a snapshot — file count, symbol count, relation count, and uncertainty report.',
        inputSchema: {
            snapshot_id: z.string().uuid().describe('Snapshot UUID'),
        },
    },
    async (args: Record<string, unknown>) => safeTool(handleSnapshotStats)(args),
);

// Tool 22: Persist Homologs
registerTool(
    'scg_persist_homologs',
    {
        description: 'Discover and persist homolog relations for a symbol — runs homolog detection and saves results to the database.',
        inputSchema: {
            source_symbol_version_id: z.string().uuid().describe('Source symbol version UUID'),
            snapshot_id: z.string().uuid().describe('Snapshot UUID'),
            confidence_threshold: z.number().min(0).max(1).optional().describe('Minimum confidence threshold (0-1). Default: 0.70'),
        },
    },
    async (args: Record<string, unknown>) => safeTool(handlePersistHomologs)(args),
);

// Tool 23: Read Source Code (DB-first, batch-capable)
registerTool(
    'scg_read_source',
    {
        description: 'Read source code from DB — by symbol_version_id (single), symbol_version_ids (batch, up to 20), or file_path (disk). Batch mode returns all symbols in one call (~500 tokens each vs ~5000 for full file). Prefer batch mode for multi-symbol lookups.',
        inputSchema: {
            repo_id: z.string().uuid().describe('Repository UUID'),
            symbol_version_id: z.string().uuid().optional().describe('Single symbol version UUID'),
            symbol_version_ids: z.array(z.string().uuid()).max(20).optional().describe('Batch: array of symbol version UUIDs (max 20)'),
            file_path: z.string().optional().describe('Relative file path within the repo (disk fallback)'),
            start_line: z.number().int().min(1).optional().describe('Start line for file mode'),
            end_line: z.number().int().min(1).optional().describe('End line for file mode'),
            context_lines: z.number().int().min(0).max(50).optional().describe('Extra context lines around symbol (default 0)'),
        },
    },
    async (args: Record<string, unknown>) => safeTool(handleReadSource)(args),
);

// Tool 24: Search Code
registerTool(
    'scg_search_code',
    {
        description: 'Search/grep across all indexed files in a repository. Returns matching lines with surrounding context. Supports regex patterns. Essential for finding implementations, usages, and patterns during audits.',
        inputSchema: {
            repo_id: z.string().uuid().describe('Repository UUID'),
            pattern: z.string().describe('Search pattern (regex supported). E.g., "async function train", "class.*Block", "def forward"'),
            file_pattern: z.string().optional().describe('Filter to files matching this substring. E.g., ".py", "src/model", "test"'),
            max_results: z.number().int().min(1).max(100).optional().describe('Maximum matches to return (default 30, max 100)'),
            context_lines: z.number().int().min(0).max(5).optional().describe('Lines of context around each match (default 2, max 5)'),
        },
    },
    async (args: Record<string, unknown>) => safeTool(handleSearchCode)(args),
);

// Tool 25: Codebase Overview
registerTool(
    'scg_codebase_overview',
    {
        description: 'High-level architecture summary with risk assessment. Shows: file structure, symbol distribution, behavioral purity profile, test coverage gaps, high-risk symbols (side-effecting, network, DB), and uncertainty analysis. Use this FIRST when auditing an unfamiliar codebase.',
        inputSchema: {
            repo_id: z.string().uuid().describe('Repository UUID'),
            snapshot_id: z.string().uuid().describe('Snapshot UUID'),
        },
    },
    async (args: Record<string, unknown>) => safeTool(handleCodebaseOverview)(args),
);

// MCP Tool: Native Codebase Overview
registerTool(
    'scg_native_codebase_overview',
    {
        description: 'Zero-setup codebase overview for a local repo path. Works before registration or ingestion. Supports 13 languages: TypeScript, JavaScript, Python, C/C++, Go, Rust, Java, C#, Ruby, Kotlin, Swift, PHP, Bash.',
        inputSchema: {
            repo_path: z.string().describe('Absolute or relative repository path'),
            max_files: z.number().int().min(1).max(5000).optional().describe('Maximum files to scan (default 1500)'),
        },
    },
    async (args: Record<string, unknown>) => safeTool(handleNativeCodebaseOverview)(args),
);

// MCP Tool: Native Symbol Search
registerTool(
    'scg_native_symbol_search',
    {
        description: 'Zero-setup symbol search over a local repo path. Parses supported languages directly from disk and does not require git, registration, or prior ingestion.',
        inputSchema: {
            repo_path: z.string().describe('Absolute or relative repository path'),
            query: z.string().describe('Symbol name or partial name to find'),
            kind_filter: z.enum(['function', 'method', 'class', 'interface', 'type_alias', 'variable', 'constant', 'enum', 'enum_member', 'property', 'module', 'namespace', 'trait', 'struct', 'protocol', 'extension', 'impl_block', 'constructor', 'destructor', 'operator', 'decorator', 'annotation', 'macro', 'closure', 'generator', 'coroutine', 'test', 'fixture', 'hook', 'middleware', 'route_handler', 'signal', 'slot', 'delegate', 'event', 'other']).optional().describe('Optional symbol kind filter'),
            language: z.enum(['typescript', 'javascript', 'python', 'cpp', 'go', 'rust', 'java', 'csharp', 'ruby', 'kotlin', 'swift', 'php', 'bash']).optional().describe('Optional language filter'),
            max_results: z.number().int().min(1).max(100).optional().describe('Maximum symbol matches to return (default 20)'),
            max_files: z.number().int().min(1).max(5000).optional().describe('Maximum source files to scan (default 1200)'),
        },
    },
    async (args: Record<string, unknown>) => safeTool(handleNativeSymbolSearch)(args),
);

// MCP Tool: Native Search Code
registerTool(
    'scg_native_search_code',
    {
        description: 'Zero-setup grep across a local repo path. Searches readable text files directly from disk with regex safety guards and surrounding context.',
        inputSchema: {
            repo_path: z.string().describe('Absolute or relative repository path'),
            pattern: z.string().max(500).describe('Search pattern (regex supported; unsafe patterns fall back to literal search)'),
            file_pattern: z.string().optional().describe('Optional file path substring filter'),
            max_results: z.number().int().min(1).max(100).optional().describe('Maximum matches to return (default 30)'),
            context_lines: z.number().int().min(0).max(5).optional().describe('Context lines around each match (default 2)'),
            max_files: z.number().int().min(1).max(5000).optional().describe('Maximum files to scan (default 1500)'),
        },
    },
    async (args: Record<string, unknown>) => safeTool(handleNativeSearchCode)(args),
);

// Tool 26: Semantic Search (body-content TF-IDF search)
registerTool(
    'scg_semantic_search',
    {
        description: 'Search inside function bodies using semantic similarity (TF-IDF). Unlike resolve_symbol (name-only), this finds code by what it DOES. Query: "accumulate V×V matrices" or "retry with exponential backoff". Returns ranked symbols with source.',
        inputSchema: {
            query: z.string().max(2000).describe('Natural language or code description of what to find'),
            snapshot_id: z.string().uuid().describe('Snapshot UUID'),
            limit: z.number().int().min(1).max(50).optional().describe('Max results (default 15, max 50)'),
            include_source: z.boolean().optional().describe('Include source code in results (default true)'),
        },
    },
    async (args: Record<string, unknown>) => safeTool(handleSemanticSearch)(args),
);

// Tool 27: Smart Context (task-oriented context bundles)
registerTool(
    'scg_smart_context',
    {
        description: 'Get everything needed for a change task in ONE call. Provide target symbols + task description → returns: target source, blast radius impacts with source, homologs, tests — all token-budgeted. Replaces 8+ separate tool calls.',
        inputSchema: {
            task_description: z.string().describe('What change are you making and why'),
            target_symbol_version_ids: z.array(z.string().uuid()).min(1).max(20).describe('Symbol version UUIDs being changed'),
            snapshot_id: z.string().uuid().describe('Snapshot UUID'),
            token_budget: z.number().int().min(1000).max(100000).optional().describe('Max tokens for response (default 20000)'),
            depth: z.number().int().min(1).max(5).optional().describe('Blast radius search depth (default 2)'),
        },
    },
    async (args: Record<string, unknown>) => safeTool(handleSmartContext)(args),
);

// ════════════════════════════════════════════════════════════════════════════
// V2 TOOLS — Dispatch, Lineage, Effects, Families, Temporal, Runtime
// ════════════════════════════════════════════════════════════════════════════

// Tool 28: Get Dispatch Edges
registerTool(
    'scg_get_dispatch_edges',
    {
        description: 'Get resolved dispatch edges for a symbol — shows how object method chains (self.service.validate()) are resolved to actual target symbols.',
        inputSchema: {
            symbol_version_id: z.string().uuid().describe('Symbol version UUID'),
        },
    },
    async (args: Record<string, unknown>) => safeTool(handleGetDispatchEdges)(args),
);

// Tool 29: Get Class Hierarchy
registerTool(
    'scg_get_class_hierarchy',
    {
        description: 'Get the class hierarchy and Method Resolution Order (MRO) for a class symbol — shows inheritance chain, interfaces, and override relationships.',
        inputSchema: {
            snapshot_id: z.string().uuid().describe('Snapshot UUID'),
            symbol_version_id: z.string().uuid().describe('Class symbol version UUID'),
        },
    },
    async (args: Record<string, unknown>) => safeTool(handleGetClassHierarchy)(args),
);

// Tool 30: Get Symbol Lineage
registerTool(
    'scg_get_symbol_lineage',
    {
        description: 'Get the lineage history of a symbol across snapshots — tracks identity through renames, moves, and refactors.',
        inputSchema: {
            symbol_id: z.string().uuid().describe('Symbol UUID'),
        },
    },
    async (args: Record<string, unknown>) => safeTool(handleGetSymbolLineage)(args),
);

// Tool 31: Get Effect Signature
registerTool(
    'scg_get_effect_signature',
    {
        description: 'Get the typed effect signature for a symbol — precise reads/writes/emits/calls/mutates/requires/throws effects with resources and confidence.',
        inputSchema: {
            symbol_version_id: z.string().uuid().describe('Symbol version UUID'),
        },
    },
    async (args: Record<string, unknown>) => safeTool(handleGetEffectSignature)(args),
);

// Tool 32: Diff Effects
registerTool(
    'scg_diff_effects',
    {
        description: 'Compare effect signatures between two symbol versions — shows added, removed, and changed effects for change validation.',
        inputSchema: {
            before_symbol_version_id: z.string().uuid().describe('Symbol version UUID before change'),
            after_symbol_version_id: z.string().uuid().describe('Symbol version UUID after change'),
        },
    },
    async (args: Record<string, unknown>) => safeTool(handleDiffEffects)(args),
);

// Tool 33: Get Concept Family
registerTool(
    'scg_get_concept_family',
    {
        description: 'Get the concept family a symbol belongs to — shows family type, exemplar, members, outliers, and contradictions.',
        inputSchema: {
            symbol_version_id: z.string().uuid().describe('Symbol version UUID'),
        },
    },
    async (args: Record<string, unknown>) => safeTool(handleGetConceptFamily)(args),
);

// Tool 34: List Concept Families
registerTool(
    'scg_list_concept_families',
    {
        description: 'List all concept families in a snapshot — validator families, serializer families, auth policy families, etc.',
        inputSchema: {
            snapshot_id: z.string().uuid().describe('Snapshot UUID'),
        },
    },
    async (args: Record<string, unknown>) => safeTool(handleListConceptFamilies)(args),
);

// Tool 35: Get Temporal Risk
registerTool(
    'scg_get_temporal_risk',
    {
        description: 'Get temporal risk score for a symbol — based on change frequency, bug-fix history, regression count, churn, and ownership patterns.',
        inputSchema: {
            symbol_id: z.string().uuid().describe('Symbol UUID'),
            snapshot_id: z.string().uuid().describe('Snapshot UUID'),
        },
    },
    async (args: Record<string, unknown>) => safeTool(handleGetTemporalRisk)(args),
);

// Tool 36: Get Co-Change Partners
registerTool(
    'scg_get_co_change_partners',
    {
        description: 'Get symbols that historically change together with a target symbol — based on git history co-change analysis.',
        inputSchema: {
            symbol_id: z.string().uuid().describe('Symbol UUID'),
            repo_id: z.string().uuid().describe('Repository UUID'),
            min_jaccard: z.number().min(0).max(1).optional().describe('Minimum Jaccard coefficient (0-1). Default: 0.3'),
        },
    },
    async (args: Record<string, unknown>) => safeTool(handleGetCoChangePartners)(args),
);

// Tool 37: Ingest Runtime Trace
registerTool(
    'scg_ingest_runtime_trace',
    {
        description: 'Ingest runtime trace data — test execution traces, dev run traces, or CI traces. Observed call edges are merged with the static graph to reduce uncertainty and improve dispatch resolution.',
        inputSchema: {
            repo_id: z.string().uuid().describe('Repository UUID'),
            snapshot_id: z.string().uuid().describe('Snapshot UUID'),
            trace_pack: z.object({
                source: z.enum(['test_execution', 'dev_run', 'ci_trace', 'production_sample']).describe('Trace source type'),
                timestamp: z.string().datetime().describe('Trace timestamp (ISO 8601)'),
                call_edges: z.array(z.object({
                    caller_key: z.string(),
                    callee_key: z.string(),
                    receiver_type: z.string().nullable().optional(),
                    call_count: z.number().int().min(1),
                })).max(50000).describe('Observed call edges (max 50000)'),
                dynamic_routes: z.array(z.object({
                    route: z.string(),
                    handler_key: z.string(),
                    method: z.string(),
                    middleware: z.array(z.string()).optional(),
                })).max(10000).default([]).describe('Dynamic route registrations (max 10000)'),
                observed_types: z.array(z.object({
                    expression: z.string(),
                    observed_type: z.string(),
                    location: z.string().optional(),
                })).max(10000).default([]).describe('Observed runtime types (max 10000)'),
                framework_events: z.array(z.object({
                    event_type: z.string(),
                    detail: z.record(z.string(), z.unknown()),
                })).max(10000).default([]).describe('Framework-specific events (max 10000)'),
            }).describe('Runtime trace pack'),
        },
    },
    async (args: Record<string, unknown>) => safeTool(handleIngestRuntimeTrace)(args),
);

// Tool 38: Get Runtime Evidence
registerTool(
    'scg_get_runtime_evidence',
    {
        description: 'Get runtime evidence for a symbol — observed call edges, caller observations, and confidence boost from runtime data.',
        inputSchema: {
            symbol_version_id: z.string().uuid().describe('Symbol version UUID'),
        },
    },
    async (args: Record<string, unknown>) => safeTool(handleGetRuntimeEvidence)(args),
);

// ════════════════════════════════════════════════════════════════════════════
// OPERATIONAL TOOLS — Health Check
// ════════════════════════════════════════════════════════════════════════════

// Tool 39: Health Check
registerTool(
    'scg_health_check',
    {
        description: 'Health check — returns DB connection status (with latency), pool stats, migration count, server uptime, and version. Use to verify the server is operational before starting a task.',
        inputSchema: {},
    },
    async (args: Record<string, unknown>) => safeTool(handleHealthCheck)(args),
);

// ════════════════════════════════════════════════════════════════════════════
// INDEXING & CACHE TOOLS — Incremental Index, Batch Embed, Cache Stats
// ════════════════════════════════════════════════════════════════════════════

// Tool 40: Incremental Index
registerTool(
    'scg_incremental_index',
    {
        description: 'Incrementally re-index changed files — accepts changed file paths (from git diff), invalidates affected symbols, re-extracts, and re-computes profiles and relations. Much faster than a full re-ingest.',
        inputSchema: {
            repo_id: z.string().uuid().describe('Repository UUID'),
            snapshot_id: z.string().uuid().describe('Snapshot UUID'),
            changed_paths: z.array(z.string().min(1)).min(1).max(5000).describe('Changed file paths (relative to repo root)'),
        },
    },
    async (args: Record<string, unknown>) => safeTool(handleIncrementalIndex)(args),
);

// Tool 41: Batch Embed Snapshot
registerTool(
    'scg_batch_embed',
    {
        description: 'Batch-embed all symbol versions in a snapshot — generates semantic vectors for similarity search. Run after ingestion to enable scg_semantic_search.',
        inputSchema: {
            snapshot_id: z.string().uuid().describe('Snapshot UUID'),
        },
    },
    async (args: Record<string, unknown>) => safeTool(handleBatchEmbed)(args),
);

// Tool 42: Cache Stats
registerTool(
    'scg_cache_stats',
    {
        description: 'Returns hit/miss/eviction stats for all 5 in-process caches (symbol, profile, capsule, homolog, query). Use to diagnose performance issues or verify cache warming.',
        inputSchema: {},
    },
    async (args: Record<string, unknown>) => safeTool(handleCacheStats)(args),
);

// ════════════════════════════════════════════════════════════════════════════
// V3 TOOLS — Tests, Explain, Neighbors, Concept, Semantic Diff, Contract Diff,
//             Plan Change, Prepare Change, Apply Propagation, Review Homolog
// ════════════════════════════════════════════════════════════════════════════

// Tool 43: Get Tests
registerTool(
    'scg_get_tests',
    {
        description: 'Get test artifacts related to a symbol — test names, frameworks, assertion summaries, and coverage hints.',
        inputSchema: {
            symbol_id: z.string().uuid().describe('Symbol UUID (not symbol_version_id)'),
            snapshot_id: z.string().uuid().describe('Snapshot UUID'),
        },
    },
    async (args: Record<string, unknown>) => safeTool(handleGetTests)(args),
);

// Tool 44: Explain Relation
registerTool(
    'scg_explain_relation',
    {
        description: 'Explain the relationship between two symbols — returns structural and inferred relations with evidence bundles and confidence scores.',
        inputSchema: {
            src_symbol_version_id: z.string().uuid().describe('Source symbol version UUID'),
            dst_symbol_version_id: z.string().uuid().describe('Destination symbol version UUID'),
            snapshot_id: z.string().uuid().describe('Snapshot UUID'),
        },
    },
    async (args: Record<string, unknown>) => safeTool(handleExplainRelation)(args),
);

// Tool 45: Get Neighbors
registerTool(
    'scg_get_neighbors',
    {
        description: 'Get the graph neighborhood of a symbol — BFS traversal through structural relations with configurable depth and direction.',
        inputSchema: {
            symbol_version_id: z.string().uuid().describe('Origin symbol version UUID'),
            snapshot_id: z.string().uuid().describe('Snapshot UUID'),
            direction: z.enum(['inbound', 'outbound', 'both']).optional().describe('Relation direction filter. Default: both'),
            depth: z.number().int().min(1).max(5).optional().describe('Traversal depth (1-5). Default: 2'),
            max_nodes: z.number().int().min(1).max(500).optional().describe('Maximum nodes to return. Default: 100'),
            relation_types: z.array(z.string()).optional().describe('Filter by specific relation types (e.g., ["calls", "imports"])'),
        },
    },
    async (args: Record<string, unknown>) => safeTool(handleGetNeighbors)(args),
);

// Tool 46: Find Concept
registerTool(
    'scg_find_concept',
    {
        description: 'Search for symbols by concept — combines name matching, semantic similarity, concept family lookup, and contract search. Returns ranked matches with relevance scores.',
        inputSchema: {
            concept: z.string().min(1).max(500).describe('Concept search string (e.g., "email validation", "payment processing")'),
            repo_id: z.string().uuid().describe('Repository UUID'),
            snapshot_id: z.string().uuid().describe('Snapshot UUID'),
            kind_filter: z.string().optional().describe('Filter by symbol kind (e.g., "function", "class")'),
            language_filter: z.string().optional().describe('Filter by language (e.g., "typescript", "python")'),
            limit: z.number().int().min(1).max(100).optional().describe('Max results (default 20, max 100)'),
        },
    },
    async (args: Record<string, unknown>) => safeTool(handleFindConcept)(args),
);

// Tool 47: Semantic Diff
registerTool(
    'scg_semantic_diff',
    {
        description: 'Compare two symbol versions semantically — detects changes in side effects, return types, exceptions, auth behavior, serialization, and persistence across 9 dimensions.',
        inputSchema: {
            before_symbol_version_id: z.string().uuid().describe('Before symbol version UUID'),
            after_symbol_version_id: z.string().uuid().describe('After symbol version UUID'),
        },
    },
    async (args: Record<string, unknown>) => safeTool(handleSemanticDiff)(args),
);

// Tool 48: Contract Diff
registerTool(
    'scg_contract_diff',
    {
        description: 'Compute contract delta between two symbol versions or for a transaction — detects breaking changes in input/output/error/security contracts.',
        inputSchema: {
            before_symbol_version_id: z.string().uuid().optional().describe('Before symbol version UUID'),
            after_symbol_version_id: z.string().uuid().optional().describe('After symbol version UUID'),
            txn_id: z.string().uuid().optional().describe('Transaction UUID (alternative to before/after IDs)'),
        },
    },
    async (args: Record<string, unknown>) => safeTool(handleContractDiff)(args),
);

// Tool 49: Plan Change
registerTool(
    'scg_plan_change',
    {
        description: 'Plan a code change from natural language — resolves target symbols, computes initial blast radius, and recommends capsule mode. The entry point for the change workflow.',
        inputSchema: {
            repo_id: z.string().uuid().describe('Repository UUID'),
            snapshot_id: z.string().uuid().describe('Snapshot UUID'),
            task_description: z.string().min(1).max(2000).describe('Natural language description of the change task'),
            max_candidates: z.number().int().min(1).max(20).optional().describe('Maximum target candidates (default 5, max 20)'),
            scope_constraints: z.object({
                kind_filter: z.string().optional(),
                file_pattern: z.string().optional(),
            }).optional().describe('Optional scope constraints to narrow candidate search'),
        },
    },
    async (args: Record<string, unknown>) => safeTool(handlePlanChange)(args),
);

// Tool 50: Prepare Change
registerTool(
    'scg_prepare_change',
    {
        description: 'Prepare a change transaction — locks target symbol versions and establishes preconditions before patching.',
        inputSchema: {
            repo_id: z.string().uuid().describe('Repository UUID'),
            base_snapshot_id: z.string().uuid().describe('Base snapshot UUID'),
            target_symbol_version_ids: z.array(z.string().uuid()).min(1).describe('Symbol version UUIDs to target'),
            plan_id: z.string().uuid().optional().describe('Optional plan ID from scg_plan_change'),
            created_by: z.string().max(200).optional().describe('Creator identifier. Default: mcp'),
        },
    },
    async (args: Record<string, unknown>) => safeTool(handlePrepareChange)(args),
);

// Tool 51: Apply Propagation
registerTool(
    'scg_apply_propagation',
    {
        description: 'Apply a propagation patch to a homolog target within an existing transaction — executes recommended changes from propagation proposals.',
        inputSchema: {
            txn_id: z.string().uuid().describe('Parent transaction UUID'),
            target_symbol_version_id: z.string().uuid().describe('Target homolog symbol version UUID'),
            patch: z.object({
                file_path: z.string().describe('Relative file path'),
                new_content: z.string().describe('New file content'),
            }).describe('Propagation patch to apply'),
        },
    },
    async (args: Record<string, unknown>) => safeTool(handleApplyPropagation)(args),
);

// Tool 52: Review Homolog
registerTool(
    'scg_review_homolog',
    {
        description: 'Review an inferred homolog relation — approve, reject, or flag for further investigation. Updates the review state for future analysis.',
        inputSchema: {
            inferred_relation_id: z.string().uuid().describe('Inferred relation UUID'),
            review_state: z.enum(['confirmed', 'rejected', 'flagged']).describe('New review state'),
            reviewer: z.string().max(200).optional().describe('Reviewer identifier'),
        },
    },
    async (args: Record<string, unknown>) => safeTool(handleReviewHomolog)(args),
);

// ════════════════════════════════════════════════════════════════════════════
// ADMIN TOOLS — Retention, Cleanup, Database Stats, System Info
// ════════════════════════════════════════════════════════════════════════════

// Tool 53: Run Retention Policy
registerTool(
    'scg_admin_run_retention',
    {
        description: 'Run the retention policy immediately — expires old snapshots, enforces per-repo snapshot caps, cleans stale transactions, and removes orphaned data. Returns a summary of all cleanup operations performed.',
        inputSchema: {},
    },
    async (args: Record<string, unknown>) => safeTool(handleAdminRunRetention)(args),
);

// Tool 54: Retention Stats
registerTool(
    'scg_admin_retention_stats',
    {
        description: 'Get retention policy statistics — total/expired snapshots, stale transactions, oldest snapshot age, and last cleanup run timestamp.',
        inputSchema: {},
    },
    async (args: Record<string, unknown>) => safeTool(handleAdminRetentionStats)(args),
);

// Tool 55: Cleanup Stale Transactions
registerTool(
    'scg_admin_cleanup_stale',
    {
        description: 'Clean up transactions stuck in intermediate states (planned, prepared, patched, etc.) beyond the configured timeout. Marks them as failed and returns the count of cleaned and remaining stale transactions.',
        inputSchema: {},
    },
    async (args: Record<string, unknown>) => safeTool(handleAdminCleanupStale)(args),
);

// Tool 56: Database Stats
registerTool(
    'scg_admin_db_stats',
    {
        description: 'Get database health statistics — table sizes and row counts, least-used indexes, total database size, and connection pool state. Use to diagnose storage growth or index bloat.',
        inputSchema: {},
    },
    async (args: Record<string, unknown>) => safeTool(handleAdminDbStats)(args),
);

// Tool 57: System Info
registerTool(
    'scg_admin_system_info',
    {
        description: 'Get system-wide operational information — server uptime, memory usage, database entity counts (repos, snapshots, symbols, relations), connection health, and cache statistics across all 5 cache layers.',
        inputSchema: {},
    },
    async (args: Record<string, unknown>) => safeTool(handleAdminSystemInfo)(args),
);

// ────────── Server Startup ──────────

async function main(): Promise<void> {
    log.info('Starting ContextZero MCP bridge', { version: SERVER_VERSION });

    // Refuse to start unauthenticated in production; warn in dev/test.
    if (!MCP_SECRET) {
        if (process.env['NODE_ENV'] === 'production') {
            log.error(
                'SCG_MCP_SECRET is not set. The MCP bridge will not start unauthenticated in production. ' +
                'Set SCG_MCP_SECRET to a high-entropy secret (e.g. `openssl rand -hex 32`) and restart.'
            );
            process.exit(1);
        }
        log.warn('MCP bridge running WITHOUT authentication. Set SCG_MCP_SECRET for production use.');
    }

    // Run pending migrations before accepting connections
    try {
        await runPendingMigrations();
    } catch (err) {
        log.error('Migration failed — refusing to start', err);
        process.exit(1);
    }

    try {
        const recoverySummary = await transactionalChangeEngine.recoverStaleTransactions();
        if (recoverySummary.scanned > 0 || recoverySummary.cleaned_terminal_backups > 0) {
            log.warn('Transactional recovery completed during startup', { ...recoverySummary });
        }
    } catch (err) {
        log.error('Transactional recovery failed — refusing to start', err);
        process.exit(1);
    }

    // Startup health check — fail fast if DB is unreachable
    const startupHealth = await db.healthCheck();
    if (!startupHealth.connected) {
        log.error('DB health check failed at startup', undefined, { latency_ms: startupHealth.latency_ms });
        process.exit(1);
    }
    log.info('DB health check passed', {
        latency_ms: startupHealth.latency_ms,
        extensions: startupHealth.extensions,
    });
    if (!startupHealth.extensions.pg_trgm) {
        log.warn(
            'pg_trgm extension is missing — homolog similarity searches will fail. ' +
            'Install it with: CREATE EXTENSION IF NOT EXISTS pg_trgm;'
        );
    }

    // Periodic health logging — detect DB issues between tool calls
    const DB_HEALTH_CHECK_INTERVAL_MS = 60_000; // 1 minute
    healthCheckTimerRef = setInterval(async () => {
        try {
            const h = await db.healthCheck();
            if (!h.connected) {
                log.error('DB health check FAILED', undefined, { details: h });
            }
        } catch (err) {
            log.error('DB health check threw', err instanceof Error ? err : new Error(String(err)));
        }
    }, DB_HEALTH_CHECK_INTERVAL_MS);
    healthCheckTimerRef.unref();

    const transport = new StdioServerTransport();

    // Handle transport-level errors
    transport.onerror = (error: Error) => {
        log.error('MCP transport error', error);
    };

    try {
        await server.connect(transport);
        log.info('MCP bridge connected and ready', {
            server: SERVER_NAME,
            version: SERVER_VERSION,
            tools_registered: toolsRegistered,
        });
    } catch (err: unknown) {
        log.error('Failed to start MCP bridge', err);
        process.exit(1);
    }
}

// ────────── Graceful Shutdown ──────────

const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 10_000; // 10 seconds
let shutdownInProgress = false;

async function shutdown(signal: string): Promise<void> {
    if (shutdownInProgress) {
        log.warn(`Duplicate shutdown signal (${signal}) ignored — shutdown already in progress`);
        return;
    }
    shutdownInProgress = true;
    const forceExitTimer = setTimeout(() => {
        log.error('Graceful shutdown timed out, forcing exit');
        process.exit(1);
    }, GRACEFUL_SHUTDOWN_TIMEOUT_MS);
    forceExitTimer.unref();

    log.info(`Received ${signal}, shutting down MCP bridge`);

    // Clear periodic timers
    if (healthCheckTimerRef) {
        clearInterval(healthCheckTimerRef);
        healthCheckTimerRef = null;
    }

    try {
        await server.close();
    } catch (err: unknown) {
        log.error('Error during MCP server close', err);
    }

    // Destroy in-process caches
    destroyAllCaches();

    // Close DB connections
    try {
        await db.close();
    } catch (err) {
        log.warn('DB close failed during shutdown', { error: err instanceof Error ? err.message : String(err) });
    }

    log.info('MCP bridge shutdown complete');
    process.exit(0);
}

process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
process.on('SIGINT', () => { void shutdown('SIGINT'); });

// Prevent unhandled rejections from crashing the process
process.on('unhandledRejection', (reason: unknown) => {
    log.error('Unhandled promise rejection', reason instanceof Error ? reason : new Error(String(reason)));
    void shutdown('unhandledRejection');
});

process.on('uncaughtException', (err: Error) => {
    log.error('Uncaught exception — initiating emergency shutdown', err);
    // Attempt cleanup even on uncaught exceptions to avoid resource leaks
    const emergencyTimer = setTimeout(() => process.exit(1), 3_000);
    emergencyTimer.unref();
    void shutdown('uncaughtException');
});

// Start the server
main().catch((err: unknown) => {
    log.error('Fatal error in main', err instanceof Error ? err : new Error(String(err)));
    process.exit(1);
});
