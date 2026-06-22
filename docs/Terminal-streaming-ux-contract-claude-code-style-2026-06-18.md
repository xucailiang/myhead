# MyHead Claude-Code-Style Streaming Terminal UX Contract

日期：2026-06-18

本文是 MyHead 默认终端体验的产品合同。后续实现如果与本文冲突，应先修改本文并重新确认。

配套交互编排见 `docs/Terminal-conversation-choreography-2026-06-18.md`。本文定义必须达到的流式 UX 合同；交互编排文档定义用户、MyHead、Codex、Claude 在终端里的状态切换、发言身份和输入语义。

## 决策

MyHead 默认终端交互必须完全对标 Claude Code 的持续对话体验：

1. 用户只运行 `myhead .`。
2. 用户始终停留在同一个 MyHead REPL loop；交互 prompt 显示为 `>`。
3. 用户先和 MyHead 聊清楚目标、约束、风险和实施方案。
4. worker 仍必须由用户确认后的实施方案触发，不能由模型自动越过执行门。
5. 用户确认执行后，MyHead 自动创建或激活 execution message hub。
6. 当前终端立即切入 message hub live transcript。
7. MyHead、worker、review、verification 和 loop closed 事件全部流式显示。
8. `logs`、`show`、`history` 只用于回看、调试和自动化，不是默认观察执行过程的主路径。
9. 用户和 MyHead 的关系始终是主对话；Codex / Claude 的可见回复可以展示，但用户普通输入默认先交给 MyHead 解释。
10. UI/UX 尽量复用 MiMo-Code 的 TUI 样式和组件语言；MyHead 只新增监督编排语义，不另起一套终端视觉系统。

## 非协商原则

- message hub 不只是 JSON 存储，它是终端 live transcript 的事实来源。
- `visibility = "hub"` 的消息默认实时显示。
- `visibility = "debug"`、raw stdout / stderr、thinking、tool result、command dump 和 debug artifact 默认折叠。
- 规划阶段、执行阶段、用户决策阶段和恢复阶段都在同一个 REPL loop 中完成。
- 用户输入只通过 `>` prompt 表示；默认 transcript 不额外渲染 `User:`、`user:`、`myhead>` 或类似用户前缀。
- 每次状态转换都必须有短状态路标，例如 `plan ready`、`hub created`、`live transcript started`、`decision needed`、`loop closed`。
- worker 子进程未结束时，用户也应该已经能看到可见 worker 文本和 MyHead 状态进度。
- 不允许实现成“执行完之后打印最终摘要，再让用户自己查 logs”。
- 不允许要求用户复制 hub id 才能继续当前任务。
- 不允许把自动化子命令体验伪装成默认产品体验。
- 不允许在已有 MiMo TUI 组件可表达时，为 MyHead 新增一套不一致的 prompt、status、dialog、theme 或 message rendering。

## 默认会话生命周期

```text
cd <workspace>
myhead .

> <user task>
MyHead: streaming planning response...
MyHead: plan ready
MyHead: manual execution gate

> codex
MyHead: hub created: hub_xxx
MyHead -> codex: dispatching confirmed plan
codex: streaming visible response...
MyHead: review started
MyHead: supervisor verdict: continue
MyHead -> codex: dispatching next step
codex: streaming visible response...
MyHead: verification started: <command>
MyHead: verification passed
MyHead: supervisor verdict: accepted
MyHead: loop closed: accepted

>
```

用户确认执行后，`hub created` 和后续 hub 消息必须自动出现。用户不需要输入 `/logs`、`show <hub-id>` 或 `run --hub`。

## 流式事件模型

interactive 层应消费 controller event stream，并把事件渲染到终端。MVP 至少支持：

