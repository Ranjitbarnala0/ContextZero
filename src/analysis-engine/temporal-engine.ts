/**
 * ContextZero — Temporal Intelligence Engine
 *
 * Mines git history to understand how code evolves over time.
 * Produces three outputs:
 *   1. Co-change pairs — symbols that change together (Jaccard similarity)
 *   2. Bug-fix hotspots — symbols that attract fixes, regressions, reverts
 *   3. Risk scores — composite per-symbol risk from change frequency,
 *      bug density, regression rate, churn, and ownership dispersion
 *
 * Security: all git commands use execFileSync with argument arrays —
 * never shell-interpolated strings.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';

const execFileAsync = promisify(execFile);
import { v4 as uuidv4 } from 'uuid';
import { db } from '../db-driver';
import { Logger } from '../logger';

const log = new Logger('temporal-engine');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single parsed git commit with its metadata and changed files. */
export interface GitCommit {
    hash: string;
    author_name: string;
    author_email: string;
    date: Date;
    subject: string;
    files: string[];
    is_bug_fix: boolean;
    is_revert: boolean;
    is_merge: boolean;
}

/** Top-level result returned by computeTemporalIntelligence. */
export interface TemporalResult {
    commits_mined: number;
    co_change_pairs: number;
    risk_scores_computed: number;
    duration_ms: number;
}

/** A row from temporal_risk_scores. */
export interface TemporalRiskScore {
    risk_id: string;
    repo_id: string;
    symbol_id: string;
    snapshot_id: string;
    change_frequency: number;
    bug_fix_count: number;
    regression_count: number;
    recent_churn_30d: number;
    distinct_authors: number;
    composite_risk: number;
    last_change_date: Date | null;
    computed_at: Date;
}

/** A co-change partner returned by getCoChangePartners. */
export interface CoChangePartner {
    symbol_id: string;
    canonical_name: string;
    co_change_count: number;
    jaccard_coefficient: number;
    last_co_change: Date | null;
}

