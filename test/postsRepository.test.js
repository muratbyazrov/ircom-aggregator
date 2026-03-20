import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createPostsRepository } from '../src/db/postsRepository.js';

function createTempDbPath() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ircom-aggregator-'));
  return {
    dbPath: path.join(tempDir, 'data.db'),
    cleanup() {
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

function buildPost(msgId) {
  return {
    source: 'test-source',
    msg_id: msgId,
    date: new Date('2026-03-19T10:00:00.000Z').toISOString(),
    permalink: `https://t.me/test/${msgId}`,
    title: `Post ${msgId}`,
    description: `Description ${msgId}`,
    price_value: 800,
    raw_text: `Raw ${msgId}`,
    dedupe_key: `dedupe-${msgId}`,
    sender_id: `sender-${msgId}`,
    content_hash: `hash-${msgId}`,
    contact_phone: '+79990000000',
    contact_username: '@test',
    contact_text: 'phone:+79990000000',
    category: null,
    taxi_direction: null,
    taxi_direction_name: null,
    taxi_from: null,
    taxi_to: null,
    taxi_route: null,
    taxi_departure_at: null,
    taxi_departure_text: null,
    taxi_seats_total: null,
    taxi_seats_free: null,
    taxi_vehicle: null,
    backend_entity_id: null,
    photo_path: null,
    photo_paths: null,
  };
}

test('clear removes rows only from the repository active table', () => {
  const { dbPath, cleanup } = createTempDbPath();

  try {
    const postsRepo = createPostsRepository(dbPath, { tableName: 'posts' });
    const servicesRepo = createPostsRepository(dbPath, { tableName: 'service_posts' });
    const taxiRepo = createPostsRepository(dbPath, { tableName: 'taxi_posts' });

    postsRepo.upsert(buildPost(1));
    servicesRepo.upsert(buildPost(2));
    taxiRepo.upsert(buildPost(3));

    assert.equal(postsRepo.listPostsForDedupe().length, 1);
    assert.equal(servicesRepo.listPostsForDedupe().length, 1);
    assert.equal(taxiRepo.listPostsForDedupe().length, 1);

    const deletedRows = taxiRepo.clear();

    assert.equal(deletedRows, 1);
    assert.equal(postsRepo.listPostsForDedupe().length, 1);
    assert.equal(servicesRepo.listPostsForDedupe().length, 1);
    assert.equal(taxiRepo.listPostsForDedupe().length, 0);

    postsRepo.close();
    servicesRepo.close();
    taxiRepo.close();
  } finally {
    cleanup();
  }
});

test('markBackendSyncSuccess persists backend entity id for later taxi updates', () => {
  const { dbPath, cleanup } = createTempDbPath();

  try {
    const taxiRepo = createPostsRepository(dbPath, { tableName: 'taxi_posts' });
    taxiRepo.upsert(buildPost(3));

    const savedPost = taxiRepo.getPostBySourceAndMsgId({ source: 'test-source', msgId: 3 });
    assert.ok(savedPost?.id);

    taxiRepo.markBackendSyncSuccess({
      id: savedPost.id,
      backendSyncTarget: JSON.stringify({ mode: 'taxi' }),
      backendEntityId: 987,
    });

    const syncedPost = taxiRepo.getPostBySourceAndMsgId({ source: 'test-source', msgId: 3 });
    assert.equal(syncedPost?.backend_entity_id, 987);

    taxiRepo.close();
  } finally {
    cleanup();
  }
});

test('changing taxi-specific fields resets backend sync state', () => {
  const { dbPath, cleanup } = createTempDbPath();

  try {
    const taxiRepo = createPostsRepository(dbPath, { tableName: 'taxi_posts' });
    const initialPost = {
      ...buildPost(4),
      taxi_direction: 2,
      taxi_from: 'Цхинвал',
      taxi_to: 'Владикавказ',
      taxi_route: 'Цхинвал - Владикавказ',
      taxi_departure_at: '2026-03-19T10:00:00.000Z',
    };
    taxiRepo.upsert(initialPost);

    const savedPost = taxiRepo.getPostBySourceAndMsgId({ source: 'test-source', msgId: 4 });
    assert.ok(savedPost?.id);

    taxiRepo.markBackendSyncSuccess({
      id: savedPost.id,
      backendSyncTarget: JSON.stringify({ mode: 'taxi' }),
      backendEntityId: 654,
    });

    taxiRepo.upsert({
      ...initialPost,
      taxi_route: 'Владикавказ - Цхинвал',
      taxi_from: 'Владикавказ',
      taxi_to: 'Цхинвал',
    });

    const updatedPost = taxiRepo.getPostBySourceAndMsgId({ source: 'test-source', msgId: 4 });
    assert.equal(updatedPost?.backend_synced_at, null);
    assert.equal(updatedPost?.backend_last_error, null);
    assert.equal(updatedPost?.backend_entity_id, 654);

    taxiRepo.close();
  } finally {
    cleanup();
  }
});
