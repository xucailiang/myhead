# MyHead MVP 实现切片

本文档把 `docs/PRD-myhead.md` 拆成可独立实现的纵向切片。每个切片完成后，都应该让产品变得更可用，而不是只完成某一层的内部代码。

## 指导选择

MVP 先做当前 macOS 本机 CLI，唯一启动入口是用户在目标工作区目录运行 `myhead .`。CLI 提供很小的交互面，用于需求对话、实施方案确认、执行触发、message hub live transcript、最终结果展示、历史和日志查询。worker 权限审批和 ask 选项不做用户交互面。

实现语言评估结论：

MVP 推荐采用 TypeScript / Node.js，但这不是长期绑定。该选择只服务第一阶段目标：用最少代码验证 `myhead . -> interactive request -> plan confirmation -> live hub execution loop` 本地闭环。

评估依据：

- MyHead 的 MVP 核心负载是 CLI 编排、子进程管理、JSONL / stream-json 读取、异步 pendingQueue、JSON schema 校验、文件型 JSON 存储，以及 OpenAI / Anthropic 官方 SDK 接入。
- TypeScript / Node.js 在这些方面生态成熟，能最快完成薄控制层和 adapter smoke test。
- Python 同样适合模型 SDK 和快速原型，但长期 CLI 分发、依赖隔离和异步子进程流处理更容易变松散。
- Rust / Go 更适合后续单二进制分发、长期 daemon、高可靠并发调度或更强本地 runtime 约束；但 MVP 阶段会增加实现成本，并减慢对 CLI 集成路径的验证。

MVP 技术栈建议：

- TypeScript / Node.js：实现 CLI、core 编排、adapter、hub writer 和 supervisor glue。
- `commander` 或 `yargs`：处理 CLI 命令。
- `execa`：唤起用户已配置好的 Codex CLI 和 Claude Code CLI。
- 官方 OpenAI SDK：用于 `protocol = "openai"` 的模型对话。
- 官方 Claude / Anthropic SDK：用于 `protocol = "claude"` 的模型对话。
- `zod`：校验 config、run record、supervisor result schema。
- 执行历史等项目状态保存在 `<workspace>/.myhead/`；MyHead 自身模型配置保存在用户全局 `~/.myhead/config.json`。
- 后续 App / 托盘 UI 可以复用同一 core package，但不作为 MVP 启动入口。

重评触发条件：

- 需要无 Node runtime 的单二进制分发。
- 需要常驻 daemon、后台任务队列或长期高并发 worker 调度。
- 文件锁、崩溃恢复、跨进程协调成为主要复杂度。
- 官方模型 SDK 不再是主要集成路径，或需要更底层的 transport 控制。

这个选择服务于产品原则：先简单、好用、能跑通；不把 MVP 技术栈视为最终架构承诺。

实现规则：用能可靠工作的最少代码。优先官方 SDK、子进程封装、JSON 文件和小函数；避免自研协议、数据库、后台服务或大型框架。

平台规则：MVP 只支持当前 macOS 本机环境，不兼容 Linux / Windows。实现可以直接使用 POSIX path、`/bin/sh`、PTY、process signal、executable bit、标准 stdin / stdout / stderr 等 macOS / Unix 风格能力。

CLI 能力事实：固定 worker 命令和 no-approval mode 以 `docs/CLI-capability-facts-2026-06-16.md` 为准。该文件包含文档层确认和当前 macOS 目标环境实测结果，作为 Slice 3 / Slice 4 前 adapter capability 的当前验收依据。

闭环规则：MVP 的“能跑通”不是只启动一次 worker，而是至少跑通 `确认实施方案 -> 创建 message hub -> 自动进入 hub live transcript -> 启动 worker -> 流式接收任意 worker 响应 -> 追加 hubLog -> 流式呈现 hub message / review / verification -> supervisor 审查 -> 生成下一轮回应或最终结论 -> 保存 JSON 历史`。Slice 9 完成前，只能算 adapter 能用，不能算产品闭环完成。

终端体验规则：默认体验必须对标 Claude Code。用户和 MyHead 聊完并确认执行后，终端不退出、不要求复制 hub id、不要求另跑 `logs`，而是自动呈现 message hub 的可见消息流。所有规划响应、执行状态、worker 可见文本、review、verification 和 loop closed 事件都必须通过同一个 REPL 流式输出；raw stdout / stderr、thinking、tool noise 和 debug artifact 默认折叠。

