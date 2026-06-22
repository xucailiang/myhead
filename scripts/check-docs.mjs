import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;

const docs = {
  prd: "docs/PRD-myhead.md",
  slices: "docs/MVP-implementation-slices.md",
  premortem: "docs/PreMortem-myhead-2026-06-16.md",
  facts: "docs/CLI-capability-facts-2026-06-16.md",
};

const text = Object.fromEntries(
  Object.entries(docs).map(([key, file]) => [
    key,
    readFileSync(join(root, file), "utf8"),
  ]),
);

const allDocs = Object.entries(text)
  .map(([key, value]) => `\n--- ${key} ---\n${value}`)
  .join("\n");

const checks = [];

function requireIncludes(name, haystack, needle) {
  checks.push({
    name,
    pass: haystack.includes(needle),
    details: `Expected to find: ${needle}`,
  });
}

function requireNotIncludes(name, haystack, needle) {
  checks.push({
    name,
    pass: !haystack.includes(needle),
    details: `Unexpected text found: ${needle}`,
  });
}

function requireCountAtLeast(name, haystack, needle, min) {
  const count = haystack.split(needle).length - 1;
  checks.push({
    name,
    pass: count >= min,
    details: `Expected at least ${min} occurrences of ${needle}; found ${count}`,
  });
}

const codexFirstTurn =
  "codex exec --cd <worker-cwd> --dangerously-bypass-approvals-and-sandbox --json --output-last-message <artifact> -";
const codexResume =
  "codex exec --cd <worker-cwd> --dangerously-bypass-approvals-and-sandbox resume --json --output-last-message <artifact> <session-id> -";
const claudeFirstTurn =
  "claude -p --verbose --output-format stream-json --dangerously-skip-permissions --append-system-prompt-file <myhead-prompt-file> --session-id <uuid> <turn-prompt>";
const claudeResume =
  "claude -p --verbose --output-format stream-json --dangerously-skip-permissions --resume <session-id> <turn-prompt>";

for (const [name, content] of Object.entries(text)) {
  requireIncludes(`${name}: Codex dangerous no-approval flag`, content, "--dangerously-bypass-approvals-and-sandbox");
  requireIncludes(`${name}: Claude dangerous no-approval flag`, content, "--dangerously-skip-permissions");
}

requireIncludes("facts: Codex first-turn command", text.facts, codexFirstTurn);
requireIncludes("facts: Codex resume command", text.facts, codexResume);
requireIncludes("facts: Claude first-turn command", text.facts, claudeFirstTurn);
requireIncludes("facts: Claude resume command", text.facts, claudeResume);

requireIncludes("PRD references facts doc", text.prd, "docs/CLI-capability-facts-2026-06-16.md");
requireIncludes("Slices references facts doc", text.slices, "docs/CLI-capability-facts-2026-06-16.md");
requireIncludes("PRD records macOS target", text.prd, "MyHead MVP 只支持当前 macOS 本机环境");
requireIncludes("Slices records macOS target", text.slices, "MVP 先做当前 macOS 本机 CLI");
requireIncludes("Facts records macOS target", text.facts, "当前 MVP 以 macOS 为目标环境");
requireIncludes("Premortem records non-macOS boundary", text.premortem, "MVP 不支持 Linux / Windows");

requireCountAtLeast("No-approval terminology is used", allDocs, "no-approval mode", 8);
requireCountAtLeast("Blocked-on-approval behavior is preserved", allDocs, "审批", 8);

requireNotIncludes(
  "Old Codex fixed command must not return",
  allDocs,
  "codex --ask-for-approval never",
);
requireNotIncludes(
  "Old Codex workspace-write fixed command must not return",
  allDocs,
  "codex --ask-for-approval never --sandbox workspace-write",
);
requireNotIncludes(
  "Codex resume options must not be placed after resume",
  allDocs,
  "codex exec resume --cd",
);
requireNotIncludes(
  "Old Claude dontAsk fixed command must not return",
  allDocs,
  "--permission-mode dontAsk --append-system-prompt-file",
);
requireNotIncludes(
  "Old Claude dontAsk resume fixed command must not return",
  allDocs,
  "--permission-mode dontAsk --resume",
);
requireNotIncludes(
  "Claude permission-mode bypass fixed command must not return",
  allDocs,
  "claude -p --output-format stream-json --permission-mode bypassPermissions",
);
requireNotIncludes(
  "Claude stream-json fixed command must include verbose",
  allDocs,
  "claude -p --output-format stream-json --dangerously-skip-permissions",
);
requireNotIncludes(
  "Old Linux-only product principle must not return",
  allDocs,
  "MyHead 只支持 Linux",
);
requireNotIncludes(
  "Old Linux CLI scope must not return",
  allDocs,
  "MVP 先做 Linux 本地 CLI",
);
requireNotIncludes(
  "Old Linux target validation must not return",
  allDocs,
  "目标 Linux 环境",
);
requireNotIncludes(
  "Old macOS-as-reference wording must not return",
  allDocs,
  "macOS 可以作为开发参考环境",
);

const failed = checks.filter((check) => !check.pass);
if (failed.length > 0) {
  console.error("Documentation checks failed:");
  for (const check of failed) {
    console.error(`- ${check.name}: ${check.details}`);
  }
  process.exit(1);
}

console.log(`Documentation checks passed (${checks.length} checks).`);
