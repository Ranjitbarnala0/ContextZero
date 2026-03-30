/**
 * ContextZero — Repository Service
 *
 * Shared business logic for repository and snapshot listing.
 * Used by both the REST API and MCP bridge handlers.
 */

import { db } from '../db-driver';

// ────────── Result Types ──────────

export interface ListReposResult {
    repositories: Record<string, unknown>[];
    count: number;
}

export interface ListSnapshotsResult {
    snapshots: Record<string, unknown>[];
    count: number;
}

// ────────── Service Functions ──────────

/**
 * List all repositories, ordered by most recently updated.
 */
export async function listRepos(
    limit: number = 20,
    offset: number = 0,
): Promise<ListReposResult> {
    const result = await db.query(
        `SELECT * FROM repositories ORDER BY updated_at DESC LIMIT $1 OFFSET $2`,
        [limit, offset],
    );
    return { repositories: result.rows as Record<string, unknown>[], count: result.rowCount ?? 0 };
}

/**
 * List snapshots for a repository, ordered by most recently indexed.
 */
export async function listSnapshots(
    repoId: string,
    limit: number = 20,
    offset: number = 0,
): Promise<ListSnapshotsResult> {
    const result = await db.query(`
        SELECT * FROM snapshots
        WHERE repo_id = $1
        ORDER BY indexed_at DESC
        LIMIT $2 OFFSET $3
    `, [repoId, limit, offset]);
    return { snapshots: result.rows as Record<string, unknown>[], count: result.rowCount ?? 0 };
}
