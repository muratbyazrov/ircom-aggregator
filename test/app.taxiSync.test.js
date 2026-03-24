import test from 'node:test';
import assert from 'node:assert/strict';

import { extractTaxiOfferIdFromBackendResponse } from '../src/sync.js';

test('extracts taxiOfferId from wrapped backend response payload', () => {
  assert.equal(extractTaxiOfferIdFromBackendResponse({ data: { taxiOfferId: 123 } }), 123);
});

test('extracts taxiOfferId from direct backend response payload', () => {
  assert.equal(extractTaxiOfferIdFromBackendResponse({ taxiOfferId: 456 }), 456);
});

test('returns null when backend response does not contain taxiOfferId', () => {
  assert.equal(extractTaxiOfferIdFromBackendResponse({ data: { ok: true } }), null);
});
