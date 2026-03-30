/**
 * Comprehensive tests for semantic-engine tokenizer and similarity modules.
 * Covers: normalizeToken, tokenizeName, tokenizeBody, tokenizeSignature,
 *         tokenizeBehavior, tokenizeContract, computeTF, computeIDF,
 *         computeTFIDF, cosineSimilarity, generateMinHash,
 *         estimateJaccardFromMinHash, computeBandHashes, multiViewSimilarity
 */

import {
    normalizeToken,
    tokenizeName,
    tokenizeBody,
    tokenizeSignature,
    tokenizeBehavior,
    tokenizeContract,
} from '../semantic-engine/tokenizer';

import {
    computeTF,
    computeIDF,
    computeTFIDF,
    cosineSimilarity,
    generateMinHash,
    estimateJaccardFromMinHash,
    computeBandHashes,
    multiViewSimilarity,
    LSH_ROWS_PER_BAND,
} from '../semantic-engine/similarity';

import type { SparseVector } from '../semantic-engine/similarity';

// ────────── Tokenizer Tests ──────────

describe('normalizeToken', () => {
    it('lowercases tokens', () => {
        expect(normalizeToken('Hello')).toBe('hello');
        expect(normalizeToken('WORLD')).toBe('world');
    });

    it('removes trailing digits', () => {
        expect(normalizeToken('item1')).toBe('item');
        expect(normalizeToken('node42')).toBe('node');
    });

    it('returns empty string for tokens shorter than 2 chars', () => {
        expect(normalizeToken('a')).toBe('');
        expect(normalizeToken('X')).toBe('');
    });

    it('returns empty string when only digits remain after trailing strip', () => {
        expect(normalizeToken('a1')).toBe('');
    });

    it('stems programming suffixes', () => {
        expect(normalizeToken('handler')).toBe('handle');
        expect(normalizeToken('service')).toBe('serve');
        expect(normalizeToken('factory')).toBe('factor');
        expect(normalizeToken('builder')).toBe('build');
        expect(normalizeToken('provider')).toBe('provide');
        expect(normalizeToken('controller')).toBe('control');
        expect(normalizeToken('validator')).toBe('valid');
        expect(normalizeToken('serializer')).toBe('serial');
        expect(normalizeToken('repository')).toBe('repo');
        expect(normalizeToken('middleware')).toBe('middle');
        expect(normalizeToken('resolver')).toBe('resolv');
        expect(normalizeToken('adapter')).toBe('adapt');
        expect(normalizeToken('listener')).toBe('listen');
        expect(normalizeToken('observer')).toBe('observ');
        expect(normalizeToken('wrapper')).toBe('wrap');
        expect(normalizeToken('helper')).toBe('help');
        expect(normalizeToken('utility')).toBe('util');
    });

    it('does not stem partial matches', () => {
        expect(normalizeToken('myhandler')).toBe('myhandler');
        expect(normalizeToken('handlers')).toBe('handlers');
    });

    it('handles empty string', () => {
        expect(normalizeToken('')).toBe('');
    });

    it('preserves tokens that are long enough and not suffixes', () => {
        expect(normalizeToken('database')).toBe('database');
        expect(normalizeToken('query')).toBe('query');
    });
});

describe('tokenizeName', () => {
    it('splits camelCase names', () => {
        expect(tokenizeName('getUserData')).toEqual(['get', 'user', 'data']);
    });

    it('splits PascalCase names', () => {
        expect(tokenizeName('UserService')).toEqual(['user', 'serve']);
    });

    it('splits snake_case names', () => {
        expect(tokenizeName('get_user_data')).toEqual(['get', 'user', 'data']);
    });

    it('splits SCREAMING_SNAKE_CASE', () => {
        expect(tokenizeName('MAX_RETRY_COUNT')).toEqual(['max', 'retry', 'count']);
    });

    it('handles mixed cases like XMLParser', () => {
        const tokens = tokenizeName('XMLParser');
        expect(tokens).toContain('xml');
        expect(tokens).toContain('parser');
    });

    it('filters out short tokens', () => {
        expect(tokenizeName('a')).toEqual([]);
        expect(tokenizeName('getX')).toEqual(['get']);
    });

    it('applies stemming during name tokenization', () => {
        expect(tokenizeName('UserHandler')).toEqual(['user', 'handle']);
    });

    it('handles empty string', () => {
        expect(tokenizeName('')).toEqual([]);
    });

    it('handles single word', () => {
        expect(tokenizeName('database')).toEqual(['database']);
    });

    it('splits hyphenated names', () => {
        expect(tokenizeName('my-component')).toEqual(['my', 'component']);
    });
});