固定路径规则：MVP 不做备用路径。adapter 的提示词注入、no-approval mode、输出格式、cwd / worktree 和 worker 原生 session 恢复方式必须是固定路径；能力不满足就 `blocked` 或 `failed`，不切换到 PTY、手动审批、缩略上下文或其他备用路径。

## Slice 1: First-Run Config and CLI Skeleton

类型：AFK

依赖：无，可立即开始

覆盖的用户故事：

- 用户无需理解内部架构即可开始使用 MyHead。
- 用户可以一次性配置 MyHead 自己的模型。
- 用户可以选择 MyHead 自己用 OpenAI 协议还是 Claude 协议与模型对话。
- 用户在 macOS 工作区中初始化 MyHead。

要构建的内容：

- `myhead .` CLI 入口；这是唯一启动方式。
- `myhead .`：将当前目录绑定为 workspace，进入规划对话；如果全局 `~/.myhead/config.json` 不存在，先进入首次配置引导。
- `config` 交互动作或等价子命令：展示有效配置。
- 配置 schema：
  - MyHead 模型协议：`openai` 或 `claude`。
  - MyHead API key 明文值。
  - MyHead base URL。
  - MyHead model。
  - MyHead 默认原始提示词路径。
  - 用户编辑后的原始提示词路径。
  - 默认验证命令。
- workspace 本地存储根目录：`.myhead/`。
- workspace path 解析规则：只接受 `.`；必须转为当前 shell 所在目录的绝对路径。不支持显式传入其他目录，也不支持未传目录时隐式使用当前目录。
- workspace 是 message hub 的根工作区；compare 模式下 worker 实际 cwd 可以是从该 workspace 派生的隔离 worktree 或临时副本。
- 不配置 Codex CLI / Claude Code CLI 的模型、账号、权限或默认参数。

验收标准：

- 在某个项目目录运行 `myhead .` 会把当前目录绑定为 workspace，并进入规划对话或首次配置引导。
- 运行 `myhead`、`myhead /path/to/project`、`myhead <path>` 或 `myhead chat --workspace <path>` 必须给出简短错误，提示用户先进入目标目录再运行 `myhead .`。
- 在当前 macOS 本机环境中运行通过；不要求 Linux / Windows 通过。
- 生成的全局配置包含 MyHead 自身模型调用所需的 `protocol`、`apiKey`、`baseUrl`、`model`。
- 运行配置查看动作会校验并展示当前全局配置，但不得输出明文 key。
- 后续 worker run 可以解析绑定的 workspace 路径。
- 配置查看动作不包含 Codex / Claude Code 的模型和账号配置。
- 缺少必要配置时，给出简短清楚的错误信息。
- 本切片不调用任何 worker CLI。

## Slice 1.5: Message Hub JSON History

类型：AFK

依赖：Slice 1

覆盖的用户故事：

- 每个执行 message hub 对话都持久化为 JSON。
- 用户可以查询当前 workspace 的执行历史。
- 用户和 MyHead 梳理需求的规划对话默认不持久化。

要构建的内容：

- Message hub JSON schema：
  - schema version。
  - hub id。
  - workspace path。
  - created / updated time。
  - current status。
  - implementation plan。
  - plan hash。
  - prompt injection method per agent。
  - no-approval mode per agent。
  - selected agents：`codex`、`claude` 或 `both`。
  - agent native session ids。
  - agent cwd / worktree。
  - hubLog：`myhead`、`codex`、`claude` 的全量可见消息。
  - pendingQueue：已收到但尚未审查回应的 worker 响应。
  - agent cursors：每个 worker 已看到的 hubLog offset。
  - context policy：MVP 固定 `{ mode: "full", version: 1 }`，为后续压缩策略预留扩展口。
  - context snapshots：每次发给 worker 的上下文元数据，包括目标 worker、hubLog offset、token 估算、构造策略版本；MVP 不写入压缩 artifact。
  - turn invocations：每次非交互 CLI 调用 / resume 的命令元数据、输入 artifact、输出 artifact、exit code 和 context snapshot id。
  - agent status：每个 worker 独立的 `idle`、`running`、`blocked`、`failed`、`cancelled`、`done`。
  - turns：inbound message、review、reply、verification。
  - per-turn reviews。
  - blocked events。
  - artifact paths。
  - resume checkpoint。
  - final status。
