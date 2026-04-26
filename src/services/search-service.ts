/**
 * ContextZero — Search Service
 *
 * Shared business logic for code search (grep across indexed files).
 * Handles regex construction, ReDoS protection, file filtering,
 * and context line extraction.
 * Used by both the REST API and MCP bridge handlers.
 */

import * as fsp from 'fs/promises';
import { db } from '../db-driver';
import { coreDataService } from '../db-driver/core_data';
import { resolveExistingPath, resolvePathWithinBase } from '../path-security';
import { UserFacingError } from '../types';

// ────────── Result Types ──────────

export interface SearchMatch {
    file: string;
    line: number;
    match: string;
    context: string;
}

export interface SearchCodeResult {
    pattern: string;
    /** 'regex' = pattern compiled as regex; 'literal' = fell back to escaped literal search (e.g. ReDoS-suspect input). */
    mode: 'regex' | 'literal';
    total_matches: number;
    matches: SearchMatch[];
}

export interface SearchCodeOptions {
    filePattern?: string;
    maxResults?: number;
    contextLines?: number;
}

// ────────── Logger Interface ──────────

interface MinimalLogger {
    debug(message: string, data?: Record<string, unknown>): void;
    warn(message: string, data?: Record<string, unknown>): void;
}

// ────────── ReDoS Protection ──────────

/**
 * Detect patterns with known catastrophic backtracking constructs.
 * Patterns like (a+)+, (a|a)+, (a*)* cause exponential time on non-matching input.
 */
const REDOS_SUSPECT = /(\([^)]*[+*][^)]*\))[+*]|\(\?[^)]*\|[^)]*\)[+*]/;

function buildSafeRegex(
    pattern: string,
    log?: MinimalLogger,
): { regex: RegExp; mode: 'regex' | 'literal' } {
    const useRegex = !REDOS_SUSPECT.test(pattern);
    try {
        if (!useRegex) throw new Error('ReDoS-suspect pattern');
        return { regex: new RegExp(pattern, 'gi'), mode: 'regex' };
    } catch (error) {
        if (log) {
            log.debug('Falling back to literal search pattern', {
                pattern,
                error: error instanceof Error ? error.message : String(error),
            });
        }
        return {
            regex: new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'),
            mode: 'literal',
        };
    }
}

// ────────── Service Function ──────────

/**
 * Search across indexed files in a repository using regex or literal matching.
 * Returns matching lines with surrounding context.
 */
export async function searchCode(
    repoId: string,
    pattern: string,
    options: SearchCodeOptions = {},
    log?: MinimalLogger,
): Promise<SearchCodeResult> {
    const maxResults = options.maxResults ?? 30;
    const contextLines = options.contextLines ?? 2;

    // Resolve repo base path
    const repo = await coreDataService.getRepository(repoId);
    if (!repo) throw UserFacingError.notFound('Repository');
    const basePath = repo.base_path as string;
    if (!basePath) throw UserFacingError.badRequest('Repository base path not configured');

    // Get indexed files
    const filesResult = await db.query(`
        SELECT DISTINCT f.path FROM files f
        JOIN snapshots snap ON snap.snapshot_id = f.snapshot_id
        WHERE snap.repo_id = $1 ORDER BY f.path
        LIMIT 10000
    `, [repoId]);

    const { regex, mode: searchMode } = buildSafeRegex(pattern, log);

    const matches: SearchMatch[] = [];

    // Resolve base symlinks once before the loop
    let realBase: string;
    try {
        realBase = resolveExistingPath(basePath);
    } catch (error) {
        if (log) {
            log.warn('Repository base path not accessible', {
                repo_id: repoId,
                error: error instanceof Error ? error.message : String(error),
            });
        }
        throw UserFacingError.badRequest('Repository base path not accessible');
    }

    // Pre-filter files by pattern before any I/O
    let files = (filesResult.rows as { path: string }[]).map(r => r.path);
    if (options.filePattern) {
        const pat = options.filePattern.toLowerCase();
        files = files.filter(fp => {
            const lower = fp.toLowerCase();
            return lower.includes(pat) || lower.endsWith(pat);
        });
    }

    // Process files in parallel batches for better throughput
    const BATCH_SIZE = 50;
    for (let batchStart = 0; batchStart < files.length && matches.length < maxResults; batchStart += BATCH_SIZE) {
        const batchEnd = Math.min(batchStart + BATCH_SIZE, files.length);
        const batch = files.slice(batchStart, batchEnd);

        const batchResults = await Promise.allSettled(
            batch.map(async (filePath) => {
                const fileMatches: SearchMatch[] = [];
                try {
                    const safePath = resolvePathWithinBase(realBase, filePath);
                    const content = await fsp.readFile(safePath.realPath, 'utf-8');
                    const lines = content.split('\n');

                    for (let i = 0; i < lines.length; i++) {
                        regex.lastIndex = 0;
                        if (regex.test(lines[i]!)) {
                            const ctxStart = Math.max(0, i - contextLines);
                            const ctxEnd = Math.min(lines.length - 1, i + contextLines);
                            const contextArr: string[] = [];
                            for (let c = ctxStart; c <= ctxEnd; c++) {
                                const prefix = c === i ? '>' : ' ';
                                contextArr.push(`${prefix} ${c + 1}: ${lines[c]}`);
                            }
                            fileMatches.push({
                                file: filePath,
                                line: i + 1,
                                match: (lines[i] ?? '').trim(),
                                context: contextArr.join('\n'),
                            });
                        }
                    }
                } catch (error) {
                    if (log) {
                        log.debug('Skipping unreadable indexed file during search', {
                            repo_id: repoId,
                            file_path: filePath,
                            error: error instanceof Error ? error.message : String(error),
                        });
                    }
                }
                return fileMatches;
            }),
        );

        // Collect results from this batch, respecting remaining quota
        for (const result of batchResults) {
            if (matches.length >= maxResults) break;
            if (result.status === 'fulfilled') {
                for (const m of result.value) {
                    if (matches.length >= maxResults) break;
                    matches.push(m);
                }
            }
        }

        // Early termination: if we've hit maxResults, skip remaining batches
        if (matches.length >= maxResults) break;
    }

    return {
        pattern,
        mode: searchMode,
        total_matches: matches.length,
        matches,
    };
}
