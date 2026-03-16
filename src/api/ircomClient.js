const DEFAULT_API_URL = 'http://127.0.0.1:3002/ircom-api/v1';

function parseErrorMessage(payload) {
  if (!payload) return 'Request failed';
  if (typeof payload === 'string') return payload;
  if (payload?.error?.message) return payload.error.message;
  if (payload?.message) return payload.message;
  return 'Request failed';
}

export function createIrcomApiClient(config) {
  const endpoint = String(config?.postApiUrl || DEFAULT_API_URL).trim();
  const timeoutMs = Number(config?.postApiTimeoutMs || 15000);
  const enabled = Boolean(config?.postApiEnabled);

  async function createListing(params) {
    if (!enabled) {
      return { skipped: true, reason: 'disabled' };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          domain: 'listing',
          event: 'createListing',
          params,
        }),
        signal: controller.signal,
      });

      let payload = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }

      if (!response.ok) {
        throw new Error(parseErrorMessage(payload) || `HTTP ${response.status}`);
      }
      if (payload?.error) {
        throw new Error(parseErrorMessage(payload));
      }

      return { skipped: false, data: payload?.data ?? payload };
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new Error(`Request timeout after ${timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function cleanupImportedListings(params) {
    if (!enabled) {
      return { skipped: true, reason: 'disabled' };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          domain: 'listing',
          event: 'cleanupImportedListings',
          params,
        }),
        signal: controller.signal,
      });

      let payload = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }

      if (!response.ok) {
        throw new Error(parseErrorMessage(payload) || `HTTP ${response.status}`);
      }
      if (payload?.error) {
        throw new Error(parseErrorMessage(payload));
      }

      return { skipped: false, data: payload?.data ?? payload };
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new Error(`Request timeout after ${timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  return { createListing, cleanupImportedListings };
}
