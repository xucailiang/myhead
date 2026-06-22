# MyHead 需求文档

## 1. 概要

MyHead 是一个面向主流编程 Agent 的监督壳子，首批包裹对象是 Codex CLI 和 Claude Code CLI。它不管理这两个 CLI 的内部配置，只根据用户选择在指定工作区唤起它们。MyHead 自己使用单独配置的高阶模型，负责和用户对话、梳理需求、生成实施方案，并在执行阶段创建 message hub，把实施方案作为 worker 会话的最高优先级上下文，向 Codex CLI / Claude Code CLI 分发任务、接收任意时刻到达的响应、检查结果、生成回应并持续推进实施。

MyHead 的核心不是再做一个新的编程 Agent，也不是做一个执行过程日志平台。它是一个简单好用的控制层：用户在目标工作区目录运行 `myhead .`，配置 MyHead 自己的模型，然后和 MyHead 对话把需求与实施方案聊清楚。用户确认实施方案后触发执行，MyHead 唤起 Codex、Claude Code 或两者，把实施方案注入 worker 会话，并通过 message hub 完成“接收响应 -> 记录全量消息 -> 审查 -> 回应推进”的循环。

## 产品原则

1. 简单好用是最高优先级。
2. 使用形态必须服从简单好用。MVP 只支持命令行入口 `myhead .`；App、托盘工具和 Web UI 不进入 MVP 启动方式。
3. 默认隐藏 worker 的 raw 执行噪声，而不是隐藏执行本身。执行阶段必须像 Claude Code 一样在同一个终端会话中自动流式呈现 message hub 的可见消息、MyHead 状态、worker 可见回复、review 进度、验证进度和最终结论；raw stdout / stderr、thinking、tool noise 和 debug artifact 默认折叠。
4. worker 运行时不透出权限审批和 ask 选项；MyHead 在本次启动参数中统一选择自动审批 / 非交互 no-approval mode。
5. 如果 Codex CLI 或 Claude Code CLI 不能在所选调用方式下关闭审批或自动处理权限请求，本次 worker run 直接 `blocked`，不提供交互审批界面。
6. MyHead 必须先尽力理解用户的真实想法和目标，经用户确认后再启动 worker。
7. MyHead 应尽量减少打扰，但不能隐藏重要风险和真实决策。
8. MyHead 应用最少的代码可靠达成功能。
9. MyHead 与模型对话时应复用官方 OpenAI SDK 和 Claude / Anthropic SDK，不自研模型客户端。
10. 每次 worker 运行都必须绑定一个工作区文件夹，MyHead 的项目本地状态必须保存在该工作区的 `.myhead/` 目录下。
11. MyHead MVP 只支持当前 macOS 本机环境，不需要兼容 Linux 或 Windows。
12. MyHead 不管理 Codex CLI 和 Claude Code CLI 的模型、账号、权限、配置文件或默认参数；这些由用户自行在对应 CLI 中配置。
13. MyHead 的原始提示词允许用户编辑；系统提供默认提示词，用于主动帮助用户梳理需求和实施方案。
14. worker 执行必须由用户确认后的实施方案触发，而不是在需求尚未清楚时直接启动。
15. 已确认实施方案必须通过每个 adapter 的固定 prompt 注入方式交给 Codex / Claude Code worker。
16. 执行阶段是持续流式对话循环：MyHead 向 worker 分发任务，实时显示 hub 消息，检查每次响应结果，生成回应，再继续推进实施。
17. MyHead 与用户梳理需求的第一段规划对话默认不持久化；只保留用户确认后的实施方案。
18. 确认实施方案后会新建执行 message hub；Codex、Claude Code 和 MyHead 共享同一个消息中心，形成最多三角色消息流。该 hub 不只是持久化 JSON，也是默认终端 live transcript 的事实来源。
19. message hub 是 MyHead 的异步消息中心：Codex 和 Claude 可以在任意时刻返回响应，MyHead 必须接住、入队、审查并回应；所有 `visibility = "hub"` 的新消息必须自动流式呈现在当前终端会话中。
20. 双 worker 同时运行时，默认使用隔离工作树或隔离副本避免互相覆盖；同一工作树协作必须显式启用，并由 MyHead 保证单写者推进。
21. 每个 adapter 必须有一个明确且稳定的提示词注入方式；如果当前 CLI 版本不支持该方式，本次 worker run 直接 `blocked`，不使用备用路径。
22. MVP 中 MyHead 不直接修改业务代码；业务文件修改交给 worker，MyHead 只写 `.myhead/`、运行验证命令、读取 diff 和生成审查回应。
23. 不设计备用路径。能力、自动审批模式、输出格式、提示词注入或 worker 原生 session 恢复不满足要求时，MyHead 必须失败得清楚，而不是切换到另一套路径。
24. 所有角色都能看到 message hub 的完整消息记录；Codex 和 Claude 只能与 MyHead 对话，不能彼此直接通信。
25. CLI 启动方式只允许 `myhead .`。用户必须先进入目标工作区目录，再运行 `myhead .`；不支持 `myhead <path>`、`myhead [workspace]` 或 `--workspace <path>` 作为启动入口。
26. message hub 上下文策略当前只支持完整上下文；MVP 不实现压缩，但数据结构和 prompt 构造接口必须预留版本化扩展口，便于后续加入压缩策略。
27. worker 的“看到完整 hubLog”以每轮 MyHead 派发时的 context snapshot 为准；正在执行中的 worker 不能被假设能实时看到其他 worker 刚产生的新消息。
28. message hub JSON 必须由单一 hub writer 串行写入，并通过临时文件加原子重命名保存，避免异步 worker 输出导致历史文件损坏。
29. MyHead 自身模型配置必须保存在全局 `~/.myhead/config.json`，启动时检测；存在则直接使用，不存在则进入交互式配置引导。配置中直接保存明文 `apiKey`，不使用环境变量引用。

## 2. 相关角色

| 名称 | 角色 | 说明 |
| --- | --- | --- |
| Justin | 产品负责人 / 主要用户 | 定义工作流预期和质量标准。 |
| MyHead supervisor model | 审查者和规划者 | 使用配置中的顶级模型做理解、审查、验证和下一步规划。 |
| Codex CLI worker | 实现 / 分析 Agent | 由 MyHead 在根工作区或派生工作区中按用户选择唤起；具体配置由 Codex CLI 自己负责。 |
| Claude Code CLI worker | 实现 / 分析 Agent | 由 MyHead 在根工作区或派生工作区中按用户选择唤起；具体配置由 Claude Code CLI 自己负责。 |

## 3. 背景

Codex CLI 和 Claude Code CLI 正在成为常用的命令行编程 Agent。它们可以读取和修改代码、执行命令、维护会话，并输出结构化内容。它们适合作为 worker，但最终结果仍需要独立审查、验证和下一步判断。

MyHead 包裹这些工具，而不是替代它们。它不理解也不接管 Codex CLI / Claude Code CLI 的内部配置，只负责在用户确认实施方案后唤起它们，并逐轮审查它们的响应。用户体验主线如下：

