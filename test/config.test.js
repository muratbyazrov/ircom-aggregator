import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadConfig } from '../src/config.js';

function createTempEnvDir(files) {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'ircom-aggregator-config-'));
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(path.join(tempDir, name), contents);
  }
  return tempDir;
}

function cleanupTempDir(tempDir) {
  rmSync(tempDir, { recursive: true, force: true });
}

test('loads base env and resolves pipeline mode from CLI arg', async () => {
  const tempDir = createTempEnvDir({
    '.env': [
      'TG_API_ID=123456',
      'TG_API_HASH=1234567890abcdef',
      'TG_SOURCES=@taxi_one,@taxi_two',
      'TG_POST_API_ENABLED=true',
      'TG_POST_API_ACCOUNT_ID=20',
    ].join('\n'),
  });

  try {
    const config = await loadConfig({
      env: {},
      argv: ['--mode=taxi'],
      cwd: tempDir,
    });

    assert.equal(config.pipelineMode, 'taxi');
    assert.deepEqual(config.sources, ['taxi_one', 'taxi_two']);
    assert.equal(config.postApiAccountId, 20);
    assert.equal(config.runtimeMode, 'taxi');
    assert.deepEqual(config.loadedEnvFiles, [
      path.join(tempDir, '.env'),
    ]);
  } finally {
    cleanupTempDir(tempDir);
  }
});

test('explicit --env-file overrides base .env values', async () => {
  const tempDir = createTempEnvDir({
    '.env': [
      'TG_API_ID=123456',
      'TG_API_HASH=1234567890abcdef',
      'TG_PIPELINE_MODE=services',
      'TG_SOURCES=@base_services',
      'TG_POST_API_ENABLED=true',
      'TG_POST_API_ACCOUNT_ID=10',
    ].join('\n'),
    '.env.customer-a': [
      'TG_SOURCES=@ads_custom',
      'TG_POST_API_ACCOUNT_ID=30',
    ].join('\n'),
  });

  try {
    const config = await loadConfig({
      env: {},
      argv: ['--mode=ads', '--env-file=.env.customer-a'],
      cwd: tempDir,
    });

    assert.equal(config.pipelineMode, 'ads');
    assert.equal(config.postApiKind, 1);
    assert.deepEqual(config.sources, ['ads_custom']);
    assert.equal(config.postApiAccountId, 30);
    assert.deepEqual(config.loadedEnvFiles, [
      path.join(tempDir, '.env'),
      path.join(tempDir, '.env.customer-a'),
    ]);
  } finally {
    cleanupTempDir(tempDir);
  }
});

test('keeps taxi skip logs compact by default and allows opt-in verbose mode', async () => {
  const baseEnv = {
    TG_API_ID: '123456',
    TG_API_HASH: '1234567890abcdef',
    TG_SOURCES: '@taxi_one',
    TG_PIPELINE_MODE: 'taxi',
    TG_POST_API_ACCOUNT_ID: '10',
  };

  const defaultConfig = await loadConfig({
    env: { ...baseEnv },
    argv: [],
    loadEnvFiles: false,
  });
  assert.equal(defaultConfig.taxiVerboseSkips, false);

  const verboseConfig = await loadConfig({
    env: { ...baseEnv, TG_TAXI_VERBOSE_SKIPS: 'true' },
    argv: [],
    loadEnvFiles: false,
  });
  assert.equal(verboseConfig.taxiVerboseSkips, true);
});
