/**
 * Tests for CircuitBreaker and isTransientError from db-driver.
 *
 * CircuitBreaker and isTransientError are exported directly from
 * src/db-driver/index.ts without pulling in the DatabaseDriver singleton
 * (which needs a live PG connection). We import them via the barrel export.
 */

// Mock pg and the db-driver config BEFORE importing the module so the
// DatabaseDriver singleton constructor doesn't blow up trying to connect.
jest.mock('pg', () => {
    const mockPool = {
        query: jest.fn(),
        connect: jest.fn(),
        end: jest.fn(),
        on: jest.fn(),
        totalCount: 0,
        idleCount: 0,
        waitingCount: 0,
    };
    return { Pool: jest.fn(() => mockPool) };
});

jest.mock('../db-driver/config', () => ({
    getConnectionConfig: jest.fn(() => ({
        host: 'localhost',
        port: 5432,
        database: 'test',
        user: 'test',
        password: 'test',
    })),
}));

import { CircuitBreaker, isTransientError } from '../db-driver';

// ---------------------------------------------------------------------------
// CircuitBreaker
// ---------------------------------------------------------------------------

describe('CircuitBreaker', () => {
    beforeEach(() => {
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    test('initial state is closed', () => {
        const cb = new CircuitBreaker();
        expect(cb.getState()).toEqual({ state: 'closed', consecutiveFailures: 0 });
    });

    test('stays closed on success', () => {
        const cb = new CircuitBreaker();
        cb.recordSuccess();
        cb.recordSuccess();
        cb.recordSuccess();
        expect(cb.getState().state).toBe('closed');
        expect(cb.getState().consecutiveFailures).toBe(0);
    });

    test('success resets consecutive failure count while closed', () => {
        const cb = new CircuitBreaker({ failureThreshold: 5 });
        cb.recordFailure();
        cb.recordFailure();
        expect(cb.getState().consecutiveFailures).toBe(2);

        cb.recordSuccess();
        expect(cb.getState().consecutiveFailures).toBe(0);
        expect(cb.getState().state).toBe('closed');
    });

    test('opens after N consecutive failures (failureThreshold)', () => {
        const threshold = 3;
        const cb = new CircuitBreaker({ failureThreshold: threshold });

        for (let i = 0; i < threshold - 1; i++) {
            cb.recordFailure();
            expect(cb.getState().state).toBe('closed');
        }

        // The Nth failure should trip the breaker
        cb.recordFailure();
        expect(cb.getState().state).toBe('open');
        expect(cb.getState().consecutiveFailures).toBe(threshold);
    });

    test('open state throws error on check()', () => {
        const cb = new CircuitBreaker({ failureThreshold: 2 });
        cb.recordFailure();
        cb.recordFailure();
        expect(cb.getState().state).toBe('open');

        expect(() => cb.check()).toThrow('circuit breaker is OPEN');
    });

    test('transitions from open to half-open after resetTimeoutMs', () => {
        const resetTimeoutMs = 5000;
        const cb = new CircuitBreaker({ failureThreshold: 2, resetTimeoutMs });

        // Trip the breaker
        cb.recordFailure();
        cb.recordFailure();
        expect(cb.getState().state).toBe('open');

        // Not enough time has elapsed — should still throw
        jest.advanceTimersByTime(resetTimeoutMs - 1);
        expect(() => cb.check()).toThrow('circuit breaker is OPEN');

        // Advance past the reset timeout
        jest.advanceTimersByTime(1);

        // Now check() should NOT throw and should transition to half-open
        expect(() => cb.check()).not.toThrow();
        expect(cb.getState().state).toBe('half-open');
    });

    test('half-open closes after N successes (halfOpenMaxSuccesses)', () => {
        const cb = new CircuitBreaker({
            failureThreshold: 2,
            resetTimeoutMs: 1000,
            halfOpenMaxSuccesses: 3,
        });

        // Trip to open
        cb.recordFailure();
        cb.recordFailure();
        expect(cb.getState().state).toBe('open');

        // Advance time to allow half-open
        jest.advanceTimersByTime(1000);
        cb.check(); // transitions to half-open
        expect(cb.getState().state).toBe('half-open');

        // Record successes up to threshold
        cb.recordSuccess();
        expect(cb.getState().state).toBe('half-open');
        cb.recordSuccess();
        expect(cb.getState().state).toBe('half-open');
        cb.recordSuccess(); // 3rd success — should close
        expect(cb.getState().state).toBe('closed');
        expect(cb.getState().consecutiveFailures).toBe(0);
    });

    test('half-open re-opens on failure', () => {
        const cb = new CircuitBreaker({
            failureThreshold: 2,
            resetTimeoutMs: 1000,
            halfOpenMaxSuccesses: 3,
        });

        // Trip to open
        cb.recordFailure();
        cb.recordFailure();

        // Move to half-open
        jest.advanceTimersByTime(1000);
        cb.check();
        expect(cb.getState().state).toBe('half-open');

        // One success then a failure
        cb.recordSuccess();
        cb.recordFailure();
        expect(cb.getState().state).toBe('open');
    });

    test('getState() returns correct state info through full lifecycle', () => {
        const cb = new CircuitBreaker({
            failureThreshold: 2,
            resetTimeoutMs: 500,
            halfOpenMaxSuccesses: 1,
        });

        // Closed
        let info = cb.getState();
        expect(info.state).toBe('closed');
        expect(info.consecutiveFailures).toBe(0);

        // Record failures to open
        cb.recordFailure();
        info = cb.getState();
        expect(info.state).toBe('closed');
        expect(info.consecutiveFailures).toBe(1);

        cb.recordFailure();
        info = cb.getState();
        expect(info.state).toBe('open');
        expect(info.consecutiveFailures).toBe(2);

        // Half-open
        jest.advanceTimersByTime(500);
        cb.check();
        info = cb.getState();
        expect(info.state).toBe('half-open');

        // Close via success
        cb.recordSuccess();
        info = cb.getState();
        expect(info.state).toBe('closed');
        expect(info.consecutiveFailures).toBe(0);
    });

    test('check() allows requests through in half-open state (probing)', () => {
        const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 100 });
        cb.recordFailure(); // open
        jest.advanceTimersByTime(100);
        cb.check(); // transitions to half-open

        // A second check in half-open should still be allowed (probing)
        expect(() => cb.check()).not.toThrow();
    });
});