```ts
type MyHeadInteractiveEvent =
  | { type: "myhead_status"; text: string }
  | { type: "hub_message"; index: number; message: HubMessage }
  | { type: "worker_visible_text"; agent: AgentName; text: string }
  | { type: "artifact_saved"; kind: string; path: string }
  | { type: "review_started"; inboundMessageId: string }
  | { type: "review_completed"; status: ReviewStatus; summary: string }
  | { type: "verification_started"; command: string }
  | { type: "verification_completed"; command: string; exitCode: number | null }
  | { type: "user_decision_required"; prompt: string }
  | { type: "loop_closed"; verdict: string; summary: string };
```

Process runner 必须支持 stdout / stderr chunk callback。Codex adapter 应边读边解析 JSONL，Claude adapter 应边读边解析 `stream-json`。解析出的 assistant visible text 应尽早产生 `worker_visible_text`，最终仍以标准 artifact 和 hubLog 收口。

## 渲染规则

- 默认复用 MiMo-Code theme provider、`mimocode` theme、plain terminal transparent theme、prompt 组件和 message rendering。
- MyHead 状态用短句，例如 `MyHead: reviewing codex response...`。
- 出站指令用 `MyHead -> codex:` 或 `MyHead -> claude:`。
- worker 可见文本用 `codex:` 或 `claude:`。
- review 只显示 verdict、摘要和下一步，不显示完整 prompt。
- verification 只显示 command、pass/fail 和短摘要。
- artifact 默认只显示数量或简短路径提示。
- 最终摘要显示 verdict、changed files、verification、risk、next action、hub id 和 run id。
- 用户输入不作为带前缀的 transcript 行重复打印；回放时如需展示用户决策，也应避免与 MyHead label 混淆。
- MyHead 新增状态块必须使用 MiMo theme token 的 text / textMuted / success / warning / error / border / backgroundPanel 等语义色，不硬编码另一套 palette。

## 用户输入规则

1. 规划阶段普通文本继续和 MyHead 对话，并可更新实施方案。
2. `plan_ready` 状态下，只有明确执行选择才启动 worker，例如 `codex`、`claude`、`both`、`1`、`2`、`3`。
3. 执行阶段普通文本默认不是新任务。只有当 MyHead 进入 `needs_user_decision` 时，普通文本才作为用户决策写入 hubLog。
4. 执行阶段如果用户输入普通新需求，MyHead 应提示当前 run 仍在执行，并提供 queue note / pause / ignore 之类的明确处理；MVP 可以先提示并拒绝隐式派发。
5. `/logs`、`/history`、`/show` 是会话内回看动作，不改变默认 live transcript。
6. Ctrl+C 第一次应提示 worker 仍在运行；第二次才尝试取消并保存状态。

## 验收

MVP 不能只用最终摘要验收。必须通过以下手动体验：

1. 运行 `myhead .` 后进入 REPL。
2. 输入一个普通开发任务。
3. MyHead 流式输出规划过程和实施方案。
4. 计划 ready 后显示手动执行入口，且 `>` prompt 仍可接受普通补充。
5. 用户输入 `codex` 或 `claude` 后，不退出当前会话。
6. 终端自动显示 `hub created`。
7. worker 可见文本在子进程结束前逐段出现。
8. review 和 verification 状态逐段出现。
9. loop closed 后显示最终摘要并回到 `>` prompt。
10. raw stdout / stderr 不进入默认 transcript，但可以通过 logs 回看。
11. 执行中普通用户输入不会被静默当作新 worker 任务。
12. `needs_user_decision` 时，用户输入会被明确写入 hubLog，并由 MyHead 生成下一步。
13. MyHead 新增 UI 与 MiMo TUI 组件语言一致，不能像另一个 CLI 拼接在 MiMo runtime 外面。

## 自动化边界

自动化子命令可以保留：

- `plan --request --out`
- `plan accept --file`
- `run --hub`
- `resume --hub`
- `logs`
- `show`
- `history`
- `--json`

这些能力只服务脚本、测试、CI 和高级调试。默认产品心智必须始终是：`myhead .` 进入持续流式终端对话，用户输入只显示为 `>` prompt。
