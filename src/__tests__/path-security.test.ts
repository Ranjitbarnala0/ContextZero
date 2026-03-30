import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolvePathWithinBase } from '../path-security';

describe('path-security', () => {
    let tempRoot: string;

    beforeEach(() => {
        tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'contextzero-path-'));
    });

    afterEach(() => {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    });

    test('allows regular paths inside the repository root', () => {
        const repoRoot = path.join(tempRoot, 'repo');
        fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });

        const resolved = resolvePathWithinBase(repoRoot, 'src/index.ts', { allowMissing: true });

        expect(resolved.realBase).toBe(fs.realpathSync(repoRoot));
        expect(resolved.resolvedPath).toBe(path.join(fs.realpathSync(repoRoot), 'src', 'index.ts'));
        expect(resolved.existed).toBe(false);
    });

    test('blocks lexical path traversal outside the repository root', () => {
        const repoRoot = path.join(tempRoot, 'repo');
        fs.mkdirSync(repoRoot, { recursive: true });

        expect(() => resolvePathWithinBase(repoRoot, '../secrets.txt', { allowMissing: true }))
            .toThrow('Path traversal attempt blocked');
    });

    test('blocks symlink escapes through an existing parent directory', () => {
        const repoRoot = path.join(tempRoot, 'repo');
        const outsideRoot = path.join(tempRoot, 'outside');
        fs.mkdirSync(repoRoot, { recursive: true });
        fs.mkdirSync(outsideRoot, { recursive: true });
        fs.symlinkSync(outsideRoot, path.join(repoRoot, 'linked'));

        expect(() => resolvePathWithinBase(repoRoot, 'linked/new-file.ts', { allowMissing: true }))
            .toThrow('symlink escape');
    });
});
