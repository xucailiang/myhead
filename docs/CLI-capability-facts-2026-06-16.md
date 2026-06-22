# MyHead CLI Capability Facts

日期：2026-06-16

本文记录 MyHead MVP 对 Codex CLI 和 Claude Code CLI 的 capability 判断，包括官方文档 / 本地安装包检查，以及当前 macOS 目标环境上的真实 smoke test。当前 MVP 以 macOS 为目标环境；Linux / Windows 不进入本阶段验收范围。

## 结论

MyHead MVP 默认不透出 worker 审批、tool confirmation 或 ask 选项。固定路径必须使用无审批模式：

- Codex：`--dangerously-bypass-approvals-and-sandbox`。
- Claude Code：`--dangerously-skip-permissions`。

这两种模式都应被视为高权限执行路径。MyHead 必须记录 no-approval mode、cwd / worktree、命令元数据和 blocked event。双 worker compare 默认使用隔离 worktree / 临时副本；同一工作树协作必须显式启用并串行化写入。

## 当前 macOS 目标环境实测结果

测试时间：2026-06-16。

本机版本：

- Codex CLI：`codex-cli 0.140.0`，路径 `/Users/justin/.local/bin/codex`。
- Claude Code：`2.1.153`，路径 `/opt/homebrew/bin/claude`。

已通过脚本：

- `scripts/probe-local-cli.mjs`：help / version / 本地安装包字符串 probe。
- `scripts/live-cli-smoke.mjs`：临时目录内真实首轮调用 + resume 调用。
- `scripts/adapter-contract-smoke.mjs`：临时目录内真实文件写入 + resume 后继续写入 + 输出结构解析。

证据文件：

- `.myhead-probe/local-cli-capability.json`。
- `.myhead-probe/live-cli-smoke-2026-06-16T13-57-27-060Z.json`。
- `.myhead-probe/adapter-contract-smoke-2026-06-16T13-58-08-156Z.json`。

实测结论：

- Codex 固定首轮命令可真实调用，能捕获 `thread_id`，能写 `--output-last-message` artifact。
- Codex 固定 resume 命令可真实调用，能恢复同一 `thread_id` 并继续写入临时工作区文件。
- Claude 固定首轮命令可真实调用，`stream-json` 可解析，输出中 `permissionMode = "bypassPermissions"`。
- Claude 固定 resume 命令可真实调用，能恢复同一 `session_id` 并继续写入临时工作区文件。
- 两个 worker 在 no-approval mode 下均能在临时工作区无交互创建文件。

边界：

- 上述真实测试在当前 macOS 目标环境上完成，作为 MVP 当前 adapter 固定路径验收依据。
- Linux / Windows 未来若纳入支持范围，必须单独复跑 capability probe 和 adapter contract smoke。
- Codex stderr 中可能出现插件 catalog 401 warning；不影响本次 worker prompt / resume 主路径。
- 真实 adapter 仍必须保存 stdout / stderr raw artifact，避免结构变化时丢失证据。

## Codex CLI

文档层确认：

- `codex exec` 是官方非交互 / automation 入口。
- `codex exec resume` 是后续轮次恢复入口。
- `--json` 可用于结构化事件输出。
- `--output-last-message <file>` 可保存最后一条 assistant 消息。
- `--cd <dir>` 可指定 worker cwd。
- `-` 可从 stdin 读取 prompt。
- `--dangerously-bypass-approvals-and-sandbox` 是无审批且绕过沙箱的模式。

MVP 固定首轮命令：

```bash
codex exec --cd <worker-cwd> --dangerously-bypass-approvals-and-sandbox --json --output-last-message <artifact> -
```

MVP 固定后续轮次命令：

```bash
codex exec --cd <worker-cwd> --dangerously-bypass-approvals-and-sandbox resume --json --output-last-message <artifact> <session-id> -
```

不得作为 MVP 固定路径：

- `--ask-for-approval never` 作为 Codex exec 固定 no-approval 路径。
- `--sandbox workspace-write` 作为“默认无审批”的替代方案。
- `--full-auto`，该路径在官方文档中已被标记为旧/废弃方向。

当前 macOS 已验证：

- 当前本机 Codex 0.140.0 接受上述 flag 位置。
- `exec resume` 中 options、`<session-id>` 和 stdin prompt 的实际顺序已验证：`--cd` 和 no-approval flag 放在 `resume` 前，作为 `codex exec` 父级 options；`--json` 和 `--output-last-message` 放在 `resume` 后，作为 resume options。
- 首轮输出能捕获 `thread_id`。
- session store 在非沙箱运行时可读写，后续 resume 能恢复同一原生会话。
- no-approval 模式下创建文件未产生审批、tool confirmation 或 ask 事件。

非 macOS 环境若纳入支持范围仍需复跑：

- CLI 版本、flag 位置、session store、auth 和 no-approval 行为。

## Claude Code CLI

文档层确认：

- `claude -p` 是 print / 非交互入口。
- `--output-format stream-json` 可输出流式 JSON；本机 Claude Code 2.1.153 要求与 `--verbose` 搭配使用。
- `--dangerously-skip-permissions` 是当前 CLI 明确暴露的无审批启动参数。
- `--permission-mode bypassPermissions` 是内部/等价权限模式名；本机 Claude Code 2.1.153 的安装包字符串显示，直接设置 `bypassPermissions` 可能被拒绝，原因是 session 未通过 `--dangerously-skip-permissions` 启动。因此 MVP 固定路径使用 `--dangerously-skip-permissions`。
- `--append-system-prompt-file <file>` 可从文件追加 system prompt。
- `--session-id <uuid>` 可指定会话 id。
- `--resume <session-id>` 可恢复会话。

MVP 固定首轮命令：

```bash
claude -p --verbose --output-format stream-json --dangerously-skip-permissions --append-system-prompt-file <myhead-prompt-file> --session-id <uuid> <turn-prompt>
```

MVP 固定后续轮次命令：

```bash
claude -p --verbose --output-format stream-json --dangerously-skip-permissions --resume <session-id> <turn-prompt>
```

不得作为 MVP 默认路径：

- `--permission-mode dontAsk`，因为 MVP 默认要求完全不透出审批。
- 只使用 `--permission-mode bypassPermissions` 而不使用 `--dangerously-skip-permissions`，因为当前本机 CLI 提示 bypass 模式需要通过危险跳过权限参数启动。
- `--append-system-prompt` 作为 `--append-system-prompt-file` 不可用时的备用路径。

当前 macOS 已验证：

- 当前本机 Claude Code 2.1.153 接受 `--dangerously-skip-permissions`。
- `--append-system-prompt-file`、`--session-id`、`--resume` 可解析并可真实调用。
- `stream-json` 输出可解析；本机版本要求同时传入 `--verbose`。
- session persistence 可读写，后续 resume 能恢复同一原生会话。
- no-approval 模式下创建文件未产生审批、tool confirmation 或 ask 事件。

非 macOS 环境若纳入支持范围仍需复跑：

- CLI 版本、flag 位置、session persistence、auth 和 no-approval 行为。

## 资料来源

- Codex CLI reference: https://developers.openai.com/codex/cli/reference
- Codex non-interactive automation: https://developers.openai.com/codex/noninteractive
- OpenAI Codex repository: https://github.com/openai/codex
- Claude Code CLI reference: https://docs.anthropic.com/en/docs/claude-code/cli-reference
- Claude Code repository: https://github.com/anthropics/claude-code
