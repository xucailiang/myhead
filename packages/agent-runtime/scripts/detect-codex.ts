import { detectAgent, getAgentDef } from '../src/index.js';

async function main() {
  const def = getAgentDef('codex');
  if (!def) {
    console.log('codex def not found');
    return;
  }
  const d = await detectAgent(def);
  console.log(JSON.stringify(d, null, 2));
}

main().catch(console.error);
