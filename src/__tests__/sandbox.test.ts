/**
 * Unit tests for sandbox environment sanitization.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildSanitizedEnv } from '../transactional-editor/sandbox';

const ORIGINAL_ENV = process.env;

describe('Sandbox environment', () => {
    beforeEach(() => {
        process.env = {
            ...ORIGINAL_ENV,
            HOME: '/home/leaky-user',
            PATH: '/usr/bin',
            LANG: 'en_US.UTF-8',
            PYTHONPATH: '/secret/python',
            VIRTUAL_ENV: '/secret/venv',
            npm_config_cache: '/secret/npm-cache',
        };
    });

    afterAll(() => {
        process.env = ORIGINAL_ENV;
    });

    test('isolates host home and strips sensitive runtime variables', () => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'contextzero-sandbox-test-'));
        const env = buildSanitizedEnv(cwd, { CUSTOM_VAR: '1' });

        expect(env['HOME']).not.toBe('/home/leaky-user');
        expect(env['HOME']).toContain('contextzero-sandbox');
        expect(env['npm_config_cache']).toContain('contextzero-sandbox');
        expect(env['PYTHONPATH']).toBeUndefined();
        expect(env['VIRTUAL_ENV']).toBeUndefined();
        expect(env['CUSTOM_VAR']).toBe('1');
        expect(fs.existsSync(env['HOME']!)).toBe(true);
        expect(fs.existsSync(env['npm_config_cache']!)).toBe(true);

        fs.rmSync(env['HOME']!, { recursive: true, force: true });
        fs.rmSync(cwd, { recursive: true, force: true });
    });
});
