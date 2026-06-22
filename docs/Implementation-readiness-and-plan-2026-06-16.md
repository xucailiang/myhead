# MyHead 实施条件评估与专业实施计划

日期：2026-06-16  
评估范围：`docs/` 下全部现有文档，包括 PRD、MVP 实现切片、Pre-Mortem 和 CLI capability facts。

## 1. 结论

MyHead MVP 已具备进入工程实施的条件。

理由如下：

1. 产品目标、MVP 范围和非目标已经明确：当前只做 macOS 本机 CLI，唯一启动入口为 `myhead .`，不做 Web UI、App、托盘工具、远程执行、Linux / Windows 兼容或备用 worker 调用路径。
2. 核心技术闭环已经定义清楚：`myhead . -> 配置 -> 临时规划对话 -> 用户确认实施方案 -> 创建 message hub -> 固定方式启动 worker -> 接收响应 -> 写入 hubLog / pendingQueue -> supervisor 审查 -> 继续推进或收敛 -> 保存 JSON 历史`。
3. 最大不确定项已经通过文档和本机 smoke test 收敛：Codex CLI 与 Claude Code CLI 的固定 no-approval 调用路径、结构化输出、prompt 注入、resume 和真实文件写入均已有当前 macOS 环境实测证据。
4. 核心风险已被转化为工程约束：message hub 不是实时三方聊天室，而是每轮 worker 调用时注入完整 hubLog 的 context snapshot；异步响应必须入队；hub JSON 必须单 writer 串行原子保存。
5. 实现切片已经具备可执行粒度：Slice 1 到 Slice 11 覆盖配置、hub 历史、规划、adapter、权限策略、diff、验证、supervisor、推进循环、compare 和 CLI 输出体验。

因此，建议立即进入 MVP 工程实现。首要目标不是实现全部愿景，而是用最小代码跑通一个可审计、可恢复、可验证的单 worker 闭环，然后扩展到双 worker compare。

## 2. 实施前置条件状态

| 条件 | 状态 | 依据 | 实施影响 |
| --- | --- | --- | --- |
| MVP 平台范围 | 已满足 | PRD 与切片均限定当前 macOS 本机环境 | 可以避免跨平台抽象，优先使用 POSIX / Node 子进程能力 |
| 唯一入口 `myhead .` | 已明确 | PRD、MVP 切片反复约束不接受 path 参数 | CLI 解析简单，workspace 绑定规则稳定 |
| MyHead 自身模型协议 | 已明确 | 支持 `openai` / `claude`，使用官方 SDK | 可以先实现薄 model client 接口 |
| Codex 固定调用路径 | 已满足 | capability facts 记录 Codex 0.140.0 实测通过 | 可以实现 Codex adapter，但仍需把 probe 纳入自动测试 |
| Claude 固定调用路径 | 已满足 | capability facts 记录 Claude Code 2.1.153 实测通过 | 可以实现 Claude adapter，但仍需版本探测和失败分支 |
| no-approval 策略 | 已明确但高风险 | 两个 worker 均使用 dangerous bypass 类参数 | 必须在 run 记录和最终输出中显式披露 |
| message hub 模型 | 已明确 | PRD 定义 hubLog、pendingQueue、agentCursor、contextSnapshot、turnInvocation | 可以先实现文件型 JSON 状态机 |
| 异步写入安全 | 已明确 | Pre-Mortem 将 hubWriter 列为 launch-blocking | 第一批代码必须实现单 writer 与原子保存 |
| 完整上下文策略 | 已明确 | MVP 固定 full hubLog，超限则 blocked | 不实现摘要与压缩，但数据结构预留版本 |
| compare 隔离策略 | 已明确 | 默认 worktree / 临时副本，无法隔离则 blocked | compare 可后置，不阻塞单 worker 闭环 |
| 现有代码基础 | 低 | 当前仓库只有 docs、probe 脚本和 probe artifact | 需要从零创建 TypeScript / Node 工程骨架 |

## 3. 仍需在实施中强制验证的事项

以下事项不阻塞开工，但必须作为早期验收门：

1. 每次本地开发或 CI smoke 必须运行 `scripts/check-docs.mjs`，防止固定 CLI 路径和文档约束漂移。
2. Slice 3 / Slice 4 前必须将现有 `probe-local-cli.mjs`、`live-cli-smoke.mjs`、`adapter-contract-smoke.mjs` 改造成可由项目命令调用的 adapter capability test。
3. Codex / Claude 的 session id 提取、resume 顺序和结构化输出解析必须被 contract test 覆盖。
4. hub JSON 写入必须通过故障注入或并发测试验证不会产生半写、乱序或丢 pendingQueue。
5. 完整 hubLog token 估算必须有保守实现；超限直接 `blocked`，不能悄悄裁剪。
6. 真实 worker no-approval run 前必须展示风险摘要，并在 hub JSON 记录 cwd / worktree、命令元数据和 permission mode。
7. MyHead 自身不得修改业务文件；除 `.myhead/`、验证命令输出和隔离工作树管理外，业务变更只能来自 worker。

## 4. 推荐技术方案

### 4.1 技术栈

MVP 使用 TypeScript / Node.js。

建议依赖：

- `commander`：CLI 命令解析。
- `execa`：子进程调用与 stdout / stderr 捕获。
- `zod`：config、hub、run、review、adapter event schema 校验。
- `openai`：OpenAI-protocol supervisor 与 planning 调用。
- `@anthropic-ai/sdk`：Claude-protocol supervisor 与 planning 调用。
- `tsx`：开发期运行 TypeScript。
- `vitest`：单元测试与集成测试。
- `eslint` / `prettier`：基础代码质量与格式。

