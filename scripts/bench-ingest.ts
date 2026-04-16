/**
 * Benchmark: Ingest a repo and print timing + counts.
 * Usage: ts-node scripts/bench-ingest.ts <repo_path> <repo_name>
 */
import * as path from 'path';
import { execSync } from 'child_process';
import { coreDataService } from '../src/db-driver/core_data';
import { ingestor } from '../src/ingestor';
import { db } from '../src/db-driver';

async function main() {
    const repoPath = path.resolve(process.argv[2] || process.cwd());
    const repoName = process.argv[3] || path.basename(repoPath) + '-bench-' + Date.now();

    let commitSha = 'bench0000000000000000000000000000000000';
    let branch = 'main';
    try {
        commitSha = execSync('git rev-parse HEAD', { cwd: repoPath }).toString().trim();
        branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: repoPath }).toString().trim();
    } catch {
        // non-git or not resolvable — keep defaults
    }

    console.log(`[bench] repo_path=${repoPath}`);
    console.log(`[bench] repo_name=${repoName}`);
    console.log(`[bench] commit_sha=${commitSha}  branch=${branch}`);

    const repoId = await coreDataService.createRepository({
        name: repoName,
        default_branch: branch,
        visibility: 'private',
        language_set: [],
        base_path: repoPath,
    });
    console.log(`[bench] repo_id=${repoId}`);

    const t0 = Date.now();
    const result = await ingestor.ingestRepo(repoPath, repoName, commitSha, branch);
    const elapsedMs = Date.now() - t0;

    console.log('\n========== INGESTION RESULT ==========');
    console.log(JSON.stringify(result, null, 2));
    console.log(`\n[bench] elapsed_ms=${elapsedMs}  elapsed_s=${(elapsedMs / 1000).toFixed(2)}`);

    // Snapshot-level counts from DB
    const snapshotId = (result as any).snapshot_id;
    if (snapshotId) {
        const q = async (sql: string) => (await db.query(sql, [snapshotId])).rows[0].count;
        const files = await q('SELECT COUNT(*)::int AS count FROM files WHERE snapshot_id=$1');
        const symbols = await q('SELECT COUNT(*)::int AS count FROM symbol_versions sv JOIN files f ON f.file_id=sv.file_id WHERE f.snapshot_id=$1');
        const relations = await q(`SELECT COUNT(*)::int AS count FROM inferred_relations ir
            JOIN symbol_versions sv ON sv.symbol_version_id = ir.src_symbol_version_id
            JOIN files f ON f.file_id = sv.file_id
            WHERE f.snapshot_id = $1`);
        const lineages = await q('SELECT COUNT(DISTINCT lineage_id)::int AS count FROM symbols s JOIN symbol_versions sv ON sv.symbol_id=s.symbol_id JOIN files f ON f.file_id=sv.file_id WHERE f.snapshot_id=$1 AND s.lineage_id IS NOT NULL');
        console.log(`[bench] files_in_snapshot=${files}`);
        console.log(`[bench] symbols_in_snapshot=${symbols}`);
        console.log(`[bench] relations_in_snapshot=${relations}`);
        console.log(`[bench] lineages_linked=${lineages}`);
    }

    await db.close();
}

main().catch(e => {
    console.error('[bench] FAILED:', e);
    process.exit(1);
});