describe('tokenizeBody', () => {
    it('extracts identifiers from code', () => {
        const code = 'const user = getUser(id);';
        const tokens = tokenizeBody(code);
        expect(tokens).toContain('user');
        expect(tokens).toContain('get');
        expect(tokens).toContain('id');
    });

    it('strips single-line comments', () => {
        const code = 'const x = 5; // this is a comment\nconst y = 10;';
        const tokens = tokenizeBody(code);
        expect(tokens).not.toContain('comment');
    });

    it('strips multi-line comments', () => {
        const code = '/* multi\nline\ncomment */ const result = calculate();';
        const tokens = tokenizeBody(code);
        expect(tokens).not.toContain('multi');
        expect(tokens).not.toContain('line');
        expect(tokens).toContain('result');
        expect(tokens).toContain('calculate');
    });

    it('strips string literals (single, double, backtick)', () => {
        const code = `const a = 'hello'; const b = "world"; const c = \`template\`;`;
        const tokens = tokenizeBody(code);
        expect(tokens).not.toContain('hello');
        expect(tokens).not.toContain('world');
        expect(tokens).not.toContain('template');
    });

    it('strips numeric literals', () => {
        const code = 'const x = 42; const y = 3.14; const z = 0xFF;';
        const tokens = tokenizeBody(code);
        expect(tokens).not.toContain('42');
        expect(tokens).not.toContain('3');
        expect(tokens).not.toContain('FF');
    });

    it('removes noise words (keywords)', () => {
        const code = 'const result = async function foo() { return true; }';
        const tokens = tokenizeBody(code);
        expect(tokens).toContain('result');
        expect(tokens).toContain('foo');
        expect(tokens).not.toContain('const');
        expect(tokens).not.toContain('async');
        expect(tokens).not.toContain('function');
        expect(tokens).not.toContain('return');
        expect(tokens).not.toContain('true');
    });

    it('splits compound identifiers in body', () => {
        const code = 'const userData = getUserById(userId);';
        const tokens = tokenizeBody(code);
        expect(tokens).toContain('user');
        expect(tokens).toContain('data');
        expect(tokens).toContain('get');
    });

    it('handles empty body', () => {
        expect(tokenizeBody('')).toEqual([]);
    });

    it('truncates extremely large bodies', () => {
        const largeBody = 'const x = myIdentifier;\n'.repeat(10000);
        const tokens = tokenizeBody(largeBody);
        expect(tokens.length).toBeGreaterThan(0);
        expect(tokens.length).toBeLessThan(100000);
    });

    it('preserves duplicates for TF-IDF', () => {
        const code = 'user.name = user.email; user.save();';
        const tokens = tokenizeBody(code);
        const userCount = tokens.filter(t => t === 'user').length;
        expect(userCount).toBe(3);
    });
});

describe('tokenizeSignature', () => {
    it('extracts parameter and return types', () => {
        const sig = 'function getUser(id: string): Promise<User>';
        const tokens = tokenizeSignature(sig);
        expect(tokens).toContain('get');
        expect(tokens).toContain('user');
        expect(tokens).toContain('id');
        // 'Promise' is in NOISE_WORDS, so it's filtered out
        expect(tokens).not.toContain('promise');
    });

    it('removes noise words from signatures', () => {
        const sig = 'async function validate(input: string): boolean';
        const tokens = tokenizeSignature(sig);
        expect(tokens).not.toContain('async');
        expect(tokens).not.toContain('function');
        expect(tokens).not.toContain('string');
        expect(tokens).not.toContain('boolean');
        // 'validate' stays as-is (stemming only applies to exact suffix matches)
        expect(tokens).toContain('validate');
        expect(tokens).toContain('input');
    });

    it('handles empty signature', () => {
        expect(tokenizeSignature('')).toEqual([]);
    });
});

