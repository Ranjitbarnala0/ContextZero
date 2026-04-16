/**
 * Benchmark: Compile a context capsule for a representative symbol
 * and measure token budget, nodes included, and feature coverage.
 *
 * Shows the concrete value of the lineage + temporal fixes: those
 * engines feed into capsule compilation, so when they were silently
 * returning 0 rows, capsules were strictly less informative at the
 * same token budget.
 */
import { capsuleCompiler } from '../src/analysis-engine/capsule-compiler';
import { db } from '../src/db-driver';

const SNAPSHOT_NAME = process.argv[2] || 'ContextZero-bench';

async function pickTarget(snapshotId: string): Promise<string> {
    const res = await db.query(`
        SELECT sv.symbol_version_id
        FROM symbol_versions sv
        JOIN symbols s ON s.symbol_id = sv.symbol_id
        JOIN files f ON f.file_id = sv.file_id
        WHERE f.snapshot_id = $1
          AND s.kind IN ('function', 'method')
        ORDER BY LENGTH(COALESCE(sv.body_source, '')) DESC
        LIMIT 1
    `, [snapshotId]);
    return (res.rows[0] as { symbol_version_id: string }).symbol_version_id;
}

async function bench(mode: 'minimal' | 'standard' | 'strict', target: string, snapshotId: string) {
    const t0 = Date.now();
    const capsule = await capsuleCompiler.compile(target, snapshotId, mode);
    const elapsedMs = Date.now() - t0;
    const json = JSON.stringify(capsule);
    // Rough token estimate: 1 token ~= 4 chars for typical English + code.
    const tokenEstimate = Math.round(json.length / 4);

    const nodeCount = (capsule as any).nodes?.length ?? 0;
    const lineageHits = (capsule as any).nodes?.filter((n: any) => n.lineage_id)?.length ?? 0;
    const coChangeHits = (capsule as any).nodes?.filter((n: any) =>
        Array.isArray(n.inbound_edges) &&
        n.inbound_edges.some((e: any) => e.relation_type === 'co_changed_with')
    )?.length ?? 0;

    return { mode, elapsedMs, byteSize: json.length, tokenEstimate, nodeCount, lineageHits, coChangeHits };
}

async function main() {
    const snapRes = await db.query(`
        SELECT s.snapshot_id FROM snapshots s JOIN repositories r ON r.repo_id = s.repo_id
        WHERE r.name LIKE $1 ORDER BY s.indexed_at DESC LIMIT 1
    `, [`${SNAPSHOT_NAME}%`]);
    if (snapRes.rowCount === 0) {
        console.error(`No snapshot found for repo matching "${SNAPSHOT_NAME}%"`);
        process.exit(1);
    }
    const snapshotId = (snapRes.rows[0] as { snapshot_id: string }).snapshot_id;
    console.log(`[bench] snapshot_id=${snapshotId}`);

    const target = await pickTarget(snapshotId);
    console.log(`[bench] target_symbol_version_id=${target}`);

    const results = [];
    for (const mode of ['minimal', 'standard', 'strict'] as const) {
        const r = await bench(mode, target, snapshotId);
        results.push(r);
        console.log(`[bench] ${mode.padEnd(8)}  ${r.elapsedMs}ms  nodes=${r.nodeCount}  bytes=${r.byteSize}  ~${r.tokenEstimate} tokens  lineage_covered=${r.lineageHits}  co_change_covered=${r.coChangeHits}`);
    }

    console.log('\n========== SUMMARY ==========');
    console.table(results);

    await db.close();
}

main().catch(e => { console.error(e); process.exit(1); });