/** Per-symbol accumulator used during risk computation. */
interface SymbolStats {
    total_changes: number;
    bug_fix_count: number;
    /** Dates of bug-fix commits (for regression detection). */
    bug_fix_dates: Date[];
    revert_count: number;
    regression_count: number;
    recent_churn_30d: number;
    authors: Set<string>;
    last_change_date: Date | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Regex patterns that indicate a bug-fix commit. */
const BUG_FIX_PATTERNS = [
    /\bfix(?:e[sd])?\b/i,
    /\bbug\b/i,
    /\bpatch\b/i,
    /\bhotfix\b/i,
    /\bresolve[sd]?\b/i,
    /\bclose[sd]?\s+#\d+/i,
    /\bregression\b/i,
];

/** Regex pattern for revert commits. */
const REVERT_PATTERN = /^revert\b/i;

/** Regex pattern for merge commits (subject line). */
const MERGE_PATTERN = /^Merge\s+(branch|pull\s+request|remote)/i;

/**
 * Minimum Jaccard coefficient to create a co_changed_with inferred_relation.
 * Pairs below this threshold are still stored in temporal_co_changes but
 * do not pollute the inferred_relations table.
 */
const CO_CHANGE_RELATION_JACCARD_THRESHOLD = 0.25;

/** Minimum co-change count to even consider a pair meaningful. */
const CO_CHANGE_MIN_COUNT = 2;

/** Window in days for detecting regressions (same symbol fixed twice). */
const REGRESSION_WINDOW_DAYS = 30;

/** Risk weight vector — sums to 1.0. */
const RISK_WEIGHTS = {
    change_frequency: 0.25,
    bug_fix_count: 0.30,
    regression_count: 0.20,
    recent_churn_30d: 0.15,
    distinct_authors: 0.10,
} as const;

/** Maximum commits to mine by default (prevents unbounded git log). */
const DEFAULT_MAX_COMMITS = 5000;

/** Batch size for DB inserts. */
const DB_BATCH_SIZE = 500;

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export class TemporalEngine {

    // -------------------------------------------------------------------
    // Public API
    // -------------------------------------------------------------------

    /**
     * Mine git history and compute all temporal intelligence for a repository.
     *
     * Orchestration:
     *   1. Mine git log -> GitCommit[]
     *   2. Compute co-change pairs -> temporal_co_changes + inferred_relations
     *   3. Compute risk scores -> temporal_risk_scores
     */
    public async computeTemporalIntelligence(
        repoId: string,
        snapshotId: string,
        repoBasePath: string
    ): Promise<TemporalResult> {
        const timer = log.startTimer('computeTemporalIntelligence', { repoId, snapshotId });
        const startMs = Date.now();

        const commits = await this.mineGitHistory(repoBasePath);

        if (commits.length === 0) {
            log.info('No commits found — skipping temporal analysis', { repoBasePath });
            const result: TemporalResult = {
                commits_mined: 0,
                co_change_pairs: 0,
                risk_scores_computed: 0,
                duration_ms: Date.now() - startMs,
            };
            timer({ ...result });
            return result;
        }

        // Pre-compute the file→symbol map once for both engines to avoid duplicate DB queries
        const fileToSymbols = await this.resolveFileSymbolMap(repoId, snapshotId);

        const [coChangePairs, riskScores] = await Promise.all([
            this.computeCoChanges(repoId, snapshotId, commits, fileToSymbols),
            this.computeRiskScores(repoId, snapshotId, commits, fileToSymbols),
        ]);

        const result: TemporalResult = {
            commits_mined: commits.length,
            co_change_pairs: coChangePairs,
            risk_scores_computed: riskScores,
            duration_ms: Date.now() - startMs,
        };

        timer({ ...result });
        return result;
    }

    /**
     * Mine the git log of a repository into structured commit objects.
     *
     * Uses `git log --pretty=format:... --name-only` which outputs:
     *   <hash>|<author>|<email>|<date>|<subject>
     *   file1
     *   file2
     *   <blank line>
     *   <next commit header>
     *   ...
     */
    public async mineGitHistory(
        repoBasePath: string,
        maxCommits: number = DEFAULT_MAX_COMMITS
    ): Promise<GitCommit[]> {
        const timer = log.startTimer('mineGitHistory', { repoBasePath, maxCommits });

        // Pre-check: skip non-git directories instead of crashing
        if (!fs.existsSync(path.join(repoBasePath, '.git'))) {
            log.info('Not a git repository — skipping git history mining', { repoBasePath });
            timer({ commits: 0 });
            return [];
        }

        let raw: string;
        try {
            const result = await execFileAsync('git', [
                'log',
                `--max-count=${maxCommits}`,
                '--pretty=format:%H|%an|%ae|%ad|%s',
                '--date=iso',
                '--name-only',
                '--diff-filter=ACDMRT',    // exclude renames-only noise
            ], {
                cwd: repoBasePath,
                encoding: 'utf-8',
                maxBuffer: 100 * 1024 * 1024,  // 100 MB
                timeout: 120_000,               // 2 minutes
            });
            raw = result.stdout;
        } catch (err) {
            // Empty repo or not a git repo — return empty
            const message = err instanceof Error ? err.message : String(err);
            if (message.includes('does not have any commits') ||
                message.includes('not a git repository') ||
                message.includes('bad default revision')) {
                log.debug('Git log returned no data', { repoBasePath, error: message });
                timer({ commits: 0 });
                return [];
            }
            throw err;
        }

        if (!raw || raw.trim().length === 0) {
            timer({ commits: 0 });
            return [];
        }

        const commits = this.parseGitLog(raw);
        timer({ commits: commits.length });
        return commits;
    }

    /**
     * Compute co-change pairs from commit history and persist to
     * temporal_co_changes. High-Jaccard pairs also get an
     * inferred_relation (co_changed_with).
     *
     * Returns the number of co-change pairs persisted.
     */
    public async computeCoChanges(
        repoId: string,
        snapshotId: string,
        commits: GitCommit[],
        precomputedFileToSymbols?: Map<string, string[]>
    ): Promise<number> {
        const timer = log.startTimer('computeCoChanges', { repoId, commitCount: commits.length });

        // Step 1: Resolve file paths -> symbol IDs.
        const fileToSymbols = precomputedFileToSymbols ?? await this.resolveFileSymbolMap(repoId, snapshotId);

        if (fileToSymbols.size === 0) {
            log.warn('No file-to-symbol mappings found — co-change analysis skipped', { repoId });
            timer({ pairs: 0 });
            return 0;
        }

        // Step 2: For each commit, collect the set of symbol IDs that changed.
        //         Then for each pair (a, b), increment co-change counts.
        const pairCounts = new Map<string, {
            count: number;
            firstDate: Date;
            lastDate: Date;
        }>();
        const symbolChangeCounts = new Map<string, number>();

        for (const commit of commits) {
            if (commit.is_merge) continue;  // skip merge commits — they duplicate child commit files

            // Collect unique symbol IDs touched by this commit
            const touchedSymbols = new Set<string>();
            for (const filePath of commit.files) {
                const symbols = fileToSymbols.get(filePath);
                if (symbols) {
                    for (const symId of symbols) {
                        touchedSymbols.add(symId);
                    }
                }
            }

            // Increment per-symbol change counts
            for (const symId of touchedSymbols) {
                symbolChangeCounts.set(symId, (symbolChangeCounts.get(symId) || 0) + 1);
            }

            // Compute all pairs (order-normalized: a < b)
            // Cap at 50 symbols per commit to prevent O(n^2) explosion
            // (50 symbols = 1,225 pairs max, which is manageable)
            const symbolList = Array.from(touchedSymbols).sort().slice(0, 50);
            for (let i = 0; i < symbolList.length; i++) {
                for (let j = i + 1; j < symbolList.length; j++) {
                    const symA = symbolList[i]!;
                    const symB = symbolList[j]!;
                    const key = `${symA}|${symB}`;
                    const existing = pairCounts.get(key);
                    if (existing) {
                        existing.count++;
                        if (commit.date < existing.firstDate) existing.firstDate = commit.date;
                        if (commit.date > existing.lastDate) existing.lastDate = commit.date;
                    } else {
                        pairCounts.set(key, {
                            count: 1,
                            firstDate: commit.date,
                            lastDate: commit.date,
                        });
                    }
                }
            }
        }

        // Step 3: Filter and compute Jaccard, then persist.
        const now = new Date();
        let persisted = 0;
        let batch: { text: string; params: unknown[] }[] = [];

        for (const [key, data] of pairCounts) {
            if (data.count < CO_CHANGE_MIN_COUNT) continue;

            const pipeIndex = key.indexOf('|');
            const symbolA = key.substring(0, pipeIndex);
            const symbolB = key.substring(pipeIndex + 1);
            const changesA = symbolChangeCounts.get(symbolA) || 0;
            const changesB = symbolChangeCounts.get(symbolB) || 0;
            const union = changesA + changesB - data.count;
            const jaccard = union > 0 ? data.count / union : 0;

            batch.push({
                text: `INSERT INTO temporal_co_changes
                    (co_change_id, repo_id, symbol_a_id, symbol_b_id,
                     co_change_count, total_changes_a, total_changes_b,
                     jaccard_coefficient, first_co_change, last_co_change, computed_at)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
                    ON CONFLICT (repo_id, symbol_a_id, symbol_b_id)
                    DO UPDATE SET
                        co_change_count = EXCLUDED.co_change_count,
                        total_changes_a = EXCLUDED.total_changes_a,
                        total_changes_b = EXCLUDED.total_changes_b,
                        jaccard_coefficient = EXCLUDED.jaccard_coefficient,
                        first_co_change = EXCLUDED.first_co_change,
                        last_co_change = EXCLUDED.last_co_change,
                        computed_at = EXCLUDED.computed_at`,
                params: [
                    uuidv4(), repoId, symbolA, symbolB,
                    data.count, changesA, changesB,
                    jaccard, data.firstDate, data.lastDate, now,
                ],
            });
            persisted++;

            if (batch.length >= DB_BATCH_SIZE) {
                await db.batchInsert(batch);
                batch = [];
            }
        }

        if (batch.length > 0) {
            await db.batchInsert(batch);
        }

        // Step 4: Create inferred_relations for high-Jaccard pairs.
        await this.createCoChangeRelations(repoId, snapshotId);

        timer({ pairs: persisted });
        return persisted;
    }

    /**
     * Compute and persist per-symbol risk scores.
     * Returns the number of risk scores written.
     */
    public async computeRiskScores(
        repoId: string,
        snapshotId: string,
        commits: GitCommit[],
        precomputedFileToSymbols?: Map<string, string[]>
    ): Promise<number> {
        const timer = log.startTimer('computeRiskScores', { repoId, snapshotId, commitCount: commits.length });

        const fileToSymbols = precomputedFileToSymbols ?? await this.resolveFileSymbolMap(repoId, snapshotId);
        if (fileToSymbols.size === 0) {
            log.warn('No file-to-symbol mappings — risk scoring skipped', { repoId });
            timer({ scores: 0 });
            return 0;
        }

        // Accumulate per-symbol statistics
        const stats = new Map<string, SymbolStats>();
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

        for (const commit of commits) {
            if (commit.is_merge) continue;

            const touchedSymbols = new Set<string>();
            for (const filePath of commit.files) {
                const symbols = fileToSymbols.get(filePath);
                if (symbols) {
                    for (const symId of symbols) {
                        touchedSymbols.add(symId);
                    }
                }
            }

            for (const symId of touchedSymbols) {
                let s = stats.get(symId);
                if (!s) {
                    s = {
                        total_changes: 0,
                        bug_fix_count: 0,
                        bug_fix_dates: [],
                        revert_count: 0,
                        regression_count: 0,
                        recent_churn_30d: 0,
                        authors: new Set<string>(),
                        last_change_date: null,
                    };
                    stats.set(symId, s);
                }

                s.total_changes++;
                s.authors.add(commit.author_email);

                if (commit.is_bug_fix) {
                    s.bug_fix_count++;
                    s.bug_fix_dates.push(commit.date);
                }
                if (commit.is_revert) {
                    s.revert_count++;
                }
                if (commit.date >= thirtyDaysAgo) {
                    s.recent_churn_30d++;
                }
                if (!s.last_change_date || commit.date > s.last_change_date) {
                    s.last_change_date = commit.date;
                }
            }
        }

        // Detect regressions: same symbol fixed more than once within REGRESSION_WINDOW_DAYS
        for (const s of stats.values()) {
            s.bug_fix_dates.sort((a, b) => a.getTime() - b.getTime());
            let regressions = 0;
            for (let i = 1; i < s.bug_fix_dates.length; i++) {
                const currentDate = s.bug_fix_dates[i]!;
                const previousDate = s.bug_fix_dates[i - 1]!;
                const daysBetween = (currentDate.getTime() - previousDate.getTime())
                    / (1000 * 60 * 60 * 24);
                if (daysBetween <= REGRESSION_WINDOW_DAYS) {
                    regressions++;
                }
            }
            // Also count reverts as regressions
            s.regression_count = regressions + s.revert_count;
        }

        // Compute normalized composite risk
        const allStats = Array.from(stats.entries());
        if (allStats.length === 0) {
            timer({ scores: 0 });
            return 0;
        }

        // Find max values for normalization
        let maxFreq = 0, maxBug = 0, maxRegression = 0, maxChurn = 0, maxAuthors = 0;
        for (const [, s] of allStats) {
            if (s.total_changes > maxFreq) maxFreq = s.total_changes;
            if (s.bug_fix_count > maxBug) maxBug = s.bug_fix_count;
            if (s.regression_count > maxRegression) maxRegression = s.regression_count;
            if (s.recent_churn_30d > maxChurn) maxChurn = s.recent_churn_30d;
            if (s.authors.size > maxAuthors) maxAuthors = s.authors.size;
        }

        const normalize = (value: number, max: number): number => {
            if (max === 0) return 0;
            return value / max;
        };

        // Persist risk scores
        const now = new Date();
        let batch: { text: string; params: unknown[] }[] = [];
        let scored = 0;

        for (const [symbolId, s] of allStats) {
            const compositeRisk =
                RISK_WEIGHTS.change_frequency * normalize(s.total_changes, maxFreq) +
                RISK_WEIGHTS.bug_fix_count * normalize(s.bug_fix_count, maxBug) +
                RISK_WEIGHTS.regression_count * normalize(s.regression_count, maxRegression) +
                RISK_WEIGHTS.recent_churn_30d * normalize(s.recent_churn_30d, maxChurn) +
                RISK_WEIGHTS.distinct_authors * normalize(s.authors.size, maxAuthors);

            batch.push({
                text: `INSERT INTO temporal_risk_scores
                    (risk_id, repo_id, symbol_id, snapshot_id,
                     change_frequency, bug_fix_count, regression_count,
                     recent_churn_30d, distinct_authors, composite_risk,
                     last_change_date, computed_at)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
                    ON CONFLICT (repo_id, symbol_id, snapshot_id)
                    DO UPDATE SET
                        change_frequency = EXCLUDED.change_frequency,
                        bug_fix_count = EXCLUDED.bug_fix_count,
                        regression_count = EXCLUDED.regression_count,
                        recent_churn_30d = EXCLUDED.recent_churn_30d,
                        distinct_authors = EXCLUDED.distinct_authors,
                        composite_risk = EXCLUDED.composite_risk,
                        last_change_date = EXCLUDED.last_change_date,
                        computed_at = EXCLUDED.computed_at`,
                params: [
                    uuidv4(), repoId, symbolId, snapshotId,
                    s.total_changes, s.bug_fix_count, s.regression_count,
                    s.recent_churn_30d, s.authors.size,
                    Math.round(compositeRisk * 10000) / 10000,  // 4 decimal places
                    s.last_change_date, now,
                ],
            });
            scored++;

            if (batch.length >= DB_BATCH_SIZE) {
                await db.batchInsert(batch);
                batch = [];
            }
        }

        if (batch.length > 0) {
            await db.batchInsert(batch);
        }

        timer({ scores: scored });
        return scored;
    }

    /**
     * Get the risk score for a specific symbol in a given snapshot.
     */
    public async getRiskScore(
        symbolId: string,
        snapshotId: string
    ): Promise<TemporalRiskScore | null> {
        const result = await db.query(
            `SELECT * FROM temporal_risk_scores
             WHERE symbol_id = $1 AND snapshot_id = $2`,
            [symbolId, snapshotId]
        );
        return (result.rows[0] as TemporalRiskScore | undefined) ?? null;
    }

    /**
     * Get co-change partners for a symbol, ordered by Jaccard coefficient.
     */
    public async getCoChangePartners(
        symbolId: string,
        repoId: string,
        minJaccard: number = 0.1
    ): Promise<CoChangePartner[]> {
        const result = await db.query(`
            SELECT
                CASE
                    WHEN tcc.symbol_a_id = $1 THEN tcc.symbol_b_id
                    ELSE tcc.symbol_a_id
                END AS symbol_id,
                s.canonical_name,
                tcc.co_change_count,
                tcc.jaccard_coefficient,
                tcc.last_co_change
            FROM temporal_co_changes tcc
            JOIN symbols s ON s.symbol_id = CASE
                WHEN tcc.symbol_a_id = $1 THEN tcc.symbol_b_id
                ELSE tcc.symbol_a_id
            END
            WHERE tcc.repo_id = $2
              AND (tcc.symbol_a_id = $1 OR tcc.symbol_b_id = $1)
              AND tcc.jaccard_coefficient >= $3
            ORDER BY tcc.jaccard_coefficient DESC
        `, [symbolId, repoId, minJaccard]);

        return result.rows as CoChangePartner[];
    }

    /**
     * Get the top N riskiest symbols for a snapshot.
     */
    public async getTopRisks(
        snapshotId: string,
        limit: number = 20
    ): Promise<(TemporalRiskScore & { canonical_name: string })[]> {
        const result = await db.query(`
            SELECT trs.*, s.canonical_name
            FROM temporal_risk_scores trs
            JOIN symbols s ON s.symbol_id = trs.symbol_id
            WHERE trs.snapshot_id = $1
            ORDER BY trs.composite_risk DESC
            LIMIT $2
        `, [snapshotId, limit]);

        return result.rows as (TemporalRiskScore & { canonical_name: string })[];
    }

    /**
     * Get ownership information for a symbol — who commits to it the most.
     */
    public async getOwnershipProfile(
        repoId: string,
        symbolId: string,
        repoBasePath: string
    ): Promise<{
        primary_owner: string | null;
        ownership_type: 'sole' | 'shared' | 'orphaned';
        contributors: { author: string; commit_count: number; percentage: number }[];
    }> {
        // Get all file paths associated with this symbol
        const fileResult = await db.query(`
            SELECT DISTINCT f.path
            FROM symbol_versions sv
            JOIN symbols s ON s.symbol_id = sv.symbol_id
            JOIN files f ON f.file_id = sv.file_id
            WHERE s.symbol_id = $1 AND s.repo_id = $2
        `, [symbolId, repoId]);

        const filePaths = (fileResult.rows as { path: string }[]).map(r => r.path);

        if (filePaths.length === 0) {
            return {
                primary_owner: null,
                ownership_type: 'orphaned',
                contributors: [],
            };
        }

        // Pre-check: skip non-git directories instead of crashing
        if (!fs.existsSync(path.join(repoBasePath, '.git'))) {
            log.info('Not a git repository — skipping ownership analysis', { repoBasePath });
            return { primary_owner: null, ownership_type: 'orphaned', contributors: [] };
        }

        // Mine git log for these specific files
        const authorCounts = new Map<string, number>();
        let totalCommits = 0;

        for (const filePath of filePaths) {
            let logOutput: string;
            try {
                const result = await execFileAsync('git', [
                    'log',
                    '--pretty=format:%ae',
                    '--follow',
                    '--max-count=500',
                    '--', filePath,
                ], {
                    cwd: repoBasePath,
                    encoding: 'utf-8',
                    maxBuffer: 10 * 1024 * 1024,
                    timeout: 30_000,
                });
                logOutput = result.stdout;
            } catch (err) {
                log.debug('Git log failed for symbol, skipping', {
                    error: err instanceof Error ? err.message : String(err)
                });
                continue;
            }

            if (!logOutput || logOutput.trim().length === 0) continue;

            for (const rawLine of logOutput.split('\n')) {
                const email = rawLine.trim();
                if (email.length === 0) continue;
                authorCounts.set(email, (authorCounts.get(email) || 0) + 1);
                totalCommits++;
            }
        }

        if (totalCommits === 0) {
            return {
                primary_owner: null,
                ownership_type: 'orphaned',
                contributors: [],
            };
        }

        // Sort by commit count descending
        const sorted = Array.from(authorCounts.entries())
            .map(([author, count]) => ({
                author,
                commit_count: count,
                percentage: Math.round((count / totalCommits) * 10000) / 100,
            }))
            .sort((a, b) => b.commit_count - a.commit_count);

        const topContributor = sorted[0];
        if (!topContributor) {
            return {
                primary_owner: null,
                ownership_type: 'orphaned',
                contributors: [],
            };
        }

        const primaryOwner = topContributor.author;
        const topPercentage = topContributor.percentage;

        const ownershipType: 'sole' | 'shared' =
            (sorted.length === 1 || topPercentage >= 80) ? 'sole' : 'shared';

        return {
            primary_owner: primaryOwner,
            ownership_type: ownershipType,
            contributors: sorted,
        };
    }

    // -------------------------------------------------------------------
    // Internal helpers
    // -------------------------------------------------------------------

    /**
     * Parse raw `git log` output into structured GitCommit objects.
     *
     * Format: each commit starts with a header line matching the
     * --pretty=format pattern, followed by zero or more file paths,
     * followed by a blank line before the next commit.
     */
    private parseGitLog(raw: string): GitCommit[] {
        const commits: GitCommit[] = [];
        const lines = raw.split('\n');

        let current: GitCommit | null = null;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i]!;

            // Try to parse as a commit header: hash|name|email|date|subject
            // A commit hash is exactly 40 hex characters
            if (line.length > 40 && line[40] === '|') {
                // Flush the previous commit
                if (current) {
                    commits.push(current);
                }

                const parts = line.split('|');
                const hash = parts[0];
                const authorName = parts[1];
                const authorEmail = parts[2];
                const dateStr = parts[3];

                if (!hash || !authorName || !authorEmail || !dateStr || parts.length < 5) {
                    // Malformed header — skip
                    current = null;
                    continue;
                }

                // Subject may contain pipe characters — rejoin remaining parts
                const subject = parts.slice(4).join('|');

                const date = new Date(dateStr);
                if (isNaN(date.getTime())) {
                    current = null;
                    continue;
                }

                const isBugFix = BUG_FIX_PATTERNS.some(p => p.test(subject));
                const isRevert = REVERT_PATTERN.test(subject);
                const isMerge = MERGE_PATTERN.test(subject);

                current = {
                    hash,
                    author_name: authorName,
                    author_email: authorEmail,
                    date,
                    subject,
                    files: [],
                    is_bug_fix: isBugFix,
                    is_revert: isRevert,
                    is_merge: isMerge,
                };
            } else if (current && line.trim().length > 0) {
                // This is a file path line belonging to the current commit
                const filePath = line.trim();
                // Skip binary files and common non-code artifacts
                if (!this.isIgnoredPath(filePath)) {
                    current.files.push(filePath);
                }
            }
            // Blank lines are commit separators — do nothing
        }