describe('tokenizeBehavior', () => {
    it('tokenizes hint types', () => {
        const hints = [{ hint_type: 'db_read', detail: 'users' }];
        const tokens = tokenizeBehavior(hints);
        expect(tokens).toContain('db');
        expect(tokens).toContain('read');
        expect(tokens).toContain('users');
    });

    it('tokenizes multiple hints', () => {
        const hints = [
            { hint_type: 'network_call', detail: 'fetchUserProfile' },
            { hint_type: 'file_write', detail: 'log.txt' },
        ];
        const tokens = tokenizeBehavior(hints);
        expect(tokens).toContain('network');
        expect(tokens).toContain('call');
        expect(tokens).toContain('fetch');
        expect(tokens).toContain('user');
        expect(tokens).toContain('profile');
        expect(tokens).toContain('file');
        expect(tokens).toContain('write');
        expect(tokens).toContain('log');
        expect(tokens).toContain('txt');
    });

    it('handles empty hints array', () => {
        expect(tokenizeBehavior([])).toEqual([]);
    });

    it('splits compound hint details', () => {
        const hints = [{ hint_type: 'state_mutation', detail: 'updateUserEmail' }];
        const tokens = tokenizeBehavior(hints);
        expect(tokens).toContain('update');
        expect(tokens).toContain('email');
    });
});

describe('tokenizeContract', () => {
    it('tokenizes input types', () => {
        const hint = {
            input_types: ['string', 'UserInput'],
            output_type: 'void',
            thrown_types: [],
            decorators: [],
        };
        const tokens = tokenizeContract(hint);
        expect(tokens).toContain('user');
        expect(tokens).toContain('input');
    });

    it('tokenizes output type', () => {
        const hint = {
            input_types: [],
            output_type: 'Promise<UserResponse>',
            thrown_types: [],
            decorators: [],
        };
        const tokens = tokenizeContract(hint);
        expect(tokens).toContain('user');
        expect(tokens).toContain('response');
        // 'Promise' is in NOISE_WORDS, so it's filtered out
        expect(tokens).not.toContain('promise');
    });

    it('tokenizes thrown types', () => {
        const hint = {
            input_types: [],
            output_type: 'void',
            thrown_types: ['NotFoundError', 'ValidationError'],
            decorators: [],
        };
        const tokens = tokenizeContract(hint);
        expect(tokens).toContain('not');
        expect(tokens).toContain('found');
        expect(tokens).toContain('error');
    });

    it('tokenizes decorators', () => {
        const hint = {
            input_types: [],
            output_type: 'void',
            thrown_types: [],
            decorators: ['@RequiresAuth', '@RateLimit(10)'],
        };
        const tokens = tokenizeContract(hint);
        expect(tokens).toContain('requires');
        expect(tokens).toContain('auth');
        expect(tokens).toContain('rate');
        expect(tokens).toContain('limit');
    });

    it('handles empty contract hint', () => {
        const hint = {
            input_types: [],
            output_type: '',
            thrown_types: [],
            decorators: [],
        };
        expect(tokenizeContract(hint)).toEqual([]);
    });
});

// ────────── Similarity Tests ──────────

describe('computeTF', () => {
    it('computes log-normalized term frequency', () => {
        const tokens = ['user', 'user', 'get'];
        const tf = computeTF(tokens);
        expect(tf['user']).toBeCloseTo(1 + Math.log(2));
        expect(tf['get']).toBeCloseTo(1 + Math.log(1));
    });

    it('handles empty token array', () => {
        expect(computeTF([])).toEqual({});
    });

    it('handles single token', () => {
        const tf = computeTF(['hello']);
        expect(tf['hello']).toBeCloseTo(1);
    });

    it('handles many duplicates', () => {
        const tokens = Array(100).fill('repeat');
        const tf = computeTF(tokens);
        expect(tf['repeat']).toBeCloseTo(1 + Math.log(100));
    });
});

describe('computeIDF', () => {
    it('computes smooth inverse document frequency', () => {
        const docs = [
            new Set(['user', 'get']),
            new Set(['user', 'set']),
            new Set(['data', 'query']),
        ];
        const idf = computeIDF(docs, 3);

        // 'user' appears in 2/3 docs
        expect(idf['user']).toBeCloseTo(Math.log(1 + 3 / (1 + 2)));
        // 'get' appears in 1/3 docs
        expect(idf['get']).toBeCloseTo(Math.log(1 + 3 / (1 + 1)));
    });

    it('returns empty for zero documents', () => {
        expect(computeIDF([], 0)).toEqual({});
    });

    it('handles negative totalDocs', () => {
        expect(computeIDF([], -1)).toEqual({});
    });
});

