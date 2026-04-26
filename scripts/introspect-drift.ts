import { db } from '../src/db-driver';

async function main() {
    const migrations = await db.query(
        `SELECT filename, checksum, applied_at FROM _migrations ORDER BY id`,
    );
    console.log('=== _migrations table ===');
    for (const row of migrations.rows as { filename: string; checksum: string; applied_at: string }[]) {
        console.log(`${row.filename}\t${row.checksum}\t${row.applied_at}`);
    }

    const tables = ['temporal_co_changes', 'temporal_risk_scores', 'runtime_observed_edges', 'snapshots'];
    for (const t of tables) {
        console.log(`\n=== columns ${t} ===`);
        const cols = await db.query(
            `SELECT column_name, data_type, character_maximum_length, is_nullable, column_default
             FROM information_schema.columns
             WHERE table_name = $1 AND table_schema = 'public'
             ORDER BY ordinal_position`,
            [t],
        );
        for (const row of cols.rows) console.log(JSON.stringify(row));
    }

    console.log('\n=== indexes on temporal/runtime/snapshots ===');
    const idx = await db.query(
        `SELECT tablename, indexname, indexdef
         FROM pg_indexes
         WHERE schemaname = 'public'
         AND tablename IN ('temporal_co_changes','temporal_risk_scores','runtime_observed_edges','snapshots','snapshot_versions','retention_policy_runs')
         ORDER BY tablename, indexname`,
    );
    for (const row of idx.rows) console.log(JSON.stringify(row));

    await db.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
