import { mkdirSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const root = new URL("..", import.meta.url).pathname;
const outFile = join(root, ".myhead-probe", "local-cli-capability.json");

function run(command, args, options = {}) {
  const startedAt = new Date().toISOString();
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    timeout: options.timeoutMs ?? 10_000,
  });
  return {
    command,
    args,
    startedAt,
    exitCode: result.status,
    signal: result.signal,
    error: result.error ? String(result.error.message ?? result.error) : null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function commandPath(name) {
  const result = run("which", [name]);
  return {
    found: result.exitCode === 0 && result.stdout.trim().length > 0,
    path: result.stdout.trim() || null,
    raw: result,
  };
}

function binaryText(path) {
  if (!path) return "";
  try {
    return readFileSync(path, "latin1");
  } catch {
    return "";
  }
}

function hasText(output, needle) {
  return output.includes(needle);
}

function combined(result) {
  return `${result.stdout}\n${result.stderr}`;
}

function check(label, value, details = "") {
  return { label, pass: Boolean(value), details };
}

const codexPath = commandPath("codex");
const claudePath = commandPath("claude");

const codex = {
  path: codexPath.path,
  version: codexPath.found ? run("codex", ["--version"]) : null,
  topHelp: codexPath.found ? run("codex", ["--help"]) : null,
  execHelp: codexPath.found ? run("codex", ["exec", "--help"]) : null,
  execResumeHelp: codexPath.found ? run("codex", ["exec", "resume", "--help"]) : null,
};

const claude = {
  path: claudePath.path,
  version: claudePath.found ? run("claude", ["--version"]) : null,
  help: claudePath.found ? run("claude", ["--help"]) : null,
  printHelp: claudePath.found ? run("claude", ["-p", "--help"]) : null,
};

const codexExecHelp = codex.execHelp ? combined(codex.execHelp) : "";
const codexExecResumeHelp = codex.execResumeHelp ? combined(codex.execResumeHelp) : "";
const claudeHelp = `${claude.help ? combined(claude.help) : ""}\n${claude.printHelp ? combined(claude.printHelp) : ""}`;
const claudeBinaryText = binaryText(claudePath.path);

const checks = [
  check("codex command found", codexPath.found, codexPath.path ?? ""),
  check("claude command found", claudePath.found, claudePath.path ?? ""),
  check("codex --version exits 0", codex.version?.exitCode === 0, codex.version ? combined(codex.version).trim() : ""),
  check("claude --version exits 0", claude.version?.exitCode === 0, claude.version ? combined(claude.version).trim() : ""),
  check("codex exec --help exits 0", codex.execHelp?.exitCode === 0, codex.execHelp ? combined(codex.execHelp).slice(0, 200) : ""),
  check("codex exec --help has --cd", hasText(codexExecHelp, "--cd")),
  check("codex exec --help has --json", hasText(codexExecHelp, "--json")),
  check("codex exec --help has --output-last-message", hasText(codexExecHelp, "--output-last-message")),
  check("codex exec --help has dangerous bypass flag", hasText(codexExecHelp, "--dangerously-bypass-approvals-and-sandbox")),
  check("codex exec resume --help exits 0", codex.execResumeHelp?.exitCode === 0, codex.execResumeHelp ? combined(codex.execResumeHelp).slice(0, 200) : ""),
  check("codex exec resume --help mentions session", /session/i.test(codexExecResumeHelp)),
  check("claude --help exits 0", claude.help?.exitCode === 0, claude.help ? claudeHelp.slice(0, 200) : ""),
  check("claude -p --help exits 0", claude.printHelp?.exitCode === 0, claude.printHelp ? combined(claude.printHelp).slice(0, 200) : ""),
  check("claude --help has -p", hasText(claudeHelp, "-p")),
  check("claude --help has stream-json", hasText(claudeHelp, "stream-json")),
  check("claude install has --verbose", claudeBinaryText.includes("--verbose")),
  check("claude --help has --permission-mode", hasText(claudeHelp, "--permission-mode")),
  check("claude --help has --dangerously-skip-permissions", hasText(claudeHelp, "--dangerously-skip-permissions")),
  check("claude install has bypassPermissions mode", claudeBinaryText.includes("bypassPermissions")),
  check("claude install has --append-system-prompt-file", claudeBinaryText.includes("--append-system-prompt-file")),
  check("claude install has --session-id", claudeBinaryText.includes("--session-id")),
  check("claude --help has --resume", hasText(claudeHelp, "--resume")),
];

const report = {
  generatedAt: new Date().toISOString(),
  platform: process.platform,
  root,
  checks,
  summary: {
    passed: checks.filter((item) => item.pass).length,
    failed: checks.filter((item) => !item.pass).length,
  },
  raw: { codex, claude },
};

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`);

for (const item of checks) {
  const mark = item.pass ? "PASS" : "FAIL";
  console.log(`${mark} ${item.label}${item.details ? ` :: ${item.details}` : ""}`);
}
console.log(`\nSaved report: ${outFile}`);

if (report.summary.failed > 0) {
  process.exit(1);
}
