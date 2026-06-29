import { detectAgents, getAgentDef, resolveAgentLaunch, execAgentFile, AGENT_DEFS } from '../src/index.js';

async function probe() {
  console.log('=== Detecting agents ===');
  const detected = await detectAgents(AGENT_DEFS);
  for (const agent of detected) {
    console.log(`Found: ${agent.id} @ ${agent.path} (version: ${agent.version})`);
    console.log(`  capabilities:`, agent.capabilities);
  }

  console.log('\n=== Launch resolution ===');
  for (const id of ['claude', 'codex']) {
    const def = getAgentDef(id);
    if (!def) {
      console.log(`${id}: not registered`);
      continue;
    }
    const launch = resolveAgentLaunch(def);
    console.log(`${id}: launchPath=${launch.launchPath}, childPathPrepend=${launch.childPathPrepend.join(',')}`);

    if (launch.launchPath) {
      const child = execAgentFile(launch.launchPath, ['--version']);
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (d) => { stdout += d; });
      child.stderr?.on('data', (d) => { stderr += d; });
      await new Promise((resolve) => child.on('close', resolve));
      console.log(`  --version stdout: ${stdout.trim()}`);
      if (stderr) console.log(`  --version stderr: ${stderr.trim()}`);
    }
  }
}

probe().catch(console.error);
