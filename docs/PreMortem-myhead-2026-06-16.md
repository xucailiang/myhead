# MyHead Pre-Mortem 闭环审查

日期：2026-06-16

## 结论

当前方案的主闭环已经成立：

`myhead . -> 配置 MyHead 模型 -> 临时规划对话 -> 用户确认实施方案 -> 创建 message hub -> 固定方式启动 Codex / Claude -> 接收任意 worker 响应 -> 追加 hubLog / pendingQueue -> supervisor 审查 -> 生成下一轮 worker 回应或最终结果 -> 保存 JSON 历史`

但方案要真正可实现，必须避免一个关键误解：message hub 不是让 Codex 和 Claude 进入一个真实三方实时聊天室。Codex 和 Claude 各自仍是原生 CLI 会话。MyHead 能保证的是：每次派发 worker turn 时注入完整 `hubLog` 的 context snapshot，并把任意 worker 的响应接入同一个 hub。正在执行中的 worker 不能被假设能实时看到另一方刚产生的新消息。

## Tigers：真实风险

### T1. 把 message hub 误实现成实时三方会话

级别：Launch-blocking

风险：如果实现时假设 Codex 和 Claude 可以在同一次 CLI 调用中实时看到对方消息，就会设计出不可落地的通信模型。正确模型应是：worker 每轮看到一个 context snapshot，返回后进入 hub，下一轮再注入最新完整 hubLog。

缓解：PRD 已补充 `contextSnapshot`、`turnInvocation`、`seenHubOffset` 和可见性边界。MVP 切片已要求每个 worker 响应记录基于哪个 hub offset。

### T2. 固定 CLI 路径不被真实版本支持

级别：Launch-blocking

风险：MyHead 明确不做备用路径。如果 Codex 或 Claude 当前版本不支持指定 flag、flag 位置、结构化输出、no-approval mode、session resume 或 prompt 注入，run 会 blocked / failed，产品主链路会断。当前文档固定 Codex 使用 `--dangerously-bypass-approvals-and-sandbox`，Claude 使用 `--dangerously-skip-permissions`，二者都必须在目标版本中真实可用。

缓解：Slice 5 已补充 capability probe。MVP 首件事必须跑通 `codex exec --cd <cwd> --dangerously-bypass-approvals-and-sandbox ...` / `codex exec --cd <cwd> --dangerously-bypass-approvals-and-sandbox resume ...` 和 `claude -p --dangerously-skip-permissions ...` / `claude -p --dangerously-skip-permissions --resume ...` 的最小真实调用。

### T3. hub JSON 在异步响应下写坏

级别：Launch-blocking

风险：Codex 和 Claude 可以任意时刻返回响应。如果多个异步处理直接写 `.myhead/sessions/<hub-id>.json`，容易出现丢消息、乱序、半写文件或 pendingQueue 状态损坏。

缓解：PRD 已补充单一 `hubWriter`，MVP Slice 9 要求所有 hub 状态写入串行化，并使用临时文件加原子重命名。

### T4. 权限自动化策略在真实 worker 中漏出审批

级别：Launch-blocking

风险：用户要求最简洁自动化，不透出审批和 ask。若 worker 仍输出审批、tool confirmation 或 ask 选项，而 MyHead 又试图继续推进，会进入不可控状态。

缓解：固定 no-approval mode；一旦出现审批或 ask，立即记录 `blockedEvent` 并停止该 worker。不得引入审批 UI 或自动审批分支。

### T4b. 无审批模式扩大 worker 权限

级别：Launch-blocking for real worker execution

风险：为了满足“不透出任何审批”，Codex 使用 `--dangerously-bypass-approvals-and-sandbox`，Claude 使用 `--dangerously-skip-permissions`。这会显著扩大 worker 在目标 cwd 中的执行权限，尤其 Codex 该 flag 明确绕过审批和沙箱。

缓解：真实 worker run 必须记录 no-approval mode、cwd / worktree、命令元数据和风险提示。compare 默认隔离 worktree / 临时副本；单 worker 默认绑定 workspace，但执行前必须明确展示 no-approval 风险。MyHead 自身仍不得直接修改业务文件。

### T5. 完整 hubLog 快速超上下文

级别：Fast-follow，MVP 中按 blocked 处理

风险：MVP 不做压缩、不裁剪、不摘要。多轮 worker 响应会让 hubLog 变大，导致无法注入 worker 上下文。

缓解：当前策略是 blocked，并通过 `contextPolicy` / `contextSnapshots` 留出后续压缩策略口子。实现时必须显式记录 token 估算和 blocked reason。

### T6. compare 模式的工作树隔离失败

级别：Launch-blocking for compare

风险：双 worker 同时写同一个目录会互相覆盖，尤其是 Codex 和 Claude 同时修改同一文件时。

缓解：compare 默认隔离 worktree / 临时副本。无法隔离时 compare run blocked，不自动切换 cooperate。同树 cooperate 必须用户显式选择，并启用单写者锁。

