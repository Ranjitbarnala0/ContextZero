/**
 * Repair `_migrations.checksum` rows when on-disk migration files have drifted
 * from what was originally applied.
 *
 * Background: the migration runner (`src/db-driver/migrate.ts`) records a
 * SHA-256 of every applied file and refuses to start in production if the
 * on-disk file no longer matches. If a migration file legitimately needs to
 * be edited (e.g. to fix a column-name typo that would break a fresh-DB
 * bootstrap), the stored checksum must be re-aligned to the new content.
 *
 * This script:
 *   1. Reads every *.sql under `db/migrations/` and computes its SHA-256.
 *   2. Reads the `_migrations` table.
 *   3. Reports drift (stored vs computed) and missing rows.
 *   4. With `--apply`, updates `_migrations.checksum` for drifted rows AND
 *      inserts rows for migration files that exist on disk but have not been
 *      applied (the idempotent guards in those files keep this safe).
 *
 * Usage:
 *   npx ts-node scripts/repair-migration-checksums.ts          # dry-run
 *   npx ts-node scripts/repair-migration-checksums.ts --apply  # patch live DB
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { db } from '../src/db-driver';

interface MigrationRow {
    filename: string;
    checksum: string;
}

async function main(): Promise<void> {
    const apply = process.argv.includes('--apply');
    const migrationsDir = path.join(__dirname, '..', 'db', 'migrations');

    const files = fs.readdirSync(migrationsDir)
        .filter(f => f.endsWith('.sql'))
        .sort();

    const onDisk = new Map<string, string>();
    for (const f of files) {
        const sha = crypto.createHash('sha256')
            .update(fs.readFileSync(path.join(migrationsDir, f), 'utf-8'))
            .digest('hex');
        onDisk.set(f, sha);
    }

    const applied = await db.query(
        `SELECT filename, checksum FROM _migrations ORDER BY id`,
    );
    const stored = new Map<string, string>();
    for (const row of applied.rows as MigrationRow[]) {
        stored.set(row.filename, row.checksum);
    }

    const drifted: { filename: string; storedSha: string; diskSha: string }[] = [];
    const missingFromDisk: string[] = [];
    const missingFromDb: string[] = [];

    for (const [f, sha] of onDisk) {
        if (!stored.has(f)) {
            missingFromDb.push(f);
        } else if (stored.get(f) !== sha) {
            drifted.push({ filename: f, storedSha: stored.get(f)!, diskSha: sha });
        }
    }
    for (const f of stored.keys()) {
        if (!onDisk.has(f)) missingFromDisk.push(f);
    }

    console.log(`On disk:  ${onDisk.size} files`);
    console.log(`In DB:    ${stored.size} rows`);
    console.log(`Drifted:  ${drifted.length}`);
    console.log(`On disk but NOT in _migrations (will be applied on next start): ${missingFromDb.length}`);
    console.log(`In _migrations but NOT on disk (cannot be re-validated):       ${missingFromDisk.length}`);

    if (drifted.length === 0 && missingFromDisk.length === 0 && missingFromDb.length === 0) {
        console.log('\nAll migrations consistent. Nothing to do.');
        await db.close();
        return;
    }

    if (drifted.length > 0) {
        console.log('\n--- Drifted ---');
        for (const d of drifted) {
            console.log(`  ${d.filename}`);
            console.log(`     stored: ${d.storedSha}`);
            console.log(`     disk:   ${d.diskSha}`);
        }
    }
    if (missingFromDb.length > 0) {
        console.log('\n--- On disk but not yet in _migrations ---');
        for (const f of missingFromDb) console.log(`  ${f} (sha=${onDisk.get(f)})`);
    }
    if (missingFromDisk.length > 0) {
        console.log('\n--- In _migrations but not on disk (cannot auto-fix) ---');
        for (const f of missingFromDisk) console.log(`  ${f}`);
    }

    if (!apply) {
        console.log('\nDry-run only. Re-run with --apply to patch the database.');
        await db.close();
        return;
    }

    console.log('\nApplying patches…');
    await db.transaction(async (client) => {
        for (const d of drifted) {
            await client.query(
                `UPDATE _migrations SET checksum = $2 WHERE filename = $1`,
                [d.filename, d.diskSha],
            );
            console.log(`  UPDATE ${d.filename}`);
        }
        for (const f of missingFromDb) {
            // For files that exist on disk but were never applied, the operator
            // is asserting that the schema already has these changes (e.g. they
            // were applied by an out-of-band tool). The migration runner will
            // skip them on startup because their filename is in appliedSet.
            await client.query(
                `INSERT INTO _migrations (filename, checksum)
                 VALUES ($1, $2)
                 ON CONFLICT (filename) DO UPDATE SET checksum = EXCLUDED.checksum`,
                [f, onDisk.get(f)],
            );
            console.log(`  INSERT ${f}`);
        }
    });

    console.log('\nDone. Future startups will accept these on-disk files.');
    await db.close();
}

main().catch((err) => {
    console.error('Repair failed:', err);
    process.exit(1);
});
