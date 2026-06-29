# MyHead 产品功能与流程说明

这份文档从产品和工作流角度说明 MyHead。它给后续 agent、贡献者和维护者阅读，用来先理解 MyHead 应该做什么，再进入具体代码实现。

## 产品定位

MyHead 是一个本地编程 Agent 监督控制层。

它不是新的 coding agent，也不是日志平台。MyHead 包在现有编程 CLI 外面，首批 worker 是 Codex CLI 和 Claude Code CLI。它的目标是把原本容易盲跑的 agent 执行过程，变成有计划、有监督、有验证、有历史记录的工程流程。

核心流程是：

```text
澄清意图 -> 生成方案 -> 用户确认 -> 派发 worker -> 汇总消息 -> 审查 -> 验证 -> 修正或接受
```

MyHead 负责控制平面。Codex CLI / Claude Code CLI 负责真正执行代码任务。MVP 中，MyHead 不应直接修改用户项目的业务代码；它可以写自己的 `.myhead/` 状态、运行验证命令、读取 diff、生成审查意见和修正指令。

## 核心产品原则

1. MyHead 必须先理解用户的真实目标，再启动 worker。
2. worker 只能在用户确认实施方案后启动。
3. 已确认实施方案是每一轮 worker 执行的最高优先级上下文。
4. Codex CLI 和 Claude Code CLI 是外部配置好的工具；MyHead 不管理它们的账号、模型、认证或全局配置。
5. MyHead 使用自己的 supervisor 模型做需求梳理、方案生成、审查、验证判断和下一步决策。
6. 每次执行都绑定一个 workspace，执行状态保存在该 workspace 的 `.myhead/` 目录下。
7. 默认隐藏 worker 的 raw stdout、stderr、thinking、tool noise 等噪声，但不能隐藏执行过程本身。
8. worker 权限确认、tool approval、ask 选项不应作为常规用户交互面。MyHead 应以固定的非交互 / no-approval 模式启动 worker。
9. 如果必要能力不可用，MyHead 应清楚失败或标记 blocked，不应偷偷切换到备用路径。
10. 产品使用方式保持简单：用户在目标 workspace 中运行 `myhead .`。

## 核心角色

### 用户

用户拥有产品意图和最终判断权。用户描述目标、补充约束、回答必要的规划问题、确认或编辑实施方案，并在 MyHead 无法安全自动决定时做关键决策。

### MyHead Supervisor

MyHead supervisor 是 MyHead 自己的模型驱动控制者。它负责澄清用户意图、生成实施方案、审查 worker 输出、判断是否继续、修正、验证、请求用户决策、失败、阻塞或接受，并生成下一轮要发给 worker 的指令。

### Codex CLI Worker

Codex 是实现或分析 worker。MyHead 在用户确认方案后，通过固定 adapter 路径启动 Codex，并把 worker 身份、已确认方案、hub 上下文、协作规则和当前 supervisor 指令放进 prompt。

### Claude Code CLI Worker

Claude Code 是另一个实现或分析 worker。它遵循和 Codex 相同的 MyHead 控制模型。它自己的 CLI 配置仍然由用户在 Claude Code 中维护。

## 用户可见模式

### 规划模式

规划模式发生在执行前。用户和 MyHead 讨论目标、背景、约束、风险、实现偏好和验收标准。

规划对话是临时的。默认情况下，原始规划聊天不作为执行历史持久化。规划阶段真正持久化的产物，是用户确认后的实施方案。

### 执行模式

执行模式在用户确认实施方案后开始。MyHead 创建 message hub，派发选中的 worker，流式显示可见事件，审查每次 worker 响应，按需运行验证，并持续推动执行。

执行模式不是一次性 review 报告，而是一个持续推进循环。

### 仅审查模式

仅审查模式用于用户已有改动、已有 diff、已有日志或已有 worker 结果的场景。MyHead 检查 diff、日志、测试输出和上下文，然后给出问题优先的审查结论，包括严重级别、文件/行引用、缺失验证和下一步建议。

### 双 Worker 比较或协作模式