- hub 文件保存到 `.myhead/sessions/<hub-id>.json`。
- `history` 动作：列出绑定 workspace 中的 message hub。
- `show <hub-id>` 动作：展示某个已保存 hub 的简洁摘要。

验收标准：

- `myhead .` 的规划对话不创建或更新 message hub JSON。
- 用户确认实施方案并触发 `exec` 动作后，才创建 message hub JSON。
- hub JSON 记录完整 hubLog、review 和最终状态。
- hub JSON 记录 `contextPolicy` 和每轮 `contextSnapshots`；MVP 中只允许完整上下文模式。
- hub JSON 记录 `turnInvocations` 和 per-agent 状态。
- hub JSON 记录每个 worker 的 prompt 注入方式、no-approval mode 和实际 cwd / worktree。
- hub JSON 可以表达 `listening`、`message_queued`、`reviewing`、`needs_user_decision`、`accepted`、`failed`、`blocked`、`cancelled` 等状态。
- `history` 动作只列出当前 workspace 的 message hub。
- `show <hub-id>` 动作从 `.myhead/sessions/` 读取内容。

## Slice 2: Workspace Chat and Implementation Plan

类型：AFK

依赖：Slice 1.5

覆盖的用户故事：

- 用户先在目标 workspace 目录运行 `myhead .`，再和 MyHead 对话梳理需求。
- MyHead 使用默认提示词主动帮助用户形成实施方案。
- 用户可以编辑 MyHead 原始提示词。
- 用户在执行前确认实施方案文本。

要构建的内容：

- `myhead .` 进入当前目录工作区对话；这是唯一启动入口。
- 不实现 `myhead chat --workspace <path>`、`myhead [workspace]`、`myhead <path>` 或任何显式 workspace path 启动方式。
- `.myhead/prompts/default.md` 保存默认提示词。
- `prompt edit` 动作或等价能力允许用户编辑 MyHead 原始提示词。
- `plan` 动作生成实施方案文本。
- 实施方案字段：
  - 原始用户请求。
  - target cwd / repo。
  - 已理解目标。
  - 约束。
  - 成功标准。
  - 实施步骤。
  - 风险和开放问题。
  - 拟使用的 worker 策略。
  - 验证计划。
- CLI 确认提示：
  - accept。
  - edit。
  - cancel。
- 已确认实施方案保存到 `.myhead/runs/<run-id>/plan.md`。
- 结构化执行输入保存到 `.myhead/runs/<run-id>/task.json`。
- 规划对话默认不写入 `.myhead/sessions/`。
- 用户确认后的实施方案保存为后续 message hub 的最高优先级执行上下文。
- 用户编辑后的最终实施方案是唯一事实来源；worker 和 supervisor 都以它为准。
- 生成 `plan hash`，后续 worker prompt、review 和 hub JSON 都引用它。

验收标准：

- 用户可以在目标 workspace 目录运行 `myhead .` 和 MyHead 对话。
- 用户不需要、也不能额外输入 `--workspace`。
- 用户可以查看和编辑 MyHead 原始提示词。
- 模糊任务会生成用户可确认或取消的实施方案。
- 已确认实施方案在任何 worker 启动前保存。
- 不持久化用户和 MyHead 的原始规划对话。
- 已确认实施方案包含必要摘要、提示词快照和可执行计划。
- 用户编辑计划后，保存的是编辑后的最终版本，而不是模型初稿。
- cancel 会干净退出，不产生副作用。

## Slice 3: Codex Conversation Run

类型：AFK

依赖：Slice 2

覆盖的用户故事：

- 用户可以通过 MyHead 把已确认实施方案和完整 hubLog 交给 Codex。
- MyHead 可以与 Codex 进行多轮任务分发、响应检查和回应推进。
- MyHead 默认展示 message hub 可见消息流和最终摘要，不展示 raw 执行噪声。

要构建的内容：