1. 用户先配置 MyHead 自己的模型协议、key、base URL 和 model。
2. 用户进入目标工作区目录并运行 `myhead .`。
3. 用户和 MyHead 进行临时规划对话，说明想法、目标和约束。
4. MyHead 使用默认提示词主动帮助用户梳理需求；用户也可以编辑 MyHead 原始提示词。
5. MyHead 生成实施方案文本。
6. 用户阅读实施方案，觉得没问题后在 CLI 中确认触发执行。
7. MyHead 新建一个执行 message hub，并把实施方案作为该 hub 的最高优先级执行上下文。
8. 用户选择启动 Codex CLI、Claude Code CLI，或同时启动两者。
9. MyHead 在绑定工作区或由该工作区派生的隔离 worktree 中唤起所选 CLI，并让 Codex / Claude Code 加入同一个 message hub。
10. MyHead 以自动审批 / 非交互 no-approval mode 启动 worker，不把 worker 审批或 ask 选项透出给用户。
11. MyHead 自动进入 message hub live transcript，不要求用户另跑 `logs`、`show` 或 `run` 才能看见执行过程。
12. MyHead 与 worker 进入执行对话循环：分发任务、接收响应、检查结果、生成回应；每个可见事件都在当前终端会话中流式呈现。
13. MyHead 用自己的顶级模型审查每次响应是否符合实施方案。
14. MyHead 根据审查结果继续回应和推进，直到实施方案完成、阻塞或用户停止。
15. 将 message hub 的执行上下文、三角色消息、每轮审查和最终结果持久化为 JSON，供历史查询。

需要围绕的 CLI 使用方式：

- MyHead 可以检查 `codex` 和 `claude` 命令是否可用，但不配置它们。
- Codex CLI 的账号、模型、权限和默认行为由用户在 Codex CLI 中自行配置。
- Claude Code CLI 的账号、模型、权限和默认行为由用户在 Claude Code CLI 中自行配置。
- MyHead 只负责选择启动哪个 CLI、在哪个工作区启动、把实施方案注入 worker 会话、维护 message hub、捕获每轮响应和最终结果。
- `myhead .` 是唯一启动入口，等价于“以当前目录为 workspace 进入规划对话”；如果全局 `~/.myhead/config.json` 不存在，先进入 MyHead 自身配置引导。

## 4. 目标

目标是把 MyHead 做成最简单可靠的多 Agent 编程控制平面。用户在目标工作区目录运行 `myhead .` 并和 MyHead 对话，把需求变成清晰实施方案；用户确认方案后，MyHead 再按用户选择唤起 Codex CLI、Claude Code CLI 或两者，把实施方案作为最高优先级上下文，并通过 message hub 接收异步响应、审查和回应推进来完成实施。

关键结果：

- 90% 的用户任务在启动 worker 前都有用户确认过的实施方案文本。
- 90% 的 worker 运行会生成标准化对话与最终结果记录，包含 prompt 注入方式、工具、cwd、状态、每轮响应、最终响应、文件变化和审查结果。
- 80% 的实现类任务至少有一个自动验证信号，例如 test、build、lint、typecheck、diff review 或定向命令输出。
- 用户可以在一个 message hub 中比较 Codex 和 Claude 对同一任务的结果。
- worker 权限审批和 ask 选项不作为用户交互面；MyHead 统一使用本次自动审批 / 非交互 no-approval mode 启动 worker。
- 100% 的执行 message hub 都以工作区本地 JSON 文件形式保存在 `.myhead/` 下。
- 规划对话默认不持久化；历史中保存的是确认后的实施方案和执行 message hub。
- supervisor 模型调用使用配置的协议：`openai` 或 `claude`，并通过对应官方 SDK 完成。
- MyHead 会检查 worker 的每次响应，并根据实施方案生成下一轮回应或任务分发。
- MyHead 默认终端体验必须对标 Claude Code：用户与 MyHead 完成规划并确认执行后，终端自动切入 message hub 流式 transcript，持续显示 MyHead、worker、review、verification 和 loop closed 事件。
- Codex 和 Claude 同时运行时，它们与 MyHead 共享同一个 message hub，而不是各自独立成两个消息上下文。
- MyHead 在处理某个 worker 响应时，另一个 worker 的响应必须仍可被接收并进入 hub 队列。
- 每次发给 Codex 或 Claude 的 MyHead 回应都必须包含当前 message hub 的完整消息记录；如果完整记录无法放入上下文，本次 run 直接 `blocked`，不使用摘要替代。
- Codex CLI / Claude Code CLI 的内部配置不进入 MyHead 配置范围。
- 系统可以在仓库中运行，不需要用户手动在不同 CLI 之间复制 prompt。

## 5. 用户群体

主要用户：

- 已经使用编程 CLI、但希望有更强监督的独立开发者。
- 希望用低成本模型执行、高阶模型审查的工程负责人。
- 会比较多个 Agent 输出后再接受代码修改的高阶用户。
- 需要保留 prompt、最终响应、diff、决策和验证证据的团队。

用户任务：

- “先理解我真正想做什么，再派 Agent 去干活。”
- “让我先选工作区，再和 MyHead 聊清楚需求。”
- “MyHead 先给我实施方案，我确认后再执行。”
- “把这个编程任务交给 Agent，但不要盲目信任它。”
- “在同一个问题上比较 Codex 和 Claude。”
- “审查 Agent 做了什么，并告诉我下一步怎么做。”
- “昂贵模型用于判断和规划，而不是消耗在每个执行 token 上。”
- “不要把 worker 审批和 ask 选项打扰我，只在 MyHead 需要产品方向或最终接受决策时问我。”
- “把项目历史保存在当前工作区里。”
- “不要让我在 MyHead 里重复配置 Codex / Claude Code；它们自己已经配置好了。”

## 6. 价值主张

MyHead 提供：

- 简单操作：用户在目标工作区运行 `myhead .`、与 MyHead 对话、确认实施方案、在 CLI 中执行，然后得到经过审查的结果。
- 成本控制：便宜模型做执行，顶级模型做审查和方向判断。
- 更高可靠性：每个 worker 结果在接受前都经过审查。
- 工具中立：Codex CLI 和 Claude Code CLI 都是一等 worker。
- 配置解耦：MyHead 只配置自己的模型，不接管 Codex CLI / Claude Code CLI 的配置。
- 低噪声直播：默认自动显示 message hub live transcript，让用户看到 MyHead 指挥、worker 可见回复、review 和验证进度；raw stdout / stderr、thinking、tool noise 和 debug artifact 默认折叠。
- 自动执行：worker 审批不作为常规交互面，MyHead 以本次自动审批 / 非交互 no-approval mode 驱动执行。
- 按需审计：prompt、最终响应、diff、日志和验证结果可保留。
- 工作流连续性：MyHead 可以恢复先前 message hub，并基于历史继续。
- 本地历史：每个执行 message hub 都以 JSON 存在绑定工作区；规划对话默认不入库。
- 决策支持：用户得到下一步建议，而不是只拿到原始 Agent 输出。

## 7. 方案

### 7.1 核心用户流程

#### 流程 A：`myhead .` 启动、对话、生成实施方案、执行