用户可以选择同时运行 Codex 和 Claude。此时 MyHead 创建一个共享 message hub，并把同一份已确认实施方案作为两个 worker 的最高优先级上下文。

默认比较模式下，两个 worker 应使用隔离 worktree 或临时副本，避免互相覆盖。如果用户明确选择同一工作树协作，MyHead 必须保证可能修改文件的 worker turn 串行推进，避免两个 worker 同时写同一份文件。

## Workspace 与配置流程

正常使用流程从目标项目开始：

```bash
cd /path/to/project
myhead .
```

MyHead 会绑定当前目录为 workspace。该 workspace 的执行状态保存在：

```text
<workspace>/.myhead/
<workspace>/.myhead/sessions/<hubId>.json
```

MyHead 自己的 supervisor 模型配置保存在：

```text
~/.myhead/config.json
```

配置形态：

```json
{
  "protocol": "openai",
  "apiKey": "your-key",
  "baseUrl": "https://your-openai-compatible-endpoint/v1",
  "model": "your-model"
}
```

这个配置只用于 MyHead 自己的规划、审查和验证判断。它不应修改 Codex CLI 或 Claude Code CLI 的任何配置。

## 实施方案

实施方案是用户、MyHead 和 worker 之间的执行契约。执行前必须可见、可确认。

实施方案应包含：

- `goal`：用户要达成的具体目标。
- `steps`：有顺序的执行步骤和每步预期产物。
- `constraints`：worker 必须遵守的边界、偏好和限制。
- `successCriteria`：可验证的完成标准。
- `risks`：已知风险、严重级别和缓解方式。
- `workerStrategy`：使用 `codex`、`claude` 或 `both`。
- `collaborationPlan`：使用双 worker 时必须提供的分工方案。
- `verificationPlan`：MyHead 应运行或要求 worker 提供的验证方式。

worker 不应从模糊需求直接启动。如果方案不清楚，MyHead 应继续规划或请求用户决策。

## Message Hub

message hub 是执行期的事实来源。

它解决的产品问题是：Codex 和 Claude Code 各自有原生会话，但 MyHead 需要一个统一的控制上下文。hub 用来记录 worker 可见输出、MyHead 审查、验证证据、用户决策、状态迁移和最终结果。

hub 应保存：

- 已确认实施方案
- 选中的 worker
- append-only 的 hub log
- worker 状态
- pending message queue
- context snapshots
- 验证结果
- 最终结果
- worker invocation 元数据
- failed 或 blocked 原因

hub JSON 必须由单一 hub writer 串行写入。异步 worker 输出不能破坏历史文件。

## 执行与推进循环

MyHead 最重要的行为是 review-driven execution loop：

```text
worker 返回响应
-> 写入 message hub
-> supervisor 审查
-> supervisor 生成 verdict
-> MyHead 接受、验证、请求用户决策、失败、阻塞，或给 worker 发下一轮指令
-> worker 再执行
-> 重复
```

MyHead 的审查不是只给用户看的报告。只要安全可行，supervisor 发现问题后，MyHead 应继续把修正或继续执行指令发给对应 worker，推动任务前进。

典型情况：

- 如果实现不完整，MyHead 发继续执行指令。
- 如果实现偏离方案，MyHead 发修正指令。
- 如果验证失败，MyHead 把失败证据发回 worker。
- 如果缺少测试，MyHead 要求 worker 添加或运行定向验证。
- 如果 worker 输出不清楚，MyHead 要求补充说明或证据。
- 如果问题需要用户做产品判断，MyHead 进入 `needs_user_decision`。

循环只有在进入终止状态或用户取消时结束。

## Supervisor Verdict

supervisor 应输出结构化 verdict，用来驱动状态机和下一步动作。

### `continue`

worker 应继续执行。MyHead 应生成明确的下一步指令，并再次派发相关 worker。

### `revise`

当前结果有问题，但 worker 可以修复。MyHead 应把修正指令发回对应 worker。这是产品闭环中的正常路径。

### `verify`

