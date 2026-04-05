import * as crypto from 'crypto';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { promisify } from 'util';
import { extractWithTreeSitter, type SupportedLanguage } from './adapters/universal';
import { Logger } from './logger';
import { isPathWithinBase, resolveExistingPath } from './path-security';
import type { BehaviorHint, ExtractedSymbol } from './types';

const execFileAsync = promisify(execFile);
const log = new Logger('workspace-native');

export interface WorkspaceLogger {
    debug?(message: string, data?: Record<string, unknown>): void;
    warn?(message: string, data?: Record<string, unknown>): void;
}

export interface AllowedRepoPathOptions {
    fallbackBasePaths?: string[];
    log?: WorkspaceLogger;
}

export interface WorkspaceFileInfo {
    absPath: string;
    relativePath: string;
    size: number;
    language: SupportedLanguage | null;
}

export interface WorkspaceFileDiscoveryResult {
    files: WorkspaceFileInfo[];
    truncated: boolean;
    total_files_seen: number;
    skipped_by_size: number;
    skipped_symlinks: number;
}

export interface WorkspaceSnapshotIdentity {
    commit_sha: string;
    branch: string;
    source: 'explicit' | 'git' | 'workspace';
    files_considered: number;
    truncated: boolean;
}

export interface NativeSearchCodeMatch {
    file: string;
    line: number;
    match: string;
    context: string;
}

export interface NativeSearchCodeResult {
    pattern: string;
    match_mode: 'regex' | 'literal';
    matches: NativeSearchCodeMatch[];
    scanned_files: number;
    truncated: boolean;
    binary_files_skipped: number;
    unreadable_files: number;
}

export interface NativeSymbolMatch {
    canonical_name: string;
    kind: string;
    file_path: string;
    language: SupportedLanguage;
    signature: string;
    visibility: string;
    range_start_line: number;
    range_end_line: number;
    score: number;
    parse_confidence: number;
    uncertainty_flags: string[];
    risk_hints: string[];
}

export interface NativeSymbolSearchResult {
    query: string;
    matches: NativeSymbolMatch[];
    scanned_files: number;
    truncated: boolean;
    unreadable_files: number;
}

export interface NativeCodebaseOverviewResult {
    summary: {
        total_files_scanned: number;
        source_files_scanned: number;
        languages: Record<string, number>;
        directories: [string, number][];
        truncated: boolean;
    };
    symbols: {
        total: number;
        by_kind: Record<string, number>;
        public_api_count: number;
        entry_points: string[];
    };
    testing_surface: {
        test_files_detected: number;
        heuristic_note: string;
    };
    risk_hotspots: Array<{
        canonical_name: string;
        kind: string;
        file_path: string;
        language: SupportedLanguage;
        visibility: string;
        risk_hints: string[];
    }>;
    scan_health: {
        parse_failures: number;
        unreadable_files: number;
    };
}

const SOURCE_LANGUAGE_MAP: Record<string, SupportedLanguage> = {
    // TypeScript
    '.ts': 'typescript',
    '.tsx': 'typescript',
    '.mts': 'typescript',
    '.cts': 'typescript',
    // JavaScript
    '.js': 'javascript',
    '.jsx': 'javascript',
    '.mjs': 'javascript',
    '.cjs': 'javascript',
    // Python
    '.py': 'python',
    '.pyi': 'python',
    '.pyw': 'python',
    // C / C++
    '.c': 'cpp',
    '.cpp': 'cpp',
    '.cc': 'cpp',
    '.cxx': 'cpp',
    '.hpp': 'cpp',
    '.hh': 'cpp',
    '.hxx': 'cpp',
    '.h': 'cpp',
    // Go
    '.go': 'go',
    // Rust
    '.rs': 'rust',
    // Java
    '.java': 'java',
    // C#
    '.cs': 'csharp',
    // Ruby
    '.rb': 'ruby',
    // Kotlin
    '.kt': 'kotlin',
    '.kts': 'kotlin',
    // Swift
    '.swift': 'swift',
    // PHP
    '.php': 'php',
    // Shell / Bash
    '.sh': 'bash',
    '.bash': 'bash',
};

