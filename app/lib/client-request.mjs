/**
 * Bounded browser request with readable errors. This never retries: an uncertain
 * mutation must be reconciled with saved state before the reviewer acts again.
 * @param {string} url
 * @param {RequestInit & {timeoutMs?: number, errorMessage?: string, timeoutMessage?: string}} [options]
 */
export async function requestJson(url, options = {}) {
  const {
    timeoutMs = 20000,
    errorMessage = 'The request could not be completed.',
    timeoutMessage = 'The request timed out. Try again.',
    signal,
    ...request
  } = options;
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...request,
      signal: signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal,
    });
    let body;
    try {
      body = await response.json();
    } catch (error) {
      if (timeout.signal.aborted || signal?.aborted) throw error;
      throw new Error(errorMessage);
    }
    if (!response.ok)
      throw new Error(typeof body?.error === 'string' && body.error.trim() ? body.error : errorMessage);
    return body;
  } catch (error) {
    if (timeout.signal.aborted && !signal?.aborted) throw new Error(timeoutMessage);
    if (signal?.aborted) throw error;
    if (error instanceof TypeError) throw new Error(errorMessage);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