当前实现需要验证。MyHead 应运行 verdict 中要求的验证命令，或在必须由 worker 执行时要求 worker 补充验证证据。

### `needs_user_decision`

下一步需要用户判断。MyHead 应停止自动推进，提出简洁的问题或呈现需要用户选择的选项。

### `accepted`

实施方案已完成，验证证据足够。MyHead 记录最终结果，并把 hub 关闭为 accepted。

### `failed`

执行因错误或不可恢复的实现失败而无法完成。

### `blocked`

由于外部条件缺失或产品契约被破坏，run 无法继续。例如 worker CLI 不可用、认证不可用、prompt 注入方式不支持、出现审批 prompt、完整上下文放不下且没有已批准压缩路径等。

### `cancelled`

用户取消或系统关闭流程取消执行。

## Worker 派发规则

每次派发 worker 时，prompt 应包含：

- worker 身份
- 已确认实施方案
- workspace 路径
- 当前 message hub 历史
- context snapshot 元数据
- 协作契约
- 当前 supervisor 指令
- 只能向 MyHead 汇报，不能直接面向用户

worker 应向 MyHead 汇报完成情况、阻塞点、变更文件、验证证据和风险。

双 worker 运行时，每个 worker 看到的是自己被派发时的 hub 快照。正在执行中的 worker 不能被假设实时知道派发后才进入 hub 的新消息。

## 双 Worker 协作规则

当 `workerStrategy` 是 `both` 时，实施方案必须定义 ownership。

协作方案应说明：

- 哪个 worker 负责哪些文件或步骤
- 当前是比较模式还是协作模式
- 如何避免冲突
- 验证如何共享
- 每个 worker 应汇报什么

Codex 和 Claude 不应直接互相对话。所有协调都通过 MyHead 和共享 message hub 完成。

比较模式下，MyHead 应从这些维度比较结果：

- 正确性
- 是否遵守实施方案
- test / build 证据
- diff 大小
- 可维护性
- 风险
- 合并或采纳成本

MyHead 可以推荐一个结果、要求某个 worker 修订，也可以在取舍涉及产品判断时请求用户选择。

## 验证流程

验证应和实施方案绑定。verification plan 可以包含命令，例如：

```bash
pnpm typecheck
pnpm -r --if-present test
pnpm --filter @myhead/web build
pnpm --filter @myhead/daemon build
```

验证流程：

1. MyHead 记录 verification 开始。
2. MyHead 在 workspace 中执行命令。
3. MyHead 记录 exit code 和 summary。
4. 如果验证通过，MyHead 再次审查并可能 accepted。
5. 如果验证失败，MyHead 把失败证据发回 worker，并要求修正。

验证失败通常不应立刻导致最终 failed。更常见路径是 revise and retry，直到达到清楚的限制、blocked 条件或需要用户决策。

## Failed 与 Blocked 行为

MyHead 必须清楚说明为什么不能继续。

适合标记 `blocked` 的情况：

- Codex CLI 或 Claude Code CLI 缺失。
- worker 认证不可用。
- 所需 CLI 输出格式不支持。
- 固定 prompt 注入路径不可用。
- worker 在 no-approval mode 下仍要求审批。
- 必须 resume worker session，但 session 恢复不可用。
- 完整 hub 上下文放不下，且没有已批准压缩策略。

适合标记 `failed` 的情况：

- worker 进程崩溃。
- worker 输出无法解析。
- 验证反复失败且 worker 无法修复。
- supervisor 模型调用失败，且 run 无法安全继续。

MyHead 不应偷偷选择备用 worker、备用命令路径或降级行为。用户应看到最短有用解释和下一步修复建议。

## 持久化与历史

规划聊天默认临时存在。执行历史必须持久化。

执行 hub 应保存：

- 实施方案
- worker 选择
- 消息历史
- 状态迁移
- review verdict
- 验证证据
- 最终结果
- invocation 元数据
- 调试所需 artifact

用户应该能通过历史 hub 理解发生过什么，而不是只能从 raw worker log 中重建过程。

