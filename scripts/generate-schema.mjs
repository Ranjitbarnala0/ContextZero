import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDir = path.join(repoRoot, 'db', 'migrations');
const outputPath = path.join(repoRoot, 'db', 'schema.sql');

const files = fs.readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .sort();

/**
 * Track tables dropped by later migrations so we can omit their
 * CREATE TABLE blocks from the consolidated schema output.
 *
 * We do two passes:
 *   1. Scan all migrations for DROP TABLE statements to build a drop set.
 *   2. Emit each migration's SQL, filtering out CREATE TABLE blocks for
 *      tables that were subsequently dropped.
 */
const droppedTables = new Set();

// ── Pass 1: collect dropped table names ──
for (const file of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
    // Match: DROP TABLE [IF EXISTS] <name>
    const dropPattern = /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(\w+)/gi;
    let match;
    while ((match = dropPattern.exec(sql)) !== null) {
        droppedTables.add(match[1].toLowerCase());
    }
}

// ── Pass 2: emit filtered SQL ──
const sections = [
    '-- ContextZero Database Schema',
    '-- Generated from db/migrations/*.sql. Do not hand-edit.',
    `-- Generated at ${new Date().toISOString()}`,
    `-- Dropped tables excluded: ${droppedTables.size > 0 ? [...droppedTables].join(', ') : 'none'}`,
];

for (const file of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8').trimEnd();

    // Filter out CREATE TABLE blocks for tables that were later dropped.
    // This handles both single-line and multi-line CREATE TABLE statements.
    let filtered = sql;
    for (const tableName of droppedTables) {
        // Match CREATE TABLE [IF NOT EXISTS] <tableName> ( ... ); across multiple lines
        const createPattern = new RegExp(
            `CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${tableName}\\s*\\([^;]*\\);`,
            'gis'
        );
        filtered = filtered.replace(createPattern, `-- [omitted] CREATE TABLE ${tableName} — dropped by later migration`);

        // Also filter out CREATE INDEX / CREATE UNIQUE INDEX on dropped tables
        const indexPattern = new RegExp(
            `CREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?\\w+\\s+ON\\s+${tableName}\\b[^;]*;`,
            'gis'
        );
        filtered = filtered.replace(indexPattern, `-- [omitted] index on ${tableName} — table dropped`);
    }

    // Skip the DROP TABLE migration lines themselves (they're already reflected by the omission)
    // but keep the migration marker for reference
    sections.push(`\n-- >>> ${file}\n`);
    sections.push(filtered);
}

fs.writeFileSync(outputPath, sections.join('\n') + '\n', 'utf-8');
console.log(`Schema written to ${outputPath} (${droppedTables.size} dropped table(s) excluded)`);