describe('computeTFIDF', () => {
    it('produces L2-normalized sparse vector', () => {
        const tf = computeTF(['hello', 'world', 'hello']);
        const idf: Record<string, number> = { hello: 1.5, world: 2.0 };
        const tfidf = computeTFIDF(tf, idf);

        // Verify L2 normalization
        let magnitude = 0;
        for (const v of Object.values(tfidf)) {
            magnitude += v * v;
        }
        expect(Math.sqrt(magnitude)).toBeCloseTo(1.0);
    });

    it('uses default IDF of 1.0 for missing tokens', () => {
        const tf = { unknown: 1.5 };
        const idf: Record<string, number> = {};
        const tfidf = computeTFIDF(tf, idf);
        expect(tfidf['unknown']).toBeDefined();
    });

    it('handles zero-magnitude vector', () => {
        const tfidf = computeTFIDF({}, {});
        expect(Object.keys(tfidf)).toHaveLength(0);
    });
});

describe('cosineSimilarity', () => {
    it('returns 1.0 for identical vectors', () => {
        const vec: SparseVector = { a: 0.5, b: 0.5, c: 0.707 };
        expect(cosineSimilarity(vec, vec)).toBeCloseTo(
            Object.values(vec).reduce((s, v) => s + v * v, 0)
        );
    });

    it('returns 0 for orthogonal vectors', () => {
        const a: SparseVector = { x: 1.0 };
        const b: SparseVector = { y: 1.0 };
        expect(cosineSimilarity(a, b)).toBe(0);
    });

    it('returns value in [0, 1]', () => {
        const a: SparseVector = { token1: 0.5, token2: 0.5 };
        const b: SparseVector = { token1: 0.3, token3: 0.7 };
        const sim = cosineSimilarity(a, b);
        expect(sim).toBeGreaterThanOrEqual(0);
        expect(sim).toBeLessThanOrEqual(1);
    });

    it('handles empty vectors', () => {
        expect(cosineSimilarity({}, {})).toBe(0);
        expect(cosineSimilarity({}, { a: 1 })).toBe(0);
    });

    it('is commutative', () => {
        const a: SparseVector = { x: 0.5, y: 0.3 };
        const b: SparseVector = { x: 0.7, z: 0.2 };
        expect(cosineSimilarity(a, b)).toBeCloseTo(cosineSimilarity(b, a));
    });
});

describe('generateMinHash', () => {
    it('produces array of specified length', () => {
        const sig = generateMinHash(new Set(['a', 'b', 'c']), 64);
        expect(sig).toHaveLength(64);
    });

    it('defaults to 128 permutations', () => {
        const sig = generateMinHash(new Set(['hello']));
        expect(sig).toHaveLength(128);
    });

    it('caps at 256 permutations', () => {
        const sig = generateMinHash(new Set(['hello']), 500);
        expect(sig).toHaveLength(256);
    });

    it('returns all 0xFFFFFFFF for empty set', () => {
        const sig = generateMinHash(new Set<string>(), 16);
        expect(sig.every(v => v === 0xFFFFFFFF)).toBe(true);
    });

    it('is deterministic', () => {
        const tokens = new Set(['foo', 'bar', 'baz']);
        const sig1 = generateMinHash(tokens, 32);
        const sig2 = generateMinHash(tokens, 32);
        expect(sig1).toEqual(sig2);
    });

    it('similar sets produce similar signatures', () => {
        const a = new Set(['user', 'get', 'data', 'query', 'result']);
        const b = new Set(['user', 'get', 'data', 'query', 'output']);
        const sigA = generateMinHash(a, 128);
        const sigB = generateMinHash(b, 128);
        const jaccard = estimateJaccardFromMinHash(sigA, sigB);
        // 4/6 overlap (union of 6 unique tokens) ≈ 0.67
        expect(jaccard).toBeGreaterThan(0.3);
    });

    it('disjoint sets produce low similarity', () => {
        const a = new Set(['apple', 'banana', 'cherry']);
        const b = new Set(['dog', 'elephant', 'frog']);
        const sigA = generateMinHash(a, 128);
        const sigB = generateMinHash(b, 128);
        const jaccard = estimateJaccardFromMinHash(sigA, sigB);
        expect(jaccard).toBeLessThan(0.2);
    });

    it('produces values within uint32 range', () => {
        const sig = generateMinHash(new Set(['test', 'value']), 128);
        for (const v of sig) {
            expect(v).toBeGreaterThanOrEqual(0);
            expect(v).toBeLessThanOrEqual(0xFFFFFFFF);
        }
    });
});