- `exec --agent codex` 和 `codex` 动作。
- Codex adapter：唤起用户已配置好的 Codex CLI。
- 始终以绑定 workspace 作为 cwd 启动 Codex。
- 固定使用 `codex exec --cd <worker-cwd> --dangerously-bypass-approvals-and-sandbox --json --output-last-message <artifact> -`。
- Codex 的 `--dangerously-bypass-approvals-and-sandbox` 和 `--cd` 必须按当前目标版本真实支持的位置传入；该模式绕过审批和沙箱，满足“不透出审批”，但必须在 hub JSON 和最终输出中清楚记录。
- 后续轮次固定使用 `codex exec --cd <worker-cwd> --dangerously-bypass-approvals-and-sandbox resume --json --output-last-message <artifact> <session-id> -`。
- Codex 的 `--cd` 和 `--dangerously-bypass-approvals-and-sandbox` 在后续轮次中必须放在 `resume` 子命令之前，作为 `codex exec` 的父级 options。
- 从 stdin 传入 MyHead prompt package，不向 Codex 传入 `--model`。
- 如果当前 Codex CLI 不支持固定路径，本次 run `blocked` 或 `failed`，不使用备用路径。
- 每轮发给 Codex 的 MyHead 消息都包含完整 hubLog、plan hash、当前实施步骤、上一轮审查结论和下一步任务。
- Codex 只能回复 MyHead；不能向 Claude 直接发消息。
- 基于实施方案生成第一轮任务分发。
- 接收 Codex 任意时刻到达的响应后，先追加 hubLog 和 pendingQueue，再交给 MyHead controller / supervisor 检查。
- 根据检查结果向 Codex 继续回应：继续、修正、验证、拆下一步，或请求用户决策。
- 捕获：
  - exit code。
  - per-turn worker response。
  - per-turn MyHead review。
  - per-turn MyHead reply。
  - final response。
  - stdout / stderr 作为 debug artifact。
  - start / end time。
  - 不泄露 secret 的有效命令元数据。
- 保存标准化 conversation / final-result record。
- 将 run id 链接到当前 hub JSON。

验收标准：

- MyHead 可以调用系统中可用的 `codex` 命令。
- Codex 默认在绑定 workspace 文件夹内运行。
- compare 模式中，Codex 可以在从绑定 workspace 派生的隔离 worktree / 临时副本中运行。
- MyHead 不读取或修改 Codex CLI 的内部配置。
- Codex 收到已确认实施方案和完整 hubLog。
- hub JSON 记录 Codex 实际使用的注入方式、no-approval mode 和 agent cursor。
- hub JSON 记录 Codex 每轮 `turnInvocation`、session id、context snapshot id 和 `seenHubOffset`。
- MyHead 至少能处理一轮“分发任务 -> 接收响应 -> 审查 -> 回应”的循环。
- 用户看到简洁最终结果。
- raw log 保存但默认不打印。
- Codex 失败时给出清晰 failure status 和 debug log 路径。

## Slice 4: Claude Conversation Run

类型：AFK

依赖：Slice 2

覆盖的用户故事：

- 用户可以通过 MyHead 把已确认实施方案和完整 hubLog 交给 Claude Code。
- MyHead 可以与 Claude Code 进行多轮任务分发、响应检查和回应推进。
- MyHead 默认展示 message hub 可见消息流和最终摘要，不展示 raw 执行噪声。

要构建的内容：

- `exec --agent claude` 和 `claude` 动作。
- Claude adapter：唤起用户已配置好的 Claude Code CLI。
- 始终以绑定 workspace 作为 cwd 启动 Claude。
- 固定使用 `claude -p --verbose --output-format stream-json --dangerously-skip-permissions --append-system-prompt-file <myhead-prompt-file> --session-id <uuid> <turn-prompt>`。
- 后续轮次固定使用 `claude -p --verbose --output-format stream-json --dangerously-skip-permissions --resume <session-id> <turn-prompt>`。
- capability probe 必须确认当前目标版本能解析 `--append-system-prompt-file`；如果该 flag 不可用，run 直接 `blocked`，不切换到 `--append-system-prompt` 或其他注入方式。
- MyHead 通过进程 cwd 绑定 workspace，不向 Claude 传入 `--model`。
- 如果当前 Claude Code 不支持固定路径，本次 run `blocked` 或 `failed`，不使用备用路径。
- 每轮发给 Claude 的 MyHead 消息都包含完整 hubLog、plan hash、当前实施步骤、上一轮审查结论和下一步任务。
- Claude 只能回复 MyHead；不能向 Codex 直接发消息。
- 基于实施方案生成第一轮任务分发。
- 接收 Claude 任意时刻到达的响应后，先追加 hubLog 和 pendingQueue，再交给 MyHead controller / supervisor 检查。
- 根据检查结果向 Claude 继续回应：继续、修正、验证、拆下一步，或请求用户决策。
- 捕获与 Codex 相同的标准化 conversation / final-result 字段。
- 结构化输出必须可用；不可用时本次 run `failed`。

