# MyHead Implementation Progress Audit

日期：2026-06-16

本审计只记录当前仓库事实，不把尚未验证的能力当作已完成。

## 已完成并有自动化验证的范围

| 范围 | 当前证据 |
| --- | --- |
| Phase 0 工程骨架 | `package.json`、`tsconfig.json`、`pnpm-lock.yaml`；`pnpm run lint` 通过 |
| docs 一致性检查 | `pnpm run check:docs` 通过，当前 31 项检查 |
| Phase 1 workspace/config | `tests/unit/workspace.test.ts`、`tests/unit/config.test.ts`、`tests/unit/cli.test.ts`；CLI 只接受 `myhead .`，启动时检测全局 `~/.myhead/config.json`；存在则使用，不存在则进入首次配置引导；MyHead 自身模型配置直接保存明文 `apiKey`，不使用环境变量引用 |
| MyHead model smoke | `myhead . config smoke`；`pnpm run smoke:model:compat` 会使用同一 key 同时验证 OpenAI-compatible DashScope `https://dashscope.aliyuncs.com/compatible-mode/v1` 和 Anthropic-compatible DashScope `https://dashscope.aliyuncs.com/apps/anthropic`；2026-06-17 联网实测二者均返回 `myhead model smoke`；脚本读取全局 `~/.myhead/config.json`，输出不打印 API key |
| Phase 2 hub JSON/history | `src/hub/*`；HubWriter 并发 append 单测；`history/show` 可读 |
| Phase 3 confirmed plan | `src/planning/*`；`plan accept` 保存 `plan.md`、`task.json` 并创建 hub |
| Phase 4 adapter capability contract | `src/adapters/*`；Codex/Claude 固定 argv 单测；`myhead . probe --agent both` 本机通过；`runPushLoop` 和 `compare` 在启动 worker 前调用 adapter capability probe，probe blocked 时记录 `capability_missing` 并且不启动 worker；fake `codex` / `claude` 子进程 E2E 覆盖默认 adapter probe + first-turn + resume 命令路径 |
| Phase 5 first-turn skeleton | `src/controller/firstTurn.ts`；fake adapter 单测覆盖 snapshot、turnInvocation、hubLog、pendingQueue；Codex 优先使用 `--output-last-message` 最终响应，Claude 解析 `stream-json` 的最终 `result` / text content，raw stream 仍保存为 artifact，hubLog 只写过滤后的最终响应文本 |
| Phase 6 diff/verification evidence | `src/verify/*`；git/non-git、secret redaction、verification artifact 单测 |
| Phase 7 supervisor review | `src/review/*`；mock model 单测覆盖 reviewed、failed、no_pending |
| Phase 8 push loop / checkpoint recovery | `src/controller/pushLoop.ts`；fake in-memory two-turn E2E 覆盖 continue/resume/accepted、verify、maxAutoTurns；fake CLI child-process two-turn E2E 覆盖 Codex / Claude 默认 adapter first-turn + resume；continue / revise 写入 MyHead reply message 和 `replyMessageId`；`replying` 可从已保存 review/reply checkpoint 恢复并 resume worker，`verifying` 可从 hub JSON 恢复并运行验证，缺少 worker 原生 session id 时明确 blocked；terminal worker blocked/failed/accepted 均写入 final result、changed files、diff artifact、`Loop closed` hub event，并在存在 run task 时通过标准 schema 写入 `.myhead/runs/<run-id>/result.json` |
| Phase 9 logs/json output and wakeup UX | `logs <run-id>`、`history --json`、`show --json` 单测和 CLI smoke；自动化子命令仍可用于脚本和调试，且 `--json` 不混入交互 transcript；`myhead .` 默认进入 REPL，`/help`、`/status`、`/plan`、`/edit-plan`、`/execute`、`/continue`、`/logs`、`/history`、`/cancel`、`/exit` 在同一会话内工作；生成计划后展示手动执行入口并继续接受普通消息；`needs_user_decision` 下普通输入会写入 hubLog，不被误判为新规划；执行阶段通过 `onEvent` 实时投影 MyHead 状态、hub message、worker visible text、review、verification 和 loop closed；`run` / `resume` / `compare` 非 JSON 自动化模式仍按 hubLog 打印消息并保留危险 no-approval 显式确认门 |
| Phase 10 compare first-turn and recommendation skeleton | `src/compare/isolation.ts`、`src/controller/compare.ts`、`src/review/compare.ts`；temp-copy isolation、双 worker 同 hub fake first-turn、comparison recommendation、blocked 分支单测 |
| Worker permission / ask detection | `src/adapters/blocking.ts`、`src/controller/firstTurn.ts`；worker 输出出现 approval / tool confirmation / ask option 时记录 `blockedEvents`，不进入 pendingQueue |
| Worker final text extraction | `src/adapters/finalText.ts`、`tests/unit/adapter-runtime.test.ts`；过滤 `<think>` / `<thinking>` / reasoning / thought block，Claude 流式 JSON 中跳过 thinking content block，Codex 嵌套 `item.agent_message` JSONL 可提取最终可见文本，Claude 无 `result` 事件时可回退到 assistant text，tool result / command output 不进入 hub 文本，纯 thinking JSON 不回退保存 raw stream |
| Dangerous controller E2E harness | `scripts/dangerous-controller-e2e.mjs`、`pnpm run smoke:controller:e2e`；默认安全退出，只有 `MYHEAD_DANGEROUS_E2E=1` 时才在临时 workspace 启动真实 Codex / Claude dangerous no-approval controller run |