describe('estimateJaccardFromMinHash', () => {
    it('returns 1.0 for identical signatures', () => {
        const sig = generateMinHash(new Set(['a', 'b', 'c']), 128);
        expect(estimateJaccardFromMinHash(sig, sig)).toBe(1.0);
    });

    it('returns 0 for empty arrays', () => {
        expect(estimateJaccardFromMinHash([], [])).toBe(0);
    });

    it('returns 0 if one signature is all-sentinel (empty set)', () => {
        const emptySig = new Array(128).fill(0xFFFFFFFF);
        const realSig = generateMinHash(new Set(['hello', 'world']), 128);
        expect(estimateJaccardFromMinHash(emptySig, realSig)).toBe(0);
        expect(estimateJaccardFromMinHash(realSig, emptySig)).toBe(0);
    });

    it('returns 0 if both are all-sentinel', () => {
        const emptySig = new Array(128).fill(0xFFFFFFFF);
        expect(estimateJaccardFromMinHash(emptySig, emptySig)).toBe(0);
    });

    it('handles mismatched lengths (uses minimum)', () => {
        const a = generateMinHash(new Set(['a', 'b']), 64);
        const b = generateMinHash(new Set(['a', 'b']), 128);
        const jaccard = estimateJaccardFromMinHash(a, b);
        expect(jaccard).toBeDefined();
        expect(typeof jaccard).toBe('number');
    });
});

describe('computeBandHashes', () => {
    it('produces correct number of bands', () => {
        const sig = generateMinHash(new Set(['hello']), 128);
        const bands = computeBandHashes(sig, LSH_ROWS_PER_BAND);
        expect(bands).toHaveLength(Math.floor(128 / LSH_ROWS_PER_BAND));
    });

    it('defaults to LSH_ROWS_PER_BAND', () => {
        const sig = generateMinHash(new Set(['hello']), 128);
        const bands = computeBandHashes(sig);
        expect(bands).toHaveLength(Math.floor(128 / LSH_ROWS_PER_BAND));
    });

    it('is deterministic', () => {
        const sig = generateMinHash(new Set(['foo', 'bar']), 128);
        const bands1 = computeBandHashes(sig);
        const bands2 = computeBandHashes(sig);
        expect(bands1).toEqual(bands2);
    });

    it('identical signatures produce identical band hashes', () => {
        const tokens = new Set(['a', 'b', 'c']);
        const sig1 = generateMinHash(tokens, 128);
        const sig2 = generateMinHash(tokens, 128);
        expect(computeBandHashes(sig1)).toEqual(computeBandHashes(sig2));
    });

    it('different signatures may share some bands', () => {
        const a = new Set(['user', 'get', 'data', 'query', 'result']);
        const b = new Set(['user', 'get', 'data', 'query', 'output']);
        const bandsA = computeBandHashes(generateMinHash(a, 128));
        const bandsB = computeBandHashes(generateMinHash(b, 128));
        // Similar sets should share at least one band
        const shared = bandsA.some((h, i) => h === bandsB[i]);
        expect(shared).toBe(true);
    });

    it('produces signed 32-bit integers', () => {
        const sig = generateMinHash(new Set(['test']), 128);
        const bands = computeBandHashes(sig);
        for (const h of bands) {
            expect(h).toBeGreaterThanOrEqual(-2147483648);
            expect(h).toBeLessThanOrEqual(2147483647);
        }
    });

    it('handles small signatures', () => {
        const sig = [1, 2, 3, 4];
        const bands = computeBandHashes(sig, 2);
        expect(bands).toHaveLength(2);
    });

    it('drops remainder when signature not evenly divisible', () => {
        const sig = [1, 2, 3, 4, 5];
        const bands = computeBandHashes(sig, 2);
        expect(bands).toHaveLength(2); // floor(5/2) = 2
    });
});

