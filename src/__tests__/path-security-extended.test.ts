import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    resolveExistingPath,
    resolvePathWithinBase,
    isPathWithinBase,
} from '../path-security';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempRoot(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'cz-path-ext-'));
}

// ---------------------------------------------------------------------------
// assertSafePath (tested indirectly via resolveExistingPath / resolvePathWithinBase)
// ---------------------------------------------------------------------------

describe('assertSafePath (via resolveExistingPath / resolvePathWithinBase)', () => {
    let tempRoot: string;
    let repoRoot: string;

    beforeEach(() => {
        tempRoot = makeTempRoot();
        repoRoot = path.join(tempRoot, 'repo');
        fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
    });

    afterEach(() => {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    });

    test('rejects null byte injection', () => {
        expect(() =>
            resolvePathWithinBase(repoRoot, 'valid/path\x00../../etc/passwd', { allowMissing: true }),
        ).toThrow('null byte');
    });

    test('rejects URL-encoded traversal (%2e%2e/%2f)', () => {
        expect(() =>
            resolvePathWithinBase(repoRoot, '%2e%2e/%2f', { allowMissing: true }),
        ).toThrow('URL-encoded');
    });

    test('rejects URL-encoded dot (%2e%2e)', () => {
        expect(() =>
            resolvePathWithinBase(repoRoot, '%2e%2e', { allowMissing: true }),
        ).toThrow('URL-encoded');
    });

    test('rejects URL-encoded backslash (%5c)', () => {
        expect(() =>
            resolvePathWithinBase(repoRoot, '%5c', { allowMissing: true }),
        ).toThrow('URL-encoded');
    });

    test('rejects case-insensitive URL encoding (%2E, %2F, %5C)', () => {
        expect(() =>
            resolvePathWithinBase(repoRoot, '%2E%2E', { allowMissing: true }),
        ).toThrow('URL-encoded');

        expect(() =>
            resolvePathWithinBase(repoRoot, '%2F', { allowMissing: true }),
        ).toThrow('URL-encoded');

        expect(() =>
            resolvePathWithinBase(repoRoot, '%5C', { allowMissing: true }),
        ).toThrow('URL-encoded');
    });

    test('rejects backslash on POSIX', () => {
        if (process.platform === 'win32') return; // skip on Windows
        expect(() =>
            resolvePathWithinBase(repoRoot, '..\\..\\etc', { allowMissing: true }),
        ).toThrow('backslash');
    });

    test('double encoding (%252e%252e) — known limitation: not caught by URL-encoded check', () => {
        // The guard checks for literal %2e but NOT double-encoded %252e.
        // This documents the known limitation: the function does NOT reject
        // double-encoded sequences because after the first decode pass they
        // become %2e, which is only dangerous if a second decode is applied.
        // Since the code never URL-decodes, %252e is treated as literal text
        // and resolves harmlessly inside the base directory.
        expect(() =>
            resolvePathWithinBase(repoRoot, '%252e%252e', { allowMissing: true }),
        ).not.toThrow();
    });

    test('allows clean path (src/index.ts)', () => {
        const result = resolvePathWithinBase(repoRoot, 'src/index.ts', { allowMissing: true });
        expect(result.resolvedPath).toBe(
            path.join(fs.realpathSync(repoRoot), 'src', 'index.ts'),
        );
    });
});

// ---------------------------------------------------------------------------
// resolvePathWithinBase
// ---------------------------------------------------------------------------

describe('resolvePathWithinBase', () => {
    let tempRoot: string;
    let repoRoot: string;

    beforeEach(() => {
        tempRoot = makeTempRoot();
        repoRoot = path.join(tempRoot, 'repo');
        fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
    });

    afterEach(() => {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    });

    test('valid path within base resolves correctly', () => {
        // Create an actual file so `existed` is true
        const filePath = path.join(repoRoot, 'src', 'hello.ts');
        fs.writeFileSync(filePath, 'export default 42;\n');

        const result = resolvePathWithinBase(repoRoot, 'src/hello.ts');
        expect(result.realBase).toBe(fs.realpathSync(repoRoot));
        expect(result.resolvedPath).toBe(path.join(fs.realpathSync(repoRoot), 'src', 'hello.ts'));
        expect(result.realPath).toBe(fs.realpathSync(filePath));
        expect(result.existed).toBe(true);
    });

    test('traversal ../../../etc/passwd is blocked', () => {
        expect(() =>
            resolvePathWithinBase(repoRoot, '../../../etc/passwd', { allowMissing: true }),
        ).toThrow('Path traversal attempt blocked');
    });

    test('symlink escape is detected and blocked', () => {
        const outsideDir = path.join(tempRoot, 'outside-secrets');
        fs.mkdirSync(outsideDir, { recursive: true });
        fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'top-secret');

        // Create a symlink inside the repo that points outside
        fs.symlinkSync(outsideDir, path.join(repoRoot, 'escape'));

        expect(() =>
            resolvePathWithinBase(repoRoot, 'escape/secret.txt'),
        ).toThrow('symlink escape');
    });

    test('allowMissing: true succeeds for non-existent file in valid dir', () => {
        const result = resolvePathWithinBase(repoRoot, 'src/does-not-exist.ts', {
            allowMissing: true,
        });
        expect(result.existed).toBe(false);
        expect(result.resolvedPath).toContain('does-not-exist.ts');
    });

    test('allowMissing: false (default) for non-existent file throws ENOENT', () => {
        expect(() =>
            resolvePathWithinBase(repoRoot, 'src/does-not-exist.ts'),
        ).toThrow(/ENOENT/);
    });
});

// ---------------------------------------------------------------------------
// isPathWithinBase
// ---------------------------------------------------------------------------

describe('isPathWithinBase', () => {
    test('exact match returns true', () => {
        expect(isPathWithinBase('/home/user/repo', '/home/user/repo')).toBe(true);
    });

    test('subdirectory returns true', () => {
        expect(
            isPathWithinBase('/home/user/repo', '/home/user/repo/src/index.ts'),
        ).toBe(true);
    });

    test('sibling directory returns false', () => {
        expect(
            isPathWithinBase('/home/user/repo', '/home/user/other-repo/src'),
        ).toBe(false);
    });

    test('prefix attack: /home/user vs /home/username returns false (path.sep boundary)', () => {
        // "/home/username".startsWith("/home/user") is true in a naive check,
        // but isPathWithinBase uses path.sep so it correctly rejects this.
        expect(isPathWithinBase('/home/user', '/home/username')).toBe(false);
    });

    test('parent directory returns false', () => {
        expect(isPathWithinBase('/home/user/repo', '/home/user')).toBe(false);
    });

    test('unrelated absolute path returns false', () => {
        expect(isPathWithinBase('/home/user/repo', '/etc/passwd')).toBe(false);
    });
});
