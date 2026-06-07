#!/usr/bin/env node
// Standalone CLI for persona generation. Doesn't require Electron.
// Usage:
//   node scripts/persona-cli.js weekly        # generate current week's snapshot
//   node scripts/persona-cli.js weekly --catchup
//   node scripts/persona-cli.js merge         # rebuild profile.md from recent weeklies
//   node scripts/persona-cli.js               # = weekly (default)

const path = require('path');
const os = require('os');

async function main() {
  const distPath = path.join(__dirname, '..', 'dist', 'electron', 'llm', 'persona.js');
  let persona;
  try {
    persona = require(distPath);
  } catch (err) {
    console.error('Compiled persona module not found. Run: npx tsc -p electron/tsconfig.json');
    console.error(err.message);
    process.exit(1);
  }

  const vaultDir = path.join(os.homedir(), 'R2Vault');
  const mode = process.argv[2] || 'weekly';
  const isCatchup = process.argv.includes('--catchup');

  // Warm the model first (best-effort, silent on failure)
  const model = process.env.R2_LLM_MODEL || 'qwen2.5:7b';
  const ollama = require(path.join(__dirname, '..', 'dist', 'electron', 'llm', 'ollama.js'));
  process.stdout.write(`[persona] warming ${model}…`);
  const ok = await ollama.prewarm?.(model, { keepAlive: '30m' }).catch(() => false);
  process.stdout.write(ok === false ? ' (skipped)\n' : ' ok\n');

  if (mode === 'merge') {
    console.log('[persona] running profile merge…');
    const r = await persona.mergeMonthlyProfile({ vaultDir });
    if (r.ok) console.log(`✓ wrote ${r.outputPath} (weeklies=${r.weekliesUsed}, ${r.totalDurationMs}ms)`);
    else { console.error(`✗ ${r.reason}`); process.exit(2); }
    return;
  }

  if (isCatchup) {
    const results = await persona.catchUpMissingWeeklies({ vaultDir });
    if (results.length === 0) console.log('[persona] nothing to catch up.');
    for (const r of results) {
      if (r.ok) console.log(`✓ ${r.weekLabel} → ${r.outputPath}`);
      else console.log(`✗ ${r.weekLabel}: ${r.reason}`);
    }
    return;
  }

  // Default: generate current week's snapshot
  console.log('[persona] generating current weekly snapshot…');
  const r = await persona.generateWeeklySnapshot({ vaultDir });
  if (r.ok) {
    console.log(`✓ wrote ${r.outputPath} (${r.weekLabel}, ${r.rangeStart}→${r.rangeEnd}, ${r.totalDurationMs}ms, ${r.payloadChars}c payload)`);
  } else {
    console.error(`✗ ${r.weekLabel ?? '?'}: ${r.reason}`);
    process.exit(2);
  }
}

main().catch((err) => {
  console.error('[persona-cli] failed:', err?.message ?? err);
  process.exit(1);
});
