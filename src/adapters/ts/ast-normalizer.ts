/**
 * ContextZero — AST Normalization Engine
 *
 * Produces rename-invariant, whitespace-invariant normalized hashes
 * for code comparison. Used by the homolog engine to detect structural
 * similarity between functions regardless of variable naming.
 */

import * as crypto from 'crypto';

/**
 * Compute SHA-256 hash of a normalized AST form.
 */
export function computeNormalizedHash(normalizedForm: string): string {
    return crypto.createHash('sha256').update(normalizedForm, 'utf-8').digest('hex');
}

/**
 * Regex-based normalization that works across all 13 supported languages.
 *
 * Steps:
 * 1. Remove single-line comments (//...)
 * 2. Remove multi-line comments
 * 3. Collapse whitespace
 * 4. Alpha-rename const/let/var declarations to v0, v1, ...
 * 5. Alpha-rename parameter names in (name: type, ...) patterns to p0, p1, ...
 * 6. Hash the result with SHA-256
 */
export function normalizeForComparison(code: string): string {
    let normalized = code;

    // Protect string literals from comment stripping by replacing them with placeholders.
    const stringLiterals: string[] = [];
    normalized = normalized.replace(
        /`(?:[^`\\]|\\.)*`|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g,
        (match) => {
            const idx = stringLiterals.length;
            stringLiterals.push(match);
            return `__STR_${idx}__`;
        }
    );

    // Remove single-line comments (safe now that strings are placeholders)
    normalized = normalized.replace(/\/\/[^\n]*/g, '');

    // Remove multi-line comments
    normalized = normalized.replace(/\/\*[\s\S]*?\*\//g, '');

    // Restore string literals
    normalized = normalized.replace(/__STR_(\d+)__/g, (_match, idx) => stringLiterals[Number(idx)] ?? _match);

    // Collapse whitespace
    normalized = normalized.replace(/\s+/g, ' ').trim();

    // Alpha-rename function/class declaration names
    let fnCounter = 0;
    const fnMap = new Map<string, string>();

    normalized = normalized.replace(
        /\b(function|class)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/g,
        (_match, keyword: string, name: string) => {
            if (!fnMap.has(name)) {
                fnMap.set(name, `_F${fnCounter++}`);
            }
            return `${keyword} ${fnMap.get(name)!}`;
        }
    );

    // Alpha-rename local variable declarations
    let varCounter = 0;
    const varMap = new Map<string, string>();

    normalized = normalized.replace(
        /\b(const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/g,
        (_match, keyword: string, name: string) => {
            if (!varMap.has(name)) {
                varMap.set(name, `v${varCounter++}`);
            }
            return `${keyword} ${varMap.get(name)!}`;
        }
    );

    // Alpha-rename parameter names in function signatures
    let paramCounter = 0;
    const paramMap = new Map<string, string>();

    normalized = normalized.replace(
        /\(([^)]*)\)\s*(?:=>|{|:)/g,
        (fullMatch, paramList: string) => {
            const renamedParams = paramList.replace(
                /([a-zA-Z_$][a-zA-Z0-9_$]*)(\s*[?]?\s*:\s*[^,)]*)?/g,
                (_pm: string, pName: string, pType: string) => {
                    if (['string', 'number', 'boolean', 'void', 'any', 'unknown', 'never', 'null', 'undefined', 'object', 'Record', 'Promise', 'Array'].includes(pName)) {
                        return _pm;
                    }
                    if (!paramMap.has(pName)) {
                        paramMap.set(pName, `p${paramCounter++}`);
                    }
                    return `${paramMap.get(pName)!}${pType || ''}`;
                }
            );
            return `(${renamedParams})${fullMatch.slice(fullMatch.indexOf(')') + 1)}`;
        }
    );

    // Replace all renamed identifiers in a SINGLE pass to prevent cascading corruption
    const allReplacements = new Map<string, string>();
    for (const [original, replacement] of fnMap) allReplacements.set(original, replacement);
    for (const [original, replacement] of varMap) allReplacements.set(original, replacement);
    for (const [original, replacement] of paramMap) allReplacements.set(original, replacement);

    if (allReplacements.size > 0) {
        const escapedKeys = [...allReplacements.keys()]
            .sort((a, b) => b.length - a.length)
            .map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        const combinedRegex = new RegExp(`\\b(${escapedKeys.join('|')})\\b`, 'g');
        normalized = normalized.replace(combinedRegex, (match) => allReplacements.get(match) ?? match);
    }

    // Final structural normalization
    normalized = normalized.replace(/\s*([(){}[\],;:=<>+\-*/&|!?.])\s*/g, '$1');
    normalized = normalized.replace(/;{2,}/g, ';');
    normalized = normalized.replace(/\s+/g, ' ').trim();

    return computeNormalizedHash(normalized);
}
