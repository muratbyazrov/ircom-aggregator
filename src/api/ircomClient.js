const DEFAULT_API_URL = 'http://127.0.0.1:3002/ircom-api/v1';

function parseErrorMessage(payload) {
  if (!payload) return 'Request failed';
  if (typeof payload === 'string') return payload;
  if (payload?.error?.message) return payload.error.message;
  if (payload?.error?.msg) return payload.error.msg;
  if (typeof payload?.error === 'string') return payload.error;
  if (payload?.message) return payload.message;
  if (payload?.msg) return payload.msg;
  try {
    return JSON.stringify(payload);
  } catch {
    return 'Request failed';
  }
}

export function createIrcomApiClient(config) {
  const endpoint = String(config?.postApiUrl || DEFAULT_API_URL).trim();
  const timeoutMs = Number(config?.postApiTimeoutMs || 15000);
  const enabled = Boolean(config?.postApiEnabled);

  async function request(domain, event, params = {}) {
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
          domain,
          event,
          params,
        }),
        signal: controller.signal,
      });

      let payload = null;
      let rawBody = '';
      try {
        rawBody = await response.text();
        payload = rawBody ? JSON.parse(rawBody) : null;
      } catch {
        payload = null;
      }

      if (!response.ok) {
        throw new Error(parseErrorMessage(payload || rawBody) || `HTTP ${response.status}`);
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

  async function createListing(params) {
    return request('listing', 'createListing', params);
  }

  async function createTaxiOffer(params) {
    return request('taxi', 'createTaxiOffer', params);
  }

  async function updateTaxiOffer(params) {
    return request('taxi', 'updateTaxiOffer', params);
  }

  async function deleteTaxiOffer(params) {
    return request('taxi', 'deleteTaxiOffer', params);
  }

  async function cleanupImportedListings(params) {
    return request('listing', 'cleanupImportedListings', params);
  }

  async function getImportedListingsForDedup(params) {
    return request('listing', 'getImportedListingsForDedup', params);
  }

  async function deleteImportedListingById(params) {
    return request('listing', 'deleteImportedListingById', params);
  }

  async function getImportedTaxiOffersForDedup(params) {
    return request('taxi', 'getImportedTaxiOffersForDedup', params);
  }

  async function getCategories(kind = 1) {
    const event = Number(kind) === 2 ? 'getServiceCategories' : 'getListingCategories';
    const response = await request('dictionary', event, {});
    return response?.data || [];
  }

  return {
    createListing,
    createTaxiOffer,
    updateTaxiOffer,
    deleteTaxiOffer,
    cleanupImportedListings,
    getImportedListingsForDedup,
    deleteImportedListingById,
    getImportedTaxiOffersForDedup,
    getCategories,
  };
}
