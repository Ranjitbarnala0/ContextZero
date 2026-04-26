import * as fs from 'fs';
import * as path from 'path';
import { db } from '../src/db-driver';

(async () => {
    const dir = '/home/mani/knowledge/contextzero/db/migrations';
    for (const f of ['014_retention_and_lifecycle.sql', '015_temporal_and_retention_indexes.sql', '016_widen_commit_sha.sql', '017_add_snapshots_created_at.sql']) {
        const sql = fs.readFileSync(path.join(dir, f), 'utf-8');
        try {
            await db.query(sql);
            console.log(`OK   ${f}`);
        } catch (err) {
            console.error(`FAIL ${f}: ${(err as Error).message}`);
        }
    }
    await db.close();
})().catch((e) => { console.error(e); process.exit(1); });
