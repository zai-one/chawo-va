import { describe, expect, it } from 'vitest';
import { progressLine, resolvePlan } from '../src/fileParallel';

const GB = 1024 ** 3;
const ru = (r: string) => r;

describe('fileParallel', () => {
  it('auto on CPU uses half the cores, capped at 4 and by RAM', () => {
    expect(resolvePlan('auto', false, false, 'v3_e2e_rnnt', 8, 16 * GB)).toMatchObject({ workers: 4, intraOpThreads: 2, summaryRu: 'Авто → 4× CPU' });
    expect(resolvePlan('auto', false, false, 'multilingual_large_ctc', 8, 4 * GB).workers).toBe(1);
  });

  it('GPU batches only when the encoder allows it', () => {
    expect(resolvePlan('auto', true, true, 'v3_e2e_rnnt', 8, 16 * GB)).toMatchObject({ batchSize: 4, encoderBatch: true });
    expect(resolvePlan('max', true, false, 'v3_e2e_rnnt', 8, 16 * GB)).toMatchObject({ batchSize: 1, encoderBatch: false });
  });

  it('builds the progress line', () => {
    expect(progressLine(2, 4, 120, 60, 'Авто → 2× CPU', ru)).toBe('Кусок 2 из 4 · 2× быстрее реального времени · осталось ~01:00 · Авто → 2× CPU');
    expect(progressLine(0, 4, 0, 0, null, ru)).toBe('Кусок 0 из 4');
  });
});
