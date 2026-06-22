import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const root = new URL("..", import.meta.url).pathname;
const reportDir = join(root, ".myhead-probe");
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const reportFile = join(reportDir, `adapter-contract-smoke-${runId}.json`);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    input: options.input,
    encoding: "utf8",
    timeout: options.timeoutMs ?? 240_000,
    maxBuffer: options.maxBuffer ?? 30 * 1024 * 1024,
  });
  return {
    command,
    args,
    cwd: options.cwd ?? root,
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

function read(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

function makeWorkspace(agent) {
  const dir = mkdtempSync(join(tmpdir(), `myhead-${agent}-contract-`));
  write(join(dir, "README.md"), `# MyHead ${agent} contract smoke\n`);
  run("git", ["init"], { cwd: dir, timeoutMs: 30_000 });
  return dir;
}

function extractUuid(text) {
  const matches = text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi);
  return matches?.[0] ?? null;
}

function parseJsonLines(text) {
  const parsed = [];
  const errors = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      parsed.push(JSON.parse(line));
    } catch (error) {
      errors.push({ line: line.slice(0, 500), error: String(error.message ?? error) });
    }
  }
  return { parsed, errors };
}

function hasMarker(result, artifact, marker) {
  return `${result.stdout}\n${result.stderr}\n${artifact ?? ""}`.includes(marker);
}

function codexContract() {
  const workspace = makeWorkspace("codex");
  const firstArtifactPath = join(workspace, "codex-first-last-message.txt");
  const resumeArtifactPath = join(workspace, "codex-resume-last-message.txt");
  const firstFile = join(workspace, "codex-first-proof.txt");
  const resumeFile = join(workspace, "codex-resume-proof.txt");
  const firstPrompt = [
    "MYHEAD ADAPTER CONTRACT SMOKE TEST.",
    "Create a file named codex-first-proof.txt in the current workspace.",
    "The file content must be exactly: MYHEAD_CODEX_FILE_OK",
    "Then reply exactly: MYHEAD_CODEX_WRITE_OK",
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
      firstArtifactPath,
      "-",
    ],
    { cwd: workspace, input: firstPrompt },
  );
  const firstArtifact = read(firstArtifactPath);
  const firstJson = parseJsonLines(first.stdout);
  const sessionId = extractUuid(`${first.stdout}\n${first.stderr}\n${firstArtifact ?? ""}`);

  let resume = null;
  let resumeArtifact = null;
  let resumeJson = { parsed: [], errors: [] };
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
        resumeArtifactPath,
        sessionId,
        "-",
      ],
      {
        cwd: workspace,
        input: [
          "Continue the MyHead adapter contract smoke test.",
          "Create a file named codex-resume-proof.txt in the current workspace.",
          "The file content must be exactly: MYHEAD_CODEX_RESUME_FILE_OK",
          "Then reply exactly: MYHEAD_CODEX_RESUME_WRITE_OK",
        ].join("\n"),
      },
    );
    resumeArtifact = read(resumeArtifactPath);
    resumeJson = parseJsonLines(resume.stdout);
  }

  const gitStatus = run("git", ["status", "--short"], { cwd: workspace, timeoutMs: 30_000 });
  return {
    workspace,
    sessionId,
    first,
    firstArtifactPath,
    firstArtifact,
    firstJsonSummary: {
      count: firstJson.parsed.length,
      errors: firstJson.errors,
      types: firstJson.parsed.map((item) => item.type).filter(Boolean),
    },
    resume,
    resumeArtifactPath,
    resumeArtifact,
    resumeJsonSummary: {
      count: resumeJson.parsed.length,
      errors: resumeJson.errors,
      types: resumeJson.parsed.map((item) => item.type).filter(Boolean),
    },
    files: {
      first: read(firstFile),
      resume: read(resumeFile),
    },
    gitStatus,
    pass: {
      firstExit: first.exitCode === 0,
      sessionCaptured: Boolean(sessionId),
      firstArtifactMarker: hasMarker(first, firstArtifact, "MYHEAD_CODEX_WRITE_OK"),
      firstFileContent: read(firstFile)?.trim() === "MYHEAD_CODEX_FILE_OK",
      firstJsonParsable: firstJson.errors.length === 0 && firstJson.parsed.length > 0,
      resumeExit: resume?.exitCode === 0,
      resumeArtifactMarker: resume ? hasMarker(resume, resumeArtifact, "MYHEAD_CODEX_RESUME_WRITE_OK") : false,
      resumeFileContent: read(resumeFile)?.trim() === "MYHEAD_CODEX_RESUME_FILE_OK",
      resumeJsonParsable: resumeJson.errors.length === 0 && resumeJson.parsed.length > 0,
    },
  };
}

