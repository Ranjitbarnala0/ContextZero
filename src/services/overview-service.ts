/**
 * ContextZero — Overview Service
 *
 * Shared business logic for codebase overview generation.
 * Runs the 5 SQL queries that summarize a snapshot's structure, behavior, tests, and risk.
 * Used by both the REST API and MCP bridge handlers.
 */

import { db } from '../db-driver';
import { uncertaintyTracker } from '../analysis-engine/uncertainty';

// ────────── Result Types ──────────

export interface RiskySymbol {
    name: string;
    kind: string;
    file: string;
    purity: string;
    risks: string[];
}

export interface CodebaseOverview {
    summary: {
        total_files: number;
        total_symbols: number;
        languages: Record<string, number>;
        directories: [string, number][];
    };
    symbols: {
        by_kind: Record<string, number>;
        public_api_count: number;
        entry_points: string[];
    };
    behavioral_profile: {
        purity_distribution: Record<string, number>;
        profiled_count?: number;
        high_risk_symbols: RiskySymbol[];
    };
    test_coverage: {
        symbols_tested: number;
        symbols_total: number;
        coverage_percent: string;
    };
    uncertainty: {
        overall_confidence: number;
        total_annotations: number;
        by_source: Record<string, number>;
        most_uncertain: unknown[];
    };
}

// ────────── Service Function ──────────

/**
 * Build a comprehensive codebase overview for a snapshot.
 * Aggregates file structure, symbol kinds, behavioral profiles,
 * test coverage, and uncertainty into a single result.
 */