const SKIP_DIRS = new Set([
    // Version control
    '.git', '.svn', '.hg',
    // JavaScript/TypeScript
    'node_modules', 'dist', 'build', '.next', '.nuxt', '.turbo',
    '.yarn', '.pnpm-store',
    // Python
    '__pycache__', '.venv', 'venv', '.mypy_cache', '.pytest_cache',
    '.ruff_cache', '.tox', '.eggs', 'egg-info',
    // Rust
    'target',
    // Go
    'vendor',
    // Java / Gradle / Maven
    '.gradle', '.mvn',
    // C# / .NET
    'bin', 'obj', 'packages',
    // iOS / macOS
    'Pods', '.build',
    // Test / CI coverage
    'coverage', '.nyc_output',
    // IDE configs
    '.idea', '.vscode', '.vs',
    // General caches
    '.cache', 'out', '_build',
]);

const DEFAULT_MAX_FILE_SIZE = 5 * 1024 * 1024;
const DEFAULT_DISCOVERY_LIMIT = 100_000;

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
    if (!Number.isFinite(value)) return fallback;
    return Math.min(Math.max(Math.trunc(value as number), min), max);
}

function detectLanguage(filePath: string): SupportedLanguage | null {
    return SOURCE_LANGUAGE_MAP[path.extname(filePath).toLowerCase()] || null;
}

export function getAllowedBasePaths(options?: AllowedRepoPathOptions): string[] {
    const configured = (process.env['SCG_ALLOWED_BASE_PATHS'] || '')
        .split(',')
        .map(value => value.trim())
        .filter(Boolean);
    const candidates = configured.length > 0 ? configured : (options?.fallbackBasePaths || []);
    const uniqueCandidates = [...new Set(candidates)];

    return uniqueCandidates.flatMap(candidate => {
        try {
            return [resolveExistingPath(candidate)];
        } catch (error) {
            options?.log?.warn?.('Ignoring inaccessible allowed base path', {
                path: candidate,
                error: error instanceof Error ? error.message : String(error),
            });
            return [];
        }
    });
}