// ---------------------------------------------------------------------------
// isTransientError
// ---------------------------------------------------------------------------

describe('isTransientError', () => {
    const transientCodes = [
        { code: '08000', label: 'connection_exception' },
        { code: '08003', label: 'connection_does_not_exist' },
        { code: '08006', label: 'connection_failure' },
        { code: '57P01', label: 'admin_shutdown' },
        { code: '57P03', label: 'cannot_connect_now' },
        { code: '40001', label: 'serialization_failure' },
        { code: '40P01', label: 'deadlock_detected' },
    ];

    test.each(transientCodes)(
        'PG error code $code ($label) is transient',
        ({ code }) => {
            const err = Object.assign(new Error('pg error'), { code });
            expect(isTransientError(err)).toBe(true);
        },
    );

    test('non-transient PG code 23505 (unique_violation) returns false', () => {
        const err = Object.assign(new Error('duplicate key value'), { code: '23505' });
        expect(isTransientError(err)).toBe(false);
    });

    test('Connection terminated message returns true', () => {
        expect(isTransientError(new Error('Connection terminated unexpectedly'))).toBe(true);
    });

    test('ECONNREFUSED message returns true', () => {
        expect(isTransientError(new Error('connect ECONNREFUSED 127.0.0.1:5432'))).toBe(true);
    });

    test('ECONNRESET message returns true', () => {
        expect(isTransientError(new Error('read ECONNRESET'))).toBe(true);
    });

    test('connection timeout message returns true', () => {
        expect(isTransientError(new Error('connection timeout expired'))).toBe(true);
    });

    test('regular Error without code or matching message returns false', () => {
        expect(isTransientError(new Error('some random error'))).toBe(false);
    });

    test('null returns false', () => {
        expect(isTransientError(null)).toBe(false);
    });

    test('undefined returns false', () => {
        expect(isTransientError(undefined)).toBe(false);
    });

    test('non-object values return false', () => {
        expect(isTransientError(42)).toBe(false);
        expect(isTransientError('string')).toBe(false);
        expect(isTransientError(true)).toBe(false);
    });
});