### T7. 没有端到端 smoke test 会让“看似完成”的切片不闭环

级别：Launch-blocking

风险：adapter、review、history、verify 单独能跑，不代表产品闭环能跑。最容易出现“启动了 worker，但没有完成接收响应 -> 审查 -> 回应 -> 保存”的假完成。

缓解：Slice 9 前不宣布 MVP 闭环完成。需要最小 E2E：一个 mock worker 或真实 CLI 最小任务，跑通两轮响应、hub JSON 写入、supervisor review 和最终状态。

### T8. worker 原生 session 存储不可用导致 resume 假可用

级别：Launch-blocking

风险：Codex / Claude 的多轮推进依赖各自原生 session 或状态存储。即使 CLI flag 能被解析，如果 session store 不可写、不可读或 session persistence 被禁用，`resume` 固定路径仍会失败。

缓解：capability probe 必须检查 worker 原生 session / state 存储可用性，并用最小真实调用验证首轮 session id 能被记录、后续 resume 能按固定方式恢复；不可用时 run `blocked` 或 `failed`。

## Paper Tigers：看起来吓人但不是当前核心风险

### P1. MVP 不支持 Linux / Windows

不是当前风险。用户已明确当前先使用 macOS。文档中已把 macOS-only MVP 写入原则和切片；Linux / Windows 未来若纳入支持范围，需要单独做 capability probe 和 smoke test。

### P2. 规划对话默认不持久化

不是风险。这是产品选择。真正需要持久化的是用户确认后的实施方案、prompt 快照和 execution message hub。

### P3. MyHead 不配置 Codex / Claude 的模型和账号

不是风险。反而降低复杂度。风险只在于能力探测要清楚提示用户 worker 自身未安装、未认证或能力不足。

## Elephants：阶段性决策与仍需明确项

### E1. 第一版实现语言阶段性选择

建议 MVP 采用 TypeScript / Node.js，但这是基于当前负载的阶段性选择，而不是最终架构承诺。MyHead 第一阶段主要是薄 CLI、子进程编排、JSONL / stream-json、文件型 JSON 存储、zod schema 和官方 OpenAI / Anthropic SDK 接入；TypeScript / Node.js 能最快验证闭环。若后续需要单二进制分发、长期 daemon、高并发调度、复杂文件锁或更强崩溃恢复，再重评 Rust / Go。

### E2. API key 存储策略

已确定：MyHead 自身模型配置保存在全局 `~/.myhead/config.json`，直接明文保存 `apiKey`，不使用环境变量引用。实现时必须避免把 key 写入 workspace、日志、hub history 或终端输出。

### E3. max auto turns 默认值

需要产品决策。建议 MVP 默认较小，例如 6 到 10 轮，超过后进入 `needs_user_decision`，避免无限循环消耗 token。

### E4. 真实 CLI 输出解析容错边界

因为不做 fallback，结构化输出解析失败必须 `failed`。但 debug artifact、错误摘要和修复建议要足够清楚，否则用户会觉得“黑盒坏了”。

## Launch-Blocking 行动项

1. 固定 Codex adapter smoke test。
   - Owner：Engineering。
   - Due：实现 Slice 3 前。
   - 完成标准：验证 `codex exec --cd <cwd> --dangerously-bypass-approvals-and-sandbox --json --output-last-message <file> -` 和 `codex exec --cd <cwd> --dangerously-bypass-approvals-and-sandbox resume --json --output-last-message <file> <session-id> -` 能被当前目标版本调用，并记录 flag 的真实位置和 resume 传参顺序。

2. 固定 Claude adapter smoke test。
   - Owner：Engineering。
   - Due：实现 Slice 4 前。
   - 完成标准：验证 `claude -p`、`--verbose`、`stream-json`、`--dangerously-skip-permissions`、`--append-system-prompt-file`、`--session-id`、`--resume` 能被当前目标版本解析和调用。

3. 实现 hub writer。
   - Owner：Engineering。
   - Due：Slice 1.5 / Slice 9。
   - 完成标准：所有 hub 更新走单一写入队列，保存使用临时文件和原子重命名，崩溃后 JSON 不损坏。

4. 实现 context snapshot 和 seenHubOffset。
   - Owner：Engineering。
   - Due：Slice 9。
   - 完成标准：每次出站 prompt 都有 snapshot id / hub offset；每条 worker 响应都记录 `seenHubOffset`。

5. 实现最小端到端闭环测试。
   - Owner：Engineering。
   - Due：宣布 MVP 可用前。
   - 完成标准：至少两轮 worker 响应、supervisor review、MyHead reply、验证或 final result、hub JSON 历史全部落盘。

6. 验证 worker 原生 session 存储。
   - Owner：Engineering。
   - Due：实现 Slice 3 / Slice 4 前。
   - 完成标准：Codex 和 Claude 的首轮 session id 能被捕获，后续 resume 能在当前 macOS 目标环境按固定路径恢复。