1. 用户配置 MyHead 自己的模型。
2. 用户进入目标工作区目录并运行 `myhead .`。
3. 用户和 MyHead 进行临时规划对话，描述目标、背景、约束和偏好。
4. MyHead 使用默认提示词主动追问和整理需求；用户可编辑 MyHead 原始提示词。
5. 规划对话默认只保存在内存中，不写入 `.myhead/sessions/`。
6. MyHead 生成实施方案文本。
7. 用户阅读实施方案，并确认、编辑或取消。
8. MyHead 保存确认后的实施方案，并新建执行 message hub。
9. 用户选择执行方式：Codex、Claude Code，或两者同时运行。
10. 用户在 CLI 中确认触发执行。
11. MyHead 在绑定工作区或派生工作区中唤起选定 CLI，并让 worker 加入同一个 message hub。
12. MyHead 用本次自动审批 / 非交互 no-approval mode 启动 worker；出现审批或 ask 选项代表调用路径不满足要求，本次 run 直接 `blocked`。
13. MyHead 捕获 worker 每次响应、文件变化和验证证据。
14. MyHead 审查每次响应是否符合实施方案。
15. MyHead 生成回应，继续分发下一步任务或要求 worker 修正。
16. MyHead 重复对话推进，直到实施方案完成、阻塞或用户停止。
17. MyHead 返回状态：accepted、needs_user_decision、failed 或 blocked。

#### 流程 B：双 worker 比较

1. 用户在实施方案确认后选择同时运行 Codex 和 Claude。
2. MyHead 创建一个 message hub，并把同一份实施方案作为最高优先级执行上下文。
3. MyHead 将 Codex 和 Claude 都加入这个 message hub。
4. 默认 compare 模式下，Codex 和 Claude 使用同一份实施方案，但写入彼此隔离的 worktree 或临时副本。
5. MyHead 在同一个 message hub 中记录两者消息、diff、验证证据和审查结论。
6. Codex 和 Claude 都可以看到 message hub 中完整的消息历史，但它们只能向 MyHead 发送响应，不能彼此直接对话。
7. MyHead 比较正确性、风险、diff 大小、测试证据和可维护性。
8. MyHead 推荐一个结果、生成融合建议，或要求某个 worker 基于审查意见继续修订。
9. 如果用户显式选择同一工作树协作，MyHead 必须串行化会修改文件的 worker turn，避免两个 worker 同时写同一份文件。

#### 流程 C：仅审查模式

1. 用户已有改动或已有 worker 运行结果。
2. MyHead 检查 diff、日志和测试输出。
3. MyHead 输出审查：问题优先、严重级别、文件 / 行引用、缺失测试和下一步建议。

#### 流程 D：执行对话与推进循环

1. MyHead 以实施方案作为最高优先级执行上下文启动一个新的 message hub。
2. MyHead 根据实施方案向 worker 分发第一步任务。
3. worker 返回响应；如果同时运行 Codex 和 Claude，两者响应进入同一个 message hub。
4. MyHead 检查响应是否满足当前步骤、是否偏离实施方案、是否需要验证。
5. MyHead 生成下一轮回应：继续、要求修正、要求补充验证、拆分下一步任务，或请求用户决策。
6. MyHead 重复分发、检查、回应，直到 accepted、blocked 或用户停止。

#### 流程 E：worker no-approval mode

1. MyHead 启动 Codex CLI 或 Claude Code CLI 时统一选择本次自动审批 / 非交互 no-approval mode。
2. MyHead 不展示 worker 权限审批、tool-use 确认或 ask 选项。
3. worker 若仍产生需要人工选择的审批或 ask，说明该 adapter 的固定调用路径不成立。
4. MyHead 将本次 worker run 标记为 `blocked`，记录原始事件和原因，并停止该 worker。
5. MyHead 不切换到其他备用路径。

#### 流程 F：失败、恢复与终止

1. 如果 worker 未安装、认证不可用、启动失败或 CLI 能力不足，MyHead 标记为 `blocked` 或 `failed`，并给出最短修复路径。
2. 如果 MyHead 无法解析 worker 输出，必须保存 raw artifact，并将本次 worker run 标记为 `failed`。
3. 如果权限或 ask 出现在执行过程中，MyHead 不做透出、不切换模式；本次 worker run 直接 `blocked`。
4. 如果验证失败，MyHead 将审查状态设为 `verify` 或 `revise`，并把失败证据写入下一轮 worker prompt。
5. 如果连续修订仍失败，MyHead 停止自动推进，标记为 `needs_user_decision` 或 `blocked`。
6. 每个中间状态都写入 message hub JSON，允许 `resume` 从最后一个稳定 checkpoint 继续；如果底层 worker session 无法按固定方式恢复，则 `resume` 失败。

### 7.2 核心功能

#### Agent adapter 层

- `codex` adapter：封装 Codex CLI。
- `claude` adapter：封装 Claude Code CLI。
- 共享接口：
  - `run(task, options)`
- `resume(hub_id, task, options)`
  - `cancel(run_id)`
  - `extract_final_result()`
  - `collect_artifacts()`
- adapter 能力检测：
  - CLI 是否安装。
  - CLI 版本。
  - 支持的输出格式。
  - 可检测的认证 / 账户状态。
  - worker 原生 session / state 存储是否可读写；如果 Codex 的 session store 或 Claude 的 session persistence 不可用，依赖 resume 的 run 必须 `blocked` 或 `failed`。

#### 两段对话模型

MyHead 有两类对话，它们的存储策略不同：

1. 规划对话：
   - 参与者是用户和 MyHead。
   - 目标是把用户想法梳理成实施方案。
   - 默认不持久化原始对话内容。
   - 用户确认后，只保留实施方案文本和必要摘要。

2. 执行 message hub：
   - 参与者是 MyHead、Codex CLI、Claude Code CLI 中被选择的角色。
   - 当用户同时选择 Codex 和 Claude 时，三者共享同一个 message hub。
   - Codex 和 Claude 各自维护自己的原生 CLI 会话，但它们的输入输出都被 MyHead 汇入同一个 hub。
   - Codex 和 Claude 都能看到 hub 中完整的消息记录，但只能向 MyHead 发消息，不能彼此直接对话。
   - 已确认实施方案是该 message hub 的最高优先级执行上下文。
   - message hub 中保存每轮 worker response、MyHead review、MyHead reply、验证结果和最终结果。
   - `.myhead/sessions/<hub-id>.json` 只保存执行 message hub 历史。

#### Message hub 运行模型

message hub 是执行期的核心控制对象，解决 Codex 和 Claude 各自原生对话通道互不相通的问题：

