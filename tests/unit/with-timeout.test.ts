import { describe, expect, it } from 'vitest';
import { withTimeout } from '../../src/utils/withTimeout';

describe('withTimeout', () => {
  it('resolves with the inner value when the promise is fast', async () => {
    const result = await withTimeout(Promise.resolve('ok'), 200, 'too slow');
    expect(result).toBe('ok');
  });

  it('rejects with the custom message when the promise hangs', async () => {
    await expect(withTimeout(new Promise(() => {}), 50, 'unlock timed out')).rejects.toThrow(
      'unlock timed out',
    );
  });

  it('propagates an inner rejection untouched', async () => {
    await expect(withTimeout(Promise.reject(new Error('boom')), 200, 'too slow')).rejects.toThrow(
      'boom',
    );
  });

  it('rejects with the earlier of the two when both can fire', async () => {
    await expect(
      withTimeout(
        new Promise((_, reject) => setTimeout(() => reject(new Error('late fail')), 400)),
        100,
        'too slow',
      ),
    ).rejects.toThrow('too slow');
  });
});
