/**
 * Persistent scheduler for ircom-aggregator.
 *
 * Runs ads / services / taxi / dedup pipelines on configurable intervals.
 * All Telegram-based runs are serialised through a queue to prevent
 * concurrent session conflicts.
 *
 * Configurable via environment variables:
 *   SCHEDULER_ADS_INTERVAL_MIN      — default 60
 *   SCHEDULER_SERVICES_INTERVAL_MIN — default 60
 *   SCHEDULER_TAXI_INTERVAL_MIN     — default 30
 *   SCHEDULER_DEDUP_INTERVAL_MIN    — default 360
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX = path.join(__dirname, 'index.js');

const toMs = (minutes) => Math.max(1, Number(minutes) || 0) * 60_000;

const INTERVALS = {
  ads:      toMs(process.env.SCHEDULER_ADS_INTERVAL_MIN      ?? 60),
  services: toMs(process.env.SCHEDULER_SERVICES_INTERVAL_MIN ?? 60),
  taxi:     toMs(process.env.SCHEDULER_TAXI_INTERVAL_MIN      ?? 30),
  dedup:    toMs(process.env.SCHEDULER_DEDUP_INTERVAL_MIN     ?? 360),
};

// ─── Queue ───────────────────────────────────────────────────────────────────
// All pipelines share a single queue so Telegram sessions are never used
// by two processes at the same time.

const queue = [];
let isRunning = false;

async function drainQueue() {
  if (isRunning || queue.length === 0) return;
  isRunning = true;
  const mode = queue.shift();
  try {
    await execute(mode);
  } catch (err) {
    console.error(`[scheduler:${mode}] Unhandled error: ${err?.message || err}`);
  } finally {
    isRunning = false;
    drainQueue();
  }
}

function enqueue(mode) {
  if (queue.includes(mode)) {
    console.log(`[scheduler:${mode}] Already queued — skipping duplicate`);
    return;
  }
  queue.push(mode);
  drainQueue();
}

// ─── Process helpers ─────────────────────────────────────────────────────────

function spawnNode(args, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      stdio: 'inherit',
      env: { ...process.env, ...extraEnv },
    });
    child.on('close', (code) => {
      if (code !== 0) {
        console.error(`[scheduler] Process exited ${code}: node ${args.join(' ')}`);
      }
      resolve();
    });
    child.on('error', (err) => {
      console.error(`[scheduler] Spawn error: ${err.message}`);
      resolve();
    });
  });
}

async function execute(mode) {
  console.log(`\n[scheduler:${mode}] ▶ Started  ${new Date().toISOString()}`);

  if (mode === 'dedup') {
    // dedup has no Telegram session — runs for each mode sequentially
    for (const dedupMode of ['ads', 'services', 'taxi']) {
      await spawnNode([INDEX, `--mode=${dedupMode}`], { TG_DEDUP_ONLY: 'true' });
    }
  } else {
    await spawnNode([INDEX, `--mode=${mode}`]);
  }

  console.log(`[scheduler:${mode}] ✓ Finished ${new Date().toISOString()}`);
}

// ─── Bootstrap ───────────────────────────────────────────────────────────────

console.log('[scheduler] ircom-aggregator scheduler started');
console.log('[scheduler] Run intervals:');
for (const [mode, ms] of Object.entries(INTERVALS)) {
  console.log(`  ${mode.padEnd(10)} every ${ms / 60_000} min`);
}

// Stagger initial runs by 3 s so logs from back-to-back start-up are readable.
const MODES = ['ads', 'services', 'taxi', 'dedup'];
MODES.forEach((mode, i) => {
  setTimeout(() => {
    enqueue(mode);
    setInterval(() => enqueue(mode), INTERVALS[mode]);
  }, i * 3_000);
});