- `hubLog`：append-only 全量消息记录，保存 MyHead、Codex、Claude 的所有可见消息。
- `inboundStreams`：每个 worker adapter 都有自己的输入流，Codex 和 Claude 可以在任意时刻产生响应。
- `pendingQueue`：MyHead 正在审查某个响应时，其他 worker 新响应必须进入队列，不能丢失或阻塞在原 CLI 输出里。
- `agentCursor`：记录每个 worker 已经看到 hubLog 的哪个位置。
- `contextPolicy`：记录本次 hub 的上下文构造策略。MVP 固定为 `mode = "full"`，表示每次出站都使用完整 hubLog。
- `contextSnapshot`：记录每次发给 worker 的上下文快照元数据，例如 hubLog offset、token 估算、构造版本和未来压缩 artifact 引用。MVP 不生成压缩内容，只保存可兼容字段。
- `turnInvocation`：每次 MyHead 给 worker 的指令对应一次非交互 CLI 调用或一次原生 session resume。MVP 不假设可以在同一个 worker 调用运行中追加新的 MyHead 消息。
- `seenHubOffset`：每条 worker 响应必须记录它基于哪个 context snapshot 产生；supervisor 审查时要知道该响应是否没有看见较新的 hub 消息。
- `dispatchLock`：同一 worker 同一时间只能有一个未完成的 MyHead 指令，避免该 worker 的原生会话乱序。
- `writeLock`：同一工作树 cooperate 模式下，同一时间只能有一个可能修改文件的 worker turn。
- `hubWriter`：所有 hubLog、pendingQueue、turns 和状态变更必须进入单一写入队列；写 `.myhead/sessions/<hub-id>.json` 时必须使用原子保存。
- `visibility`：默认所有非 debug 消息对 MyHead、Codex、Claude 可见；raw log、secret、脱敏前输出只作为 artifact，不进入可见 hubLog。
- `addressing`：消息可以标记目标 worker，但可见性仍是全员可见；Codex 和 Claude 看到彼此响应，是通过 hubLog，而不是直接通信。
- `controller`：只有 MyHead 可以从 pendingQueue 中取消息、调用 supervisor、生成回复并派发给 worker。

出站给任意 worker 的 MyHead 消息必须包含：

- 当前完整 hubLog。
- 已确认实施方案。
- 当前 worker 的目标任务。
- 其他 worker 的最新可见响应。
- MyHead 对最新响应的审查结论。
- 本轮只允许该 worker 回复 MyHead。

如果完整 hubLog 无法放入 worker 上下文，本次 run 进入 `blocked`。MyHead 当前不使用摘要、裁剪或压缩上下文。后续加入压缩策略时，只能通过 `contextPolicy` 的新版本显式启用，不能改变既有 `mode = "full"` hub 的语义。

可见性边界：

- 所有角色最终都能看到完整 hubLog，但 worker 只能在 MyHead 下一次派发指令时看到新的完整 context snapshot。
- compare 模式允许 Codex 和 Claude 基于同一个快照并行执行；其中一方先返回的新消息不会自动进入另一方正在运行的 CLI 调用，只会进入对方下一轮快照。
- cooperate 模式必须串行派发会改文件的 turn，因此每个写入型 turn 都应基于最新 hubLog。
- MyHead 审查 worker 响应时必须比较 `seenHubOffset` 和最新 hub offset；如果响应基于旧快照产生，审查结论应显式考虑这一点。

#### 闭环状态机

MyHead 的闭环不是一次性调用 worker，而是一个可以停止、恢复和审计的状态机：

1. `planning`：用户和 MyHead 临时对话，规划对话默认只在内存中。
2. `plan_ready`：MyHead 生成实施方案，等待用户确认、编辑或取消。
3. `plan_confirmed`：用户确认后的方案成为事实来源，保存为 `plan.md` 和 `task.json`。
4. `hub_created`：MyHead 创建 message hub，写入 implementation plan。
5. `worker_started`：MyHead 在绑定 workspace 或隔离 worktree 中启动所选 worker。
6. `listening`：MyHead 同时监听所有已启动 worker 的输入流。
7. `message_queued`：任意 worker 返回响应后，消息追加到 hubLog 并进入 pendingQueue。
8. `reviewing`：MyHead 从 pendingQueue 取一条消息，使用 supervisor model、hubLog、diff、验证结果和 worker 输出进行审查。
9. `replying`：MyHead 生成下一轮回应，要求继续、修正、验证、切换 worker 或请求用户决策。
10. `verifying`：MyHead 运行验证命令或要求 worker 补充可验证证据。
11. `needs_user_decision`：supervisor 判定需要用户选择方向、接受风险、切换策略或停止。
12. `accepted`：实施方案成功标准已满足，给用户呈现最终结果。
13. `failed`：worker 输出不可用、命令失败、hub 损坏或固定能力不满足。
14. `blocked`：缺少外部权限、依赖、凭证、工作区条件、上下文空间或用户决策。
15. `cancelled`：用户主动停止。

允许的主循环是：

`listening -> message_queued -> reviewing -> verifying/replying -> listening`

循环只能在 `accepted`、`failed`、`blocked`、`cancelled` 或 `needs_user_decision` 处停下。MyHead 不应在未审查 worker 响应的情况下直接接受结果。

#### Message hub 数据结构

message hub JSON 是 MyHead 的真实历史，而不是两个 worker 原生日志的简单拼接。MVP 至少保存：

- `schemaVersion`。
- `hubId`。
- `workspacePath`。
- `createdAt` / `updatedAt`。
- `status`：当前闭环状态。
- `confirmedPlan`：实施方案文本、摘要、hash、生成时的 MyHead prompt 快照。
- `promptInjection`：每个 worker 的固定注入方式；能力不满足时不启动。
- `permissionMode`：每个 worker 本次启动使用的自动审批 / 非交互 no-approval mode。
- `selectedAgents`：`codex`、`claude` 或 `both`。
- `agentSessions`：worker 原生 session id、cwd / worktree、启动命令元数据、版本、能力探测结果。
- `hubLog`：按时间排序的 `myhead`、`codex`、`claude` 可见消息。
- `pendingQueue`：已进入 hubLog、尚未被 MyHead controller 处理的 worker 响应。
- `agentCursors`：每个 worker 已看到的 hubLog offset。
- `contextPolicy`：上下文策略版本。MVP 示例：`{ "mode": "full", "version": 1 }`。
- `contextSnapshots`：每轮出站 prompt 对应的上下文元数据，记录目标 worker、hubLog offset、token 估算和构造策略；MVP 中 `compressedArtifact` 必须为空。
- `turnInvocations`：每次 worker 调用的命令元数据、stdin / prompt artifact、stdout / stderr artifact、开始结束时间、exit code、对应 context snapshot id。
- `agentStatus`：每个 worker 独立的 `idle`、`running`、`blocked`、`failed`、`cancelled`、`done` 状态；hub 总状态由所有 agent 状态和 supervisor verdict 汇总而来。
- `turns`：每轮的 inbound message、review、reply、verification、status transition。
- `blockedEvents`：权限请求、ask 选项、上下文超限、能力缺失等导致 run 停止的事件。
- `artifacts`：raw log、diff、验证输出、最终响应文件路径。
- `finalResult`：verdict、changed files、验证证据、风险、下一步建议。
- `resumeCheckpoint`：最后一个可以恢复的 hub offset、worker 原生 session id 和当前实施步骤。

#### MyHead 配置

MyHead 只配置自己，不配置 Codex CLI / Claude Code CLI：

- MyHead 模型协议：`openai` 或 `claude`。
- MyHead API key：明文直接值，保存在全局配置中。
- MyHead base URL。
- MyHead model。
- MyHead 默认原始提示词。
- 用户编辑后的原始提示词。
- 可选验证命令。
- worker 启动策略：
  - 固定使用自动审批 / 非交互 no-approval mode。
  - 固定使用每个 adapter 支持的结构化输出格式。
  - 固定使用每个 adapter 支持的提示词注入方式。

