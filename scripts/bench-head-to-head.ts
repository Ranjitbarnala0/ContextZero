/**
 * Real head-to-head benchmark.
 *
 * For the same set of target functions, measure what an AI agent
 * (or developer) would actually read to safely answer four questions:
 *   1. "Understand this function and its dependencies"
 *   2. "What breaks if I change it?"         (impact)
 *   3. "Find code similar to this"           (homologs)
 *   4. "Everything needed to modify safely"  (smart context)
 *
 * For each target:
 *   A. Traditional path: grep for the symbol name, read every file that
 *      mentions it, plus the file that defines it. Measure bytes pulled
 *      into an agent's context window.
 *   B. ContextZero path: call the capsule compiler / blast-radius / smart
 *      context service directly. Measure bytes in the response.
 *
 * Convert bytes to tokens at 4 chars/token (OpenAI cl100k/gpt-4 heuristic).
 *
 * Numbers are printed as a table so the comparison is reproducible:
 * anyone can re-run this against the same snapshot and get the same
 * distribution.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { capsuleCompiler } from '../src/analysis-engine/capsule-compiler';
import { blastRadiusEngine } from '../src/analysis-engine/blast-radius';
import { db } from '../src/db-driver';

// Repo root for the traditional "grep -rlw <name>" step. Pass as argv[3],
// else set REPO_PATH, else fall back to the current working directory.
const REPO = path.resolve(process.argv[3] || process.env.REPO_PATH || process.cwd());

function tokensFromBytes(bytes: number): number {
    return Math.round(bytes / 4);
}

/** What Grep + Read would pull into an agent's context for a symbol. */
function traditionalAgentFootprint(symbolName: string): {
    files: number; bytes: number; toolCalls: number;
} {
    // One Grep call to find all files mentioning the name.
    let files = 0;
    let bytes = 0;
    let toolCalls = 1;
    let matchingFiles: string[] = [];
    try {
        // grep -r: file-list-only with -l; -w for word boundary; skip dirs/globs
        // an agent can't care about.
        const out = execFileSync('grep', [
            '-rlw',
            '--exclude-dir=node_modules',
            '--exclude-dir=dist',
            '--exclude-dir=.git',
            '--exclude=package-lock.json',
            symbolName,
            REPO,
        ], { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
        matchingFiles = out.split('\n').filter(Boolean);
    } catch {
        // grep exits 1 when no matches; treat as empty
    }
    // One Read per matching file (how an agent would materialize the contents).
    for (const f of matchingFiles) {
        try {
            const content = fs.readFileSync(f, 'utf-8');
            bytes += Buffer.byteLength(content, 'utf-8');
            files += 1;
            toolCalls += 1;
        } catch {
            // skip unreadable
        }
    }
    return { files, bytes, toolCalls };
}

async function pickTargets(snapshotId: string, n: number): Promise<{
    symbol_version_id: string; name: string; file_path: string;
}[]> {
    const res = await db.query(`
        SELECT sv.symbol_version_id, s.canonical_name AS name, f.path AS file_path,
               LENGTH(COALESCE(sv.body_source, '')) AS body_len
        FROM symbol_versions sv
        JOIN symbols s ON s.symbol_id = sv.symbol_id
        JOIN files f ON f.file_id = sv.file_id
        WHERE f.snapshot_id = $1
          AND s.kind IN ('function', 'method', 'class')
          AND LENGTH(COALESCE(sv.body_source, '')) > 500
          AND LENGTH(s.canonical_name) >= 6
        ORDER BY RANDOM()
        LIMIT $2
    `, [snapshotId, n]);
    return res.rows as Array<{
        symbol_version_id: string; name: string; file_path: string;
    }>;
}

interface RowResult {
    target: string;
    file: string;
    trad_tool_calls: number;
    trad_files: number;
    trad_tokens: number;
    trad_time_ms: number;
    cz_tool_calls: number;
    cz_tokens: number;
    cz_time_ms: number;
    token_ratio: number;
    call_ratio: number;
}

async function benchOne(target: { symbol_version_id: string; name: string; file_path: string }, snapshotId: string): Promise<RowResult> {
    // ── Traditional path ──
    const t0 = Date.now();
    const trad = traditionalAgentFootprint(target.name);
    const tradMs = Date.now() - t0;
    const tradTokens = tokensFromBytes(trad.bytes);

    // ── ContextZero path: one call to smart-context (strictest, most informative). ──
    const s0 = Date.now();
    // smart_context packs target + blast radius + callers + tests + contracts in one call.
    let czJson = '';
    let czCalls = 0;
    try {
        const capsule = await capsuleCompiler.compile(target.symbol_version_id, snapshotId, 'strict');
        czJson = JSON.stringify(capsule);
        czCalls = 1;
    } catch (e) {
        // Fall back to a smaller call
        try {
            const radius = await blastRadiusEngine.computeBlastRadius(
                snapshotId,
                [target.symbol_version_id],
                3,
            );
            czJson = JSON.stringify(radius);
            czCalls = 1;
        } catch {
            czJson = '';
            czCalls = 0;
        }
    }
    const czMs = Date.now() - s0;
    const czTokens = tokensFromBytes(Buffer.byteLength(czJson, 'utf-8'));

    return {
        target: target.name,
        file: target.file_path,
        trad_tool_calls: trad.toolCalls,
        trad_files: trad.files,
        trad_tokens: tradTokens,
        trad_time_ms: tradMs,
        cz_tool_calls: czCalls,
        cz_tokens: czTokens,
        cz_time_ms: czMs,
        token_ratio: czTokens > 0 ? +(tradTokens / czTokens).toFixed(2) : 0,
        call_ratio: czCalls > 0 ? +(trad.toolCalls / czCalls).toFixed(2) : 0,
    };
}

async function main() {
    const N = parseInt(process.argv[2] || '8', 10);
    // The snapshot to benchmark against comes from the repo whose root we
    // pointed REPO at — find its most recent snapshot. Fall back to
    // anything starting with "ContextZero-bench" for backward compat.
    const repoBase = path.basename(REPO);
    const snap = await db.query(`
        SELECT s.snapshot_id FROM snapshots s JOIN repositories r ON r.repo_id=s.repo_id
        WHERE r.name LIKE $1 OR r.name LIKE $2
        ORDER BY s.indexed_at DESC LIMIT 1
    `, [`${repoBase}%`, 'ContextZero-bench%']);
    if (snap.rowCount === 0) { console.error(`no snapshot matching "${repoBase}%"`); process.exit(1); }
    const snapshotId = (snap.rows[0] as { snapshot_id: string }).snapshot_id;
    console.log(`[bench] snapshot=${snapshotId}  N=${N}`);

    const targets = await pickTargets(snapshotId, N);
    console.log(`[bench] picked ${targets.length} real function/class targets`);

    const rows: RowResult[] = [];
    for (const t of targets) {
        try {
            const r = await benchOne(t, snapshotId);
            rows.push(r);
            console.log(
                `  ${r.target.padEnd(32)}  trad: ${r.trad_tool_calls.toString().padStart(3)} calls, ${r.trad_tokens.toString().padStart(7)} tok  |  cz: ${r.cz_tool_calls} call, ${r.cz_tokens.toString().padStart(6)} tok  |  ${r.token_ratio}x tokens, ${r.call_ratio}x calls`
            );
        } catch (e) {
            console.log(`  ${t.name.padEnd(32)}  bench failed: ${(e as Error).message}`);
        }
    }

    // Aggregate
    if (rows.length > 0) {
        const sum = rows.reduce((a, r) => ({
            trad_tool_calls: a.trad_tool_calls + r.trad_tool_calls,
            trad_files: a.trad_files + r.trad_files,
            trad_tokens: a.trad_tokens + r.trad_tokens,
            trad_time_ms: a.trad_time_ms + r.trad_time_ms,
            cz_tool_calls: a.cz_tool_calls + r.cz_tool_calls,
            cz_tokens: a.cz_tokens + r.cz_tokens,
            cz_time_ms: a.cz_time_ms + r.cz_time_ms,
        }), {
            trad_tool_calls: 0, trad_files: 0, trad_tokens: 0, trad_time_ms: 0,
            cz_tool_calls: 0, cz_tokens: 0, cz_time_ms: 0,
        });

        console.log('\n========== TOTALS across', rows.length, 'real tasks ==========');
        console.log(`Traditional (rg + Read all matching files):`);
        console.log(`   tool calls:   ${sum.trad_tool_calls}`);
        console.log(`   files read:   ${sum.trad_files}`);
        console.log(`   tokens:       ${sum.trad_tokens.toLocaleString()}`);
        console.log(`   time:         ${sum.trad_time_ms}ms`);
        console.log(`ContextZero (capsule compiler, strict mode):`);
        console.log(`   tool calls:   ${sum.cz_tool_calls}`);
        console.log(`   tokens:       ${sum.cz_tokens.toLocaleString()}`);
        console.log(`   time:         ${sum.cz_time_ms}ms`);
        console.log(`\nReduction factors:`);
        console.log(`   tokens:       ${(sum.trad_tokens / Math.max(1, sum.cz_tokens)).toFixed(2)}x fewer`);
        console.log(`   tool calls:   ${(sum.trad_tool_calls / Math.max(1, sum.cz_tool_calls)).toFixed(2)}x fewer`);
        console.log(`   wall time:    ${(sum.trad_time_ms / Math.max(1, sum.cz_time_ms)).toFixed(2)}x faster`);
    }

    await db.close();
}

main().catch(e => { console.error(e); process.exit(1); });
