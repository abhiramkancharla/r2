#!/usr/bin/env node
// Standalone CLI for testing diary generation without Electron.
// Usage:
//   node scripts/diary-cli.js                 # today (local)
//   node scripts/diary-cli.js 2026-05-24      # specific date
//   node scripts/diary-cli.js --catchup       # backfill missing past-day diaries

const path = require('path');
const os = require('os');

async function main() {
  // Ensure compiled output exists
  const distPath = path.join(__dirname, '..', 'dist', 'electron', 'llm', 'diary.js');
  let diary;
  try {
    diary = require(distPath);
  } catch (err) {
    console.error('Compiled diary module not found. Run: npx tsc -p electron/tsconfig.json');
    console.error(err.message);
    process.exit(1);
  }

  const vaultDir = path.join(os.homedir(), 'R2Vault');
  const arg = process.argv[2];

  // Sniff payload size to pre-warm the model the diary will actually pick.
  // Saves a 30–60s cold-load on big-day runs.
  let predicted = process.env.R2_LLM_MODEL || 'qwen2.5:7b';
  if (!process.env.R2_LLM_MODEL && arg !== '--catchup') {
    try {
      const fs = require('fs');
      const date = arg ?? new Date().toISOString().slice(0, 10);
      const sessFile = path.join(vaultDir, 'sessions', `${date}.json`);
      const stat = fs.statSync(sessFile);
      // pre-compaction size is rough but useful signal
      if (stat.size > 200_000) predicted = 'qwen2.5:14b';
    } catch { /* file missing → leave default */ }
  }
  process.stdout.write(`[diary] warming ${predicted}…`);
  const ok = await diary.prewarm?.(predicted, { keepAlive: '30m' }).catch(() => false);
  process.stdout.write(ok === false ? ' (skipped)\n' : ' ok\n');

  if (arg === '--catchup') {
    console.log(`[catchup] scanning ${vaultDir}/sessions for missing diaries…`);
    const results = await diary.catchUpMissingDiaries({ vaultDir });
    if (results.length === 0) {
      console.log('[catchup] nothing to do — all past-day diaries present.');
      return;
    }
    for (const r of results) {
      if (r.ok) {
        console.log(`✓ ${r.date} → ${r.outputPath} (${r.totalDurationMs}ms, sessions=${r.inputSessions})`);
      } else {
        console.log(`✗ ${r.date}: ${r.reason}`);
      }
    }
    return;
  }

  const date = arg;
  console.log(`[diary] generating for ${date ?? 'today'}…`);
  const result = await diary.generateDiary({ vaultDir, date });
  if (result.ok) {
    console.log(`✓ wrote ${result.outputPath}`);
    console.log(`  model=${result.model} sessions=${result.inputSessions} took=${result.totalDurationMs}ms`);
  } else {
    console.error(`✗ ${result.reason}`);
    process.exit(2);
  }
}

main().catch((err) => {
  console.error('[diary-cli] failed:', err?.message ?? err);
  process.exit(1);
});