当前完整单测命令：

```bash
pnpm run test
```

最近一次结果：79 tests passed。

## 已实现但仍需真实环境验收的范围

| 范围 | 未完成证据 |
| --- | --- |
| 真实 Codex first-turn + resume 由 MyHead controller 驱动 | fake CLI child-process E2E 已覆盖默认 adapter 命令路径；真实 Codex dangerous no-approval worker E2E 尚未获批执行 |
| 真实 Claude first-turn + resume 由 MyHead controller 驱动 | fake CLI child-process E2E 已覆盖默认 adapter 命令路径；真实 Claude dangerous no-approval worker E2E 尚未获批执行 |
| 真实 supervisor API 调用 | `config smoke` 已验证 OpenAI-compatible 与 Anthropic-compatible JSON 调用；仍需把真实 supervisor review 放入真实 worker controller E2E |
| compare 真实质量比较 | comparison review/recommendation 已有 mock supervisor 自动化验证；仍需真实 Codex / Claude worker 输出和真实 supervisor API 的端到端验收 |
| raw artifact 完整 UX polish | `logs` 可列 artifact；`myhead .` 入口已有持续 REPL 和 live transcript 投影；run/compare 默认摘要与 verbose/json 已有单测覆盖；仍需真实 worker E2E 产物验证最终 UX |

## 明确未完成

1. 不能宣称 MVP 主闭环已由真实 worker 完成；目前主闭环 E2E 使用 fake adapter 和 mock supervisor。
2. 不能宣称双 worker compare 已由真实 worker 完成；目前 compare recommendation 使用 mock supervisor 自动化验证，真实 Codex / Claude 输出仍需危险 no-approval E2E 证据。
3. 不能宣称压缩上下文能力已完成；MVP 按计划只支持 full context，超限 blocked。
4. 不支持 Linux / Windows；当前仍是 macOS 本机 MVP。
5. 已申请运行真实 Codex dangerous controller E2E，但本轮权限审查因高风险拒绝；不得绕过该限制，需用户对具体高风险命令明确批准后再运行。

## 下一步建议

1. 在显式风险确认下运行 `MYHEAD_DANGEROUS_E2E=1 MYHEAD_E2E_AGENT=codex pnpm run smoke:controller:e2e`：first-turn、review、resume、artifact、hub JSON、changed files、`Loop closed` event。
2. 在显式风险确认下运行 `MYHEAD_DANGEROUS_E2E=1 MYHEAD_E2E_AGENT=claude pnpm run smoke:controller:e2e`。
3. 用真实 Codex / Claude 输出和真实 supervisor API 运行 compare recommendation E2E。
4. 收紧默认最终输出，展示 verdict、worker、changed files、verification、risk、next action、hub id、run id。
