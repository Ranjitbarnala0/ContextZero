/**
 * TypeScript Adapter Unit Tests
 *
 * Tests the core extraction pipeline:
 * - Behavioral hint pattern matching (positive + negative cases)
 * - Symbol extraction from TypeScript source
 * - False positive prevention (crypto, Map, Set operations)
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

jest.mock('../db-driver', () => ({
    db: { query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }), batchInsert: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('../db-driver/core_data', () => ({
    coreDataService: { upsertBehavioralProfile: jest.fn(), insertContractProfile: jest.fn() },
}));

import { extractFromTypeScript } from '../adapters/ts/index';

let tmpDir: string;
let counter = 0;

beforeAll(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scg-ts-test-')); });
afterAll(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

function extract(source: string) {
    const fp = path.join(tmpDir, `t${++counter}.ts`);
    fs.writeFileSync(fp, source, 'utf-8');
    return extractFromTypeScript([fp]);
}

function hints(source: string) { return extract(source).behavior_hints; }
function symbols(source: string) { return extract(source).symbols; }
function ofType(h: any[], t: string) { return h.filter((x: any) => x.hint_type === t); }

// ── Behavioral Hints: Positive Cases ──

describe('Behavioral Hints — Positive', () => {
    test('detects .findOne()', () => {
        expect(ofType(hints('function f() { return db.findOne({ id: 1 }); }'), 'db_read').length).toBeGreaterThan(0);
    });
    test('detects .query("SQL")', () => {
        expect(ofType(hints('function f() { return db.query("SELECT 1"); }'), 'db_read').length).toBeGreaterThan(0);
    });
    test('detects db.insertOne()', () => {
        expect(ofType(hints('function f() { return db.insertOne({ x: 1 }); }'), 'db_write').length).toBeGreaterThan(0);
    });
    test('detects db.update()', () => {
        expect(ofType(hints('function f() { return db.update({ x: 1 }); }'), 'db_write').length).toBeGreaterThan(0);
    });
    test('detects .deleteOne()', () => {
        expect(ofType(hints('function f() { return repo.deleteOne({ id: 1 }); }'), 'db_write').length).toBeGreaterThan(0);
    });
    test('detects .updateMany({)', () => {
        expect(ofType(hints('function f() { return model.updateMany({ a: true }); }'), 'db_write').length).toBeGreaterThan(0);
    });
    test('detects fetch()', () => {
        expect(ofType(hints('async function f() { return fetch("https://api.com"); }'), 'network_call').length).toBeGreaterThan(0);
    });
    test('detects axios.get()', () => {
        expect(ofType(hints('async function f() { return axios.get("/api"); }'), 'network_call').length).toBeGreaterThan(0);
    });
    test('detects readFileSync()', () => {
        expect(ofType(hints('function f() { return readFileSync("f.txt"); }'), 'file_io').length).toBeGreaterThan(0);
    });
    test('detects fs.writeFile()', () => {
        expect(ofType(hints('function f() { fs.writeFile("o.txt", "d", () => {}); }'), 'file_io').length).toBeGreaterThan(0);
    });
    test('detects .transaction()', () => {
        expect(ofType(hints('async function f() { return db.transaction(async (t: any) => {}); }'), 'transaction').length).toBeGreaterThan(0);
    });
    test('detects throw new Error', () => {
        expect(ofType(hints('function f() { throw new Error("bad"); }'), 'throws').length).toBeGreaterThan(0);
    });
    test('detects catch', () => {
        expect(ofType(hints('function f() { try {} catch(e) { console.error(e); } }'), 'catches').length).toBeGreaterThan(0);
    });
    test('detects this.x =', () => {
        expect(ofType(hints('class C { n = 0; m() { this.n = 5; } }'), 'state_mutation').length).toBeGreaterThan(0);
    });
    test('detects console.log', () => {
        expect(ofType(hints('function f() { console.log("hi"); }'), 'logging').length).toBeGreaterThan(0);
    });
});

// ── Behavioral Hints: Negative (False Positive Prevention) ──

describe('Behavioral Hints — False Positives', () => {
    test('Map.get() is NOT db_read', () => {
        expect(ofType(hints('function f() { const m = new Map<string,string>(); return m.get("k"); }'), 'db_read').length).toBe(0);
    });
    test('crypto.update() is NOT db_write', () => {
        expect(ofType(hints(
            'import * as crypto from "crypto";\nfunction sha(s: string) { return crypto.createHash("sha256").update(s).digest("hex"); }'
        ), 'db_write').length).toBe(0);
    });
    test('Map.delete() is NOT db_write', () => {
        expect(ofType(hints('function f() { const m = new Map<string,string>(); m.delete("k"); }'), 'db_write').length).toBe(0);
    });
    test('Set.delete() is NOT db_write', () => {
        expect(ofType(hints('function f() { const s = new Set<string>(); s.delete("i"); }'), 'db_write').length).toBe(0);
    });
});

// ── Symbol Extraction ──

describe('Symbol Extraction', () => {
    test('extracts function', () => {
        const fn = symbols('export function greet(name: string): string { return "hi " + name; }').find(s => s.canonical_name === 'greet');
        expect(fn).toBeDefined();
        expect(fn!.kind).toBe('function');
        expect(fn!.visibility).toBe('public');
    });
    test('extracts class', () => {
        const cls = symbols('export class Svc { run() { return 1; } }').find(s => s.canonical_name === 'Svc');
        expect(cls).toBeDefined();
        expect(cls!.kind).toBe('class');
    });
    test('extracts interface', () => {
        const i = symbols('export interface Cfg { host: string; }').find(s => s.canonical_name === 'Cfg');
        expect(i).toBeDefined();
        expect(i!.kind).toBe('interface');
    });
    test('generates AST hash (64-char hex)', () => {
        const fn = symbols('function add(a: number, b: number) { return a + b; }').find(s => s.canonical_name === 'add');
        expect(fn).toBeDefined();
        expect(fn!.ast_hash).toMatch(/^[0-9a-f]{64}$/);
    });
    test('generates body hash (64-char hex)', () => {
        const fn = symbols('function compute() { return 42; }').find(s => s.canonical_name === 'compute');
        expect(fn).toBeDefined();
        expect(fn!.body_hash).toMatch(/^[0-9a-f]{64}$/);
    });
});
