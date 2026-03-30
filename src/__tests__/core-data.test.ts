import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { coreDataService } from '../db-driver/core_data';

const mockQuery = jest.fn();

jest.mock('../db-driver', () => ({
    db: {
        query: (...args: unknown[]) => mockQuery(...args),
    },
}));

describe('CoreDataService.createRepository', () => {
    let tempRoot: string;

    beforeEach(() => {
        mockQuery.mockReset();
        tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'contextzero-core-data-'));
    });

    afterEach(() => {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    });

    test('deduplicates repositories by canonical base path', async () => {
        const repoRoot = path.join(tempRoot, 'repo');
        const aliasRoot = path.join(tempRoot, 'repo-alias');
        fs.mkdirSync(repoRoot, { recursive: true });
        fs.symlinkSync(repoRoot, aliasRoot);

        mockQuery
            .mockResolvedValueOnce({ rows: [{ repo_id: 'repo-123' }], rowCount: 1 })
            .mockResolvedValueOnce({ rows: [], rowCount: 1 });

        const repoId = await coreDataService.createRepository({
            name: 'research-repo',
            default_branch: 'main',
            visibility: 'private',
            language_set: ['typescript'],
            base_path: aliasRoot,
        });

        expect(repoId).toBe('repo-123');
        expect(mockQuery).toHaveBeenNthCalledWith(
            1,
            'SELECT repo_id FROM repositories WHERE base_path = $1',
            [fs.realpathSync(repoRoot)],
        );
    });

    test('creates a new repository without name-based upsert collisions', async () => {
        const repoRoot = path.join(tempRoot, 'repo-two');
        fs.mkdirSync(repoRoot, { recursive: true });

        mockQuery
            .mockResolvedValueOnce({ rows: [], rowCount: 0 })
            .mockResolvedValueOnce({ rows: [{ repo_id: 'repo-456' }], rowCount: 1 });

        const repoId = await coreDataService.createRepository({
            name: 'shared-name',
            default_branch: 'main',
            visibility: 'private',
            language_set: ['typescript'],
            base_path: repoRoot,
        });

        expect(repoId).toBe('repo-456');
        expect(mockQuery).toHaveBeenCalledTimes(2);
        expect(mockQuery.mock.calls[1]?.[0]).toContain('INSERT INTO repositories');
        expect(mockQuery.mock.calls[1]?.[0]).not.toContain('ON CONFLICT (name)');
    });
});