## Web UI 产品面

当前实现包含本地 daemon 和 Web UI。

Web UI 应支持：

- workspace 选择或当前 workspace 展示
- supervisor 模型配置
- 规划聊天
- 实施方案展示
- 方案确认
- worker strategy 选择
- 执行直播 transcript
- hub 状态
- worker 状态
- review verdict
- verification 进度
- final result

UI 应强调真实工作流，而不是营销页面。首次使用体验应帮助用户完成配置、描述任务、确认方案并观看执行。

## CLI 与 API 产品面

主入口是：

```bash
myhead .
```

本地 daemon 提供 API 支持：

- config 查看和更新
- workspace 注册和列表
- agent 能力检测
- planning request
- hub 创建
- hub 列表和详情
- hub SSE 事件流
- 向 active hub 推送用户消息
- 取消 active loop

SSE 事件应让执行过程可理解：

- `hub_status`
- `hub_message`
- `hub_message_delta`
- `review_started`
- `review_completed`
- `worker_dispatch`
- `error`
- 终止状态或 final status

## 产品边界

MyHead 不应：

- 变成 Codex CLI 或 Claude Code CLI 的替代品
- 管理 worker 的账号、模型或全局配置
- 在用户确认方案前启动 worker
- 隐藏重要风险或失败验证
- 把 worker 审批 prompt 作为常规交互路径暴露给用户
- 在 MVP 控制层直接修改业务代码
- 依赖未记录的旁路状态推进执行
- 让 Codex 和 Claude 绕过 hub 私下协调
- 偷偷降级到备用行为

MyHead 应该：

- 澄清用户意图
- 生成并确认实施方案
- 用稳定 prompt 派发 worker
- 维护共享 message hub
- 审查每次 worker 响应
- 审查发现问题时推动 worker 修正或继续执行
- 运行或要求验证
- 需要用户决策时停下来问用户
- 保存清楚的执行历史
- 以明确的 accepted、failed、blocked、needs-user-decision 或 cancelled 状态结束

## 当前仓库结构

当前实现位于 `myhead/`。

```text
myhead/
  apps/
    daemon/          Express API、SSE、本地 Web UI 托管、worker 生命周期
    web/             React/Vite UI，用于规划、确认方案、查看 hub transcript
  packages/
    agent-runtime/   Codex/Claude CLI adapter 和 stream 解析
    myhead-core/     planning schema、hub writer、controller loop、review、verification
    contracts/       共享 HTTP DTO 类型
```

重要产品参考：

```text
docs/PRD-myhead.md
```

重要实现概念：

- `ModelClient`：MyHead supervisor 模型抽象。
- `ControllerLoop`：执行循环、review、dispatch、verification、terminal handling。
- `HubWriter`：串行化 hub 持久化。
- `implementationPlanSchema`：已确认实施方案结构。
- `reviewVerdictSchema`：结构化 supervisor verdict。
- `agent-runtime`：worker CLI 检测、启动和输出解析。

## 预期端到端体验

一次成功执行应该像这样：

1. 用户在目标项目中运行 `myhead .`。
2. MyHead 确认 supervisor 模型配置和 worker 可用性。
3. 用户描述编程任务。
4. MyHead 只追问有价值的澄清问题。
5. MyHead 生成具体实施方案。
6. 用户确认方案和 worker strategy。
7. MyHead 创建 message hub。
8. MyHead 派发 Codex、Claude 或两者。
9. worker 输出流式进入 hub。
10. MyHead 审查输出。
11. 如果发现问题，MyHead 给对应 worker 发修正指令。
12. 如果缺少验证，MyHead 运行或要求补充验证。
13. 如果验证失败，MyHead 把失败证据发回 worker 并继续推进。
14. 如果需要人类判断，MyHead 暂停并询问用户。
15. 完成后，MyHead 记录包含验证证据的 accepted final result。

MyHead 的产品承诺不是 worker 永远不犯错。真正的承诺是：MyHead 能发现问题、保留上下文、推动修正、验证结果，并给用户一个清楚的最终状态。
