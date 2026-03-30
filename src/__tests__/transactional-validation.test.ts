import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TransactionalChangeEngine } from '../transactional-editor';
import { behavioralEngine } from '../analysis-engine/behavioral';
import { contractEngine } from '../analysis-engine/contracts';
import type { BehavioralProfile, ChangeTransaction, ContractProfile } from '../types';

const mockQuery = jest.fn();
const mockIngestRepo = jest.fn();

jest.mock('../db-driver', () => ({
    db: {
        query: (...args: unknown[]) => mockQuery(...args),
        transaction: jest.fn(),
        queryWithClient: jest.fn(),
    },
}));

jest.mock('../transactional-editor/sandbox', () => ({
    sandboxExec: jest.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
    sandboxTypeCheck: jest.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
    sandboxRunTests: jest.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
}));

jest.mock('../ingestor', () => ({
    ingestor: {
        ingestRepo: (...args: unknown[]) => mockIngestRepo(...args),
    },
}));

function makeTransaction(overrides?: Partial<ChangeTransaction>): ChangeTransaction {
    return {
        txn_id: 'txn-001',
        repo_id: 'repo-001',
        base_snapshot_id: 'snap-base',
        created_by: 'tester',
        state: 'patched',
        target_symbol_versions: ['sv-base'],
        patches: [{ file_path: 'src/index.ts', new_content: 'export const x = 1;\n' }],
        impact_report_ref: null,
        validation_report_ref: null,
        propagation_report_ref: null,
        created_at: new Date(),
        updated_at: new Date(),
        ...overrides,
    };
}

function makeContract(symbolVersionId: string, overrides?: Partial<ContractProfile>): ContractProfile {
    return {
        contract_profile_id: `cp-${symbolVersionId}`,
        symbol_version_id: symbolVersionId,
        input_contract: '(input: string)',
        output_contract: 'string',
        error_contract: 'none',
        schema_refs: [],
        api_contract_refs: [],
        serialization_contract: 'none',
        security_contract: 'none',
        derived_invariants_count: 0,
        ...overrides,
    };
}

function makeBehavior(symbolVersionId: string, overrides?: Partial<BehavioralProfile>): BehavioralProfile {
    return {
        behavior_profile_id: `bp-${symbolVersionId}`,
        symbol_version_id: symbolVersionId,
        purity_class: 'pure',
        resource_touches: [],
        db_reads: [],
        db_writes: [],
        network_calls: [],
        cache_ops: [],
        file_io: [],
        auth_operations: [],
        validation_operations: [],
        exception_profile: [],
        state_mutation_profile: [],
        transaction_profile: [],
        ...overrides,
    };
}