export async function ensureAllowedRepoPath(repoPath: string, options?: AllowedRepoPathOptions): Promise<string> {
    let resolvedPath: string;
    try {
        resolvedPath = resolveExistingPath(repoPath);
    } catch (error) {
        throw new Error(`repo_path does not exist or is not accessible: ${error instanceof Error ? error.message : String(error)}`);
    }

    let stat: fs.Stats;
    try {
        stat = await fsp.stat(resolvedPath);
    } catch (error) {
        throw new Error(`repo_path does not exist or is not accessible: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!stat.isDirectory()) {
        throw new Error('repo_path must be a directory');
    }

    const allowedBasePaths = getAllowedBasePaths(options);
    if (allowedBasePaths.length === 0) {
        throw new Error('Allowed base path violation: no accessible base paths are configured for workspace access');
    }
    if (!allowedBasePaths.some(base => isPathWithinBase(base, resolvedPath))) {
        throw new Error('Allowed base path violation: repo_path is not under any configured SCG_ALLOWED_BASE_PATHS');
    }

    // Verify directory is a git repository before accepting it
    try {
        await fsp.access(path.join(resolvedPath, '.git'));
    } catch {
        throw new Error(
            `repo_path is not a git repository (no .git found): ${resolvedPath}`
        );
    }

    return resolvedPath;
}

export async function discoverWorkspaceFiles(
    repoPath: string,
    options?: {
        maxFiles?: number;
        maxFileSize?: number;
        supportedLanguagesOnly?: boolean;
    }
): Promise<WorkspaceFileDiscoveryResult> {
    const maxFiles = clampInt(options?.maxFiles, 1, DEFAULT_DISCOVERY_LIMIT, DEFAULT_DISCOVERY_LIMIT);
    const maxFileSize = clampInt(options?.maxFileSize, 1, DEFAULT_MAX_FILE_SIZE, DEFAULT_MAX_FILE_SIZE);
    const files: WorkspaceFileInfo[] = [];
    let truncated = false;
    let totalFilesSeen = 0;
    let skippedBySize = 0;
    let skippedSymlinks = 0;

    const walk = async (currentDir: string): Promise<void> => {
        if (truncated) return;

        let entries: fs.Dirent[];
        try {
            const rawEntries = await fsp.readdir(currentDir, { withFileTypes: true });
            entries = rawEntries.sort((left, right) => left.name.localeCompare(right.name));
        } catch (err) {
            log.warn('Failed to read directory during workspace discovery', {
                directory: currentDir,
                error: err instanceof Error ? err.message : String(err),
            });
            return;
        }

        for (const entry of entries) {
            if (truncated) break;
            const entryPath = path.join(currentDir, entry.name);

            let lst: fs.Stats;
            try {
                lst = await fsp.lstat(entryPath);
            } catch (err) {
                log.debug('Failed to lstat file entry', {
                    path: entryPath,
                    error: err instanceof Error ? err.message : String(err),
                });
                continue;
            }

            if (lst.isSymbolicLink()) {
                skippedSymlinks++;
                continue;
            }

            if (entry.isDirectory()) {
                if (SKIP_DIRS.has(entry.name)) continue;
                await walk(entryPath);
                continue;
            }

            if (!entry.isFile()) continue;
            totalFilesSeen++;

            let stat: fs.Stats;
            try {
                stat = await fsp.stat(entryPath);
            } catch (err) {
                log.debug('Failed to stat file entry', {
                    path: entryPath,
                    error: err instanceof Error ? err.message : String(err),
                });
                continue;
            }

            if (stat.size > maxFileSize) {
                skippedBySize++;
                continue;
            }

            const language = detectLanguage(entryPath);
            if (options?.supportedLanguagesOnly && !language) {
                continue;
            }

            if (files.length >= maxFiles) {
                truncated = true;
                break;
            }

            files.push({
                absPath: entryPath,
                relativePath: path.relative(repoPath, entryPath) || path.basename(entryPath),
                size: stat.size,
                language,
            });
        }
    };

    await walk(repoPath);
    return {
        files,
        truncated,
        total_files_seen: totalFilesSeen,
        skipped_by_size: skippedBySize,
        skipped_symlinks: skippedSymlinks,
    };
}

const isReDoSSuspect = (pattern: string): boolean => {
    // Reject patterns with nested quantifiers (most common ReDoS source)
    const nestedQuantifier = /([+*]|\{[\d,]+\})\s*\)[\s]*([+*]|\{[\d,]+\})/;
    // Reject patterns with overlapping alternations inside quantifiers
    const overlappingAlt = /\([^)]*\|[^)]*\)\s*[+*{]/;
    // Reject backreferences (can cause exponential behavior)
    const backreference = /\\[1-9]/;
    // Reject excessive nesting
    const deepNesting = /\([^)]*\([^)]*\([^)]*\)/;
    return nestedQuantifier.test(pattern) || overlappingAlt.test(pattern) ||
           backreference.test(pattern) || deepNesting.test(pattern);
};

function buildRegex(pattern: string, wsLog?: WorkspaceLogger): { regex: RegExp; mode: 'regex' | 'literal' } {
    try {
        if (isReDoSSuspect(pattern)) {
            throw new Error('ReDoS-suspect pattern');
        }
        return { regex: new RegExp(pattern, 'gi'), mode: 'regex' };
    } catch (error) {
        wsLog?.debug?.('Workspace search falling back to literal pattern', {
            pattern,
            error: error instanceof Error ? error.message : String(error),
        });
        log.debug('Workspace search falling back to literal pattern', {
            pattern,
            error: error instanceof Error ? error.message : String(error),
        });
        return {
            regex: new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'),
            mode: 'literal',
        };
    }
}

async function readTextFile(filePath: string): Promise<string | null> {
    const buffer = await fsp.readFile(filePath);
    if (buffer.includes(0)) return null;
    return buffer.toString('utf-8');
}

async function tryReadGitIdentity(repoPath: string): Promise<{ commit_sha: string; branch: string } | null> {
    try {
        const [headResult, branchResult] = await Promise.all([
            execFileAsync('git', ['-C', repoPath, 'rev-parse', 'HEAD'], { timeout: 1500, maxBuffer: 64 * 1024 }),
            execFileAsync('git', ['-C', repoPath, 'rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 1500, maxBuffer: 64 * 1024 })
                .catch((err) => {
                    log.debug('Git branch detection failed (likely detached HEAD)', {
                        error: err instanceof Error ? err.message : String(err),
                    });
                    return { stdout: '' };
                }),
        ]);
        const commitSha = headResult.stdout.trim();
        if (!commitSha) return null;
        const branch = branchResult.stdout.trim() || 'HEAD';
        return { commit_sha: commitSha, branch };
    } catch (err) {
        log.warn('Git HEAD detection failed — snapshot identity will use workspace fingerprint', {
            repoPath,
            error: err instanceof Error ? err.message : String(err),
        });
        return null;
    }
}

async function computeWorkspaceFingerprint(repoPath: string): Promise<{ commit_sha: string; files_considered: number; truncated: boolean }> {
    const discovery = await discoverWorkspaceFiles(repoPath, {
        maxFiles: 20_000,
        maxFileSize: DEFAULT_MAX_FILE_SIZE,
        supportedLanguagesOnly: false,
    });
    const hash = crypto.createHash('sha256');
    hash.update('workspace-fingerprint-v1');
    hash.update(repoPath);

    for (const file of discovery.files) {
        hash.update(file.relativePath);
        hash.update(String(file.size));
        try {
            const stat = await fsp.stat(file.absPath);
            hash.update(String(Math.trunc(stat.mtimeMs)));
        } catch (err) {
            log.debug('Failed to stat file during workspace fingerprint', {
                path: file.absPath,
                error: err instanceof Error ? err.message : String(err),
            });
            hash.update('missing');
        }
    }

    return {
        commit_sha: `workspace-${hash.digest('hex').slice(0, 40)}`,
        files_considered: discovery.files.length,
        truncated: discovery.truncated,
    };
}

export async function deriveWorkspaceSnapshotIdentity(
    repoPath: string,
    options?: {
        commitSha?: string;
        branch?: string;
    }
): Promise<WorkspaceSnapshotIdentity> {
    const explicitCommit = options?.commitSha?.trim();
    const branchHint = options?.branch?.trim();

    if (explicitCommit) {
        const gitIdentity = await tryReadGitIdentity(repoPath);
        return {
            commit_sha: explicitCommit,
            branch: branchHint || gitIdentity?.branch || 'main',
            source: 'explicit',
            files_considered: 0,
            truncated: false,
        };
    }

    const gitIdentity = await tryReadGitIdentity(repoPath);
    if (gitIdentity) {
        return {
            commit_sha: gitIdentity.commit_sha,
            branch: branchHint || gitIdentity.branch || 'main',
            source: 'git',
            files_considered: 0,
            truncated: false,
        };
    }

    const fingerprint = await computeWorkspaceFingerprint(repoPath);
    return {
        commit_sha: fingerprint.commit_sha,
        branch: branchHint || 'workspace',
        source: 'workspace',
        files_considered: fingerprint.files_considered,
        truncated: fingerprint.truncated,
    };
}

function isTestLikePath(relativePath: string): boolean {
    return /(^|\/)(test|tests|spec|specs|__tests__)(\/|$)|\.(test|spec)\./i.test(relativePath);
}

/** Risk severity ordering — higher number = more dangerous.
 *  Used to sort risk hints so the most critical ones appear first. */
const RISK_SEVERITY: Record<string, number> = {
    'transaction': 6,
    'acquires_lock': 5,
    'network_call': 4,
    'concurrency': 4,
    'db_write': 3,
    'file_io': 3,
    'auth_check': 2,
    'throws': 1,
};

function summarizeRiskHints(
    behaviorHints: BehaviorHint[],
    stableKey: string
): string[] {
    const interestingHints = new Set([
        'db_write', 'network_call', 'file_io', 'auth_check',
        'transaction', 'acquires_lock', 'throws', 'concurrency',
    ]);

    // Deduplicate: same hint_type:detail should appear only once per symbol
    const seen = new Set<string>();
    const unique: { key: string; severity: number }[] = [];

    for (const hint of behaviorHints) {
        if (hint.symbol_key !== stableKey) continue;
        if (!interestingHints.has(hint.hint_type)) continue;
        const key = `${hint.hint_type}:${hint.detail}`;
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push({ key, severity: RISK_SEVERITY[hint.hint_type] ?? 0 });
    }

    // Sort by severity descending so most dangerous hints appear first
    unique.sort((a, b) => b.severity - a.severity);
    return unique.map(u => u.key).slice(0, 10);
}

function scoreSymbol(query: string, symbol: ExtractedSymbol, relativePath: string): number {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return 0;

    const normalizedName = symbol.canonical_name.toLowerCase();
    const normalizedStableKey = symbol.stable_key.toLowerCase();
    const normalizedPath = relativePath.toLowerCase();

    let score = 0;
    if (normalizedName === normalizedQuery) score = 100;
    else if (normalizedName.startsWith(normalizedQuery)) score = 92;
    else if (normalizedName.includes(normalizedQuery)) score = 84;

    if (normalizedStableKey.includes(normalizedQuery)) score = Math.max(score, 76);
    if (normalizedPath.includes(normalizedQuery)) score = Math.max(score, 56);

    const queryTokens = normalizedQuery.split(/[^a-z0-9_]+/).filter(Boolean);
    const tokenHits = queryTokens.filter(token =>
        normalizedName.includes(token) ||
        normalizedStableKey.includes(token) ||
        normalizedPath.includes(token)
    ).length;
    if (tokenHits > 0) {
        score = Math.max(score, 40 + tokenHits * 12);
    }

    if (symbol.visibility === 'public') score += 3;
    return score;
}

export async function searchWorkspaceCode(
    repoPath: string,
    pattern: string,
    options?: {
        filePattern?: string;
        maxFiles?: number;
        maxResults?: number;
        contextLines?: number;
        log?: WorkspaceLogger;
    }
): Promise<NativeSearchCodeResult> {
    const discovery = await discoverWorkspaceFiles(repoPath, {
        maxFiles: options?.maxFiles ?? 1500,
        maxFileSize: DEFAULT_MAX_FILE_SIZE,
        supportedLanguagesOnly: false,
    });
    const maxResults = clampInt(options?.maxResults, 1, 100, 30);
    const contextLines = clampInt(options?.contextLines, 0, 5, 2);
    const filePattern = options?.filePattern?.toLowerCase();
    const { regex, mode } = buildRegex(pattern, options?.log);

    const SEARCH_FILE_CAP = 1000;
    const matches: NativeSearchCodeMatch[] = [];
    let binaryFilesSkipped = 0;
    let unreadableFiles = 0;
    let scannedFiles = 0;

    for (const file of discovery.files) {
        if (matches.length >= maxResults) break;
        if (scannedFiles >= SEARCH_FILE_CAP) break;
        if (filePattern) {
            const normalizedPath = file.relativePath.toLowerCase();
            if (!normalizedPath.includes(filePattern) && !normalizedPath.endsWith(filePattern)) {
                continue;
            }
        }

        try {
            const source = await readTextFile(file.absPath);
            if (source === null) {
                binaryFilesSkipped++;
                continue;
            }
            scannedFiles++;
            const lines = source.split('\n');
            for (let i = 0; i < lines.length && matches.length < maxResults; i++) {
                regex.lastIndex = 0;
                if (!regex.test(lines[i] || '')) continue;
                const start = Math.max(0, i - contextLines);
                const end = Math.min(lines.length - 1, i + contextLines);
                const context: string[] = [];
                for (let lineIndex = start; lineIndex <= end; lineIndex++) {
                    const prefix = lineIndex === i ? '>' : ' ';
                    context.push(`${prefix} ${lineIndex + 1}: ${lines[lineIndex]}`);
                }
                matches.push({
                    file: file.relativePath,
                    line: i + 1,
                    match: (lines[i] || '').trim(),
                    context: context.join('\n'),
                });
            }
        } catch (err) {
            log.debug('Failed to read file during code search', {
                path: file.relativePath,
                error: err instanceof Error ? err.message : String(err),
            });
            unreadableFiles++;
        }
    }

    return {
        pattern,
        match_mode: mode,
        matches,
        scanned_files: scannedFiles,
        truncated: discovery.truncated || matches.length >= maxResults || scannedFiles >= SEARCH_FILE_CAP,
        binary_files_skipped: binaryFilesSkipped,
        unreadable_files: unreadableFiles,
    };
}

export async function searchWorkspaceSymbols(
    repoPath: string,
    query: string,
    options?: {
        kindFilter?: string;
        language?: SupportedLanguage;
        maxFiles?: number;
        maxResults?: number;
    }
): Promise<NativeSymbolSearchResult> {
    const discovery = await discoverWorkspaceFiles(repoPath, {
        maxFiles: options?.maxFiles ?? 1200,
        maxFileSize: DEFAULT_MAX_FILE_SIZE,
        supportedLanguagesOnly: true,
    });
    const maxResults = clampInt(options?.maxResults, 1, 100, 20);
    const matches: NativeSymbolMatch[] = [];
    let unreadableFiles = 0;
    let scannedFiles = 0;

    for (const file of discovery.files) {
        if (!file.language) continue;
        const language = file.language;
        if (options?.language && language !== options.language) continue;

        try {
            const source = await readTextFile(file.absPath);
            if (source === null) continue;
            scannedFiles++;

            const extraction = extractWithTreeSitter(file.relativePath, source, language);
            const symbols = extraction.symbols
                .filter(symbol => !options?.kindFilter || symbol.kind === options.kindFilter)
                .map(symbol => {
                    const score = scoreSymbol(query, symbol, file.relativePath);
                    if (score <= 0) return null;
                    return {
                        canonical_name: symbol.canonical_name,
                        kind: symbol.kind,
                        file_path: file.relativePath,
                        language,
                        signature: symbol.signature,
                        visibility: symbol.visibility,
                        range_start_line: symbol.range_start_line,
                        range_end_line: symbol.range_end_line,
                        score,
                        parse_confidence: extraction.parse_confidence,
                        uncertainty_flags: extraction.uncertainty_flags,
                        risk_hints: summarizeRiskHints(extraction.behavior_hints, symbol.stable_key),
                    } satisfies NativeSymbolMatch;
                })
                .filter((value): value is NativeSymbolMatch => value !== null);

            matches.push(...symbols);
        } catch (err) {
            log.debug('Failed to read file during symbol search', {
                path: file.relativePath,
                error: err instanceof Error ? err.message : String(err),
            });
            unreadableFiles++;
        }
    }

    matches.sort((left, right) =>
        right.score - left.score ||
        left.file_path.localeCompare(right.file_path) ||
        left.canonical_name.localeCompare(right.canonical_name)
    );

    return {
        query,
        matches: matches.slice(0, maxResults),
        scanned_files: scannedFiles,
        truncated: discovery.truncated || matches.length > maxResults,
        unreadable_files: unreadableFiles,
    };
}

export async function buildNativeCodebaseOverview(
    repoPath: string,
    options?: {
        maxFiles?: number;
    }
): Promise<NativeCodebaseOverviewResult> {
    const discovery = await discoverWorkspaceFiles(repoPath, {
        maxFiles: options?.maxFiles ?? 1500,
        maxFileSize: DEFAULT_MAX_FILE_SIZE,
        supportedLanguagesOnly: false,
    });

    const directoryCounts = new Map<string, number>();
    const languageCounts = new Map<string, number>();
    const kindCounts = new Map<string, number>();
    const publicEntryPoints: string[] = [];
    const riskHotspots: Array<{
        canonical_name: string;
        kind: string;
        file_path: string;
        language: SupportedLanguage;
        visibility: string;
        risk_hints: string[];
    }> = [];

    let sourceFilesScanned = 0;
    let totalSymbols = 0;
    let publicApiCount = 0;
    let testFilesDetected = 0;
    let parseFailures = 0;
    let unreadableFiles = 0;

    for (const file of discovery.files) {
        const directory = path.dirname(file.relativePath) === '.' ? '.' : path.dirname(file.relativePath);
        directoryCounts.set(directory, (directoryCounts.get(directory) || 0) + 1);
        if (isTestLikePath(file.relativePath)) testFilesDetected++;

        if (!file.language) continue;
        const language = file.language;
        languageCounts.set(language, (languageCounts.get(language) || 0) + 1);

        try {
            const source = await readTextFile(file.absPath);
            if (source === null) continue;

            sourceFilesScanned++;
            const extraction = extractWithTreeSitter(file.relativePath, source, language);
            if (extraction.parse_confidence === 0) parseFailures++;

            totalSymbols += extraction.symbols.length;
            for (const symbol of extraction.symbols) {
                kindCounts.set(symbol.kind, (kindCounts.get(symbol.kind) || 0) + 1);
                if (symbol.visibility === 'public') {
                    publicApiCount++;
                    if (publicEntryPoints.length < 30) {
                        publicEntryPoints.push(`${symbol.kind}:${symbol.canonical_name} (${file.relativePath})`);
                    }
                }
                const riskHints = summarizeRiskHints(extraction.behavior_hints, symbol.stable_key);
                if (riskHints.length > 0) {
                    riskHotspots.push({
                        canonical_name: symbol.canonical_name,
                        kind: symbol.kind,
                        file_path: file.relativePath,
                        language,
                        visibility: symbol.visibility,
                        risk_hints: riskHints,
                    });
                }
            }
        } catch (err) {
            log.debug('Failed to read file during codebase overview', {
                path: file.relativePath,
                error: err instanceof Error ? err.message : String(err),
            });
            unreadableFiles++;
        }
    }

    // Sort hotspots by maximum severity first, then by hint count, then alphabetically.
    // A symbol with a single 'transaction' is more dangerous than one with 5 'throws'.
    const maxSeverity = (hints: string[]): number => {
        let max = 0;
        for (const hint of hints) {
            const hintType = hint.split(':')[0]!;
            const sev = RISK_SEVERITY[hintType] ?? 0;
            if (sev > max) max = sev;
        }
        return max;
    };
    riskHotspots.sort((left, right) =>
        maxSeverity(right.risk_hints) - maxSeverity(left.risk_hints) ||
        right.risk_hints.length - left.risk_hints.length ||
        left.file_path.localeCompare(right.file_path) ||
        left.canonical_name.localeCompare(right.canonical_name)
    );

    return {
        summary: {
            total_files_scanned: discovery.files.length,
            source_files_scanned: sourceFilesScanned,
            languages: Object.fromEntries(languageCounts.entries()),
            directories: [...directoryCounts.entries()].sort((left, right) => right[1] - left[1]).slice(0, 20),
            truncated: discovery.truncated,
        },
        symbols: {
            total: totalSymbols,
            by_kind: Object.fromEntries(kindCounts.entries()),
            public_api_count: publicApiCount,
            entry_points: publicEntryPoints,
        },
        testing_surface: {
            test_files_detected: testFilesDetected,
            heuristic_note: 'Pre-index heuristic only. Use full ingestion for symbol-level test coverage.',
        },
        risk_hotspots: riskHotspots.slice(0, 25),
        scan_health: {
            parse_failures: parseFailures,
            unreadable_files: unreadableFiles,
        },
    };
}
