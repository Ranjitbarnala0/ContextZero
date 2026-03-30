/**
 * Unit tests for Prometheus Metrics module.
 */

import { EventEmitter } from 'events';
import { Request, Response, NextFunction } from 'express';

// We need to reset module state between tests because counters/histograms/gauges
// are module-level singletons.
let incrementCounter: typeof import('../metrics')['incrementCounter'];
let setGauge: typeof import('../metrics')['setGauge'];
let observeHistogram: typeof import('../metrics')['observeHistogram'];
let renderMetrics: typeof import('../metrics')['renderMetrics'];
let metricsMiddleware: typeof import('../metrics')['metricsMiddleware'];

beforeEach(async () => {
    jest.resetModules();
    const mod = await import('../metrics');
    incrementCounter = mod.incrementCounter;
    setGauge = mod.setGauge;
    observeHistogram = mod.observeHistogram;
    renderMetrics = mod.renderMetrics;
    metricsMiddleware = mod.metricsMiddleware;
});

// ── incrementCounter ──

describe('incrementCounter', () => {
    test('creates a new counter with value 1', () => {
        incrementCounter('scg_requests_total');
        const output = renderMetrics();
        expect(output).toContain('scg_requests_total 1');
    });

    test('increments existing counter', () => {
        incrementCounter('scg_requests_total');
        incrementCounter('scg_requests_total');
        incrementCounter('scg_requests_total');
        const output = renderMetrics();
        expect(output).toContain('scg_requests_total 3');
    });

    test('supports labels', () => {
        incrementCounter('scg_requests_total', { method: 'GET', status: '200' });
        incrementCounter('scg_requests_total', { method: 'GET', status: '200' });
        const output = renderMetrics();
        expect(output).toContain('scg_requests_total{method="GET",status="200"} 2');
    });

    test('different label sets create separate series', () => {
        incrementCounter('scg_requests_total', { method: 'GET' });
        incrementCounter('scg_requests_total', { method: 'POST' });
        const output = renderMetrics();
        expect(output).toContain('scg_requests_total{method="GET"} 1');
        expect(output).toContain('scg_requests_total{method="POST"} 1');
    });

    test('labels are sorted alphabetically in the key', () => {
        incrementCounter('scg_requests_total', { z: '1', a: '2' });
        const output = renderMetrics();
        // Labels should be sorted: a before z
        expect(output).toContain('scg_requests_total{a="2",z="1"} 1');
    });

    test('renders HELP and TYPE for known counters', () => {
        incrementCounter('scg_requests_total');
        const output = renderMetrics();
        expect(output).toContain('# HELP scg_requests_total Total number of HTTP requests received');
        expect(output).toContain('# TYPE scg_requests_total counter');
    });

    test('MAX_METRIC_SERIES guard prevents unbounded growth', () => {
        // Create 10_000 unique series to hit the cap
        for (let i = 0; i < 10_000; i++) {
            incrementCounter('scg_requests_total', { id: String(i) });
        }

        // The 10_001st series should be silently dropped
        incrementCounter('scg_requests_total', { id: 'overflow' });

        const output = renderMetrics();
        expect(output).not.toContain('id="overflow"');
    });
});

// ── setGauge ──

