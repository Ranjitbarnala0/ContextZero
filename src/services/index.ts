/**
 * ContextZero — Service Layer
 *
 * Transport-agnostic business logic shared between the REST API
 * (mcp-interface) and MCP bridge (mcp-bridge/handlers).
 *
 * Each service exports pure async functions that:
 * - Accept typed parameters (no Express req/res, no MCP result types)
 * - Return typed results
 * - Throw UserFacingError on validation/not-found failures
 */

export { resolveSymbol, getSymbolDetails } from './symbol-service';
export type { ResolvedSymbol, ResolveSymbolResult, SymbolDetailsResult } from './symbol-service';

export { getCodebaseOverview } from './overview-service';
export type { CodebaseOverview, RiskySymbol } from './overview-service';

export { compileSmartContext } from './context-service';
export type { SmartContextResult, SmartContextOptions, TargetSymbol, ContextSymbol } from './context-service';

export { searchCode } from './search-service';
export type { SearchCodeResult, SearchMatch, SearchCodeOptions } from './search-service';

export { listRepos, listSnapshots } from './repo-service';
export type { ListReposResult, ListSnapshotsResult } from './repo-service';

export { getNeighbors, explainRelation, getTests, findConcept, reviewHomolog } from './graph-service';
export type {
    GetNeighborsOptions, NeighborhoodResult, NeighborhoodNode, NeighborhoodEdge,
    ExplainRelationOptions, RelationExplanation,
    GetTestsOptions, TestsResult, TestInfo,
    FindConceptOptions, ConceptResult, ConceptMatch,
    ReviewHomologOptions, ReviewResult,
} from './graph-service';

export { computeSemanticDiff, computeContractDiff } from './diff-service';
export type {
    SemanticDiffOptions, SemanticDiffResult, SemanticChange,
    ContractDiffOptions, ContractDiffResult, ContractChange,
} from './diff-service';

export { planChange, prepareChange, applyPropagation } from './planning-service';
export type {
    PlanChangeOptions, ChangePlan, PlanTarget,
    PrepareChangeOptions, PrepareResult,
    ApplyPropagationOptions, PropagationResult,
} from './planning-service';

export {
    runRetentionPolicy, getRetentionStats, listStaleTransactions,
    cleanupExpiredSnapshots, enforceSnapshotCap,
    cleanupStaleTransactions, cleanupOrphanedData,
} from './retention-service';
export type { RetentionRunResult, RetentionStats, StaleTransactionInfo } from './retention-service';