暂不引入数据库、daemon、Web server、复杂队列、ORM 或跨平台封装。

### 4.2 工程结构

建议初始结构：

```text
package.json
tsconfig.json
src/
  cli/
    main.ts
    commands.ts
    output.ts
  core/
    workspace.ts
    ids.ts
    errors.ts
    clock.ts
  config/
    schema.ts
    load.ts
    firstRun.ts
  hub/
    schema.ts
    writer.ts
    store.ts
    context.ts
    stateMachine.ts
  planning/
    prompt.ts
    plan.ts
  adapters/
    types.ts
    capability.ts
    codex.ts
    claude.ts
  model/
    types.ts
    openaiClient.ts
    claudeClient.ts
  review/
    prompt.ts
    schema.ts
    supervisor.ts
  verify/
    commands.ts
    diff.ts
  artifacts/
    paths.ts
    sanitize.ts
tests/
  unit/
  integration/
scripts/
  check-docs.mjs
  probe-local-cli.mjs
  live-cli-smoke.mjs
  adapter-contract-smoke.mjs
```

### 4.3 核心边界

1. CLI 层只负责用户交互、参数校验和展示，不直接写 hub 状态。
2. Hub 层是执行历史事实来源，所有状态变化走 `HubWriter`。
3. Adapter 层只负责固定命令调用、输出解析和 artifact 收集，不决定下一步。
4. Review 层只输出结构化 verdict 和 recommended reply，不直接启动 worker。
5. Controller 根据 review verdict 推进状态机。
6. Verification 层只运行配置命令并产生 evidence，不接受 worker 自述作为证据。

## 5. 分阶段实施计划

### Phase 0：工程初始化与质量门

目标：把空仓库变成可开发、可测试、可发布的 TypeScript CLI 项目。

任务：

1. 创建 `package.json`、`tsconfig.json`、测试和 lint 配置。
2. 定义 `npm` scripts：`build`、`test`、`lint`、`check:docs`、`probe:cli`、`smoke:adapter`。
3. 保留并接入现有 docs/probe 脚本。
4. 建立基础错误类型、时间工具、id 生成工具和路径工具。

验收：

- `npm test` 可以运行空测试集或基础测试。
- `npm run check:docs` 调用现有文档一致性检查并通过。
- CLI binary 可以输出版本和基础帮助。

### Phase 1：Workspace 绑定与配置

对应 Slice 1。

目标：实现唯一入口 `myhead .` 和全局 `~/.myhead/config.json` 配置引导。

任务：

1. CLI 只接受 `myhead .` 作为启动入口；其他 path 形态给出简短错误。
2. 将 `.` 解析为当前 shell 所在目录绝对路径。
3. 创建 `.myhead/`、`.myhead/prompts/`、`.myhead/runs/`、`.myhead/sessions/`。
4. 实现 config schema：`protocol`、`apiKey`、`baseUrl`、`model`、prompt path、验证命令。
5. API key 明文保存在全局配置中，不使用环境变量名。
6. 实现 `config` 查看与校验。

验收：

- `myhead .` 在无配置 workspace 中进入 first-run 引导。
- `myhead /tmp/foo`、`myhead foo`、`myhead` 均被拒绝并提示正确用法。
- 不出现 Codex / Claude 模型、账号或全局配置项。

### Phase 2：Message Hub 存储与原子写入

对应 Slice 1.5。

目标：先把执行历史事实来源做好，再接 worker。

任务：

1. 实现 hub JSON schema，覆盖 `hubId`、workspace、status、confirmedPlan、selectedAgents、agentSessions、hubLog、pendingQueue、agentCursors、contextPolicy、contextSnapshots、turnInvocations、turns、blockedEvents、artifacts、finalResult、resumeCheckpoint。
2. 实现 `HubWriter`：单队列串行写入、临时文件、`rename` 原子替换。
3. 实现 `history` 和 `show <hub-id>`。
4. 实现 schema version 与最小迁移钩子。
5. 增加并发追加测试，验证不会丢消息或写坏 JSON。

验收：

- 规划对话不会创建 hub JSON。
- 只有确认执行计划后才创建 `.myhead/sessions/<hub-id>.json`。
- 并发 append 测试后 JSON 可解析、消息顺序稳定、pendingQueue 完整。

### Phase 3：规划对话与实施方案确认

对应 Slice 2。

目标：实现用户确认后的计划产物，作为 worker 和 supervisor 的唯一事实来源。

任务：

1. 创建默认 MyHead planning prompt。
2. 实现 prompt 查看 / 编辑能力。
3. 通过官方 SDK 实现 planning model call。
4. 生成实施方案字段：用户请求、目标、约束、成功标准、实施步骤、风险、开放问题、worker 策略、验证计划。
5. 提供 accept / edit / cancel。
6. 保存 `.myhead/runs/<run-id>/plan.md` 与 `task.json`。
7. 生成 plan hash，并写入后续 hub。

验收：

- 模糊需求会生成可编辑实施方案。
- cancel 不创建 execution hub。
- edit 后的最终方案成为唯一事实来源。

### Phase 4：Adapter Capability 与固定命令契约

对应 Slice 3、Slice 4、Slice 5 的前半部分。

目标：把已验证的 CLI 固定路径沉淀为代码契约。

任务：