function claudeContract() {
  const workspace = makeWorkspace("claude");
  const systemPromptPath = join(workspace, "myhead-system-prompt.md");
  const firstFile = join(workspace, "claude-first-proof.txt");
  const resumeFile = join(workspace, "claude-resume-proof.txt");
  const sessionId = randomUUID();
  write(systemPromptPath, [
    "You are running a MyHead adapter contract smoke test.",
    "Follow the user instruction exactly.",
  ].join("\n"));

  const first = run(
    "claude",
    [
      "-p",
      "--verbose",
      "--output-format",
      "stream-json",
      "--dangerously-skip-permissions",
      "--append-system-prompt-file",
      systemPromptPath,
      "--session-id",
      sessionId,
      [
        "Create a file named claude-first-proof.txt in the current workspace.",
        "The file content must be exactly: MYHEAD_CLAUDE_FILE_OK",
        "Then reply exactly: MYHEAD_CLAUDE_WRITE_OK",
      ].join(" "),
    ],
    { cwd: workspace },
  );
  const firstJson = parseJsonLines(first.stdout);

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
      [
        "Continue the MyHead adapter contract smoke test.",
        "Create a file named claude-resume-proof.txt in the current workspace.",
        "The file content must be exactly: MYHEAD_CLAUDE_RESUME_FILE_OK",
        "Then reply exactly: MYHEAD_CLAUDE_RESUME_WRITE_OK",
      ].join(" "),
    ],
    { cwd: workspace },
  );
  const resumeJson = parseJsonLines(resume.stdout);
  const gitStatus = run("git", ["status", "--short"], { cwd: workspace, timeoutMs: 30_000 });

  return {
    workspace,
    sessionId,
    systemPromptPath,
    first,
    firstJsonSummary: {
      count: firstJson.parsed.length,
      errors: firstJson.errors,
      types: firstJson.parsed.map((item) => item.type).filter(Boolean),
      permissionModes: firstJson.parsed.map((item) => item.permissionMode).filter(Boolean),
      sessionIds: firstJson.parsed.map((item) => item.session_id).filter(Boolean),
    },
    resume,
    resumeJsonSummary: {
      count: resumeJson.parsed.length,
      errors: resumeJson.errors,
      types: resumeJson.parsed.map((item) => item.type).filter(Boolean),
      permissionModes: resumeJson.parsed.map((item) => item.permissionMode).filter(Boolean),
      sessionIds: resumeJson.parsed.map((item) => item.session_id).filter(Boolean),
    },
    files: {
      first: read(firstFile),
      resume: read(resumeFile),
    },
    gitStatus,
    pass: {
      firstExit: first.exitCode === 0,
      firstMarker: hasMarker(first, null, "MYHEAD_CLAUDE_WRITE_OK"),
      firstFileContent: read(firstFile)?.trim() === "MYHEAD_CLAUDE_FILE_OK",
      firstJsonParsable: firstJson.errors.length === 0 && firstJson.parsed.length > 0,
      firstSessionMatches: firstJson.parsed.some((item) => item.session_id === sessionId),
      firstBypassMode: firstJson.parsed.some((item) => item.permissionMode === "bypassPermissions"),
      resumeExit: resume.exitCode === 0,
      resumeMarker: hasMarker(resume, null, "MYHEAD_CLAUDE_RESUME_WRITE_OK"),
      resumeFileContent: read(resumeFile)?.trim() === "MYHEAD_CLAUDE_RESUME_FILE_OK",
      resumeJsonParsable: resumeJson.errors.length === 0 && resumeJson.parsed.length > 0,
      resumeSessionMatches: resumeJson.parsed.some((item) => item.session_id === sessionId),
    },
  };
}

mkdirSync(reportDir, { recursive: true });
const report = {
  generatedAt: new Date().toISOString(),
  platform: process.platform,
  root,
  codex: codexContract(),
  claude: claudeContract(),
};

writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);

function printSummary(name, pass) {
  const failed = Object.entries(pass).filter(([, ok]) => !ok).map(([key]) => key);
  console.log(`${name}: ${failed.length === 0 ? "PASS" : "FAIL"}${failed.length ? ` failed=${failed.join(",")}` : ""}`);
}

printSummary("codex", report.codex.pass);
printSummary("claude", report.claude.pass);
console.log(`Saved report: ${reportFile}`);

if (Object.values(report.codex.pass).some((ok) => !ok) || Object.values(report.claude.pass).some((ok) => !ok)) {
  process.exit(1);
}
