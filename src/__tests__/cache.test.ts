/**
 * Unit tests for LRU Cache with TTL.
 */

jest.mock('../logger', () => ({
    Logger: jest.fn().mockImplementation(() => ({
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    })),
}));

import { LRUCache, destroyAllCaches, scopedKey } from '../cache';

describe('LRUCache', () => {
    let cache: LRUCache<string>;

    beforeEach(() => {
        jest.useFakeTimers();
        cache = new LRUCache<string>(5, 10_000);
    });

    afterEach(() => {
        cache.destroy();
        jest.useRealTimers();
    });

    // ── set / get ──

    describe('set and get', () => {
        test('stores and retrieves a value', () => {
            cache.set('k1', 'v1');
            expect(cache.get('k1')).toBe('v1');
        });

        test('returns undefined for non-existent key', () => {
            expect(cache.get('missing')).toBeUndefined();
        });

        test('overwrites existing key with new value', () => {
            cache.set('k1', 'old');
            cache.set('k1', 'new');
            expect(cache.get('k1')).toBe('new');
        });

        test('stores multiple distinct keys', () => {
            cache.set('a', '1');
            cache.set('b', '2');
            cache.set('c', '3');
            expect(cache.get('a')).toBe('1');
            expect(cache.get('b')).toBe('2');
            expect(cache.get('c')).toBe('3');
        });
    });

    // ── TTL expiry ──

    describe('TTL expiry', () => {
        test('entry expires after default TTL', () => {
            cache.set('ttl-key', 'val');
            expect(cache.get('ttl-key')).toBe('val');

            // Advance past the 10_000ms default TTL
            jest.advanceTimersByTime(10_001);

            expect(cache.get('ttl-key')).toBeUndefined();
        });

        test('entry expires after custom TTL', () => {
            cache.set('short', 'val', 2_000);

            jest.advanceTimersByTime(1_999);
            expect(cache.get('short')).toBe('val');

            jest.advanceTimersByTime(2);
            expect(cache.get('short')).toBeUndefined();
        });

        test('evictExpired runs on cleanup interval and removes expired entries', () => {
            cache.set('expire-me', 'val', 5_000);

            // Advance past the TTL but before cleanup
            jest.advanceTimersByTime(6_000);

            // The entry is expired but not yet cleaned up from the store.
            // Trigger the 60s cleanup interval.
            jest.advanceTimersByTime(54_000); // Total 60_000ms

            // A direct get would have already returned undefined (lazy check),
            // but the interval proactively purges it. Verify via stats.
            expect(cache.stats().size).toBe(0);
        });
    });

    // ── maxSize eviction ──

    describe('maxSize eviction', () => {
        test('evicts oldest entry when maxSize exceeded', () => {
            // Cache has maxSize=5
            cache.set('a', '1');
            cache.set('b', '2');
            cache.set('c', '3');
            cache.set('d', '4');
            cache.set('e', '5');

            // Adding a 6th key should evict 'a' (first inserted, least recently used)
            cache.set('f', '6');

            expect(cache.get('a')).toBeUndefined();
            expect(cache.get('f')).toBe('6');
            expect(cache.stats().size).toBe(5);
        });

        test('does not evict when updating an existing key at capacity', () => {
            cache.set('a', '1');
            cache.set('b', '2');
            cache.set('c', '3');
            cache.set('d', '4');
            cache.set('e', '5');

            // Updating existing key should NOT evict anything
            cache.set('a', 'updated');

            expect(cache.get('a')).toBe('updated');
            expect(cache.get('b')).toBe('2');
            expect(cache.stats().size).toBe(5);
        });

        test('multiple evictions maintain maxSize', () => {
            cache.set('a', '1');
            cache.set('b', '2');
            cache.set('c', '3');
            cache.set('d', '4');
            cache.set('e', '5');

            cache.set('f', '6'); // evicts 'a'
            cache.set('g', '7'); // evicts 'b'
            cache.set('h', '8'); // evicts 'c'

            expect(cache.get('a')).toBeUndefined();
            expect(cache.get('b')).toBeUndefined();
            expect(cache.get('c')).toBeUndefined();
            expect(cache.get('d')).toBe('4');
            expect(cache.stats().size).toBe(5);
        });
    });

    // ── LRU ordering ──

    describe('LRU ordering', () => {
        test('accessing an entry moves it to most-recently-used position', () => {
            cache.set('a', '1');
            cache.set('b', '2');
            cache.set('c', '3');
            cache.set('d', '4');
            cache.set('e', '5');

            // Access 'a' to move it to the end (most recently used)
            cache.get('a');

            // Now 'b' is the least recently used. Adding a new key should evict 'b'.
            cache.set('f', '6');

            expect(cache.get('a')).toBe('1'); // still present, was accessed
            expect(cache.get('b')).toBeUndefined(); // evicted
            expect(cache.get('f')).toBe('6');
        });

        test('set on existing key does NOT change Map iteration order', () => {
            cache.set('a', '1');
            cache.set('b', '2');
            cache.set('c', '3');
            cache.set('d', '4');
            cache.set('e', '5');

            // Overwrite 'a' via set — Map.set on an existing key does NOT
            // move the entry to the end of the iteration order (unlike get,
            // which explicitly deletes + re-inserts). So 'a' remains LRU.
            cache.set('a', 'refreshed');

            // Adding a new key evicts the LRU entry, which is still 'a'
            cache.set('f', '6');

            expect(cache.get('a')).toBeUndefined(); // evicted despite update
            expect(cache.get('b')).toBe('2');        // still present
            expect(cache.get('f')).toBe('6');
        });

        test('multiple accesses change eviction order correctly', () => {
            cache.set('a', '1');
            cache.set('b', '2');
            cache.set('c', '3');
            cache.set('d', '4');
            cache.set('e', '5');

            // Access in order: a, b -- now c is LRU
            cache.get('a');
            cache.get('b');

            cache.set('f', '6'); // evicts 'c'
            expect(cache.get('c')).toBeUndefined();
            expect(cache.get('a')).toBe('1');
            expect(cache.get('b')).toBe('2');
        });
    });

    // ── invalidate ──

    describe('invalidate', () => {
        test('removes a specific key', () => {
            cache.set('k1', 'v1');
            cache.set('k2', 'v2');

            const result = cache.invalidate('k1');

            expect(result).toBe(true);
            expect(cache.get('k1')).toBeUndefined();
            expect(cache.get('k2')).toBe('v2');
        });

        test('returns false for non-existent key', () => {
            const result = cache.invalidate('nope');
            expect(result).toBe(false);
        });

        test('reduces size after invalidation', () => {
            cache.set('a', '1');
            cache.set('b', '2');
            expect(cache.stats().size).toBe(2);

            cache.invalidate('a');
            expect(cache.stats().size).toBe(1);
        });
    });

    // ── invalidateByPrefix ──

    describe('invalidateByPrefix', () => {
        test('removes all keys matching prefix', () => {
            cache.set('user:1', 'alice');
            cache.set('user:2', 'bob');
            cache.set('post:1', 'hello');

            const count = cache.invalidateByPrefix('user:');

            expect(count).toBe(2);
            expect(cache.get('user:1')).toBeUndefined();
            expect(cache.get('user:2')).toBeUndefined();
            expect(cache.get('post:1')).toBe('hello');
        });

        test('returns 0 when no keys match prefix', () => {
            cache.set('a', '1');
            const count = cache.invalidateByPrefix('zzz:');
            expect(count).toBe(0);
        });

        test('removes all keys when prefix matches everything', () => {
            cache.set('data:x', '1');
            cache.set('data:y', '2');

            const count = cache.invalidateByPrefix('data:');

            expect(count).toBe(2);
            expect(cache.stats().size).toBe(0);
        });
    });

    // ── clear ──

    describe('clear', () => {
        test('removes all entries', () => {
            cache.set('a', '1');
            cache.set('b', '2');
            cache.set('c', '3');

            cache.clear();

            expect(cache.get('a')).toBeUndefined();
            expect(cache.get('b')).toBeUndefined();
            expect(cache.get('c')).toBeUndefined();
            expect(cache.stats().size).toBe(0);
        });

        test('clear on empty cache does not throw', () => {
            expect(() => cache.clear()).not.toThrow();
            expect(cache.stats().size).toBe(0);
        });
    });

    // ── destroy ──

    describe('destroy', () => {
        test('stops the eviction interval and clears the store', () => {
            cache.set('a', '1');
            cache.destroy();

            expect(cache.stats().size).toBe(0);

            // Advancing timers should not cause errors (interval was cleared)
            expect(() => jest.advanceTimersByTime(120_000)).not.toThrow();
        });
    });

    // ── stats ──

    describe('stats', () => {
        test('tracks hits and misses', () => {
            cache.set('k', 'v');

            cache.get('k');     // hit
            cache.get('k');     // hit
            cache.get('miss1'); // miss
            cache.get('miss2'); // miss
            cache.get('miss3'); // miss

            const s = cache.stats();
            expect(s.hits).toBe(2);
            expect(s.misses).toBe(3);
        });

        test('tracks size correctly', () => {
            expect(cache.stats().size).toBe(0);
            cache.set('a', '1');
            expect(cache.stats().size).toBe(1);
            cache.set('b', '2');
            expect(cache.stats().size).toBe(2);
            cache.invalidate('a');
            expect(cache.stats().size).toBe(1);
        });

        test('hitRate is 0 when no accesses', () => {
            expect(cache.stats().hitRate).toBe(0);
        });

        test('hitRate computed correctly', () => {
            cache.set('k', 'v');

            cache.get('k');     // hit
            cache.get('k');     // hit
            cache.get('k');     // hit
            cache.get('nope');  // miss

            // 3 hits / 4 total = 0.75
            expect(cache.stats().hitRate).toBe(0.75);
        });

        test('expired entry get counts as a miss', () => {
            cache.set('temp', 'val', 1_000);

            cache.get('temp'); // hit
            jest.advanceTimersByTime(1_001);
            cache.get('temp'); // miss (expired)

            const s = cache.stats();
            expect(s.hits).toBe(1);
            expect(s.misses).toBe(1);
            expect(s.hitRate).toBe(0.5);
        });
    });
});

// ── Module-level exports ──

describe('destroyAllCaches', () => {
    test('destroys all 5 module-level caches without throwing', () => {
        expect(() => destroyAllCaches()).not.toThrow();
    });
});

describe('scopedKey', () => {
    test('produces "snapshotId:key" format', () => {
        expect(scopedKey('snap-123', 'myKey')).toBe('snap-123:myKey');
    });

    test('handles empty strings', () => {
        expect(scopedKey('', '')).toBe(':');
    });

    test('preserves special characters', () => {
        expect(scopedKey('snap/1', 'key:with:colons')).toBe('snap/1:key:with:colons');
    });
});