1. 抽象 `WorkerAdapter`：`probe()`、`startTurn()`、`resumeTurn()`、`cancel()`、`parseOutput()`、`collectArtifacts()`。
2. 实现 Codex capability probe：命令存在、版本、`exec` / `resume` help、flag 位置、session store、最小调用。
3. 实现 Claude capability probe：命令存在、版本、`-p`、`stream-json + verbose`、`--dangerously-skip-permissions`、`--append-system-prompt-file`、`--session-id`、`--resume`。
4. 把现有 smoke 脚本改造为 test fixture 或项目命令。
5. 能力缺失时返回结构化 `blocked`，不尝试备用路径。

验收：

- 当前 macOS 环境上 capability probe 通过。
- 任一关键 flag 缺失时 adapter 不启动 worker，并生成 blocked reason。
- no-approval mode、cwd、prompt injection method 写入 hub JSON。

### Phase 5：单 Worker 首轮运行

对应 Slice 3 / Slice 4 的最小闭环。

目标：让 Codex 或 Claude 接收已确认计划和完整 hubLog，并返回第一轮响应。

任务：

1. 实现 prompt package builder，包含 confirmed plan、plan hash、hub id、完整 hubLog、当前步骤、成功标准、约束、输出要求。
2. Codex 使用 stdin prompt 与 `--output-last-message` artifact。
3. Claude 使用 prompt file 与 `stream-json` 输出。
4. 捕获 stdout / stderr / final artifact / exit code / startedAt / endedAt。
5. 将 worker response 追加到 hubLog 与 pendingQueue。
6. 记录 `contextSnapshot`、`turnInvocation`、`seenHubOffset`。

验收：

- Codex 单轮可以完成“分发任务 -> 响应入 hub”。
- Claude 单轮可以完成“分发任务 -> 响应入 hub”。
- raw log 默认不打印，只保存 artifact 路径。

### Phase 6：Diff、验证和 evidence

对应 Slice 6 / Slice 7。

目标：supervisor 审查时有真实证据，而不是只读 worker 自述。

任务：

1. 检测 git repo，记录 run 前后 `status`、changed files、diff summary。
2. 保存 full diff artifact。
3. 实现可配置 verification commands。
4. 实现 `verify` 动作。
5. 将命令、exit code、短摘要、完整日志路径保存到 run record 与 hub turn。
6. 对 secret pattern 做基础脱敏。

验收：

- git repo 内展示 changed files 与 diff summary。
- 非 git repo 不失败。
- 验证失败会进入 review 输入，并可驱动下一轮修正。

### Phase 7：Supervisor Review

对应 Slice 8。

目标：使用 MyHead 自身高阶模型审查 worker 结果并给出结构化下一步。

任务：

1. 实现 `completeJson(messages, schema, options)` 薄接口。
2. 接入 OpenAI SDK 与 Anthropic SDK。
3. 定义 review schema：`accepted`、`continue`、`revise`、`verify`、`needs_user_decision`、`failed`、`blocked`。
4. Review prompt 输入 confirmed plan、hubLog、当前步骤、worker 响应、diff、验证结果、blocked events。
5. 将 review result 写入 hub turns。
6. CLI 输出 verdict、evidence、risk、next action。

验收：

- supervisor review 可结构化解析。
- schema 不合法时本轮 review failed，并保留 raw artifact。
- review 不把 worker 自述当作验证证据。

### Phase 8：Implementation Push Loop

对应 Slice 9。

目标：跑通真正 MVP 闭环，而不是一次性 worker 调用。

任务：

1. 实现 controller 主循环：`listening -> message_queued -> reviewing -> verifying/replying -> listening`。
2. controller 必须暴露 streaming event sink，让 interactive 层可以实时显示 hub message、worker visible text、review、verification、user decision 和 loop closed。
3. 每轮根据 review verdict 决定继续、修正、验证、询问用户或结束。
4. 每轮 worker 调用前生成 full context snapshot；超限即 blocked。
5. 同一 worker 同一时间只允许一个 dispatch。
6. 维护 agent cursor 和 resume checkpoint。
7. 设置 max auto turns，默认建议 6。
8. worker 崩溃、输出不可解析、审批 / ask 事件出现时记录 failed / blocked。
9. 至少实现两轮 E2E smoke，并验证终端 live transcript 逐段输出。

验收：

- 单 worker 至少完成两轮“响应 -> 审查 -> 回应 / resume”。
- 每轮都有 worker response、review、reply、context snapshot 和 checkpoint。
- 用户确认执行后自动进入 message hub live transcript，不需要另跑 `logs` / `show` / `run` 才能观察执行。
- worker 可见文本、review、verification 和 loop closed 事件必须流式显示。
- accepted / failed / blocked / needs_user_decision 都能正确收敛。

### Phase 9：Claude-Code-Style Streaming Terminal UX

对应 Slice 11。

目标：默认终端体验对标 Claude Code。用户和 MyHead 聊完并确认执行后，仍留在同一个 REPL 中，自动看到 message hub 消息流；详细日志可追，但不是默认观察执行的主路径。

任务：

1. interactive 层把 controller event stream 渲染成当前终端 live transcript。
2. 默认显示 hub created、MyHead dispatch、worker visible text、review started/completed、verification started/completed、loop closed。
3. 默认不打印 raw stdout / stderr、thinking、tool noise 或 debug artifact。
4. 最终摘要展示 verdict、worker、changed files、verification、risk、next action、hub id、run id。
5. `--verbose` 展示 debug artifact 路径与关键命令元数据。
6. `--json` 输出机器可读结果，不混入交互 transcript。
7. `logs <run-id>` 展示 raw / debug artifact 路径，用于回看和调试。

验收：