export async function getCodebaseOverview(snapshotId: string): Promise<CodebaseOverview> {
    // 1. File structure summary — use GROUP BY to count in the database
    const [langResult, pathResult] = await Promise.all([
        db.query(
            `SELECT language, COUNT(*) as count FROM files WHERE snapshot_id = $1 GROUP BY language`,
            [snapshotId],
        ),
        db.query(
            `SELECT path FROM files WHERE snapshot_id = $1`,
            [snapshotId],
        ),
    ]);

    const langCounts: Record<string, number> = {};
    let totalFiles = 0;
    for (const row of langResult.rows as { language: string | null; count: string }[]) {
        const lang = row.language || 'unknown';
        const count = parseInt(row.count, 10);
        langCounts[lang] = Number.isFinite(count) ? count : 0;
        totalFiles += Number.isFinite(count) ? count : 0;
    }

    const dirCounts: Record<string, number> = {};
    for (const row of (pathResult?.rows ?? []) as { path: string }[]) {
        if (!row?.path) continue;
        const dir = row.path.split('/').slice(0, -1).join('/') || '.';
        dirCounts[dir] = (dirCounts[dir] || 0) + 1;
    }

    // 2. Symbol summary — count by kind in DB, load public symbols separately
    const [kindResult, totalSymbolResult, publicResult] = await Promise.all([
        db.query(`
            SELECT s.kind, COUNT(*) as count
            FROM symbol_versions sv
            JOIN symbols s ON s.symbol_id = sv.symbol_id
            WHERE sv.snapshot_id = $1
            GROUP BY s.kind
        `, [snapshotId]),
        db.query(`
            SELECT COUNT(*) as count
            FROM symbol_versions sv
            WHERE sv.snapshot_id = $1
        `, [snapshotId]),
        db.query(`
            SELECT s.kind, s.canonical_name, f.path as file_path
            FROM symbol_versions sv
            JOIN symbols s ON s.symbol_id = sv.symbol_id
            JOIN files f ON f.file_id = sv.file_id
            WHERE sv.snapshot_id = $1 AND sv.visibility = 'public'
            ORDER BY s.kind, s.canonical_name
            LIMIT 30
        `, [snapshotId]),
    ]);

    const kindCounts: Record<string, number> = {};
    for (const row of kindResult.rows as { kind: string; count: string }[]) {
        const count = parseInt(row.count, 10);
        kindCounts[row.kind] = Number.isFinite(count) ? count : 0;
    }

    const rawTotalSymbols = parseInt((totalSymbolResult.rows[0] as { count: string })?.count || '0', 10);
    const totalSymbols = Number.isFinite(rawTotalSymbols) ? rawTotalSymbols : 0;

    const publicSymbols: string[] = (publicResult.rows as { kind: string; canonical_name: string; file_path: string }[])
        .map(s => `${s.kind}:${s.canonical_name} (${s.file_path})`);

    // 3. Behavioral risk - purity distribution
    const behaviorResult = await db.query(`
        SELECT bp.purity_class, COUNT(*) as cnt
        FROM behavioral_profiles bp
        JOIN symbol_versions sv ON sv.symbol_version_id = bp.symbol_version_id
        WHERE sv.snapshot_id = $1
        GROUP BY bp.purity_class
    `, [snapshotId]);
    const purityDist = Object.fromEntries(
        ((behaviorResult?.rows ?? []) as { purity_class: string; cnt: string }[])
            .map(r => {
                const count = parseInt(r.cnt, 10);
                return [r.purity_class, Number.isFinite(count) ? count : 0];
            }),
    );

    // High-risk symbols
    const riskyResult = await db.query(`
        SELECT s.canonical_name, s.kind, f.path, bp.purity_class,
               bp.network_calls, bp.db_writes, bp.file_io
        FROM behavioral_profiles bp
        JOIN symbol_versions sv ON sv.symbol_version_id = bp.symbol_version_id
        JOIN symbols s ON s.symbol_id = sv.symbol_id
        JOIN files f ON f.file_id = sv.file_id
        WHERE sv.snapshot_id = $1
        AND bp.purity_class IN ('side_effecting', 'read_write')
        AND (array_length(bp.network_calls, 1) > 0
             OR array_length(bp.db_writes, 1) > 0
             OR array_length(bp.file_io, 1) > 0)
        LIMIT 30
    `, [snapshotId]);

    const riskySymbols: RiskySymbol[] = ((riskyResult?.rows ?? []) as Record<string, unknown>[]).map(r => ({
        name: (r.canonical_name as string) ?? '',
        kind: (r.kind as string) ?? 'unknown',
        file: (r.path as string) ?? '',
        purity: (r.purity_class as string) ?? 'unknown',
        risks: [
            ...(Array.isArray(r.network_calls) ? r.network_calls : []).map((c: string) => `network:${c}`),
            ...(Array.isArray(r.db_writes) ? r.db_writes : []).map((c: string) => `db_write:${c}`),
            ...(Array.isArray(r.file_io) ? r.file_io : []).map((c: string) => `file_io:${c}`),
        ],
    }));

    // 4. Test coverage
    const testResult = await db.query(`
        SELECT COUNT(DISTINCT ta.symbol_version_id) as tested
        FROM test_artifacts ta
        JOIN symbol_versions sv ON sv.symbol_version_id = ta.symbol_version_id
        WHERE sv.snapshot_id = $1
    `, [snapshotId]);
    const rawTested = parseInt((testResult?.rows?.[0] as { tested: string } | undefined)?.tested || '0', 10);
    const testedCount = Number.isFinite(rawTested) ? rawTested : 0;

    // 5. Uncertainty
    const uncertainty = await uncertaintyTracker.getSnapshotUncertainty(snapshotId);

    return {
        summary: {
            total_files: totalFiles,
            total_symbols: totalSymbols,
            languages: langCounts,
            directories: Object.entries(dirCounts).sort((a, b) => b[1] - a[1]).slice(0, 20),
        },
        symbols: {
            by_kind: kindCounts,
            public_api_count: publicSymbols.length,
            entry_points: publicSymbols.slice(0, 30),
        },
        behavioral_profile: {
            purity_distribution: purityDist,
            profiled_count: Object.values(purityDist).reduce((a, b) => a + b, 0),
            high_risk_symbols: riskySymbols,
        },
        test_coverage: {
            symbols_tested: testedCount,
            symbols_total: totalSymbols,
            coverage_percent: totalSymbols > 0
                ? ((testedCount / totalSymbols) * 100).toFixed(1) + '%'
                : '0%',
        },
        uncertainty: {
            overall_confidence: uncertainty.overall_confidence,
            total_annotations: uncertainty.total_annotations,
            by_source: uncertainty.by_source,
            most_uncertain: uncertainty.most_uncertain_symbols.slice(0, 10),
        },
    };
}