describe('multiViewSimilarity', () => {
    it('computes weighted similarity across views', () => {
        const viewsA = new Map<string, SparseVector>([
            ['name', { user: 0.5, get: 0.5 }],
            ['body', { query: 0.7, result: 0.3 }],
        ]);
        const viewsB = new Map<string, SparseVector>([
            ['name', { user: 0.5, get: 0.5 }],
            ['body', { query: 0.7, output: 0.3 }],
        ]);
        const weights = { name: 0.3, body: 0.7 };
        const sim = multiViewSimilarity(viewsA, viewsB, weights);
        expect(sim).toBeGreaterThan(0);
        expect(sim).toBeLessThanOrEqual(1);
    });

    it('returns 0 when no common views', () => {
        const viewsA = new Map<string, SparseVector>([['name', { a: 1 }]]);
        const viewsB = new Map<string, SparseVector>([['body', { b: 1 }]]);
        const weights = { name: 0.5, body: 0.5 };
        expect(multiViewSimilarity(viewsA, viewsB, weights)).toBe(0);
    });

    it('ignores missing views and renormalizes', () => {
        const viewsA = new Map<string, SparseVector>([
            ['name', { a: 1 }],
        ]);
        const viewsB = new Map<string, SparseVector>([
            ['name', { a: 1 }],
            ['body', { b: 1 }],
        ]);
        const weights = { name: 0.3, body: 0.7 };
        // Only 'name' is in both, so similarity = cosine(name_A, name_B) / (0.3/0.3)
        const sim = multiViewSimilarity(viewsA, viewsB, weights);
        expect(sim).toBeCloseTo(1.0);
    });

    it('returns 0 for empty views', () => {
        const empty = new Map<string, SparseVector>();
        expect(multiViewSimilarity(empty, empty, { name: 1 })).toBe(0);
    });

    it('handles zero weight', () => {
        const views = new Map<string, SparseVector>([['name', { a: 1 }]]);
        expect(multiViewSimilarity(views, views, { name: 0 })).toBe(0);
    });
});

// ────────── Integration: End-to-End Tokenizer + Similarity ──────────

describe('end-to-end tokenizer → similarity pipeline', () => {
    it('similar functions produce high similarity', () => {
        const codeA = `
            function getUser(id: string): Promise<User> {
                const result = await db.query('SELECT * FROM users WHERE id = $1', [id]);
                return result.rows[0];
            }
        `;
        const codeB = `
            function fetchUser(userId: string): Promise<User> {
                const data = await database.query('SELECT * FROM users WHERE id = $1', [userId]);
                return data.rows[0];
            }
        `;

        const tokensA = tokenizeBody(codeA);
        const tokensB = tokenizeBody(codeB);

        const allDocs = [new Set(tokensA), new Set(tokensB)];
        const idf = computeIDF(allDocs, 2);

        const tfA = computeTF(tokensA);
        const tfB = computeTF(tokensB);

        const vecA = computeTFIDF(tfA, idf);
        const vecB = computeTFIDF(tfB, idf);

        const sim = cosineSimilarity(vecA, vecB);
        expect(sim).toBeGreaterThan(0.3);
    });

    it('dissimilar functions produce low similarity', () => {
        const codeA = `
            function calculateTax(amount: number, rate: number): number {
                return amount * rate;
            }
        `;
        const codeB = `
            function sendEmail(to: string, subject: string, body: string): void {
                const transport = createTransport(config);
                transport.send({ to, subject, html: body });
            }
        `;

        const tokensA = tokenizeBody(codeA);
        const tokensB = tokenizeBody(codeB);

        const allDocs = [new Set(tokensA), new Set(tokensB)];
        const idf = computeIDF(allDocs, 2);

        const vecA = computeTFIDF(computeTF(tokensA), idf);
        const vecB = computeTFIDF(computeTF(tokensB), idf);

        const sim = cosineSimilarity(vecA, vecB);
        expect(sim).toBeLessThan(0.3);
    });

    it('MinHash LSH detects similar code as candidates', () => {
        const tokensA = new Set(tokenizeBody('function getUser(id) { return db.findById(id); }'));
        const tokensB = new Set(tokenizeBody('function fetchUser(userId) { return db.findById(userId); }'));
        const tokensC = new Set(tokenizeBody('function sendEmail(to, subject) { smtp.send(to, subject); }'));

        const sigA = generateMinHash(tokensA);
        const sigB = generateMinHash(tokensB);
        const sigC = generateMinHash(tokensC);

        const simAB = estimateJaccardFromMinHash(sigA, sigB);
        const simAC = estimateJaccardFromMinHash(sigA, sigC);

        // A and B are similar functions, A and C are not
        expect(simAB).toBeGreaterThan(simAC);
    });
});