- 执行阶段所有可见 hub 消息都在当前终端会话中流式出现。
- 子进程未结束时，用户已经能看到 worker visible text 和 MyHead 状态进度。
- 默认不打印 raw stdout / stderr。
- 用户能从最终输出知道 no-approval mode 风险和验证证据。

### Phase 10：双 Worker Compare

对应 Slice 10，建议放在单 worker MVP 闭环稳定后。

目标：Codex 和 Claude 在同一 hub 中比较结果，但默认隔离工作树。

任务：

1. 实现 `compare` / `exec --agent both`。
2. git repo 优先创建 `git worktree`；非 git repo 使用临时副本。
3. 无法隔离则 blocked，不自动切换 cooperate。
4. 两个 worker 使用同一 confirmed plan 和各自 context snapshot。
5. 同一个 hub 接收两方响应并入 pendingQueue。
6. supervisor 比较质量、diff 风险、验证证据、可维护性和 confidence。
7. 不自动合并冲突 diff，只给建议或请求用户决策。

验收：

- 两个 worker 的 cwd、diff、验证证据可区分。
- 任一 worker 失败不丢失另一方成功结果。
- comparison 输出清楚推荐与理由。

## 6. MVP 验收矩阵

| 能力 | 最低验收 |
| --- | --- |
| 启动入口 | 只支持 `myhead .`，其他 workspace path 形态拒绝 |
| 配置 | MyHead 自身模型配置可创建、校验、展示 |
| 规划 | 可生成、编辑、确认实施方案 |
| Hub 历史 | 确认执行后创建 JSON，完整记录 hubLog / turns / review / artifacts |
| Codex adapter | 固定路径首轮 + resume 可运行，输出可解析 |
| Claude adapter | 固定路径首轮 + resume 可运行，stream-json 可解析 |
| 权限策略 | 固定 no-approval mode；出现审批 / ask 即 blocked |
| 审查 | supervisor 输出结构化 verdict |
| 验证 | 至少支持一个配置命令并记录结果 |
| 推进循环 | 单 worker 至少两轮自动推进 |
| 恢复 | 从 hub JSON checkpoint 恢复，而不是直接恢复 worker 最近 session |
| 输出 | 默认简洁，verbose / logs 可追原始证据 |

## 7. 测试策略

### 7.1 单元测试

- workspace 参数解析与拒绝规则。
- config schema 与缺失字段错误。
- hub schema round-trip。
- HubWriter 串行写入与原子保存。
- context builder full 模式与 token 超限 blocked。
- prompt package 字段完整性。
- review schema 校验。
- secret 脱敏。

### 7.2 集成测试

- `myhead .` first-run 到 config 保存。
- confirmed plan 保存并创建 hub。
- history / show 读取 hub。
- git diff 捕获。
- verification command pass / fail。
- supervisor mock review 推动 `continue`、`revise`、`verify`、`accepted`、`blocked` 状态。

### 7.3 Contract / Smoke 测试

- Codex capability probe。
- Claude capability probe。
- Codex 首轮 + resume 写文件。
- Claude 首轮 + resume 写文件。
- 单 worker 两轮 controller E2E。
- compare 隔离工作树创建与失败 blocked。

## 8. 风险与控制

| 风险 | 级别 | 控制 |
| --- | --- | --- |
| CLI 版本变化导致固定路径失效 | 高 | 每次真实 worker run 前 probe；失败直接 blocked |
| no-approval 扩大权限 | 高 | 执行前展示风险，默认 compare 隔离，完整记录命令元数据 |
| hub JSON 写坏 | 高 | 单 writer、原子 rename、并发测试 |
| worker 输出格式变化 | 高 | 保留 raw artifact；解析失败 failed；不使用 raw 作为备用语义输入 |
| 完整 hubLog 超上下文 | 中高 | token 估算，超限 blocked，不摘要 |
| supervisor 误判 | 中 | 强制输入 diff / verification evidence，结构化 schema，保留人工决策状态 |
| compare 冲突 | 中 | 默认隔离，不自动 merge |
| 实施范围膨胀 | 中 | Phase gate；未完成单 worker 闭环前不做 UI / daemon / 跨平台 |

## 9. 里程碑建议

1. M0：工程骨架可运行，docs check 纳入命令。
2. M1：`myhead .` + config + plan 确认可用。
3. M2：hub JSON + HubWriter + history / show 可用。
4. M3：Codex / Claude capability probe 与单轮 adapter 可用。
5. M4：diff / verify / supervisor review 可用。
6. M5：单 worker 两轮 push loop 可用，达到 MVP 主闭环。
7. M6：CLI 输出 polish 与 logs / json 完成。
8. M7：双 worker compare 完成。

M5 是 MVP 可用性的关键点。M5 之前不能宣称产品闭环完成。

## 10. 开工建议

建议立即从 Phase 0 开始实施，并采用以下工程纪律：

1. 每个 phase 完成后必须有可运行命令和验收证据。
2. 所有 worker 真实调用都必须保存 artifact。
3. 不做任何备用路径；能力不满足时 blocked / failed。
4. 不把规划对话持久化；只保存确认后的计划和执行 hub。
5. compare、cooperate、UI、压缩上下文和跨平台支持全部后置。

最终优先级排序：

1. 先保证本地单 worker 闭环真实可用。
2. 再保证审查和验证证据可信。
3. 再做双 worker compare。
4. 最后再考虑 UI、压缩、跨平台和更复杂恢复。

## 11. 代码编写补充合同

本节用于把实施计划从“阶段计划”补足为“可直接指导代码编写”的工程合同。开始写代码时，开发者应优先遵守本节；若本节与 PRD 或实现切片冲突，以更严格、更少备用路径、更可审计的要求为准。

