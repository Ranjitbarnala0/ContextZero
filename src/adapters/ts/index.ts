/**
 * ContextZero — TypeScript Language Adapter
 *
 * Symbol extraction using the TypeScript Compiler API.
 * Extracts symbols, relations, behavior hints, and contract hints
 * from source code.
 *
 * Uses:
 * - ts.createProgram for project-level type resolution
 * - ts.TypeChecker for type information extraction
 * - AST walking for symbol boundary detection
 * - 30+ regex patterns for behavioral side-effect detection
 * - SHA-256 hashing for AST and body fingerprints
 */

import * as ts from 'typescript';
import * as crypto from 'crypto';
import * as path from 'path';
import { Logger } from '../../logger';
import type {
    AdapterExtractionResult, ExtractedSymbol, ExtractedRelation,
    BehaviorHint, ContractHint,
} from '../../types';
import { normalizeForComparison } from './ast-normalizer';

const log = new Logger('ts-adapter');

/** Side-effect detection patterns for behavioral hints */
const BEHAVIOR_PATTERNS: { pattern: RegExp; hint_type: BehaviorHint['hint_type']; detail: string }[] = [
    // DB reads — require ORM-specific method suffixes or contextual DB object prefix
    // to avoid matching Map.get(), Array.find(), etc.
    { pattern: /\.find(One|Many|All|ById|Unique|First|Where)\s*\(/, hint_type: 'db_read', detail: 'orm_find' },
    { pattern: /\.select\s*\(\s*['"`{]/, hint_type: 'db_read', detail: 'query_select' },
    { pattern: /\.query\s*\(\s*['"`]/, hint_type: 'db_read', detail: 'raw_query' },
    { pattern: /\b(db|model|repo|repository|collection|table|prisma|knex|sequelize|typeorm|pool|client)\.\w*(?:get|find|select|query|count|aggregate)\w*\s*\(/, hint_type: 'db_read', detail: 'db_contextual_read' },
    // DB writes — require ORM-specific suffixes or contextual DB object prefix
    // to avoid matching Map.delete(), Set.delete(), Array.splice().create(), etc.
    { pattern: /\.save\s*\(\s*\{/, hint_type: 'db_write', detail: 'orm_save' },
    { pattern: /\.insert(One|Many)?\s*\(/, hint_type: 'db_write', detail: 'db_insert' },
    { pattern: /\.update(One|Many|ById|Where)?\s*\(\s*\{/, hint_type: 'db_write', detail: 'db_update' },
    { pattern: /\.delete(One|Many|ById|Where)\s*\(/, hint_type: 'db_write', detail: 'db_delete' },
    { pattern: /\.destroy\s*\(/, hint_type: 'db_write', detail: 'db_destroy' },
    { pattern: /\b(db|model|repo|repository|collection|table|prisma|knex|sequelize|typeorm|pool|client)\.\w*(?:save|insert|update|delete|remove|create|upsert|destroy)\w*\s*\(/, hint_type: 'db_write', detail: 'db_contextual_write' },
    // Network calls
    { pattern: /fetch\s*\(/, hint_type: 'network_call', detail: 'fetch' },
    { pattern: /axios\.(get|post|put|patch|delete)\s*\(/, hint_type: 'network_call', detail: 'axios' },
    { pattern: /\.request\s*\(/, hint_type: 'network_call', detail: 'http_request' },
    { pattern: /https?\.\s*(get|request)\s*\(/, hint_type: 'network_call', detail: 'node_http' },
    { pattern: /WebSocket/, hint_type: 'network_call', detail: 'websocket' },
    // File I/O
    { pattern: /fs\.(read|write|append|unlink|mkdir|rmdir)/, hint_type: 'file_io', detail: 'fs_operation' },
    { pattern: /readFile(Sync)?\s*\(/, hint_type: 'file_io', detail: 'read_file' },
    { pattern: /writeFile(Sync)?\s*\(/, hint_type: 'file_io', detail: 'write_file' },
    // Cache operations
    { pattern: /\.cache\.(get|set|del|clear)/, hint_type: 'cache_op', detail: 'cache_operation' },
    { pattern: /redis\.(get|set|hget|hset|del)/, hint_type: 'cache_op', detail: 'redis' },
    // Auth
    { pattern: /\.authenticate\s*\(/, hint_type: 'auth_check', detail: 'authenticate' },
    { pattern: /\.authorize\s*\(/, hint_type: 'auth_check', detail: 'authorize' },
    { pattern: /verify(Token|JWT|Session)/, hint_type: 'auth_check', detail: 'token_verify' },
    { pattern: /\.isAuthenticated/, hint_type: 'auth_check', detail: 'auth_check' },
    // Validation
    { pattern: /\.validate\s*\(/, hint_type: 'validation', detail: 'validate' },
    { pattern: /Joi\.|Yup\.|Zod\./, hint_type: 'validation', detail: 'schema_validation' },
    // Exception handling
    { pattern: /throw\s+new\s+\w+/, hint_type: 'throws', detail: 'throws' },
    { pattern: /catch\s*\(/, hint_type: 'catches', detail: 'catches' },
    // State mutation
    { pattern: /this\.\w+\s*=/, hint_type: 'state_mutation', detail: 'this_assignment' },
    { pattern: /\.setState\s*\(/, hint_type: 'state_mutation', detail: 'set_state' },
    // Transactions
    { pattern: /\.transaction\s*\(/, hint_type: 'transaction', detail: 'db_transaction' },
    { pattern: /BEGIN|COMMIT|ROLLBACK/, hint_type: 'transaction', detail: 'sql_transaction' },
    // Lock acquisition
    { pattern: /\.(lock|acquire|tryLock)\s*\(/, hint_type: 'acquires_lock', detail: 'lock_acquire' },
    { pattern: /[Mm]utex/, hint_type: 'acquires_lock', detail: 'mutex' },
    { pattern: /[Ss]emaphore/, hint_type: 'acquires_lock', detail: 'semaphore' },
    { pattern: /synchronized/, hint_type: 'acquires_lock', detail: 'synchronized' },
    // Serialization
    { pattern: /JSON\.stringify/, hint_type: 'serialization', detail: 'json_stringify' },
    { pattern: /\.(serialize|marshal)\s*\(/, hint_type: 'serialization', detail: 'serialize' },
    { pattern: /\.toJSON\s*\(/, hint_type: 'serialization', detail: 'to_json' },
    { pattern: /protobuf/, hint_type: 'serialization', detail: 'protobuf' },
    { pattern: /\.encode\s*\(/, hint_type: 'serialization', detail: 'encode' },
    // Logging (informational only)
    { pattern: /console\.(log|warn|error|info)/, hint_type: 'logging', detail: 'console' },
    { pattern: /log\.(debug|info|warn|error|fatal)/, hint_type: 'logging', detail: 'structured_log' },
];

function sha256(content: string): string {
    return crypto.createHash('sha256').update(content, 'utf-8').digest('hex');
}

function getVisibility(node: ts.Node): string {
    const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
    if (mods) {
        for (const mod of mods) {
            if (mod.kind === ts.SyntaxKind.PrivateKeyword) return 'private';
            if (mod.kind === ts.SyntaxKind.ProtectedKeyword) return 'protected';
        }
    }
    // Check for export keyword
    if (mods?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) return 'public';
    return 'internal';
}

function getNodeText(node: ts.Node, sourceFile: ts.SourceFile): string {
    return node.getText(sourceFile);
}

function getSignature(node: ts.Node, sourceFile: ts.SourceFile, checker: ts.TypeChecker): string {
    if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) {
        const name = node.name?.getText(sourceFile) || 'anonymous';
        const params = node.parameters.map(p => {
            const pName = p.name.getText(sourceFile);
            const pType = p.type ? p.type.getText(sourceFile) : checker.typeToString(checker.getTypeAtLocation(p));
            return `${pName}: ${pType}`;
        }).join(', ');
        const sig = checker.getSignatureFromDeclaration(node);
        const returnType = node.type
            ? node.type.getText(sourceFile)
            : sig
                ? checker.typeToString(checker.getReturnTypeOfSignature(sig))
                : 'unknown';
        return `${name}(${params}): ${returnType}`;
    }
    if (ts.isClassDeclaration(node)) {
        return `class ${node.name?.getText(sourceFile) || 'anonymous'}`;
    }
    if (ts.isInterfaceDeclaration(node)) {
        return `interface ${node.name.getText(sourceFile)}`;
    }
    if (ts.isTypeAliasDeclaration(node)) {
        return `type ${node.name.getText(sourceFile)}`;
    }
    if (ts.isEnumDeclaration(node)) {
        return `enum ${node.name.getText(sourceFile)}`;
    }
    if (ts.isVariableDeclaration(node)) {
        return node.name.getText(sourceFile);
    }
    return node.getText(sourceFile).substring(0, 100);
}

function classifyKind(node: ts.Node, sourceFile: ts.SourceFile): string {
    if (ts.isClassDeclaration(node)) return 'class';
    if (ts.isInterfaceDeclaration(node)) return 'interface';
    if (ts.isTypeAliasDeclaration(node)) return 'type_alias';
    if (ts.isEnumDeclaration(node)) return 'enum';
    if (ts.isMethodDeclaration(node)) return 'method';
    if (ts.isFunctionDeclaration(node)) {
        const text = node.getText(sourceFile);
        if (/router\.(get|post|put|delete|patch)|app\.(get|post|put|delete|patch)/.test(text)) {
            return 'route_handler';
        }
        return 'function';
    }
    if (ts.isVariableDeclaration(node)) return 'variable';
    return 'function';
}

/** Maximum files per TypeScript compiler batch to prevent OOM in large monorepos */
const BATCH_SIZE = 500;

/**
 * Extract all symbols, relations, behavior hints, and contract hints
 * from a set of TypeScript files.
 *
 * For repos with more than BATCH_SIZE files, processes files in batches
 * using a shared CompilerHost so cross-file type resolution still works
 * (the host caches parsed source files between batches).
 */
export function extractFromTypeScript(
    filePaths: string[],
    tsconfigPath?: string
): AdapterExtractionResult {
    const timer = log.startTimer('extractFromTypeScript', { fileCount: filePaths.length });
    const uncertaintyFlags: string[] = [];

    // Load compiler options
    let compilerOptions: ts.CompilerOptions = {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        strict: true,
        esModuleInterop: true,
        noEmit: true,
    };

    if (tsconfigPath) {
        const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
        if (!configFile.error) {
            const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, path.dirname(tsconfigPath));
            compilerOptions = parsed.options;
        } else {
            uncertaintyFlags.push('incomplete_type_info');
            log.warn('Failed to read tsconfig', { path: tsconfigPath });
        }
    }

    const symbols: ExtractedSymbol[] = [];
    const relations: ExtractedRelation[] = [];
    const behaviorHints: BehaviorHint[] = [];
    const contractHints: ContractHint[] = [];

    if (filePaths.length <= BATCH_SIZE) {
        // Small repo: single-program approach (no overhead)
        const program = ts.createProgram(filePaths, compilerOptions);
        const checker = program.getTypeChecker();

        for (const filePath of filePaths) {
            const sourceFile = program.getSourceFile(filePath);
            if (!sourceFile) {
                uncertaintyFlags.push('parse_error');
                log.warn('Source file not found in program', { filePath });
                continue;
            }

            extractFromSourceFile(
                sourceFile, checker, filePath,
                symbols, relations, behaviorHints, contractHints, uncertaintyFlags
            );
        }
    } else {
        // Large monorepo: batched extraction with shared CompilerHost
        // The shared host caches parsed files so cross-file type resolution
        // still works across batches while avoiding holding all ASTs in memory.
        const host = ts.createCompilerHost(compilerOptions);
        const totalBatches = Math.ceil(filePaths.length / BATCH_SIZE);
        log.info('Batched extraction enabled', { files: filePaths.length, batchSize: BATCH_SIZE, totalBatches });

        for (let batchIdx = 0; batchIdx < filePaths.length; batchIdx += BATCH_SIZE) {
            const batch = filePaths.slice(batchIdx, batchIdx + BATCH_SIZE);
            const batchNum = Math.floor(batchIdx / BATCH_SIZE) + 1;
            log.debug('Processing batch', { batch: batchNum, totalBatches, files: batch.length });

            const program = ts.createProgram(batch, compilerOptions, host);
            const checker = program.getTypeChecker();

            for (const filePath of batch) {
                const sourceFile = program.getSourceFile(filePath);
                if (!sourceFile) {
                    uncertaintyFlags.push('parse_error');
                    log.warn('Source file not found in program', { filePath });
                    continue;
                }

                extractFromSourceFile(
                    sourceFile, checker, filePath,
                    symbols, relations, behaviorHints, contractHints, uncertaintyFlags
                );
            }
        }
    }

    timer({
        symbols: symbols.length,
        relations: relations.length,
        behavior_hints: behaviorHints.length,
        contract_hints: contractHints.length,
    });

    return {
        symbols,
        relations,
        behavior_hints: behaviorHints,
        contract_hints: contractHints,
        parse_confidence: uncertaintyFlags.length === 0 ? 1.0 : Math.max(0.5, 1.0 - uncertaintyFlags.length * 0.1),
        uncertainty_flags: [...new Set(uncertaintyFlags)],
    };
}

function extractFromSourceFile(
    sourceFile: ts.SourceFile,
    checker: ts.TypeChecker,
    filePath: string,
    symbols: ExtractedSymbol[],
    relations: ExtractedRelation[],
    behaviorHints: BehaviorHint[],
    contractHints: ContractHint[],
    uncertaintyFlags: string[]
): void {
    const relativePath = filePath;

    function visit(node: ts.Node, parentKey?: string): void {
        // Extract top-level and class-member declarations
        const isExtractable =
            ts.isFunctionDeclaration(node) ||
            ts.isClassDeclaration(node) ||
            ts.isInterfaceDeclaration(node) ||
            ts.isTypeAliasDeclaration(node) ||
            ts.isEnumDeclaration(node) ||
            ts.isMethodDeclaration(node) ||
            (ts.isVariableStatement(node) && node.declarationList.declarations.length > 0);

        if (isExtractable) {
            let name: string | undefined;
            const targetNode: ts.Node = node;

            // For variable statements, iterate ALL declarations (not just the first)
            if (ts.isVariableStatement(node)) {
                for (const decl of node.declarationList.declarations) {
                    const declName = decl.name.getText(sourceFile);
                    if (!declName) continue;

                    const declStableKey = parentKey
                        ? `${relativePath}#${parentKey}.${declName}`
                        : `${relativePath}#${declName}`;

                    const declFullText = getNodeText(decl, sourceFile);
                    const { line: declStartLine, character: declStartCol } = sourceFile.getLineAndCharacterOfPosition(decl.getStart(sourceFile));
                    const { line: declEndLine, character: declEndCol } = sourceFile.getLineAndCharacterOfPosition(decl.getEnd());

                    let declSig = '';
                    try {
                        declSig = getSignature(decl, sourceFile, checker);
                    } catch {
                        declSig = declName;
                        uncertaintyFlags.push('type_inference_failure');
                    }

                    const declBodyText = declFullText.includes('{')
                        ? declFullText.substring(declFullText.indexOf('{'))
                        : declFullText;

                    let declNormalizedAstHash: string | undefined;
                    try {
                        declNormalizedAstHash = normalizeForComparison(declBodyText);
                    } catch {
                        uncertaintyFlags.push('normalization_failure');
                    }

                    symbols.push({
                        stable_key: declStableKey,
                        canonical_name: declName,
                        kind: classifyKind(node, sourceFile),
                        range_start_line: declStartLine + 1,
                        range_start_col: declStartCol + 1,
                        range_end_line: declEndLine + 1,
                        range_end_col: declEndCol + 1,
                        signature: declSig,
                        ast_hash: sha256(declFullText),
                        body_hash: sha256(declBodyText),
                        normalized_ast_hash: declNormalizedAstHash,
                        visibility: getVisibility(node),
                    });
                }
            } else if ('name' in node && node.name) {
                name = (node.name as ts.Identifier).getText(sourceFile);
            }

            if (!ts.isVariableStatement(node) && name) {
                const stableKey = parentKey
                    ? `${relativePath}#${parentKey}.${name}`
                    : `${relativePath}#${name}`;

                const fullText = getNodeText(node, sourceFile);
                const { line: startLine, character: startCol } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
                const { line: endLine, character: endCol } = sourceFile.getLineAndCharacterOfPosition(node.getEnd());

                let sig = '';
                try {
                    sig = getSignature(targetNode, sourceFile, checker);
                } catch {
                    sig = name;
                    uncertaintyFlags.push('type_inference_failure');
                }

                // Body text = full text minus the first line (signature)
                const bodyText = fullText.includes('{')
                    ? fullText.substring(fullText.indexOf('{'))
                    : fullText;

                // Compute normalized AST hash for structural similarity detection
                let normalizedAstHash: string | undefined;
                try {
                    normalizedAstHash = normalizeForComparison(bodyText);
                } catch {
                    // Fall back gracefully if normalization fails
                    uncertaintyFlags.push('normalization_failure');
                }

                symbols.push({
                    stable_key: stableKey,
                    canonical_name: name,
                    kind: classifyKind(node, sourceFile),
                    range_start_line: startLine + 1,
                    range_start_col: startCol + 1,
                    range_end_line: endLine + 1,
                    range_end_col: endCol + 1,
                    signature: sig,
                    ast_hash: sha256(fullText),
                    body_hash: sha256(bodyText),
                    normalized_ast_hash: normalizedAstHash,
                    visibility: getVisibility(node),
                });

                // Extract behavior hints from function/method bodies
                if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) {
                    extractBehaviorHints(fullText, stableKey, startLine + 1, behaviorHints);
                    extractContractHint(node, sourceFile, checker, stableKey, contractHints, uncertaintyFlags);
                }

                // Extract relations from function/method bodies
                if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) {
                    extractRelationsFromBody(node, sourceFile, checker, stableKey, relations);
                }

                // Recurse into class body for methods
                if (ts.isClassDeclaration(node)) {
                    node.members.forEach(member => visit(member, name));
                    // Extract implements/extends relations
                    if (node.heritageClauses) {
                        for (const clause of node.heritageClauses) {
                            const relType = clause.token === ts.SyntaxKind.ImplementsKeyword
                                ? 'implements' : 'inherits';
                            for (const type of clause.types) {
                                relations.push({
                                    source_key: stableKey,
                                    target_name: type.expression.getText(sourceFile),
                                    relation_type: relType as ExtractedRelation['relation_type'],
                                });
                            }
                        }
                    }
                    return; // Don't recurse again
                }
            }
        }

        ts.forEachChild(node, child => visit(child, parentKey));
    }

    visit(sourceFile);
}

function extractBehaviorHints(
    text: string,
    symbolKey: string,
    baseLine: number,
    hints: BehaviorHint[]
): void {
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        for (const bp of BEHAVIOR_PATTERNS) {
            if (bp.pattern.test(line)) {
                hints.push({
                    symbol_key: symbolKey,
                    hint_type: bp.hint_type,
                    detail: bp.detail,
                    line: baseLine + i,
                });
            }
        }
    }
}

function extractContractHint(
    node: ts.FunctionDeclaration | ts.MethodDeclaration,
    sourceFile: ts.SourceFile,
    checker: ts.TypeChecker,
    symbolKey: string,
    hints: ContractHint[],
    uncertaintyFlags: string[]
): void {
    try {
        const inputTypes = node.parameters.map(p => {
            if (p.type) return p.type.getText(sourceFile);
            return checker.typeToString(checker.getTypeAtLocation(p));
        });

        let outputType = 'void';
        if (node.type) {
            outputType = node.type.getText(sourceFile);
        } else {
            const sig = checker.getSignatureFromDeclaration(node);
            if (sig) {
                outputType = checker.typeToString(checker.getReturnTypeOfSignature(sig));
            }
        }

        // Extract thrown types from body
        const thrownTypes: string[] = [];
        const text = node.getText(sourceFile);
        const throwMatches = text.matchAll(/throw\s+new\s+(\w+)/g);
        for (const match of throwMatches) {
            if (match[1]) thrownTypes.push(match[1]);
        }

        // Extract decorators
        const decorators: string[] = [];
        const mods = ts.canHaveDecorators(node) ? ts.getDecorators(node) : undefined;
        if (mods) {
            for (const dec of mods) {
                decorators.push(dec.getText(sourceFile));
            }
        }

        hints.push({
            symbol_key: symbolKey,
            input_types: inputTypes,
            output_type: outputType,
            thrown_types: [...new Set(thrownTypes)],
            decorators,
        });
    } catch {
        uncertaintyFlags.push('type_inference_failure');
    }
}

function extractRelationsFromBody(
    node: ts.FunctionDeclaration | ts.MethodDeclaration,
    sourceFile: ts.SourceFile,
    checker: ts.TypeChecker,
    sourceKey: string,
    relations: ExtractedRelation[]
): void {
    /** Extract full dotted chain from a property access expression (e.g. this.service.repo.find → "this.service.repo.find") */
    function extractFullChain(expr: ts.Expression): string {
        if (ts.isIdentifier(expr)) {
            return expr.getText(sourceFile);
        }
        if (ts.isPropertyAccessExpression(expr)) {
            const base = extractFullChain(expr.expression);
            const member = expr.name.getText(sourceFile);
            return base ? `${base}.${member}` : member;
        }
        if (ts.isElementAccessExpression(expr)) {
            const base = extractFullChain(expr.expression);
            return base ? `${base}.[dynamic]` : '[dynamic]';
        }
        return expr.getText(sourceFile);
    }

    function walkBody(child: ts.Node): void {
        // Detect call expressions
        if (ts.isCallExpression(child)) {
            let targetName: string | undefined;
            let fullChain: string | undefined;

            if (ts.isIdentifier(child.expression)) {
                targetName = child.expression.getText(sourceFile);
            } else if (ts.isPropertyAccessExpression(child.expression)) {
                // Extract FULL chain (e.g. this.service.repo.find)
                fullChain = extractFullChain(child.expression);
                // Also extract just the method name for backward compatibility
                targetName = child.expression.name.getText(sourceFile);
            }

            // Emit full chain relation (primary — enables dispatch resolution)
            if (fullChain) {
                relations.push({
                    source_key: sourceKey,
                    target_name: fullChain,
                    relation_type: 'calls',
                });
                // Also emit bare method name (enables matching without type inference)
                if (targetName && targetName !== fullChain) {
                    relations.push({
                        source_key: sourceKey,
                        target_name: targetName,
                        relation_type: 'calls',
                    });
                }
            } else if (targetName) {
                relations.push({
                    source_key: sourceKey,
                    target_name: targetName,
                    relation_type: 'calls',
                });
            }
        }

        // Detect type references
        if (ts.isTypeReferenceNode(child)) {
            const typeName = child.typeName.getText(sourceFile);
            relations.push({
                source_key: sourceKey,
                target_name: typeName,
                relation_type: 'typed_as',
            });
        }

        ts.forEachChild(child, walkBody);
    }

    if (node.body) {
        ts.forEachChild(node.body, walkBody);
    }
}