describe('setGauge', () => {
    test('sets a gauge value', () => {
        setGauge('scg_db_pool_total', 10);
        const output = renderMetrics();
        expect(output).toContain('scg_db_pool_total 10');
    });

    test('overwrites existing gauge value', () => {
        setGauge('scg_db_pool_total', 10);
        setGauge('scg_db_pool_total', 25);
        const output = renderMetrics();
        expect(output).toContain('scg_db_pool_total 25');
        expect(output).not.toContain('scg_db_pool_total 10');
    });

    test('renders HELP and TYPE for known gauges', () => {
        setGauge('scg_db_pool_total', 5);
        const output = renderMetrics();
        expect(output).toContain('# HELP scg_db_pool_total Total number of connections in the database pool');
        expect(output).toContain('# TYPE scg_db_pool_total gauge');
    });

    test('handles zero value', () => {
        setGauge('scg_db_pool_idle', 0);
        const output = renderMetrics();
        expect(output).toContain('scg_db_pool_idle 0');
    });

    test('handles negative value', () => {
        setGauge('scg_db_pool_waiting', -5);
        const output = renderMetrics();
        expect(output).toContain('scg_db_pool_waiting -5');
    });

    test('handles very large value', () => {
        setGauge('scg_db_pool_total', 999_999_999);
        const output = renderMetrics();
        expect(output).toContain('scg_db_pool_total 999999999');
    });

    test('MAX_METRIC_SERIES guard prevents unbounded growth', () => {
        // Fill up to the cap with unique gauge names
        for (let i = 0; i < 10_000; i++) {
            setGauge(`gauge_${i}`, i);
        }

        // New gauge beyond cap should be silently dropped
        setGauge('gauge_overflow', 42);

        const output = renderMetrics();
        expect(output).not.toContain('gauge_overflow');
    });

    test('overwriting existing gauge does not count toward cap', () => {
        setGauge('scg_db_pool_total', 1);

        // Fill remaining capacity
        for (let i = 0; i < 9_999; i++) {
            setGauge(`gauge_${i}`, i);
        }

        // Overwrite the first gauge - should succeed since key already exists
        setGauge('scg_db_pool_total', 99);
        const output = renderMetrics();
        expect(output).toContain('scg_db_pool_total 99');
    });
});

// ── observeHistogram ──

describe('observeHistogram', () => {
    test('records observation in the correct bucket', () => {
        // Buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]
        observeHistogram('scg_request_duration_seconds', 0.03); // fits in 0.05 bucket
        const output = renderMetrics();
        expect(output).toContain('scg_request_duration_seconds_bucket{le="0.01"} 0');
        expect(output).toContain('scg_request_duration_seconds_bucket{le="0.05"} 1');
        expect(output).toContain('scg_request_duration_seconds_sum 0.03');
        expect(output).toContain('scg_request_duration_seconds_count 1');
    });

    test('records value in lowest matching bucket', () => {
        // 0.01 fits in the 0.01 bucket (value <= bucket boundary)
        observeHistogram('scg_request_duration_seconds', 0.01);
        const output = renderMetrics();
        expect(output).toContain('scg_request_duration_seconds_bucket{le="0.01"} 1');
    });

    test('cumulative bucket counts in rendered output', () => {
        // Two observations: one in 0.05 bucket, one in 0.5 bucket
        observeHistogram('scg_request_duration_seconds', 0.03); // bucket 0.05
        observeHistogram('scg_request_duration_seconds', 0.4);  // bucket 0.5

        const output = renderMetrics();
        // Cumulative: 0.01->0, 0.05->1, 0.1->1, 0.25->1, 0.5->2
        expect(output).toContain('scg_request_duration_seconds_bucket{le="0.01"} 0');
        expect(output).toContain('scg_request_duration_seconds_bucket{le="0.05"} 1');
        expect(output).toContain('scg_request_duration_seconds_bucket{le="0.1"} 1');
        expect(output).toContain('scg_request_duration_seconds_bucket{le="0.25"} 1');
        expect(output).toContain('scg_request_duration_seconds_bucket{le="0.5"} 2');
        expect(output).toContain('scg_request_duration_seconds_bucket{le="+Inf"} 2');
    });

    test('+Inf bucket captures observations exceeding all bucket boundaries', () => {
        observeHistogram('scg_request_duration_seconds', 100); // exceeds all buckets
        const output = renderMetrics();

        // No defined bucket should contain this observation
        expect(output).toContain('scg_request_duration_seconds_bucket{le="10"} 0');
        // But +Inf always equals count
        expect(output).toContain('scg_request_duration_seconds_bucket{le="+Inf"} 1');
        expect(output).toContain('scg_request_duration_seconds_sum 100');
        expect(output).toContain('scg_request_duration_seconds_count 1');
    });

    test('ignores unknown histogram names', () => {
        observeHistogram('unknown_histogram', 1.0);
        const output = renderMetrics();
        expect(output).not.toContain('unknown_histogram');
    });

    test('supports labels on histograms', () => {
        observeHistogram('scg_request_duration_seconds', 0.5, { method: 'GET' });
        const output = renderMetrics();
        expect(output).toContain('scg_request_duration_seconds_bucket{method="GET",le="0.5"} 1');
    });

    test('renders HELP and TYPE for known histograms', () => {
        observeHistogram('scg_request_duration_seconds', 0.1);
        const output = renderMetrics();
        expect(output).toContain('# HELP scg_request_duration_seconds Duration of HTTP requests in seconds');
        expect(output).toContain('# TYPE scg_request_duration_seconds histogram');
    });

    test('zero value observation goes into lowest bucket', () => {
        observeHistogram('scg_request_duration_seconds', 0);
        const output = renderMetrics();
        expect(output).toContain('scg_request_duration_seconds_bucket{le="0.01"} 1');
    });

    test('sum accumulates across multiple observations', () => {
        observeHistogram('scg_request_duration_seconds', 1.0);
        observeHistogram('scg_request_duration_seconds', 2.0);
        observeHistogram('scg_request_duration_seconds', 3.0);
        const output = renderMetrics();
        expect(output).toContain('scg_request_duration_seconds_sum 6');
        expect(output).toContain('scg_request_duration_seconds_count 3');
    });

    test('MAX_METRIC_SERIES guard prevents unbounded histogram growth', () => {
        // Fill up the histogram map to the cap
        for (let i = 0; i < 10_000; i++) {
            observeHistogram('scg_request_duration_seconds', 0.01, { id: String(i) });
        }

        // The next unique series should be dropped
        observeHistogram('scg_request_duration_seconds', 0.01, { id: 'overflow' });

        const output = renderMetrics();
        expect(output).not.toContain('id="overflow"');
    });
});