### 11.1 第一批必须落地的模块

Phase 0 到 Phase 2 的第一批代码必须至少包含：

| 模块 | 文件 | 最小职责 |
| --- | --- | --- |
| CLI entry | `src/cli/main.ts` | 注册 `myhead` binary、解析 argv、把控制权交给 command 层 |
| CLI commands | `src/cli/commands.ts` | 只接受 `myhead .`，分发 config / history / show 等动作 |
| Workspace | `src/core/workspace.ts` | 解析并校验 workspace，只允许当前目录的 `.` |
| Config schema | `src/config/schema.ts` | 用 zod 定义 MyHead 自身配置，不包含 worker 账号或模型 |
| Config load | `src/config/load.ts` | 读取、校验、保存全局 `~/.myhead/config.json` |
| Hub schema | `src/hub/schema.ts` | 定义 hub JSON 的全部核心结构 |
| Hub writer | `src/hub/writer.ts` | 单 writer 队列、临时文件、原子 rename |
| Hub store | `src/hub/store.ts` | 创建、读取、列出 `.myhead/sessions/<hub-id>.json` |
| Artifacts | `src/artifacts/paths.ts` | 统一生成 run、prompt、stdout、stderr、diff、verification artifact 路径 |
| Tests | `tests/unit/*` | 覆盖 workspace、config、hub schema、writer 原子写入 |

未完成上述模块前，不应开始真实 Codex / Claude worker 调用。

### 11.2 CLI 合同

MVP 的外部启动合同：

```text
myhead .
```

必须拒绝：

```text
myhead
myhead /path/to/project
myhead <path>
myhead chat --workspace <path>
myhead . --workspace <path>
```

拒绝时返回非 0 exit code，并输出简短错误：

```text
MyHead only supports: myhead .
Run it from the target workspace directory.
```

`myhead .` 绑定 workspace 后，才可以进入交互动作或内部子命令，例如 `plan`、`exec --agent codex|claude|both`、`history`、`show <hub-id>`、`logs <run-id>`。这些动作仍必须基于当前绑定 workspace，不接受任何 workspace path 参数。

### 11.3 最小 TypeScript 类型合同

实现时应先建立类型，再写流程。最小类型如下，实际字段可以增加，但不能删除这些语义。

```ts
export type AgentName = "codex" | "claude";
export type SelectedAgents = "codex" | "claude" | "both";

export type HubStatus =
  | "planning"
  | "plan_ready"
  | "plan_confirmed"
  | "hub_created"
  | "worker_started"
  | "listening"
  | "message_queued"
  | "reviewing"
  | "replying"
  | "verifying"
  | "needs_user_decision"
  | "accepted"
  | "failed"
  | "blocked"
  | "cancelled";

export type AgentStatus =
  | "idle"
  | "running"
  | "blocked"
  | "failed"
  | "cancelled"
  | "done";

export type ReviewStatus =
  | "accepted"
  | "continue"
  | "revise"
  | "verify"
  | "needs_user_decision"
  | "failed"
  | "blocked";

export interface MyHeadConfig {
  myhead: {
    protocol: "openai" | "claude";
    apiKey?: string;
    baseUrl?: string;
    model: string;
    systemPromptPath: string;
    editedPromptPath?: string;
    verificationCommands?: string[];
    maxAutoTurns: number;
  };
}

export interface HubMessage {
  id: string;
  role: "myhead" | "codex" | "claude";
  target?: AgentName;
  visibility: "hub" | "debug";
  createdAt: string;
  seenHubOffset?: number;
  contextSnapshotId?: string;
  content: string;
  artifactIds?: string[];
}

export interface ContextPolicy {
  mode: "full";
  version: 1;
}

export interface ContextSnapshot {
  id: string;
  targetAgent: AgentName;
  hubLogOffset: number;
  estimatedTokens: number;
  policy: ContextPolicy;
  compressedArtifact: null;
  createdAt: string;
}

export interface TurnInvocation {
  id: string;
  agent: AgentName;
  kind: "first_turn" | "resume";
  command: string;
  args: string[];
  cwd: string;
  stdinArtifact?: string;
  stdoutArtifact: string;
  stderrArtifact: string;
  outputArtifact?: string;
  contextSnapshotId: string;
  startedAt: string;
  endedAt?: string;
  exitCode?: number | null;
  signal?: string | null;
}

export interface AgentSession {
  agent: AgentName;
  nativeSessionId?: string;
  cwd: string;
  version?: string;
  promptInjection: string;
  permissionMode: string;
  capabilityProbeId?: string;
}

export interface ReviewResult {
  status: ReviewStatus;
  summary: string;
  findings: Array<{
    severity: "high" | "medium" | "low";
    message: string;
    file?: string;
    line?: number;
  }>;
  missingVerification: string[];
  recommendedReply?: string;
  nextImplementationStep?: string;
}

export interface VerificationResult {
  command: string;
  cwd: string;
  exitCode: number | null;
  startedAt: string;
  endedAt: string;
  summary: string;
  stdoutArtifact: string;
  stderrArtifact: string;
}
```

### 11.4 Hub JSON 最小合同

`src/hub/schema.ts` 必须表达以下结构：