不进入 MyHead 配置范围：

- Codex CLI 的模型、账号、认证和全局配置。
- Claude Code CLI 的模型、账号、认证和全局配置。
- 两个 CLI 的全局配置文件或项目配置文件。

#### Worker 选择与启动

MyHead 只负责根据用户选择启动 worker：

- 可选执行目标：`codex`、`claude`、`both`。
- MyHead 可检查 `codex` / `claude` 命令是否存在。
- MyHead 在绑定 workspace 或该 workspace 的隔离 worktree / 临时副本中启动对应命令。
- MyHead 将确认后的实施方案文本通过固定 prompt 注入方式交给 worker。
- MyHead 可同时启动 Codex 和 Claude Code。
- MyHead 不修改 worker 的内部配置。
- MyHead 可以在本次启动命令中传入 no-approval mode、cwd / worktree、输出格式和提示词文件等运行参数。
- adapter 启动后必须把 worker 输出事件接入 message hub inbound stream。
- adapter 不直接决定下一步；所有 worker 响应先进入 hubLog 和 pendingQueue，再由 MyHead controller 审查和回复。

#### 提示词注入策略

MyHead 必须为每个 CLI 定义唯一稳定的提示词注入方式，不提供备用路径：

- Codex CLI：MVP 固定使用 `codex exec --cd <worker-cwd> --dangerously-bypass-approvals-and-sandbox --json --output-last-message <artifact> -`，从 stdin 传入 MyHead prompt package。后续轮次固定使用保存的 Codex session id 执行 `codex exec --cd <worker-cwd> --dangerously-bypass-approvals-and-sandbox resume --json --output-last-message <artifact> <session-id> -`。`--cd` 和 `--dangerously-bypass-approvals-and-sandbox` 必须放在 `resume` 子命令之前，作为 `codex exec` 的父级 options。该 flag 会绕过审批和沙箱，满足“不透出审批”的要求，但也意味着 MyHead 必须优先在隔离 worktree / 临时副本或明确受控的绑定 workspace 中运行 worker，并在 hub JSON 中记录危险 no-approval mode。如果任一 flag、flag 位置或 resume 方式不可用，本次 run `blocked` 或 `failed`。
- Claude Code：MVP 固定使用 `claude -p --verbose --output-format stream-json --dangerously-skip-permissions --append-system-prompt-file <myhead-prompt-file> --session-id <uuid> <turn-prompt>`；后续轮次使用 `claude -p --verbose --output-format stream-json --dangerously-skip-permissions --resume <session-id> <turn-prompt>`。`--dangerously-skip-permissions` 是 Claude Code 当前明确暴露的无审批启动参数，等价进入 `bypassPermissions` 模式；本机 Claude Code 2.1.153 要求 `--output-format stream-json` 与 `--verbose` 搭配使用。如果当前 Claude Code 版本不能解析 `--append-system-prompt-file`、`--session-id`、`--resume` 或该 no-approval mode 仍产生审批 / ask，本次 run `blocked`。
- 所有 worker：实际注入方法必须写入 `promptInjection`。
- adapter 能力探测只用于确认固定路径是否可用；不可用时失败，不切换到其他注入方式。
- MyHead 不向 worker 传入 `--model` 或等价参数；worker 模型和账号仍完全由各自 CLI 的已有配置决定。

Prompt 打包格式必须包含：

- `MYHEAD_CONFIRMED_IMPLEMENTATION_PLAN`。
- 计划 hash 和 hub id。
- 完整 hubLog。
- 目标 workspace / worktree。
- 当前实施步骤。
- 成功标准和不可违反约束。
- worker 本轮必须返回的摘要、已改文件、验证证据和阻塞点。
- 明确声明 worker 只能回复 MyHead，不得尝试向另一个 worker 发起直接对话。

#### 双 worker 工作区隔离策略

Codex 和 Claude 共享的是 MyHead message hub，不默认共享同一个可写工作树：

- `compare`：默认模式。每个 worker 在独立 worktree 或临时副本中执行，MyHead 通过 message hub 比较 diff 和验证结果，再向用户推荐采用哪一份或如何融合。
- `cooperate`：显式模式。两个 worker 可以围绕同一工作树轮流工作，但 MyHead 必须维护单写者锁；同一时间只能有一个 worker 执行可能修改文件的 turn。
- git repo 中优先使用 `git worktree` 隔离；非 git repo 中使用临时目录副本。无法隔离时本次 compare run 进入 `blocked`，不自动切换到串行同树模式。
- MyHead 必须记录每个 worker 的实际 cwd、基线 hash / 文件快照、changed files 和 diff。
- 当两个 worker 的 diff 互相冲突时，MyHead 不自动合并业务代码；它给出融合建议并请求用户决策，或分发给一个 worker 做受控修订。

#### 工作区绑定

每次 Codex CLI 或 Claude Code CLI 运行都必须绑定一个工作区文件夹：

- 工作区只能通过 `myhead .` 绑定为当前 shell 所在目录。
- `myhead .` 必须把 `.` 解析为当前 shell 所在目录的绝对路径，并把它作为 workspace。
- 不支持 `myhead <path>`、`myhead [workspace]`、`myhead chat --workspace <path>` 或其他传入 workspace path 的启动方式；如果当前目录没有 `.myhead/`，进入 MyHead 配置 / 初始化引导。
- 单 worker 默认以该工作区作为 cwd 启动。
- compare 模式可以使用由该工作区派生的隔离 worktree 或临时副本作为 worker cwd，但 hub 必须记录原始 workspace 和实际 worker cwd。
- MyHead 的所有项目本地状态保存在 `<workspace>/.myhead/`。
- 一次 run 不得静默把 MyHead 状态写到绑定工作区之外。
- 跨工作区 hub 默认分离，除非用户明确链接。

#### 模型 SDK 与协议配置

MyHead 自己的对话和 supervisor 审查应使用官方 SDK：

- 当 `protocol = "openai"` 时使用官方 OpenAI SDK。
- 当 `protocol = "claude"` 时使用官方 Claude / Anthropic SDK。
- 除非官方 SDK 缺少必要能力，否则不自研 HTTP 客户端。
- 模型配置必须包含：
  - `protocol`：`openai` 或 `claude`。
  - `api_key`：明文直接值。
  - `base_url`：可选自定义 endpoint。
  - `model`：模型名称。
- 同一套协议配置可用于：
  - MyHead 意图澄清。
  - 实施方案生成。
  - supervisor 审查。
  - worker 回应和下一步任务分发生成。

配置示例：

```json
{
  "myhead": {
    "protocol": "openai",
    "apiKey": "<plaintext api key>",
    "baseUrl": "https://api.openai.com/v1",
    "model": "gpt-5",
    "systemPromptPath": ".myhead/prompts/default.md"
  }
}
```

#### 最少代码实现策略

MyHead 应保持小而薄：

- 优先薄编排层，而不是大型框架。
- MVP 优先文件型 JSON 存储，而不是数据库。
- 优先官方 SDK 和现有 CLI 启动能力，而不是重写协议或管理 worker 配置。
- 在明确需要前，不引入后台服务。
- 只围绕稳定产品概念抽象：workspace、message hub、hubLog、worker run、supervisor review。

