import * as fs from 'fs';
import * as path from 'path';

export interface ResolvedRepoPath {
    realBase: string;
    resolvedPath: string;
    realPath: string;
    existed: boolean;
}

/**
 * Reject paths containing characters that can bypass security checks:
 * - Null bytes (\0): truncate paths in C-based functions
 * - URL-encoded sequences that resolve to traversal: %2e, %2f, %5c
 * - Backslashes on POSIX (can confuse cross-platform path resolution)
 */
function assertSafePath(filePath: string): void {
    if (filePath.includes('\0')) {
        throw new Error('Path contains null byte — rejected');
    }
    // Reject URL-encoded path traversal sequences
    const lower = filePath.toLowerCase();
    if (lower.includes('%2e') || lower.includes('%2f') || lower.includes('%5c')) {
        throw new Error('Path contains URL-encoded characters — rejected');
    }
    // On POSIX systems, reject backslashes to prevent cross-platform confusion
    if (process.platform !== 'win32' && filePath.includes('\\')) {
        throw new Error('Path contains backslash — rejected on POSIX');
    }
}

export function resolveExistingPath(targetPath: string): string {
    assertSafePath(targetPath);
    return fs.realpathSync(path.resolve(targetPath));
}

export function isPathWithinBase(realBase: string, candidatePath: string): boolean {
    return candidatePath === realBase || candidatePath.startsWith(realBase + path.sep);
}

function findNearestExistingAncestor(targetPath: string): string {
    let current = targetPath;
    for (;;) {
        if (fs.existsSync(current)) {
            return current;
        }
        const parent = path.dirname(current);
        if (parent === current) {
            throw new Error(`Path traversal attempt blocked: ${targetPath}`);
        }
        current = parent;
    }
}

export function resolvePathWithinBase(
    basePath: string,
    filePath: string,
    options?: { allowMissing?: boolean }
): ResolvedRepoPath {
    assertSafePath(filePath);
    const realBase = resolveExistingPath(basePath);
    const resolvedPath = path.resolve(realBase, filePath);

    if (!isPathWithinBase(realBase, resolvedPath)) {
        throw new Error(`Path traversal attempt blocked: ${filePath}`);
    }

    const probePath = options?.allowMissing
        ? findNearestExistingAncestor(resolvedPath)
        : resolvedPath;
    const realProbePath = fs.realpathSync(probePath);

    if (!isPathWithinBase(realBase, realProbePath)) {
        throw new Error(`Path traversal attempt blocked: ${filePath} (symlink escape)`);
    }

    const existed = fs.existsSync(resolvedPath);
    const realPath = existed ? fs.realpathSync(resolvedPath) : resolvedPath;

    if (!isPathWithinBase(realBase, realPath)) {
        throw new Error(`Path traversal attempt blocked: ${filePath} (symlink escape)`);
    }

    return { realBase, resolvedPath, realPath, existed };
}