```ts
export interface MessageHub {
  schemaVersion: 1;
  hubId: string;
  workspacePath: string;
  createdAt: string;
  updatedAt: string;
  status: HubStatus;
  confirmedPlan: {
    text: string;
    summary: string;
    hash: string;
    promptSnapshot: string;
  };
  selectedAgents: SelectedAgents;
  promptInjection: Partial<Record<AgentName, string>>;
  permissionMode: Partial<Record<AgentName, string>>;
  agentSessions: Partial<Record<AgentName, AgentSession>>;
  agentStatus: Partial<Record<AgentName, AgentStatus>>;
  hubLog: HubMessage[];
  pendingQueue: string[];
  agentCursors: Partial<Record<AgentName, number>>;
  contextPolicy: ContextPolicy;
  contextSnapshots: ContextSnapshot[];
  turnInvocations: TurnInvocation[];
  turns: Array<{
    id: string;
    inboundMessageId?: string;
    review?: ReviewResult;
    replyMessageId?: string;
    verification?: VerificationResult;
    statusBefore: HubStatus;
    statusAfter: HubStatus;
    createdAt: string;
  }>;
  blockedEvents: Array<{
    id: string;
    agent?: AgentName;
    reason:
      | "capability_missing"
      | "permission_prompt"
      | "ask_option"
      | "context_overflow"
      | "session_unavailable"
      | "workspace_isolation_failed";
    detail: string;
    artifactIds?: string[];
    createdAt: string;
  }>;
  artifacts: Array<{
    id: string;
    kind:
      | "prompt"
      | "stdout"
      | "stderr"
      | "last_message"
      | "stream_json"
      | "diff"
      | "verification"
      | "raw";
    path: string;
    sha256?: string;
    createdAt: string;
  }>;
  finalResult?: {
    verdict: "accepted" | "failed" | "blocked" | "cancelled";
    summary: string;
    changedFiles: string[];
    verification: VerificationResult[];
    risks: string[];
    nextSteps: string[];
  };
  resumeCheckpoint?: {
    hubLogOffset: number;
    currentStep?: string;
    agentSessions: Partial<Record<AgentName, string>>;
    updatedAt: string;
  };
}
```

### 11.5 HubWriter 算法合同

`HubWriter` 必须是唯一允许保存 hub JSON 的路径。

最小行为：

1. `enqueue(mutator)` 接受一个同步或异步 mutator。
2. 内部维护 promise chain，保证同一 hub 的 mutator 串行执行。
3. 每个 mutator 基于最后一次成功落盘的 hub state 生成 next state，统一更新 `updatedAt`。
4. 保存到临时文件：`.myhead/sessions/<hub-id>.json.tmp-<pid>-<seq>`。
5. 临时文件写入完成后，用 `rename` 原子替换正式文件。
6. 只有 rename 成功后，内存中的 current state 才能指向 next state。
7. 写入失败时必须保留最后一次成功落盘的 current state；调用方必须得到异常并将 run 标记为 failed。
8. 任何 adapter、review、verify 模块不得直接 `writeFile` hub JSON。

建议测试：

- 100 个并发 `enqueue` 后，最终 JSON 可解析。
- `hubLog.length` 与 pendingQueue 引用数量符合预期。
- 模拟写入异常时，正式 JSON 仍保持上一次有效内容。

### 11.6 Adapter 固定命令合同

Codex 首轮命令必须按数组构造：

```ts
[
  "exec",
  "--cd",
  workerCwd,
  "--dangerously-bypass-approvals-and-sandbox",
  "--json",
  "--output-last-message",
  lastMessageArtifact,
  "-"
]
```

Codex resume 命令必须按数组构造：

```ts
[
  "exec",
  "--cd",
  workerCwd,
  "--dangerously-bypass-approvals-and-sandbox",
  "resume",
  "--json",
  "--output-last-message",
  lastMessageArtifact,
  sessionId,
  "-"
]
```

Claude 首轮命令必须按数组构造：

```ts
[
  "-p",
  "--verbose",
  "--output-format",
  "stream-json",
  "--dangerously-skip-permissions",
  "--append-system-prompt-file",
  myheadPromptFile,
  "--session-id",
  sessionId,
  turnPrompt
]
```

Claude resume 命令必须按数组构造：

```ts
[
  "-p",
  "--verbose",
  "--output-format",
  "stream-json",
  "--dangerously-skip-permissions",
  "--resume",
  sessionId,
  turnPrompt
]
```

不得通过 shell 字符串拼接执行 worker。必须使用 argv array，避免 prompt、路径或用户内容触发 shell 解释。

### 11.7 blocked 与 failed 分类合同

实现时必须稳定区分 `blocked` 与 `failed`。

标记为 `blocked`：

- worker CLI 未安装。
- worker CLI 版本或 flag 不支持固定路径。
- no-approval mode 不可用。
- worker 运行中出现审批、tool confirmation 或 ask 选项。
- worker 原生 session / state store 不可恢复。
- full hubLog 超出上下文预算。
- compare 无法创建隔离 worktree / 临时副本。
- 需要用户产品决策才能继续。

标记为 `failed`：

- worker 进程异常退出且不属于能力缺失。
- worker 输出格式不可解析。
- supervisor review JSON 不符合 schema。
- hub JSON 保存失败。
- artifact 写入失败。
- verification runner 自身崩溃。

标记为 `needs_user_decision`：

- worker 给出多个互斥实现方向且 supervisor 无法可靠选择。
- 验证失败但是否接受风险取决于用户。
- 达到 `maxAutoTurns`。
- compare 结果冲突，需要用户选择采用哪份 diff 或是否融合。

### 11.8 Context Builder 合同

MVP 只允许：

```ts
const contextPolicy = { mode: "full", version: 1 } as const;
```

每次出站给 worker 前必须：

