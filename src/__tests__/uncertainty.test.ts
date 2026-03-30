import { UncertaintyTracker } from '../analysis-engine/uncertainty';
import type { UncertaintyAnnotation } from '../types';

const tracker = new UncertaintyTracker();

describe('UncertaintyTracker', () => {
    describe('createAnnotation', () => {
        test('creates annotation with correct impact', () => {
            const ann = tracker.createAnnotation('parse_error', 'sym-1', 'Syntax error in file');

            expect(ann.source).toBe('parse_error');
            expect(ann.affected_symbol_id).toBe('sym-1');
            expect(ann.confidence_impact).toBe(0.30);
            expect(ann.recommended_evidence).toContain('Fix syntax errors');
        });

        test('eval_usage has highest impact', () => {
            const ann = tracker.createAnnotation('eval_usage', null, 'Uses eval()');
            expect(ann.confidence_impact).toBe(0.35);
        });

        test('untested_path has lowest impact', () => {
            const ann = tracker.createAnnotation('untested_path', null, 'No tests');
            expect(ann.confidence_impact).toBe(0.08);
        });
    });

    describe('computeSnapshotConfidence', () => {
        test('returns 1.0 for no annotations', () => {
            expect(tracker.computeSnapshotConfidence([])).toBe(1.0);
        });

        test('single annotation reduces confidence', () => {
            const annotations: UncertaintyAnnotation[] = [
                tracker.createAnnotation('parse_error', null, 'test'),
            ];
            const confidence = tracker.computeSnapshotConfidence(annotations);
            expect(confidence).toBeCloseTo(0.70, 1);
        });

        test('repeated same-source gets diminishing weight', () => {
            const annotations: UncertaintyAnnotation[] = [
                tracker.createAnnotation('parse_error', 'a', 'test'),
                tracker.createAnnotation('parse_error', 'b', 'test'),
            ];
            const confidence = tracker.computeSnapshotConfidence(annotations);
            // Multiplicative: first *= (1-0.30)=0.70, second (repeat) *= (1-0.30*0.3)=0.91 → 0.637
            expect(confidence).toBeCloseTo(0.637, 1);
        });

        test('different sources stack multiplicatively', () => {
            const annotations: UncertaintyAnnotation[] = [
                tracker.createAnnotation('parse_error', null, 'test'),       // *= (1-0.30)
                tracker.createAnnotation('eval_usage', null, 'test'),        // *= (1-0.35)
            ];
            const confidence = tracker.computeSnapshotConfidence(annotations);
            // 1.0 * 0.70 * 0.65 = 0.455
            expect(confidence).toBeCloseTo(0.455, 1);
        });

        test('never goes below 0.10 floor', () => {
            const annotations: UncertaintyAnnotation[] = [
                tracker.createAnnotation('parse_error', null, 'test'),
                tracker.createAnnotation('eval_usage', null, 'test'),
                tracker.createAnnotation('dynamic_dispatch', null, 'test'),
                tracker.createAnnotation('reflection_usage', null, 'test'),
                tracker.createAnnotation('runtime_only_behavior', null, 'test'),
            ];
            const confidence = tracker.computeSnapshotConfidence(annotations);
            // Multiplicative: 0.70 * 0.65 * 0.80 * 0.75 * 0.78 = ~0.213
            expect(confidence).toBeGreaterThanOrEqual(0.10);
            expect(confidence).toBeLessThan(0.30);
        });
    });

    describe('computeSymbolConfidence', () => {
        test('returns 1.0 for no flags', () => {
            expect(tracker.computeSymbolConfidence([])).toBe(1.0);
        });

        test('known flags reduce by their impact', () => {
            const confidence = tracker.computeSymbolConfidence(['parse_error']);
            expect(confidence).toBeCloseTo(0.70, 1);
        });

        test('unknown flags get small penalty', () => {
            const confidence = tracker.computeSymbolConfidence(['some_unknown_flag']);
            expect(confidence).toBeCloseTo(0.95, 1);
        });

        test('multiple flags stack multiplicatively', () => {
            const confidence = tracker.computeSymbolConfidence(['parse_error', 'eval_usage']);
            // Multiplicative: 1.0 * (1-0.30) * (1-0.35) = 0.70 * 0.65 = 0.455
            expect(confidence).toBeCloseTo(0.455, 1);
        });
    });
});