验收标准：

- MyHead 可以调用系统中可用的 `claude` 命令。
- Claude 默认在绑定 workspace 文件夹内运行。
- compare 模式中，Claude 可以在从绑定 workspace 派生的隔离 worktree / 临时副本中运行。
- MyHead 不读取或修改 Claude Code CLI 的内部配置。
- Claude 收到已确认实施方案和完整 hubLog。
- hub JSON 记录 Claude 实际使用的 prompt 文件路径、no-approval mode、hash、session id 和 agent cursor。
- hub JSON 记录 Claude 每轮 `turnInvocation`、context snapshot id 和 `seenHubOffset`。
- MyHead 至少能处理一轮“分发任务 -> 接收响应 -> 审查 -> 回应”的循环。
- 用户看到简洁最终结果。
- raw log 保存但默认不打印。
- Claude 失败时给出清晰 failure status 和 debug log 路径。

## Slice 5: Fixed Worker No-Approval Mode

类型：AFK

依赖：Slice 3 或 Slice 4

覆盖的用户故事：

- worker 执行时不把权限审批和 ask 选项打断给用户。
- MyHead 以固定的自动审批 / 非交互 no-approval mode 启动 Codex 和 Claude。
- 如果固定调用路径不成立，MyHead 清楚失败，而不是切换模式。

要构建的内容：

- 为 Codex adapter 定义唯一 no-approval mode 启动参数：`--dangerously-bypass-approvals-and-sandbox`。
- 为 Claude adapter 定义唯一 no-approval mode 启动参数：`--dangerously-skip-permissions`。
- adapter capability probe 检查该 no-approval mode 是否可用。
- Codex capability probe 必须确认 `exec`、`exec resume`、`--json`、`--output-last-message`、`--dangerously-bypass-approvals-and-sandbox`、`--cd` 可用，并记录这些 flag 的真实位置；`--cd` 和 no-approval flag 放在 `resume` 前，`--json` 和 `--output-last-message` 放在 `resume` 后且 `<session-id>` 前。
- Claude capability probe 必须确认 `-p`、`--verbose`、`--output-format stream-json`、`--dangerously-skip-permissions`、`--append-system-prompt-file`、`--session-id`、`--resume` 可用，并用最小 dry-run、help parse 或本地安装包字符串检查证明目标版本能解析 prompt file 注入 flag。
- capability probe 必须确认 worker 原生 session / state 存储可用；如果 Codex session store 或 Claude session persistence 不可读写，依赖 resume 的 run 进入 `blocked` 或 `failed`。
- 启动命令元数据记录到 hub JSON：
  - agent。
  - no-approval mode。
  - cwd / worktree。
  - output format。
  - prompt injection method。
- worker 运行中如果输出权限审批、tool-use 确认或 ask 选项，记录为 `blockedEvent`。
- 不实现 CLI prompt。
- 不实现交互审批界面。
- 不实现自动审批策略分支。
- 不实现备用调用路径。

验收标准：

- Codex 和 Claude run 默认不向用户透出审批或 ask。
- 固定 no-approval mode 不可用时，run 进入 `blocked`。
- worker 仍请求审批或 ask 时，run 进入 `blocked`。
- hub JSON 记录 no-approval mode 和 blocked event。
- 没有多种权限运行分支。

## Slice 6: Git Diff and Final-Result Artifacts

类型：AFK

依赖：Slice 3 或 Slice 4

覆盖的用户故事：

- MyHead 知道发生了哪些文件变化。
- 用户可以查看结果证据，而不用阅读完整执行过程。

要构建的内容：

- 检测 cwd 是否在 git 仓库内。
- 捕获 run 前后 diff 元数据。
- 保存：
  - changed files。
  - diff summary。
  - 可用时保存 full diff artifact。
  - final response。
  - decisions。
  - debug log paths。