1. 读取当前完整 `hubLog`。
2. 生成 prompt package。
3. 估算 token。
4. 如果超过预算，写入 `blockedEvents.reason = "context_overflow"` 并停止 run。
5. 写入 `contextSnapshots`，其中 `compressedArtifact` 必须为 `null`。
6. 将 snapshot id 写入 `turnInvocation`。

不得实现摘要、裁剪、最近 N 条消息或隐式压缩。后续压缩只能通过新的 `contextPolicy.version` 显式启用。

### 11.9 Controller 状态转移合同

MVP 主循环只允许以下主路径：

```text
hub_created
-> worker_started
-> listening
-> message_queued
-> reviewing
-> verifying | replying
-> listening
```

终止状态：

```text
accepted
failed
blocked
cancelled
needs_user_decision
```

约束：

1. worker 响应进入 hubLog 后必须先进 pendingQueue。
2. MyHead 不得在未 review 的情况下直接 accepted。
3. `continue` 和 `revise` 都必须生成下一轮 MyHead reply。
4. `verify` 必须先运行验证命令或要求 worker 补充可验证证据。
5. 每轮开始前写 checkpoint。
6. 单 worker 同一时刻只能有一个 running invocation。
7. 同一工作树 cooperate 模式中，同一时刻只能有一个写入型 turn；MVP 可先不实现 cooperate。
8. Codex 和 Claude 的消息只能通过 MyHead 生成的 hubLog context snapshot 相互可见；adapter 不得创建 worker-to-worker 直接通信通道。
9. 规划对话不得写入 `.myhead/sessions/`，也不得作为 hubLog 保存；只有用户确认后的实施方案、prompt snapshot 和执行 hub 可以落盘。

### 11.10 Artifact 路径合同

所有 MyHead 生成的 artifact 必须位于绑定 workspace 的 `.myhead/runs/<run-id>/artifacts/` 下。compare 模式中的隔离 worktree / 临时副本只作为 worker cwd 和 diff 来源；MyHead 的 prompt、stdout、stderr、review、verification、diff artifact 仍写回根 workspace 的 `.myhead/`。

建议命名：

```text
.myhead/runs/<run-id>/plan.md
.myhead/runs/<run-id>/task.json
.myhead/runs/<run-id>/result.json
.myhead/runs/<run-id>/artifacts/<turn-id>-prompt.md
.myhead/runs/<run-id>/artifacts/<turn-id>-stdout.log
.myhead/runs/<run-id>/artifacts/<turn-id>-stderr.log
.myhead/runs/<run-id>/artifacts/<turn-id>-last-message.md
.myhead/runs/<run-id>/artifacts/<turn-id>-stream.jsonl
.myhead/runs/<run-id>/artifacts/<turn-id>-diff.patch
.myhead/runs/<run-id>/artifacts/<turn-id>-verification.log
```

artifact 记录应保存相对 workspace 的路径、kind、sha256 和创建时间。默认 CLI 输出只展示摘要和路径，不直接打印大日志。

### 11.11 Security 与脱敏合同

实现中必须遵守：

1. MyHead 配置直接保存明文 `apiKey`，不使用 `apiKeyEnv`。
2. 若用户显式保存明文 key，CLI 必须二次确认，并在输出中遮蔽。
3. stdout、stderr、prompt artifact、review artifact 入库前做基础 secret pattern 脱敏。
4. hubLog 可见消息不得包含未脱敏 secret。
5. raw artifact 可以保存更多 debug 信息，但路径必须记录，默认不打印。
6. worker no-approval mode 必须在最终输出和 hub JSON 中可见。

### 11.12 实施顺序硬门槛

以下 gate 未过，不进入下一阶段：

| Gate | 进入条件 | 不通过时 |
| --- | --- | --- |
| G0 | `npm run check:docs` 通过 | 不写业务代码 |
| G1 | workspace / config / hub schema 单元测试通过 | 不接 model SDK |
| G2 | HubWriter 并发和失败测试通过 | 不启动真实 worker |
| G3 | Codex / Claude capability probe 通过 | 对应 adapter run 只能 blocked |
| G4 | 单 worker 首轮 artifact、hubLog、pendingQueue 可复现 | 不做 supervisor 自动推进 |
| G5 | supervisor mock 能推动状态机 | 不接真实 supervisor 模型 |
| G6 | 单 worker 两轮 E2E 通过 | 不做 compare |
| G7 | compare 隔离工作树测试通过 | 不展示 compare 为可用能力 |

### 11.13 当前完整性复核结论

补充本节后，实施计划已经可以指导实际代码编写。

它覆盖了：

1. 从空仓库创建工程骨架的顺序。
2. 第一批文件和模块职责。
3. CLI 输入合同。
4. Hub、adapter、review、verification 的最小类型合同。
5. 固定 worker 命令数组和禁止 shell 拼接的执行方式。
6. blocked / failed / needs_user_decision 分类。
7. HubWriter 写入算法。
8. artifact 路径和脱敏要求。
9. 状态机推进规则。
10. 每个阶段进入下一阶段前的硬门槛。

剩余未决项不阻塞开工：

1. MyHead 默认 supervisor 协议选择 `openai` 还是 `claude`。
2. 明文 API key 是否允许作为长期配置策略。
3. cooperate 模式是否进入 MVP。

这些未决项已有默认值：默认协议可由 first-run 用户选择；API key 明文保存在全局配置；cooperate 后置。

## 12. 设计原则符合性审查

本节逐条对照 `docs/PRD-myhead.md` 中的 28 条产品原则，检查当前实施计划是否能约束实际代码。

