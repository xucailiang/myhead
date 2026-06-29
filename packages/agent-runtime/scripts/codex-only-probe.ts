import { runAgent } from '../src/index.js';

const PROMPT = 'Say exactly one word: hello';

async function main() {
  console.log('=== Probing codex stream ===');
  const events: string[] = [];
  try {
    for await (const ev of runAgent('codex', { prompt: PROMPT, cwd: process.cwd() })) {
      const type = typeof ev.type === 'string' ? ev.type : 'unknown';
      events.push(type);
      if (events.length <= 15) {
        console.log(`  [${type}]`, JSON.stringify(ev).slice(0, 200));
      } else if (events.length === 16) {
        console.log('  ... (truncated)');
      }
    }
    console.log(`  total events: ${events.length}`);
    console.log(`  event types: ${[...new Set(events)].join(', ')}`);
  } catch (err) {
    console.log(`  FAILED: ${err instanceof Error ? err.message : String(err)}`);
  }
}

main().catch(console.error);
