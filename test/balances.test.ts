import { describe, expect, it } from 'vitest';
import { mapPooled } from '../src/pool.js';

/** Resolve after a tick, tracking peak concurrency across the whole run. */
function tracker() {
  let inFlight = 0;
  let peak = 0;
  return {
    get peak() {
      return peak;
    },
    async run<T>(value: T): Promise<T> {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight--;
      return value;
    },
  };
}

describe('mapPooled', () => {
  it('preserves input order regardless of completion order', async () => {
    const items = [40, 5, 30, 1, 20];
    const out = await mapPooled(items, 3, async (ms) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return ms;
    });
    expect(out).toEqual(items);
  });

  it('never exceeds the concurrency ceiling', async () => {
    const t = tracker();
    await mapPooled(Array.from({ length: 50 }, (_, i) => i), 4, (i) => t.run(i));
    expect(t.peak).toBeLessThanOrEqual(4);
  });

  it('still saturates the pool when there is work for it', async () => {
    const t = tracker();
    await mapPooled(Array.from({ length: 50 }, (_, i) => i), 4, (i) => t.run(i));
    expect(t.peak).toBe(4);
  });

  it('spawns no more workers than there are items', async () => {
    const t = tracker();
    const out = await mapPooled([1, 2], 8, (i) => t.run(i));
    expect(out).toEqual([1, 2]);
    expect(t.peak).toBeLessThanOrEqual(2);
  });

  it('handles an empty input', async () => {
    expect(await mapPooled([], 4, async () => 'x')).toEqual([]);
  });

  it('propagates a rejection', async () => {
    await expect(
      mapPooled([1, 2, 3], 2, async (i) => {
        if (i === 2) throw new Error('boom');
        return i;
      }),
    ).rejects.toThrow('boom');
  });
});
