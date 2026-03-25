/**
 * Shared Utility Functions
 *
 * Common helpers used across multiple modules in the ingestion pipeline.
 */

/**
 * Retries an async operation with exponential backoff for transient file system errors
 */
export async function retryAsync<T>(fn: () => Promise<T>, maxRetries = 3, baseDelay = 100): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      const isTransient = ['EMFILE', 'EAGAIN', 'ENFILE', 'EBUSY'].includes(error?.code);
      if (!isTransient || attempt === maxRetries) throw error;
      await new Promise(r => setTimeout(r, baseDelay * Math.pow(2, attempt)));
    }
  }
  throw new Error('Unreachable');
}