#### MyHead 原始提示词

MyHead 的原始提示词是可配置、可编辑的：

- 系统提供默认提示词。
- 默认提示词的目标是主动帮助用户梳理需求、约束、风险、验收标准和实施方案。
- 用户可以在工作区中编辑提示词。
- 每份确认后的实施方案应记录生成时使用的提示词版本或内容快照。
- 生成实施方案时必须受当前提示词约束。

#### 意图发现、实施方案与确认

启动 worker 前，MyHead 必须理解用户意图并生成实施方案：

- 只在需要时提出澄清问题。
- 识别目标 repo、任务类型、期望结果、约束和风险偏好。
- 将模糊请求转成清晰的实施方案文本。
- 实施方案应包含目标、范围、步骤、风险、验收标准、建议 worker 和验证方式。
- 执行前展示实施方案和建议 worker 策略。
- 允许用户确认、编辑或取消实施方案。

已确认实施方案是 worker prompt、执行推进和 supervisor review 的事实来源。

#### Worker no-approval mode

MyHead 不代理 Codex CLI / Claude Code CLI 的权限审批或 ask 选项。MVP 的策略是最小复杂度和最自动化：默认使用固定 no-approval mode，不展示审批 UI，也不在执行中等待人工确认。

- 启动 worker 时统一传入本次自动审批 / 非交互 no-approval mode。
- 不做 permission prompt UI。
- 不做 ask-option UI。
- 不做交互审批界面。
- 不做自动审批策略分支。
- 不做备用调用路径。
- Codex no-approval mode 固定为 `--dangerously-bypass-approvals-and-sandbox`，不再使用 `--ask-for-approval never` 或已废弃的 `--full-auto` 作为 MVP 固定路径。
- Claude Code no-approval mode 固定为 `--dangerously-skip-permissions`，不使用 `dontAsk` 作为 MVP 默认路径，因为默认要求是完全不透出审批。`--permission-mode bypassPermissions` 是内部/等价模式名，但本机 Claude Code 2.1.153 的实现提示 bypass 模式应通过 `--dangerously-skip-permissions` 启动。
- 因为上述模式会扩大 worker 权限，真实 worker run 必须清楚记录 cwd / worktree、命令元数据和 no-approval mode；双 worker compare 默认隔离工作树，单 worker 默认绑定 workspace 但应在执行前展示风险。

固定失败条件：

- CLI 版本不支持目标 no-approval mode：`blocked`。
- worker 运行中仍出现权限审批或 ask 选项：`blocked`。
- worker 输出格式不是 adapter 约定格式：`failed`。
- 完整 hubLog 无法注入 worker 上下文：`blocked`。

#### 用户体验形态

MyHead MVP 只支持命令行 `myhead .` 启动；其他形态不进入 MVP：

- CLI：唯一启动方式，用户在目标工作区运行 `myhead .`。
- App、托盘 UI、Web UI：未来可以做结果查看或历史查看，但不作为 MVP 启动入口。

用户不需要理解 Codex CLI 和 Claude Code CLI 的内部差异也能使用 MyHead。

#### Worker 对话与结果捕获

MyHead 默认展示完整的可见 message hub 过程，但不展示完整 raw worker 噪声。内部必须捕获每轮 worker 响应、MyHead 回应、raw artifact 和解析后的可见消息。每次 worker run 应生成标准化对话与最终结果记录：

- run id。
- agent 名称。
- CLI 版本。
- cwd。
- 实施方案 / prompt injection。
- 每轮任务分发。
- 每轮 worker 响应。
- 每轮 MyHead 审查结论。
- 每轮 MyHead 回应。
- 开始 / 结束时间。
- exit code。
- 最终响应。
- no-approval mode 启动参数。
- 因权限请求或 ask 选项导致的 blocked event。
- 变更文件。
- 如果在 git repo 中，保存运行前后 diff。
- 验证命令和结果。
- supervisor review / per-turn review。
- 原始 stdout / stderr 和事件流作为可选调试证据。

#### Supervisor 审查引擎

MyHead supervisor model 应审查：

- worker 是否回答了真实请求。
- 是否修改了正确文件。
- 是否引入明显 bug。
- 是否遵守约束。
- 是否进行了足够验证。
- 是否缺少测试。
- 下一轮应该继续、修正、验证、询问用户，还是结束。

supervisor 输出状态：

- `accepted`：结果足够好，可以呈现。
- `continue`：响应可接受，继续分发实施方案中的下一步任务。
- `needs_user_decision`：需要用户决策。
- `revise`：响应不满足当前步骤，需要要求 worker 修正。
- `verify`：需要先运行验证或要求 worker 补充验证证据。
- `failed`：worker 结果不可用。
- `blocked`：缺少外部依赖或权限。

#### 验证引擎

MyHead 应支持自动和用户配置的验证：

- Git diff 检查。
- test 命令。
- build 命令。
- lint 命令。
- typecheck 命令。
- format 检查。
- 静态文件存在性检查。
- 后续版本的 Web app smoke check。
- 每个 repo 的自定义命令列表。

supervisor 不应把 worker 的说法当成证据。它应优先使用真实命令输出和文件检查。

#### 规划与下一步方向

审查后，MyHead 应给出下一步动作：

- 接受结果。
- 要求 Codex 修复具体问题。
- 要求 Claude 修复具体问题。
- 同时运行两者比较。
- 运行验证命令。
- 请求用户决策。
- 因阻塞停止。
- 如果实施方案未完成，继续根据方案和完整 hubLog 生成下一轮 worker 回应或任务分发。

#### Message hub 与历史管理

- 规划对话默认不进入历史记录。
- 确认后的实施方案会作为 message hub 的最高优先级执行上下文保存。
- message hub 是 MyHead、Codex、Claude 的共享消息中心。
- 当只选择一个 worker 时，hub 包含 MyHead 和该 worker 两类角色。
- 当同时选择 Codex 和 Claude 时，hub 包含 MyHead、Codex、Claude 三类角色。
- 所有角色最终都能看到完整 hubLog；worker 通过下一轮 context snapshot 看到最新完整 hubLog。
- Codex 和 Claude 只能向 MyHead 发送响应，不能直接互相对话。
- 当底层 CLI 暴露 worker session id 时，记录到同一个 hub 的角色映射中。
- 支持 continue / resume。
- 保存足够清晰的索引字段，供后续查询使用。
- 原始日志只作为可选调试证据保存。
- 每个 message hub 对话持久化为 JSON。
- 支持按 workspace、hub id、时间、状态、agent、任务摘要查询历史。

恢复规则：

- `resume` 必须先读取 message hub JSON，而不是直接让 worker 从自己最近的 session 继续。
- 如果底层 CLI 有原生 session id，MyHead 使用 `agentSessions` 中保存的映射恢复。
- 如果底层 CLI session 无法按固定方式恢复，`resume` 直接 `failed`。
- 恢复后第一轮必须向 worker 注入完整 hubLog、当前状态、未完成事项和计划约束。

#### Prompt 打包

MyHead 生成 worker prompt 时应包含：