- `logs <run-id>` 动作：查看详细输出。

验收标准：

- git repo 内的 run 会展示 changed files 和 diff summary。
- 非 git repo 内的 run 也能正常完成。
- `logs <run-id>` 动作能展示 raw / debug artifact 的位置。

## Slice 7: Verification Commands

类型：AFK

依赖：Slice 6

覆盖的用户故事：

- MyHead 验证结果，而不是相信 worker 的说法。
- 用户看到证据摘要，而不是日志墙。

要构建的内容：

- 可配置验证命令。
- `verify` 动作：运行已配置 check。
- worker 完成后可按配置自动运行验证。
- 保存 check result：
  - command。
  - exit code。
  - short output summary。
  - log path。

验收标准：

- 可以运行并记录已配置的 test / build / lint 命令。
- 最终结果展示 pass / fail 摘要。
- 验证失败会让 supervisor 在下一轮回应中要求修正、补充验证，或请求用户决策。

## Slice 8: Supervisor Review

类型：AFK

依赖：Slice 6 和 Slice 7

覆盖的用户故事：

- MyHead 使用更强模型判断 worker 输出。
- 用户得到 verdict 和下一步动作，而不是只有原始 Agent 输出。

要构建的内容：

- 官方 SDK model client：
  - 配置 `protocol = "openai"` 时走 OpenAI SDK。
  - 配置 `protocol = "claude"` 时走 Claude / Anthropic SDK。
  - 共享小接口：`completeJson(messages, schema, options)`。
- Supervisor prompt template，使用：
  - 已确认实施方案。
  - 完整 hubLog。
  - 当前实施步骤。
  - worker 本轮响应。
  - changed files / diff summary。
  - verification result。
  - blocked events。
- 结构化 review schema：
  - status：`accepted`、`continue`、`revise`、`verify`、`needs_user_decision`、`failed`、`blocked`。
  - summary。
  - findings。
  - missing verification。
  - recommended reply。
  - next implementation step。
- 基于协议的 supervisor config：API key、base URL、model。

验收标准：

- MyHead 可以为 worker run 生成结构化 review。
- 在配置中切换 `openai` / `claude` 协议，会选择对应官方 SDK 路径。
- 最终 CLI 输出展示 verdict、evidence、risk 和 next action。
- supervisor review 保存进 run record。
- supervisor message 和 result 追加进 hub JSON。
- review 会判断 worker 本轮响应是否完成当前实施步骤，以及下一轮应该如何回应。

## Slice 9: Implementation Push Loop

类型：HITL

依赖：Slice 8

覆盖的用户故事：

- MyHead 可以拿着实施方案持续驱动 worker 完成工作。
- MyHead 检查每次 worker 响应，并生成下一轮回应。
- 用户确认执行后自动看到 message hub 消息流，而不是等待最终摘要或另跑日志命令。
- 需要用户决策时才暂停询问。

要构建的内容：

- interactive layer 在用户确认执行后自动订阅 controller event stream，并把 message hub 可见消息投影为当前终端的 live transcript。
- controller 必须提供事件 sink，例如 `onEvent(event)`，覆盖 `hub_message`、`worker_visible_text`、`review_started`、`review_completed`、`verification_started`、`verification_completed`、`user_decision_required` 和 `loop_closed`。
- ProcessRunner 必须支持 stdout / stderr chunk callback；adapter 应边读边解析 Codex JSONL 和 Claude `stream-json`，尽早产生 worker 可见文本事件。
- 使用固定 prompt 注入方式把已确认实施方案交给 worker。
- 每次回复 worker 时注入完整 hubLog；如果完整 hubLog 无法放入上下文，run 进入 `blocked`。
- 通过统一 context builder 生成 worker 出站上下文；MVP 的 builder 只有 `full` 模式，但接口和 hub JSON 预留后续压缩策略字段。
- 每次 worker turn 是一次非交互 CLI 调用或一次原生 session resume；MVP 不假设可以在同一个 worker 运行中追加新消息。
- 每条 worker 响应必须记录 `seenHubOffset`，表示它基于哪个 context snapshot 生成。
- 从实施方案中生成当前实施步骤。
- 根据 supervisor review 生成 MyHead 对 worker 的下一轮回应。
- MyHead controller 监听所有 worker inbound streams；任意 worker 任意时刻的响应都要追加 hubLog 并进入 pendingQueue。
- MyHead 可以串行审查 pendingQueue，但接收 worker 响应不能因为正在审查另一条消息而丢失。
- hub JSON 只能由一个 hub writer 串行写入；每次保存使用临时文件和原子重命名。
- 对每个 worker 维护 agent cursor，确保下一轮该 worker 能看到完整 hubLog。
- 状态为 `continue` 时自动推进下一步。
- 状态为 `revise` 时要求 worker 修正当前响应。
- 状态为 `verify` 时运行验证或要求 worker 补充验证证据。
- 状态为 `needs_user_decision` 时暂停并询问用户。
- 状态为 `blocked`、`failed`、`cancelled`、`accepted` 时停止循环并写入 final result。
- 设置最大自动推进轮数，达到上限后进入 `needs_user_decision`，避免无限循环烧 token。
- 每轮开始前写入 checkpoint；崩溃后可以从最后一轮恢复。
- 将每轮 worker response、MyHead review、MyHead reply 追加到同一个 hub JSON。
- raw stdout / stderr、thinking、tool result 和 debug artifact 必须保存但默认不进入 live transcript。

