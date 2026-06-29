import { runAgent, AGENT_DEFS } from '../src/index.js';

const PROMPT = 'Say exactly one word: hello';

async function probeAgent(agentId: string) {
  console.log(`\n=== Probing ${agentId} stream ===`);
  const def = AGENT_DEFS.find((d) => d.id === agentId);
  if (!def) {
    console.log(`${agentId}: not registered`);
    return;
  }

  const events: string[] = [];
  try {
    for await (const ev of runAgent(agentId, { prompt: PROMPT, cwd: process.cwd() })) {
      const type = typeof ev.type === 'string' ? ev.type : 'unknown';
      if (type === 'text_delta' || type === 'assistant') {
        events.push(JSON.stringify(ev));
      } else if (type === 'stderr' || type === 'stdout') {
        events.push(`${type}: ${(ev as { chunk?: string }).chunk ?? ''}`.trimEnd());
      } else if (type === 'error') {
        events.push(`ERROR: ${JSON.stringify(ev)}`);
      }

      // Print first 10 events to avoid flooding
      if (events.length <= 10) {
        console.log(`  [${type}]`, JSON.stringify(ev).slice(0, 200));
      } else if (events.length === 11) {
        console.log('  ... (truncated)');
      }
    }
    console.log(`  total events: ${events.length}`);
  } catch (err) {
    console.log(`  FAILED: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function main() {
  await probeAgent('claude');
  await probeAgent('codex');
}

main().catch(console.error);