- 已确认实施方案。
- 完整 hubLog。
- 用户目标。
- repo 路径。
- 约束。
- 期望行为。
- 验证预期。
- 请求的输出格式。
- 是否允许修改文件。
- 是否禁止破坏性命令。
- worker 最后应报告什么。
- 每轮回应应明确当前实施步骤、最新 hub 消息、worker 上一轮结果、检查结论和下一步任务。
- 如果完整 hubLog 无法放入上下文，本次 run 直接 `blocked`。

#### 结果呈现

MyHead 应展示：

- 当前终端会话中的 message hub live transcript。
- MyHead 正在做什么，例如 probing、building prompt、dispatching、reviewing、verifying、loop closed。
- worker 的可见回复流，而不是 raw stdout / stderr 墙。
- 每轮 supervisor verdict 和下一步动作。
- 高层 verdict。
- 发生了什么变化。
- 验证证据。
- 风险或开放问题。
- 下一步建议。
- 本次运行使用的 worker no-approval mode。
- 如有 blocked event，展示导致阻塞的权限请求、ask 选项、输出格式或上下文超限原因。
- 仅在有用时展示详细日志路径；`logs` / `show` 是回看和调试入口，不是默认观察执行的主路径。
- 用户请求时可展示原始 worker 输出；默认 transcript 不混入 raw、thinking、tool noise 或 debug artifact。

#### 安全与权限控制

- 可配置工作目录。
- worker 启动时显式设置本次自动审批 / 非交互 no-approval mode。
- 权限审批和 ask 选项不进入用户交互流程。
- 如果 worker 仍要求审批或选择，本次 worker run 直接 `blocked`。
- 不在日志中打印隐藏凭证。
- 对已知 secret pattern 做脱敏。
- 明确区分 worker 声称和已验证证据。
- MyHead 不直接改业务文件，以免 supervisor 和 worker 权责混乱。

#### 存储

建议的本地存储结构：

- `~/.myhead/config.json`：MyHead 全局模型配置。
- `<workspace>/.myhead/sessions/<hub-id>.json`：message hub 历史，包含 MyHead / Codex / Claude 角色消息。
- `<workspace>/.myhead/runs/<run-id>/result.json`：标准化对话与最终结果记录。
- `<workspace>/.myhead/runs/<run-id>/plan.md`：已确认实施方案文本。
- `<workspace>/.myhead/runs/<run-id>/task.json`：由实施方案生成的结构化执行输入。
- `<workspace>/.myhead/runs/<run-id>/artifacts/`：可选调试日志、diff、验证输出。
- `<workspace>/.myhead/templates/`：prompt 模板。
- `<workspace>/.myhead/prompts/`：可编辑的 MyHead 原始提示词。

默认不存储：

- 用户和 MyHead 梳理需求的原始规划对话。

#### CLI 接口

MVP 启动命令：

- `myhead .`：唯一用户启动入口。解析当前目录为 workspace，进入配置引导或规划对话。

MVP 内部交互动作或后续子命令可以包括：

- `plan`：生成或查看实施方案。
- `exec --agent codex|claude|both`：在用户确认实施方案后触发执行。
- `codex`：用已确认实施方案启动 Codex worker。
- `claude`：用已确认实施方案启动 Claude worker。
- `compare`：用已确认实施方案同时运行两者并比较。
- `review`：审查当前工作区或最近一次 run。
- `verify`：运行配置的验证命令。
- `resume <run-id>`：从已有 run 继续。
- `history`：列出当前工作区的 message hub 历史。
- `show <hub-id>`：展示某个保存的 hub 摘要。
- `config`：展示 / 编辑配置。
- `logs <run-id>`：展示调试日志。

这些动作都必须基于当前目录通过 `myhead .` 绑定的 workspace，不接受 `--workspace` 或任意 path 参数作为工作区选择方式。

#### API 接口

未来 UI、Web 服务或桌面 App 可复用同一核心引擎：

- 澄清任务。
- 确认实施方案。
- 编辑 MyHead 原始提示词。
- 创建 message hub。
- 追加 hub message。
- 列出 message hub 历史。
- 创建 task。
- 启动 run。
- 检查 run。
- resume run。
- cancel run。

### 7.3 技术说明

当前项目目录是空项目，工程结构尚未创建。MVP 实现语言按下方评估结论执行，后续仅在触发重评条件时重新评估。实现应保持有意的小而薄。

平台约束：

- MVP 只支持当前 macOS 本机环境。
- 不需要兼容 Linux / Windows 的路径、shell、信号、权限或文件系统语义。
- 可以使用 macOS / Unix 风格能力，例如 POSIX path、`/bin/sh`、process signal、executable bit、标准 stdin / stdout / stderr。
- Linux 可以作为后续扩展目标，但不进入当前 MVP 验收范围。

#### 实现语言评估

MVP 推荐采用 TypeScript / Node.js，但该选择来自当前工作负载评估，不是不可逆的长期绑定。

| 方案 | MVP 适配度 | 优点 | 风险 / 代价 |
| --- | --- | --- | --- |
| TypeScript / Node.js | 高 | 官方 OpenAI / Anthropic SDK 支持成熟；CLI、子进程、JSONL / stream-json、异步队列、zod schema 和文件型 JSON 存储生态成熟；能最快验证本地闭环。 | 依赖 Node runtime；长期复杂状态机和崩溃恢复需要工程纪律。 |
| Python | 中高 | 模型 SDK 和原型开发友好；pydantic / typer 等生态可用。 | 打包和依赖隔离更麻烦；async subprocess / streaming 容易随实现增长变复杂。 |
| Rust | 中 | 单二进制、进程控制、文件锁和崩溃恢复能力强。 | 官方模型 SDK 和结构化输出生态不如 Node / Python 顺手；MVP 开发速度慢，容易过早工程化。 |
| Go | 中 | 单二进制、并发和子进程管理扎实。 | 模型 SDK、schema-first 开发和快速 CLI 产品迭代不如 TypeScript / Python 轻。 |

因此，MVP 技术栈建议是 TypeScript / Node.js：先验证 `myhead . -> interactive request -> plan confirmation -> live hub execution loop`，后续如果出现单二进制分发、长期 daemon、高并发 worker 调度、复杂跨进程锁或更强崩溃恢复要求，再评估 Rust / Go 重写 core。

推荐架构：

- Core package：workspace 绑定、编排、run model、adapter、JSON 存储。
- CLI package：用户命令。
- App package：不进入 MVP；后续只能作为进度 / final-result / history UI，不作为启动入口。
- Adapter package / module：Codex 和 Claude 包裹器。
- Model package / module：围绕官方 OpenAI SDK 和 Claude SDK 的薄封装。
- Review package / module：supervisor prompt 和结果 schema。
- Verification package / module：命令 runner 和 check result schema。

第一版可以只做本地 CLI。CLI 只负责规划、确认、执行、历史、日志和结果展示；不做 worker 审批或 ask 选择界面。

官方 CLI 能力匹配：