验收标准：

- 用户输入普通需求、确认执行后，终端自动从 planning transcript 切换到 message hub live transcript，不退出当前 `myhead>` 会话。
- worker 输出应逐段显示可见文本；不能等子进程结束后才一次性打印全部内容。
- review 和 verification 的开始、完成、verdict、失败证据和 loop closed 必须实时显示。
- `logs`、`show`、`history` 是回看和调试入口，不是默认观察执行过程的主路径。
- MyHead 能完成至少两轮 worker 对话推进。
- 每轮推进都能记录 worker response、review 和 reply。
- Codex 和 Claude 同时运行时，MyHead 能在处理其中一方响应时接住另一方响应并入队。
- 每次发给任一 worker 的回应都包含完整 hubLog。
- 每次出站都写入 context snapshot；MVP 中不得生成压缩、摘要或裁剪后的 worker 上下文。
- supervisor 审查时必须比较 worker 响应的 `seenHubOffset` 和最新 hub offset；如果响应基于旧快照，审查结果要说明是否需要再派发一轮同步上下文。
- MyHead 的回应明确引用实施方案中的当前步骤或未完成事项。
- 当需要用户判断时，循环会暂停并等待用户选择。
- 验证失败会把真实命令输出摘要带回下一轮 worker prompt。
- worker 崩溃或输出不可解析时，hub JSON 仍保留 raw artifact 路径和失败状态。

## Slice 10: Compare Codex and Claude

类型：AFK

依赖：Slice 3、Slice 4、Slice 8、Slice 9

覆盖的用户故事：

- 用户可以在同一个已确认实施方案上比较 Codex 和 Claude。
- MyHead 推荐哪个结果更可信。

要构建的内容：

- `compare` 或 `exec --agent both` 动作。
- 将同一份已确认实施方案发送给两个 worker。
- 创建一个 message hub，角色包括 `myhead`、`codex`、`claude`。
- Codex 和 Claude 的响应都写入同一个 hubLog。
- 默认 compare 模式为每个 worker 准备隔离 worktree 或临时副本；共享的是 message hub，不是同一个可写目录。
- Codex 和 Claude 都看到完整 hubLog，但只能回复 MyHead，不能互相直连。
- Codex 和 Claude 并行运行时看到的是各自启动时的 context snapshot；某一方先返回的新消息只会进入另一方下一轮派发，不会注入正在运行的 CLI 调用。
- git repo 中优先使用 `git worktree`；非 git repo 中使用临时副本。无法隔离时 compare run 进入 `blocked`，用户必须显式重新选择 cooperate 才能同树串行执行。
- 同一工作树 cooperate 模式必须串行化会修改文件的 worker turn，并记录锁持有者。
- Supervisor 比较：
  - final answer quality。
  - diff risk。
  - verification evidence。
  - maintainability。
  - confidence。

验收标准：

