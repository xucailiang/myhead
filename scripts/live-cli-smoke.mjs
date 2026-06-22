import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const root = new URL("..", import.meta.url).pathname;
const reportDir = join(root, ".myhead-probe");
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const reportFile = join(reportDir, `live-cli-smoke-${runId}.json`);

function run(command, args, options = {}) {
  const startedAt = new Date().toISOString();
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    input: options.input,
    encoding: "utf8",
    timeout: options.timeoutMs ?? 180_000,
    maxBuffer: options.maxBuffer ?? 20 * 1024 * 1024,
  });
  return {
    command,
    args,
    cwd: options.cwd ?? root,
    startedAt,
    endedAt: new Date().toISOString(),
    exitCode: result.status,
    signal: result.signal,
    error: result.error ? String(result.error.message ?? result.error) : null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function write(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function readIfExists(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function makeWorkspace(agent) {
  const dir = mkdtempSync(join(tmpdir(), `myhead-${agent}-smoke-`));
  write(join(dir, "README.md"), `# MyHead ${agent} smoke\n\nTemporary smoke workspace.\n`);
  run("git", ["init"], { cwd: dir, timeoutMs: 30_000 });
  run("git", ["add", "README.md"], { cwd: dir, timeoutMs: 30_000 });
  run("git", ["commit", "-m", "init"], { cwd: dir, timeoutMs: 30_000 });
  return dir;
}

function extractUuid(text) {
  const matches = text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi);
  return matches?.[0] ?? null;
}

function summarizeResult(name, first, resume, expectedText) {
  const combined = `${first.stdout}\n${first.stderr}\n${resume?.stdout ?? ""}\n${resume?.stderr ?? ""}`;
  const failed = first.exitCode !== 0 || (resume !== null && resume.exitCode !== 0);
  return {
    name,
    firstExitCode: first.exitCode,
    resumeExitCode: resume?.exitCode ?? null,
    firstTimedOut: first.error?.includes("ETIMEDOUT") ?? false,
    resumeTimedOut: resume?.error?.includes("ETIMEDOUT") ?? false,
    sawExpectedText: combined.includes(expectedText),
    likelyAuthOrNetworkFailure: failed && /auth|login|api key|network|ENOTFOUND|ECONN|timeout|401|403|429/i.test(combined),
  };
}

function codexSmoke() {
  const workspace = makeWorkspace("codex");
  const firstOut = join(workspace, "codex-first-last-message.txt");
  const resumeOut = join(workspace, "codex-resume-last-message.txt");
  const prompt = [
    "MYHEAD LIVE SMOKE TEST.",
    "Do not modify files. Do not run commands unless absolutely necessary.",
    "Reply exactly: MYHEAD_CODEX_SMOKE_OK",
  ].join("\n");

  const first = run(
    "codex",
    [
      "exec",
      "--cd",
      workspace,
      "--dangerously-bypass-approvals-and-sandbox",
      "--json",
      "--output-last-message",
      firstOut,
      "-",
    ],
    { cwd: workspace, input: prompt, timeoutMs: 180_000 },
  );

  const firstArtifact = readIfExists(firstOut);
  const sessionId = extractUuid(`${first.stdout}\n${first.stderr}\n${firstArtifact}`);
  let resume = null;
  let resumeArtifact = "";
  if (sessionId) {
    resume = run(
      "codex",
      [
        "exec",
        "--cd",
        workspace,
        "--dangerously-bypass-approvals-and-sandbox",
        "resume",
        "--json",
        "--output-last-message",
        resumeOut,
        sessionId,
        "-",
      ],
      {
        cwd: workspace,
        input: "Continue the smoke test. Reply exactly: MYHEAD_CODEX_RESUME_OK",
        timeoutMs: 180_000,
      },
    );
    resumeArtifact = readIfExists(resumeOut);
  }

  return {
    workspace,
    firstOut,
    resumeOut,
    sessionId,
    first,
    firstArtifact,
    resume,
    resumeArtifact,
    summary: summarizeResult("codex", first, resume, "MYHEAD_CODEX_SMOKE_OK"),
  };
}

function claudeSmoke() {
  const workspace = makeWorkspace("claude");
  const systemPrompt = join(workspace, "myhead-system-prompt.md");
  const sessionId = randomUUID();
  write(systemPrompt, "You are running a MyHead smoke test. Do not modify files. Reply with the exact requested marker.\n");

  const first = run(
    "claude",
    [
      "-p",
      "--verbose",
      "--output-format",
      "stream-json",
      "--dangerously-skip-permissions",
      "--append-system-prompt-file",
      systemPrompt,
      "--session-id",
      sessionId,
      "Reply exactly: MYHEAD_CLAUDE_SMOKE_OK",
    ],
    { cwd: workspace, timeoutMs: 180_000 },
  );

  const resume = run(
    "claude",
    [
      "-p",
      "--verbose",
      "--output-format",
      "stream-json",
      "--dangerously-skip-permissions",
      "--resume",
      sessionId,
      "Continue the smoke test. Reply exactly: MYHEAD_CLAUDE_RESUME_OK",
    ],
    { cwd: workspace, timeoutMs: 180_000 },
  );

  return {
    workspace,
    systemPrompt,
    sessionId,
    first,
    resume,
    summary: summarizeResult("claude", first, resume, "MYHEAD_CLAUDE_SMOKE_OK"),
  };
}

mkdirSync(reportDir, { recursive: true });

const report = {
  generatedAt: new Date().toISOString(),
  platform: process.platform,
  root,
  codex: codexSmoke(),
  claude: claudeSmoke(),
};

writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);

for (const entry of [report.codex.summary, report.claude.summary]) {
  const first = entry.firstExitCode === 0 ? "PASS" : "FAIL";
  const resume = entry.resumeExitCode === 0 ? "PASS" : "FAIL";
  console.log(`${entry.name}: first=${first} resume=${resume} expectedText=${entry.sawExpectedText ? "yes" : "no"} authOrNetworkSuspected=${entry.likelyAuthOrNetworkFailure ? "yes" : "no"}`);
}

console.log(`Saved report: ${reportFile}`);

if (report.codex.summary.firstExitCode !== 0 || report.claude.summary.firstExitCode !== 0) {
  process.exit(1);
}
