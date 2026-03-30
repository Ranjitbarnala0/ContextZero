/**
 * Unit tests for stale transaction recovery.
 */

const mockQuery = jest.fn();

jest.mock('../db-driver', () => ({
    db: {
        query: (...args: unknown[]) => mockQuery(...args),
    },
}));

jest.mock('../analysis-engine/behavioral', () => ({
    behavioralEngine: {
        getProfile: jest.fn(),
        compareBehavior: jest.fn(),
    },
}));

jest.mock('../analysis-engine/contracts', () => ({
    contractEngine: {
        getProfile: jest.fn(),
        compareContracts: jest.fn(),
    },
}));

jest.mock('../ingestor', () => ({
    ingestor: {
        ingestRepo: jest.fn(),
    },
}));

jest.mock('../transactional-editor/sandbox', () => ({
    sandboxExec: jest.fn(),
    sandboxTypeCheck: jest.fn(),
    sandboxRunTests: jest.fn(),
}));

describe('Transactional recovery', () => {
    beforeEach(() => {
        jest.resetModules();
        mockQuery.mockReset();
    });

    test('rolls back stale transactions with backups and cleans terminal leftovers', async () => {
        const { transactionalChangeEngine } = await import('../transactional-editor');
        const rollbackSpy = jest.spyOn(transactionalChangeEngine, 'rollback').mockResolvedValue();
        const transitionSpy = jest.spyOn(transactionalChangeEngine as any, 'transitionState').mockResolvedValue();

        mockQuery
            .mockResolvedValueOnce({
                rows: [
                    { txn_id: 'txn-backed-up', state: 'failed', backup_count: '2' },
                    { txn_id: 'txn-empty', state: 'failed', backup_count: '0' },
                ],
                rowCount: 2,
            })
            .mockResolvedValueOnce({
                rows: [{ backup_id: 'backup-1' }, { backup_id: 'backup-2' }],
                rowCount: 2,
            });

        const result = await transactionalChangeEngine.recoverStaleTransactions(60_000, 10);

        expect(rollbackSpy).toHaveBeenCalledWith('txn-backed-up');
        expect(transitionSpy).toHaveBeenCalledWith('txn-empty', 'rolled_back');
        expect(result).toEqual({
            scanned: 2,
            recovered: 2,
            recovery_failed: 0,
            cleaned_terminal_backups: 2,
        });
    });

    test('continues when one stale transaction recovery fails', async () => {
        const { transactionalChangeEngine } = await import('../transactional-editor');
        const rollbackSpy = jest.spyOn(transactionalChangeEngine, 'rollback')
            .mockRejectedValueOnce(new Error('disk restore failed'));

        mockQuery
            .mockResolvedValueOnce({
                rows: [{ txn_id: 'txn-001', state: 'failed', backup_count: '1' }],
                rowCount: 1,
            })
            .mockResolvedValueOnce({
                rows: [],
                rowCount: 0,
            });

        const result = await transactionalChangeEngine.recoverStaleTransactions(60_000, 10);

        expect(rollbackSpy).toHaveBeenCalledWith('txn-001');
        expect(result).toEqual({
            scanned: 1,
            recovered: 0,
            recovery_failed: 1,
            cleaned_terminal_backups: 0,
        });
    });
});