| # | 产品原则 | 符合性 | 实施计划中的约束 |
| --- | --- | --- | --- |
| 1 | 简单好用是最高优先级 | 符合 | 唯一入口、默认简洁输出、Phase gate、防止范围膨胀 |
| 2 | MVP 只支持 `myhead .`，不做 App / 托盘 / Web 启动 | 符合 | CLI 合同明确只接受 `myhead .`，其他 workspace path 形态拒绝 |
| 3 | 默认隐藏 worker raw 执行噪声，但自动展示 message hub live transcript | 符合 | raw stdout / stderr、thinking、tool noise 只存 artifact；interactive 层默认流式展示 hub message、worker visible text、review、verification、loop closed 和最终摘要 |
| 4 | worker 运行时不透出审批和 ask | 符合 | 固定 no-approval mode；出现审批、confirmation 或 ask 即 blocked |
| 5 | CLI 不能关闭审批时 run blocked | 符合 | capability probe 是硬门槛；能力缺失归类为 blocked |
| 6 | 先理解用户真实目标，经确认再启动 worker | 符合 | Phase 3 生成、编辑、确认 plan；未确认不得创建 execution hub |
| 7 | 减少打扰但不隐藏风险和真实决策 | 符合 | no-approval 风险必须展示；`needs_user_decision` 明确收敛用户决策点 |
| 8 | 用最少代码可靠达成功能 | 符合 | TypeScript 薄 CLI、文件 JSON、官方 SDK；不引入数据库、daemon、Web server |
| 9 | 模型对话复用官方 SDK | 符合 | model client 只封装 OpenAI SDK 与 Anthropic SDK |
| 10 | 每次 worker run 绑定 workspace，状态保存在 `.myhead/` | 符合 | workspace 绑定合同、artifact 路径合同和 Hub store 均限定根 workspace |
| 11 | MVP 只支持当前 macOS 本机 | 符合 | 前置条件、技术方案和风险控制均排除 Linux / Windows 兼容 |
| 12 | 不管理 Codex / Claude 的模型、账号、权限、配置 | 符合 | config schema 不包含 worker 账号或模型；adapter 只传本次运行参数 |
| 13 | MyHead 原始提示词可编辑，系统提供默认提示词 | 符合 | Phase 3 包含 default prompt 与 prompt edit，confirmed plan 记录 prompt snapshot |
| 14 | worker 执行必须由用户确认后的实施方案触发 | 符合 | plan hash、plan.md、task.json 是执行事实来源；cancel 不创建 hub |
| 15 | 已确认方案通过固定 prompt 注入方式交给 worker | 符合 | Adapter 固定命令合同和 prompt package builder 约束注入路径 |
| 16 | 执行阶段是持续对话循环 | 符合 | Controller 状态机要求 response -> review -> reply / verify -> listening |
| 17 | 第一段规划对话默认不持久化 | 符合 | Controller 合同明确规划对话不进 `.myhead/sessions/` 或 hubLog |
| 18 | 确认方案后新建 execution message hub | 符合 | Hub 创建在确认执行后发生，hub JSON 是执行历史事实来源 |
| 19 | message hub 异步接收、入队、审查和回应 | 符合 | pendingQueue、HubWriter、controller 主循环和异步响应约束覆盖 |
| 20 | 双 worker 默认隔离工作树；同树协作显式启用并单写者 | 符合 | compare 后置且默认隔离；cooperate 后置并要求单写者锁 |
| 21 | adapter 必须有稳定注入方式，不支持则 blocked，无备用路径 | 符合 | 固定 argv 合同、capability probe gate、blocked 分类均覆盖 |
| 22 | MyHead 不直接改业务代码 | 符合 | MyHead 只写 `.myhead/`、运行验证、读取 diff、生成 review；业务修改交给 worker |
| 23 | 不设计备用路径 | 符合 | no fallback 写入工程纪律、adapter 合同和 gate |
| 24 | 所有角色看到完整 hubLog；worker 只能和 MyHead 对话 | 符合 | full context policy、worker-to-worker 直连禁止、context snapshot 可见性边界 |
| 25 | CLI 启动方式只允许 `myhead .` | 符合 | CLI 合同列出必须拒绝的命令形态 |
| 26 | 上下文策略只支持完整上下文，不实现压缩 | 符合 | `contextPolicy = { mode: "full", version: 1 }`，超限 blocked，`compressedArtifact = null` |
| 27 | worker 只能看到派发时的 context snapshot | 符合 | 每次出站写 contextSnapshot、seenHubOffset；不假设实时共享 |
| 28 | hub JSON 单 writer 串行写入，临时文件原子重命名 | 符合 | HubWriter 算法合同明确 promise chain、tmp file、rename、失败保留 last good state |

### 12.1 审查结论

当前实施计划符合设计原则，可以指导实际代码编写。

可执行性最强的保护点是：

1. CLI 输入合同防止使用形态漂移。
2. HubWriter 合同防止异步历史损坏。
3. Adapter 固定 argv 合同防止备用路径和 shell 拼接风险。
4. Context Builder 合同防止隐式摘要、裁剪或实时聊天室误解。
5. blocked / failed 分类合同防止能力不足时继续推进。
6. Artifact 与脱敏合同防止默认输出噪声和敏感信息泄露。

设计原则中仍需实现期持续关注的点：

1. “简单好用”需要每个 CLI 输出改动都接受默认一屏可读检查。
2. “最少代码”需要每个新依赖说明必要性，不能为未来 UI、daemon 或压缩提前铺大框架。
3. “不隐藏重要风险”需要 no-approval、验证失败、diff 冲突和 max auto turns 都进入默认摘要。
