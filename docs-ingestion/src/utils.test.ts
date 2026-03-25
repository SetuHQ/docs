import { jest } from '@jest/globals';
import { retryAsync } from './utils.js';

describe('retryAsync', () => {
  test('returns result on first success', async () => {
    const fn = jest.fn().mockResolvedValue('ok');
    const result = await retryAsync(fn);
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('retries on transient error and succeeds', async () => {
    const error = new Error('transient') as any;
    error.code = 'EMFILE';
    const fn = jest.fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValue('ok');
    const result = await retryAsync(fn, 3, 10);
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  test('throws on non-transient error immediately', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('ENOENT'));
    await expect(retryAsync(fn, 3, 10)).rejects.toThrow('ENOENT');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('throws after max retries exhausted', async () => {
    const error = new Error('busy') as any;
    error.code = 'EBUSY';
    const fn = jest.fn().mockRejectedValue(error);
    await expect(retryAsync(fn, 2, 10)).rejects.toThrow('busy');
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