        // Flush the last commit
        if (current) {
            commits.push(current);
        }

        return commits;
    }

    /**
     * Returns true if a file path should be excluded from temporal analysis.
     * Filters out binary files, lock files, generated files, and non-code assets.
     */
    private isIgnoredPath(filePath: string): boolean {
        const lower = filePath.toLowerCase();

        // Binary/media extensions
        const binaryExtensions = [
            '.png', '.jpg', '.jpeg', '.gif', '.ico', '.svg', '.webp', '.bmp',
            '.woff', '.woff2', '.ttf', '.eot', '.otf',
            '.zip', '.tar', '.gz', '.bz2', '.7z', '.rar',
            '.exe', '.dll', '.so', '.dylib', '.bin',
            '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
            '.mp3', '.mp4', '.avi', '.mov', '.wav',
            '.pyc', '.pyo', '.class', '.o', '.obj',
        ];

        if (binaryExtensions.some(ext => lower.endsWith(ext))) {
            return true;
        }

        // Lock files and generated artifacts
        const ignoredNames = [
            'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
            'composer.lock', 'Gemfile.lock', 'Cargo.lock', 'poetry.lock',
            'go.sum',
        ];

        const basename = filePath.split('/').pop() || '';
        if (ignoredNames.includes(basename)) {
            return true;
        }

        // Generated directories
        const ignoredDirs = ['node_modules/', 'dist/', 'build/', '.git/', '__pycache__/', '.tox/'];
        if (ignoredDirs.some(dir => filePath.includes(dir))) {
            return true;
        }

        return false;
    }

    /**
     * Build a map from file path -> symbol IDs using the files and
     * symbol_versions tables. Uses the given snapshot (so it works
     * even before the snapshot is marked 'complete').
     *
     * This enables mapping git-log file paths to the symbols defined
     * in those files.
     */
    private async resolveFileSymbolMap(repoId: string, snapshotId: string): Promise<Map<string, string[]>> {
        const result = await db.query(`
            SELECT f.path, s.symbol_id
            FROM symbol_versions sv
            JOIN symbols s ON s.symbol_id = sv.symbol_id
            JOIN files f ON f.file_id = sv.file_id
            WHERE s.repo_id = $1
              AND sv.snapshot_id = $2
        `, [repoId, snapshotId]);

        const fileMap = new Map<string, string[]>();
        const seen = new Set<string>();  // dedup symbol_id per path

        for (const row of result.rows as { path: string; symbol_id: string }[]) {
            const key = `${row.path}|${row.symbol_id}`;
            if (seen.has(key)) continue;
            seen.add(key);

            const existing = fileMap.get(row.path);
            if (existing) {
                existing.push(row.symbol_id);
            } else {
                fileMap.set(row.path, [row.symbol_id]);
            }
        }

        log.debug('Resolved file-to-symbol map', {
            files: fileMap.size,
            symbols: seen.size,
        });

        return fileMap;
    }

    /**
     * Create co_changed_with inferred_relations for high-Jaccard
     * co-change pairs. Looks up the current symbol_version_ids for
     * the latest complete snapshot, then upserts inferred_relations.
     */
    private async createCoChangeRelations(repoId: string, snapshotId: string): Promise<number> {
        // Get high-Jaccard pairs
        const pairsResult = await db.query(`
            SELECT symbol_a_id, symbol_b_id, jaccard_coefficient, co_change_count
            FROM temporal_co_changes
            WHERE repo_id = $1
              AND jaccard_coefficient >= $2
              AND co_change_count >= $3
            ORDER BY jaccard_coefficient DESC
        `, [repoId, CO_CHANGE_RELATION_JACCARD_THRESHOLD, CO_CHANGE_MIN_COUNT]);

        if (pairsResult.rowCount === 0) return 0;

        // Build symbol_id -> symbol_version_id map for the snapshot
        const svResult = await db.query(`
            SELECT sv.symbol_version_id, sv.symbol_id
            FROM symbol_versions sv
            WHERE sv.snapshot_id = $1
        `, [snapshotId]);

        const symbolToSv = new Map<string, string>();
        for (const row of svResult.rows as { symbol_version_id: string; symbol_id: string }[]) {
            symbolToSv.set(row.symbol_id, row.symbol_version_id);
        }

        // Upsert-or-fetch the shared co-change evidence bundle. The score tuple
        // (0, 0, 0, 0, 0, 1.0) is a fingerprint for "temporal co-change" and is
        // unique via uq_evidence_bundle_scores — so every run reuses the same
        // bundle instead of trying to insert a fresh UUID that conflicts.
        const bundleResult = await db.query(`
            INSERT INTO evidence_bundles
                (evidence_bundle_id, semantic_score, structural_score,
                 behavioral_score, contract_score, test_score, history_score,
                 contradiction_flags, feature_payload)
            VALUES ($1, 0, 0, 0, 0, 0, 1.0, '{}', '{"source": "temporal_co_change"}')
            ON CONFLICT ON CONSTRAINT uq_evidence_bundle_scores DO UPDATE
                SET feature_payload = evidence_bundles.feature_payload
            RETURNING evidence_bundle_id
        `, [uuidv4()]);
        const evidenceBundleId = (bundleResult.rows[0] as { evidence_bundle_id: string }).evidence_bundle_id;

        let created = 0;
        let batch: { text: string; params: unknown[] }[] = [];

        for (const row of pairsResult.rows as {
            symbol_a_id: string;
            symbol_b_id: string;
            jaccard_coefficient: number;
            co_change_count: number;
        }[]) {
            const svA = symbolToSv.get(row.symbol_a_id);
            const svB = symbolToSv.get(row.symbol_b_id);
            if (!svA || !svB) continue;

            // Create bidirectional relations (A->B and B->A)
            const pairs: [string, string][] = [[svA, svB], [svB, svA]];
            for (const [src, dst] of pairs) {
                batch.push({
                    text: `INSERT INTO inferred_relations
                        (inferred_relation_id, src_symbol_version_id, dst_symbol_version_id,
                         relation_type, confidence, review_state, evidence_bundle_id,
                         valid_from_snapshot_id, valid_to_snapshot_id)
                        VALUES ($1, $2, $3, 'co_changed_with', $4, 'unreviewed', $5, $6, NULL)
                        ON CONFLICT (src_symbol_version_id, dst_symbol_version_id, relation_type, valid_from_snapshot_id)
                        DO UPDATE SET
                            confidence = GREATEST(inferred_relations.confidence, EXCLUDED.confidence),
                            evidence_bundle_id = EXCLUDED.evidence_bundle_id`,
                    params: [
                        uuidv4(), src, dst,
                        Math.round(row.jaccard_coefficient * 1000) / 1000,
                        evidenceBundleId, snapshotId,
                    ],
                });
                created++;
            }

            if (batch.length >= DB_BATCH_SIZE) {
                await db.batchInsert(batch);
                batch = [];
            }
        }

        if (batch.length > 0) {
            await db.batchInsert(batch);
        }

        log.info('Co-change inferred relations created', { repoId, relations: created });
        return created;
    }
}

export const temporalEngine = new TemporalEngine();