- 两个 worker 收到同一份已确认实施方案和完整 hubLog。
- Codex、Claude 和 MyHead 的消息保存在同一个 message hub 中。
- MyHead 能接住任意一方任意时刻到达的响应。
- MyHead 能识别并记录每个 worker 响应基于哪个 hub snapshot。
- 两个 worker 的 cwd / worktree、diff 和验证证据可区分。
- MyHead 展示简洁 comparison 和 recommendation。
- 某个 worker 失败时，不丢失另一个成功 worker 的结果。
- MyHead 不自动合并冲突 diff；需要用户确认或分发给一个 worker 做受控融合。

## Slice 11: Claude-Code-Style Streaming Terminal UX

类型：AFK

依赖：Slice 8

覆盖的用户故事：

- 默认体验像 Claude Code 一样持续、流式、可恢复。
- 用户确认执行后自然看到 MyHead、worker、review 和 verification 消息滚动。
- 用户不会被 raw worker 执行噪声淹没。

要构建的内容：

- 清晰的终端 live transcript 布局：
  - implementation plan。
  - manual execution gate。
  - hub created。
  - MyHead dispatch。
  - worker visible text。
  - supervisor review status。
  - verification status。
  - loop closed。
  - worker used。
  - final response。
  - changed files。
  - supervisor verdict。
  - next action。
- execution 启动后自动呈现 message hub 消息，不要求用户运行 `logs` 或复制 hub id。
- `visibility = "hub"` 的消息默认显示；`visibility = "debug"` 的消息默认折叠。
- planning、execution、review、verification、blocked、needs_user_decision、accepted 都必须在同一个 REPL loop 中显示。
- `--verbose`：展示 debug 细节。
- `--json`：供脚本使用。
- live transcript 和最终摘要中包含 hub id 和 run id。

验收标准：

- 常见任务的默认输出可以持续滚动，但每条消息必须短、清楚、可扫读；最终摘要能放进一个易读屏幕。
- 用户确认执行后立即看到 hub created、dispatch、worker visible text、review、verification 和 loop closed 事件。
- 除非使用 `--verbose` 或 `logs` 动作，否则不打印 raw log。
- JSON 输出有效且可脚本化。
- `history` 和 `show` 动作保持简洁可读。

## 建议构建顺序

1. Slice 1: First-Run Config and CLI Skeleton。
2. Slice 1.5: Message Hub JSON History。
3. Slice 2: Workspace Chat and Implementation Plan。
4. Slice 3: Codex Conversation Run。
5. Slice 4: Claude Conversation Run。
6. Slice 5: Fixed Worker No-Approval Mode。
7. Slice 6: Git Diff and Final-Result Artifacts。
8. Slice 7: Verification Commands。
9. Slice 8: Supervisor Review。
10. Slice 9: Implementation Push Loop。
11. Slice 11: Claude-Code-Style Streaming Terminal UX。
12. Slice 10: Compare Codex and Claude。

## 早期技术风险

- Codex CLI 和 Claude Code CLI 在 non-interactive / headless 模式下暴露交互 prompt 的方式可能不同。
- 固定 no-approval mode 可能在不同 CLI 版本中的能力表现不同；能力缺失时必须 blocked，不做备用路径。
- per-turn response / final response extraction 必须能抵抗 CLI 输出格式变化。
- 同时运行两个 worker 不能默认写同一 worktree；compare 默认隔离，cooperate 必须单写者串行化。
- OpenAI SDK 和 Claude SDK 的请求 / 响应结构不同；封装必须保持小而 schema-focused。
- message hub JSON 文件可能变大；MVP 应保存可查询历史，把大日志放到 artifacts。
- macOS-only 简化了实现；如果用户在 Linux / Windows 上运行，需要明确报错或提示不支持。
- Codex CLI 没有与 Claude Code 等价的 prompt file 注入能力；MVP 已固定为 stdin prompt package，并必须把能力探测结果记录到 hub。
- 完整 hubLog 可能超出 worker 上下文；超出时必须 blocked，不做摘要替代。

## 待决策问题

1. MyHead 自身模型调用的默认协议应是 `openai` 还是 `claude`？
2. API key 已确定直接明文存入全局 `~/.myhead/config.json`，不使用环境变量引用。
3. 后续是否提供只读 App / 托盘 UI 查看进度和历史？
4. 同一工作树 cooperate 模式是否进入 MVP，还是 MVP 只交付隔离 compare 模式？