// ── renderMetrics ──

describe('renderMetrics', () => {
    test('renders empty output (just newline) when no metrics exist', () => {
        const output = renderMetrics();
        expect(output).toBe('\n');
    });

    test('renders counters, histograms, and gauges together', () => {
        incrementCounter('scg_requests_total');
        observeHistogram('scg_request_duration_seconds', 0.05);
        setGauge('scg_db_pool_total', 10);

        const output = renderMetrics();

        // All three metric types should be present
        expect(output).toContain('scg_requests_total 1');
        expect(output).toContain('scg_request_duration_seconds_bucket');
        expect(output).toContain('scg_db_pool_total 10');
    });

    test('sections are separated by double newlines', () => {
        incrementCounter('scg_requests_total');
        setGauge('scg_db_pool_total', 5);

        const output = renderMetrics();
        // Counter section and gauge section separated by \n\n
        expect(output).toContain('\n\n');
    });

    test('output ends with a trailing newline', () => {
        incrementCounter('scg_requests_total');
        const output = renderMetrics();
        expect(output.endsWith('\n')).toBe(true);
    });
});

// ── metricsMiddleware ──

describe('metricsMiddleware', () => {
    function createMockReqRes(overrides?: {
        method?: string;
        statusCode?: number;
        routePath?: string;
        path?: string;
        authFailure?: boolean;
    }) {
        const res = new EventEmitter() as EventEmitter & Partial<Response>;
        res.statusCode = overrides?.statusCode ?? 200;
        res.locals = overrides?.authFailure ? { authFailure: true } : {};

        const req: Partial<Request> = {
            method: overrides?.method ?? 'GET',
            path: overrides?.path,
            route: overrides?.routePath ? { path: overrides.routePath } as any : undefined,
        };

        return { req: req as Request, res: res as Response };
    }

    test('calls next() immediately', () => {
        const { req, res } = createMockReqRes();
        const next = jest.fn();

        metricsMiddleware(req, res, next);

        expect(next).toHaveBeenCalledTimes(1);
    });

    test('increments request counter on finish', () => {
        const { req, res } = createMockReqRes({ routePath: '/test', method: 'GET', statusCode: 200 });
        const next = jest.fn();

        metricsMiddleware(req, res, next);
        (res as EventEmitter).emit('finish');

        const output = renderMetrics();
        expect(output).toContain('scg_requests_total');
    });

    test('records latency histogram on finish', () => {
        const { req, res } = createMockReqRes({ routePath: '/test' });
        const next = jest.fn();

        metricsMiddleware(req, res, next);
        (res as EventEmitter).emit('finish');

        const output = renderMetrics();
        expect(output).toContain('scg_request_duration_seconds');
    });

    test('uses a safe raw path fallback when route metadata is unavailable', () => {
        const { req, res } = createMockReqRes({ path: '/scg_resolve_symbol' });
        const next = jest.fn();

        metricsMiddleware(req, res, next);
        (res as EventEmitter).emit('finish');

        const output = renderMetrics();
        expect(output).toContain('path="/scg_resolve_symbol"');
    });

    test('uses "unmatched" for unknown raw paths', () => {
        const { req, res } = createMockReqRes(); // no routePath -> req.route is undefined
        const next = jest.fn();

        metricsMiddleware(req, res, next);
        (res as EventEmitter).emit('finish');

        const output = renderMetrics();
        expect(output).toContain('path="unmatched"');
    });

    test('increments error counter for 5xx status', () => {
        const { req, res } = createMockReqRes({ routePath: '/fail', statusCode: 500 });
        const next = jest.fn();

        metricsMiddleware(req, res, next);
        (res as EventEmitter).emit('finish');

        const output = renderMetrics();
        expect(output).toContain('scg_errors_total 1');
    });

    test('increments auth failure counter for 401', () => {
        const { req, res } = createMockReqRes({ routePath: '/secure', statusCode: 401 });
        const next = jest.fn();

        metricsMiddleware(req, res, next);
        (res as EventEmitter).emit('finish');

        const output = renderMetrics();
        expect(output).toContain('scg_auth_failures_total 1');
    });

    test('increments auth failure counter when auth middleware marks a 429 rejection', () => {
        const { req, res } = createMockReqRes({
            path: '/metrics',
            statusCode: 429,
            authFailure: true,
        });
        const next = jest.fn();

        metricsMiddleware(req, res, next);
        (res as EventEmitter).emit('finish');

        const output = renderMetrics();
        expect(output).toContain('scg_auth_failures_total 1');
    });

    test('increments auth failure counter for 403', () => {
        const { req, res } = createMockReqRes({ routePath: '/admin', statusCode: 403 });
        const next = jest.fn();

        metricsMiddleware(req, res, next);
        (res as EventEmitter).emit('finish');

        const output = renderMetrics();
        expect(output).toContain('scg_auth_failures_total 1');
    });

    test('does not increment error counter for 4xx (non-auth)', () => {
        const { req, res } = createMockReqRes({ routePath: '/missing', statusCode: 404 });
        const next = jest.fn();

        metricsMiddleware(req, res, next);
        (res as EventEmitter).emit('finish');

        const output = renderMetrics();
        expect(output).not.toContain('scg_errors_total');
        expect(output).not.toContain('scg_auth_failures_total');
    });

    test('labels include method, path, and status', () => {
        const { req, res } = createMockReqRes({ method: 'POST', routePath: '/submit', statusCode: 201 });
        const next = jest.fn();

        metricsMiddleware(req, res, next);
        (res as EventEmitter).emit('finish');

        const output = renderMetrics();
        expect(output).toContain('method="POST"');
        expect(output).toContain('path="/submit"');
        expect(output).toContain('status="201"');
    });
});

// ── Edge cases ──

describe('edge cases', () => {
    test('very large counter value', () => {
        for (let i = 0; i < 1000; i++) {
            incrementCounter('scg_requests_total');
        }
        const output = renderMetrics();
        expect(output).toContain('scg_requests_total 1000');
    });

    test('very large histogram observation', () => {
        observeHistogram('scg_request_duration_seconds', 1_000_000);
        const output = renderMetrics();
        expect(output).toContain('scg_request_duration_seconds_sum 1000000');
    });

    test('zero histogram observation', () => {
        observeHistogram('scg_request_duration_seconds', 0);
        const output = renderMetrics();
        expect(output).toContain('scg_request_duration_seconds_sum 0');
        expect(output).toContain('scg_request_duration_seconds_count 1');
    });

    test('counter with empty labels object', () => {
        incrementCounter('scg_requests_total', {});
        const output = renderMetrics();
        // Empty labels should produce a plain key without braces
        expect(output).toContain('scg_requests_total 1');
        expect(output).not.toContain('scg_requests_total{');
    });
});