describe('Transactional validation snapshots', () => {
    const engine = new TransactionalChangeEngine();
    let repoRoot: string;

    beforeEach(() => {
        mockQuery.mockReset();
        mockIngestRepo.mockReset();
        jest.restoreAllMocks();

        repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'contextzero-txn-validate-'));
        fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
    });

    afterEach(() => {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    test('validates against the post-patch snapshot instead of the base snapshot', async () => {
        mockQuery
            .mockResolvedValueOnce({ rows: [makeTransaction()], rowCount: 1 })
            .mockResolvedValueOnce({ rows: [{ name: 'repo', default_branch: 'main' }], rowCount: 1 })
            .mockResolvedValueOnce({ rows: [{ branch: 'main' }], rowCount: 1 })
            .mockResolvedValueOnce({ rows: [{ index_status: 'complete' }], rowCount: 1 })
            .mockResolvedValueOnce({
                rows: [{
                    base_symbol_version_id: 'sv-base',
                    validation_symbol_version_id: 'sv-validated',
                    symbol_id: 'sym-001',
                    canonical_name: 'doWork',
                }],
                rowCount: 1,
            })
            .mockResolvedValueOnce({ rows: [{ state: 'patched' }], rowCount: 1 })
            .mockResolvedValueOnce({ rows: [{ txn_id: 'txn-001' }], rowCount: 1 })
            .mockResolvedValueOnce({ rows: [{ state: 'reindexed' }], rowCount: 1 })
            .mockResolvedValueOnce({ rows: [{ txn_id: 'txn-001' }], rowCount: 1 })
            .mockResolvedValueOnce({ rows: [], rowCount: 1 });

        mockIngestRepo.mockResolvedValue({
            repo_id: 'repo-001',
            snapshot_id: 'snap-validated',
            files_processed: 1,
            files_failed: 0,
            symbols_extracted: 1,
            relations_extracted: 0,
            behavior_hints_extracted: 0,
            contract_hints_extracted: 0,
            duration_ms: 1,
        });

        const contractSpy = jest.spyOn(contractEngine, 'getProfile')
            .mockImplementation(async (svId: string) => makeContract(svId));
        const behaviorSpy = jest.spyOn(behavioralEngine, 'getProfile')
            .mockImplementation(async (svId: string) => makeBehavior(svId));

        const report = await engine.validate('txn-001', repoRoot, 'standard');

        expect(report.overall_passed).toBe(true);
        expect(report.validation_snapshot_id).toBe('snap-validated');
        expect(mockIngestRepo).toHaveBeenCalledWith(
            repoRoot,
            'repo',
            expect.stringMatching(/^txnval-/),
            'main',
            'snap-base',
        );
        expect(contractSpy).toHaveBeenCalledWith('sv-base');
        expect(contractSpy).toHaveBeenCalledWith('sv-validated');
        expect(behaviorSpy).toHaveBeenCalledWith('sv-base');
        expect(behaviorSpy).toHaveBeenCalledWith('sv-validated');
    });

    test('fails validation when the post-patch snapshot cannot map a target symbol', async () => {
        mockQuery
            .mockResolvedValueOnce({ rows: [makeTransaction()], rowCount: 1 })
            .mockResolvedValueOnce({ rows: [{ name: 'repo', default_branch: 'main' }], rowCount: 1 })
            .mockResolvedValueOnce({ rows: [{ branch: 'main' }], rowCount: 1 })
            .mockResolvedValueOnce({ rows: [{ index_status: 'complete' }], rowCount: 1 })
            .mockResolvedValueOnce({
                rows: [{
                    base_symbol_version_id: 'sv-base',
                    validation_symbol_version_id: null,
                    symbol_id: 'sym-001',
                    canonical_name: 'doWork',
                }],
                rowCount: 1,
            })
            .mockResolvedValueOnce({ rows: [{ state: 'patched' }], rowCount: 1 })
            .mockResolvedValueOnce({ rows: [{ txn_id: 'txn-001' }], rowCount: 1 })
            .mockResolvedValueOnce({ rows: [{ state: 'reindexed' }], rowCount: 1 })
            .mockResolvedValueOnce({ rows: [{ txn_id: 'txn-001' }], rowCount: 1 })
            .mockResolvedValueOnce({ rows: [], rowCount: 1 });

        mockIngestRepo.mockResolvedValue({
            repo_id: 'repo-001',
            snapshot_id: 'snap-validated',
            files_processed: 1,
            files_failed: 0,
            symbols_extracted: 1,
            relations_extracted: 0,
            behavior_hints_extracted: 0,
            contract_hints_extracted: 0,
            duration_ms: 1,
        });

        jest.spyOn(contractEngine, 'getProfile').mockResolvedValue(makeContract('sv-base'));

        const report = await engine.validate('txn-001', repoRoot, 'standard');

        expect(report.overall_passed).toBe(false);
        expect(report.validation_snapshot_id).toBe('snap-validated');
        expect(report.levels[2]?.name).toBe('contract_delta');
        expect(report.levels[2]?.failures).toContain(
            'Validation snapshot missing target symbol: doWork (sv-base)'
        );
    });
});