- 固定路径事实来源见 `docs/CLI-capability-facts-2026-06-16.md`；该文件包含文档层确认和当前 macOS 目标环境实测结果，作为 MVP 当前 adapter 固定路径的验收依据。
- Codex CLI adapter 必须固定使用 `codex exec` / `codex exec resume`、结构化 JSON 输出、stdin prompt、`--output-last-message`、`--dangerously-bypass-approvals-and-sandbox` 和 `--cd <worker-cwd>`；capability probe 必须确认这些 flag 的真实可用位置和 resume 传参顺序。任一能力不可用则 blocked / failed。
- Claude Code adapter 必须固定使用 `claude -p` / `--resume`、`--verbose`、`--output-format stream-json`、`--append-system-prompt-file`、`--dangerously-skip-permissions` 和 `--session-id`；capability probe 必须确认当前目标版本能解析这些 flag。任一能力不可用则 blocked / failed。
- 这些 CLI 能力必须通过 adapter capability probe 记录版本、实际命令路径、flag 位置、worker 原生 session 存储可用性和最小真实调用结果；能力缺失时不使用备用路径。

### 7.4 假设

- Codex CLI 和 Claude Code CLI 已由用户安装并完成认证。
- 它们的 non-interactive / headless 模式足够稳定，可以被 MyHead 调用。
- 结构化输出必须可用；raw log 只作为 debug artifact，不作为备用输入。
- 用户希望 MyHead 对审查和下一步建议有主见。
- 顶级模型应节制使用，主要用于监督，而不是每个 worker 步骤。
- 用户更偏好少看细节，除非需要决策。
- 用户愿意在 worker 执行前确认实施方案。
- 用户规划对话默认不需要持久化。
- 每个 message hub 都有且只有一个根工作区；worker 可以使用该根工作区本身，或使用从它派生出的隔离 worktree / 临时副本。
- 工作区本地 JSON 文件足以满足 MVP 的历史和 run 存储。
- 官方 OpenAI SDK 和 Claude SDK 能覆盖 MVP 的模型对话需求。
- 目标运行环境是当前 macOS 本机环境，不考虑 Linux / Windows 兼容性。
- Codex CLI 和 Claude Code CLI 的内部配置已由用户自行完成，MyHead 不负责管理。

## 8. 发布计划

### MVP

MVP 目标是在一个本地 repo 中跑通完整闭环。

必需能力：

- MyHead 自身模型配置。
- 简单 first-run setup。
- macOS-only MVP 运行环境约束。
- 每次 run 的 workspace 绑定。
- MyHead 自身模型调用接入官方 OpenAI SDK 和 Claude SDK。
- 基于协议的模型配置：`openai` 或 `claude`，加 API key、base URL、model。
- 可编辑 MyHead 原始提示词和默认提示词。
- `.myhead/sessions/` 下的 message hub JSON 历史。
- 规划对话不持久化，只保存确认后的实施方案。
- 意图澄清、实施方案生成和实施方案确认。
- Codex adapter：在绑定 workspace 或其隔离 worktree 中唤起已配置好的 Codex CLI。
- Claude adapter：在绑定 workspace 或其隔离 worktree 中唤起已配置好的 Claude Code CLI。
- 用户可选择运行 Codex、Claude Code 或两者同时运行。
- Codex 和 Claude 同时运行时共享同一个 message hub。
- message hub 异步接收 Codex / Claude 任意时刻到达的响应。
- 固定 worker no-approval mode，默认不透出审批或 ask。
- 标准化对话与最终结果记录。
- raw log 作为调试 artifact。
- 每轮响应与最终结果提取。
- git repo 中的 diff 捕获。
- 可配置验证命令。
- supervisor review prompt 和结构化 verdict。
- 启动命令：
  - `myhead .`
- `myhead .` 进入后的交互动作或后续子命令：
  - `plan`
  - `exec`
  - `codex`
  - `claude`
  - `compare`
  - `review`
  - `history`
  - `show`
  - `logs`

MVP 可以暂不做：

- Web UI。
- Linux / Windows 支持。
- 远程执行。
- 团队权限。
- 复杂 merge 自动化。
- 超出 message hub 历史的长期记忆。
- 完整过程 replay UI。
- 数据库存储。

### V1

- 更好地从 worker 输出中提取最终结果和结构化事件。
- 恢复 worker 原生 session。
- 更完整的 CLI 能力检测矩阵和版本兼容报告。
- repo-specific check discovery。
- secret 脱敏。
- review result schema 完善。
- 双 agent 隔离运行、结果融合和同一工作树 cooperate 模式增强。
- 更丰富的 workspace message hub 历史搜索。
- 小 App 或托盘 UI，用于进度、历史和最终结果。

### V2

- Web 或桌面 UI。
- Agent marketplace 或自定义 adapter 接口。
- 命令和文件访问 policy engine。
- 按 agent / model 统计历史质量指标。
- 多 repo 编排。
- CI 集成。
- Pull request review mode。

## 开放问题

- supervisor model 的首个默认协议应是 `openai` 还是 `claude`？
- MyHead 默认保存完整日志，还是仅在 debug 模式保存最终结果之外的日志？
- 后续是否提供只读 App / 托盘 UI 查看进度和历史？
- 同一工作树 `cooperate` 模式是否进入 MVP，还是先只交付隔离 `compare` 模式？

## 验收标准

- 用户确认实施方案后，可以通过 MyHead 启动 Codex。
- 用户确认实施方案后，可以通过 MyHead 启动 Claude。
- 用户可以配置 MyHead 自己的模型，不需要在 MyHead 中配置 Codex CLI / Claude Code CLI。
- 用户可以在目标工作区目录运行 `myhead .` 并和 MyHead 对话梳理需求。
- 用户可以编辑 MyHead 原始提示词，并使用默认提示词生成实施方案。
- MyHead 在需要时能提出澄清问题，并在启动 worker 前获得用户确认的实施方案。
- MyHead 默认不透出 worker 权限审批和 ask 选项。
- MyHead 用固定 worker no-approval mode 启动 Codex / Claude；若仍出现审批或 ask，run 进入 `blocked`。
- MyHead 将每次 worker run 绑定到一个工作区文件夹，并把自身状态保存在该工作区 `.myhead/` 下。
- MyHead 可以通过官方 SDK 使用 OpenAI-protocol 或 Claude-protocol 模型配置。
- MyHead 不默认持久化用户规划对话。
- MyHead 将每个 message hub 对话持久化为 JSON，并支持 list / show 历史。
- Codex 和 Claude 同时运行时，它们与 MyHead 共享同一个 message hub。
- MyHead 能接住 Codex / Claude 任意时刻到达的响应，追加 hubLog，并给出回应。
- Codex 和 Claude 在下一轮 context snapshot 中能看到完整 hubLog，但只能与 MyHead 对话。
- MyHead 为每次 run 保存标准化对话与最终结果记录。
- MyHead 可以用自己的 supervisor model 审查 worker 结果。
- MyHead 可以根据实施方案通过对话循环推动 Codex CLI / Claude Code CLI 完成未完成事项。
- MyHead 可以运行至少一个验证命令，并把结果附加到审查中。
- MyHead 可以在审查后推荐下一步动作。
- MyHead 可以比较 Codex 和 Claude 对同一实施方案的输出。

## 资料来源

- Codex CLI reference: https://developers.openai.com/codex/cli/reference
- Codex non-interactive automation: https://developers.openai.com/codex/noninteractive
- Claude Code CLI reference: https://docs.anthropic.com/en/docs/claude-code/cli-reference
- Claude Code overview: https://docs.anthropic.com/en/docs/claude-code/overview
