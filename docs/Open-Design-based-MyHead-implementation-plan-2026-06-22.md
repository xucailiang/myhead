# MyHead 基于 Open Design 去设计化实施计划

日期：2026-06-22

## 1. 决策

**采用 Open Design 作为 MyHead 的工程起点，剥离设计层，保留 agent runtime + 桌面壳 + daemon 基础设施，在其上构建 MyHead 的监督控制平面。**

### 1.1 为什么不是从零写

MyHead 的核心复杂度不在 TUI 渲染或终端事件循环，而在两个东西：

1. **Agent adapter**：Codex 和 Claude 的 CLI 调用路径、flag 位置、no-approval mode、stream 解析、session resume。Open Design 的 `runtimes/defs/claude.ts` 和 `runtimes/defs/codex.ts` 已经在 22 个 CLI 上战验证过，包括 `--input-format stream-json`、`--output-format stream-json`、`--permission-mode bypassPermissions`、`--resume`、`--session-id` 等全部固定路径。这是从零写最容易踩坑、迭代最慢的部分。

2. **桌面壳**：Electron 41 + sidecar IPC + auto-update + macOS/Windows 双平台打包。Open Design 的 `apps/desktop/` + `apps/packaged/` 已经是生产级实现。

从零写意味着要先花大量时间踩 agent adapter 的 CLI 兼容性坑，再花时间搭桌面壳。Open Design 路径让这两个最大风险项直接清零。

### 1.2 为什么不是 MiMo-Code 二开

MiMo-Code 的优势是 terminal-first TUI（天然对标 Claude Code 的 REPL 体验），但弱势是：

- 没有 Codex/Claude adapter（需要从零写，这是最大风险）
- 没有桌面壳（需要后加）
- 代码量 140M，提取 runtime 本身就需要大量裁剪工作

如果接受 MyHead 用 Web UI + Electron 桌面壳（而不是纯终端 TUI），Open Design 路径更省事。agent adapter 和桌面壳直接拿，改造集中在 chat loop 重写。

### 1.3 设计判断

Open Design 和 MyHead 的根本差异不是架构，而是**产品循环**：

| | Open Design | MyHead |
|---|---|---|
| 循环 | brief → agent renders → artifact preview | plan → confirm → dispatch workers → hub receive → review → iterate → close |
| agent 角色 | 设计渲染引擎 | 编程任务执行者 |
| 产物 | HTML/PPTX/MP4 | 代码变更 + 审查结论 |
| 对话模型 | 单轮为主，支持 retry | 多轮推进，完整 hubLog |
| 状态 | run status | hub 状态机（15 个状态） |

这意味着：

- **agent adapter 层几乎不用改**——Codex 和 Claude 的启动参数、stream 解析、session 管理完全复用
- **daemon 基础设施大部分保留**——Express、MCP、CLI、项目绑定、agent 检测、桌面壳
- **需要彻底重写的是 chat loop**——从 design render loop 变成 supervisor push loop
- **需要新增的是 message hub、supervisor review、planning gate**
- **需要删除的是所有 design 特定代码**——skills、design systems、design templates、craft、artifacts 生成、媒体生成

## 2. Open Design 保留清单

### 2.1 完整保留（不改或接近不改）

| 模块 | 路径 | 说明 |
|------|------|------|
| Agent 运行时定义 | `apps/daemon/src/runtimes/defs/*.ts` | 25 个 agent 的 bin、versionArgs、authProbe、buildArgs、streamFormat 等完整定义。**myhead 只需要 claude.ts 和 codex.ts**，其余 23 个可删 |
| Agent 启动 | `apps/daemon/src/runtimes/launch.ts` | `resolveAgentLaunch()`、`applyAgentLaunchEnv()`，PATH 解析和 env 组装 |
| Agent 调用 | `apps/daemon/src/runtimes/invocation.ts` | `execAgentFile()`，子进程 exec 封装 |
| Agent 检测 | `apps/daemon/src/runtimes/detection.ts` | `detectAgents()`，扫描 PATH 上的可用 CLI |
| Agent registry | `apps/daemon/src/runtimes/registry.ts` | `AGENT_DEFS`、`getAgentDef()` |
| Claude stream 解析 | `apps/daemon/src/claude-stream.ts` | `createClaudeStreamHandler()`，解析 `stream-json` 输出为 text_delta、thinking_delta、tool_use、tool_result、usage 事件 |
| Codex stream 解析 | `apps/daemon/src/codex-cli.ts` | Codex JSONL 输出解析 |
| Agent session 管理 | `apps/daemon/src/agent-session-resume.ts` | `resolveAgentResumeContext()`、`persistCapturedAgentSession()`，SQLite 持久化的 session id 管理 |
| 桌面壳 | `apps/desktop/` | Electron 41 主进程，sidecar IPC，窗口管理 |
| 打包桌面壳 | `apps/packaged/` | 打包 Electron runtime，auto-update，installer |
| Web 框架 | `apps/web/` | Next.js 16 App Router。**保留框架层**（路由、组件系统、CSS Modules），重写业务页面 |
| Sidecar 协议 | `packages/sidecar-proto/`、`packages/sidecar/` | 桌面壳与 daemon 的 IPC 协议 |
| 平台原语 | `packages/platform/` | 进程管理、命令调用 |
| 契约层 | `packages/contracts/` | 保留 DTO 类型定义结构，重写内容 |
| 共享组件 | `packages/components/` | Button、VisuallyHidden 等基础 UI 原语 |
| MCP server | `apps/daemon/src/mcp-routes.ts` 相关 | 可用于暴露 MyHead 能力给外部 agent |
| CLI 框架 | `apps/daemon/src/cli.ts` | `od` 命令注册，改为 `myhead` |
| Daemon 路径 | `apps/daemon/src/daemon-paths.ts` | `RUNTIME_DATA_DIR` 等路径解析 |
| Express 基础设施 | `apps/daemon/src/server.ts` 的 app 创建、中间件、context 组装 | 保留路由注册模式 |
| SQLite 基础设施 | `apps/daemon/src/db.ts` | agent session、配置持久化 |

### 2.2 保留但需适配

| 模块 | 需要改什么 |
|------|-----------|
| `server.ts` | 删除 design-specific 路由注册；删除 `design.runs` 调用；替换 `startChatRun` 为 MyHead 执行循环 |
| `chat-routes.ts` | 完全重写为 MyHead 的 hub/plan/exec 路由 |
| `server-context.ts` | 删除 design、skills、craft、critique 依赖；添加 hub、supervisor、verification 依赖 |
| `route-context-contract.ts` | 精简为 MyHead 路由依赖 |
| `runtimes/types.ts` | 删除 design-specific 字段 |
| agent defs | 只保留 claude.ts 和 codex.ts，删除其余 23 个 |
| `runtimes/capabilities.ts` | 只保留 claude 和 codex 的能力检测 |

### 2.3 删除清单

#### 顶层目录

```
skills/              # 100+ 设计技能
design-templates/    # 渲染模板目录（decks, prototypes, hyperframes）
design-systems/      # 150 个 DESIGN.md 品牌系统
craft/               # 品牌无关的设计规则
prompt-templates/    # 93 个图片/视频 prompt 模板
mocks/               # 22 个 mock CLI（可保留 codex/claude mock 用于测试）
```

#### Daemon 源文件（`apps/daemon/src/`）

```
# 设计系统
design-systems.ts
design-system-preview.ts
design-system-showcase.ts
design-system-generation-jobs.ts
design-token-contract-rebuild.ts

# 技能
skills.ts

# Artifact 生成
artifact-create.ts
artifact-manifest.ts
artifact-publication-guard.ts
artifact-runtime-compat.ts
artifact-stub-guard.ts
artifact-text-suppression.ts
artifacts-cli.ts

# 媒体生成
byok-tools.ts
aihubmix.ts
amr-image-staging.ts
amr-stderr-filter.ts

# 自动化
automation-ingestions.ts
automation-proposals.ts
automation-routine-evolution.ts
automation-templates.ts

# 设计 critique
critique/

# 设计导入
claude-design-import.ts

# 设计相关路由
routes/live-artifact.ts
routes/genui.ts
routes/media.ts
routes/host-tools.ts

# Codex 特定（保留 codex-cli.ts 和 defs/codex.ts）
codex-pets.ts
codex-config-normalize.ts

# 其他设计相关
craft.ts
handoff-design.ts
finalize-design.ts
connectors/
```

#### Packages

```
packages/plugin-runtime/     # 插件运行时
packages/agui-adapter/       # AG-UI 适配器
packages/download/           # 下载管理
packages/launcher-proto/     # 启动器协议
packages/host/               # 宿主工具
packages/metatool/           # 元工具
packages/registry-protocol/  # 注册表协议
```

#### Apps

```
apps/landing-page/      # Open Design 官网
apps/telemetry-worker/  # 遥测 worker
```

### 2.4 删除后的包结构

```
myhead/
├── package.json
├── pnpm-workspace.yaml
├── apps/
│   ├── daemon/            # 保留，重写 chat loop
│   ├── desktop/           # 保留，改品牌
│   ├── packaged/          # 保留，改品牌
│   └── web/               # 保留框架，重写页面
├── packages/
│   ├── components/        # 基础 UI 原语
│   ├── contracts/         # 保留结构，重写 DTO
│   ├── diagnostics/       # 保留（可选）
│   ├── platform/          # 进程管理原语
│   ├── sidecar/           # sidecar 运行时
│   └── sidecar-proto/     # sidecar 协议
├── tools/
│   ├── dev/               # 本地开发生命周期
│   ├── pack/              # 打包构建
│   └── serve/             # fixture 服务
└── e2e/                   # E2E 测试框架
```

## 3. 新增模块

### 3.1 MyHead Core（新增 package: `packages/myhead-core`）

```
packages/myhead-core/src/
├── config/
│   ├── schema.ts          # ~/.myhead/config.json zod schema
│   ├── load.ts            # 从 ~/.myhead/config.json 加载
│   └── first-run.ts       # 交互式配置引导
├── hub/
│   ├── schema.ts          # message hub JSON zod schema
│   ├── writer.ts          # HubWriter：单 writer 队列 + 临时文件 + 原子重命名
│   ├── store.ts           # hub JSON 读写
│   ├── context.ts         # context builder：完整 hubLog 组装 + token 估算
│   └── state-machine.ts   # 15 状态闭环状态机
├── planning/
│   ├── prompt.ts          # supervisor 规划提示词（默认 + 可编辑）
│   ├── plan.ts            # 实施方案生成、确认、编辑、取消
│   └── schema.ts          # 实施方案结构化 schema
├── supervisor/
│   ├── prompt.ts          # supervisor 审查提示词模板
│   ├── review.ts          # 审查引擎
│   └── schema.ts          # 结构化 review verdict schema
├── verification/
│   ├── runner.ts          # 验证命令执行器
│   └── schema.ts          # 验证结果 schema
├── model/
│   ├── client.ts          # 统一 model client 接口
│   ├── openai.ts          # OpenAI SDK 封装
│   └── claude.ts          # Anthropic SDK 封装
├── controller/
│   ├── loop.ts            # 主推进循环
│   ├── pending-queue.ts   # worker 响应入队和出队
│   └── events.ts          # 事件定义和 event sink
└── types.ts               # 共享类型
```

### 3.2 Daemon 新增

```
apps/daemon/src/
├── myhead-routes.ts       # MyHead HTTP 路由（替代 chat-routes.ts）
├── myhead-worker.ts       # Worker 管理：Codex/Claude 启动、monitor、cancel
├── myhead-prompt.ts       # Prompt 打包
├── myhead-context.ts      # Hub context snapshot 构建
└── myhead-supervisor.ts   # Supervisor 调度的 daemon 层封装
```

### 3.3 Web UI 重写

```
apps/web/src/app/
├── layout.tsx
├── page.tsx               # 主页面：planning chat + live transcript
├── chat/
│   ├── ChatPane.tsx       # 聊天面板
│   ├── PlanningView.tsx   # 规划阶段视图
│   ├── LiveTranscript.tsx # 执行直播视图
│   ├── SupervisorVerdict.tsx # 审查结论展示
│   └── DecisionPrompt.tsx # 用户决策提示
├── hub/
│   ├── HubStatus.tsx      # Hub 状态展示
│   ├── WorkerOutput.tsx   # Worker 可见文本展示
│   └── ArtifactList.tsx   # Diff/验证结果列表
├── settings/
│   ├── ConfigPage.tsx     # MyHead 模型配置
│   └── PromptEditor.tsx   # 提示词编辑器
└── history/
    ├── HistoryList.tsx    # 历史 hub 列表
    └── HubDetail.tsx      # Hub 详情查看
```

## 4. 分阶段实施

### Phase 0：工程骨架（1-2 天）

**目标**：Open Design 删干净后能 `pnpm install && pnpm tools-dev run web` 跑起来。

**步骤**：

1. 复制 open-design 目录为 myhead 工作目录，初始化 git
2. 删除所有 design-specific 目录和文件（见 2.3 删除清单）
3. 删除除 `claude.ts`、`codex.ts`、`shared.ts` 外的所有 agent def
4. 从 `runtimes/registry.ts` 中移除其他 agent 注册
5. 精简 `server.ts`：移除 `/api/skills`、`/api/design-systems`、`/api/artifacts`、`/api/media`、`/api/plugins`、`/api/automations` 等路由注册
6. 精简 `server-context.ts`：删除 design、skills、craft、critique 依赖
7. 精简 `pnpm-workspace.yaml`：只保留需要的 packages
8. 全局替换品牌名：`Open Design` → `MyHead`，`open-design` → `myhead`，`od` → `myhead`
9. 运行 `pnpm install`，修编译错误
10. 运行 `pnpm tools-dev run web`，确保空白 web app 能启动
11. 运行 `pnpm tools-dev inspect desktop status`，确保桌面壳能启动

**验收**：
- `pnpm install` 无错误
- `pnpm typecheck` 通���
- `pnpm guard` 通过
- `pnpm tools-dev run web` 能看到空白 web 页面
- 桌面壳能启动并显示空白窗口

### Phase 1：Agent Adapter 验证与适配（2-3 天）

**目标**：确认保留的 Codex 和 Claude adapter 在当前 macOS 环境中能正常工作。

**步骤**：

1. 从 `runtimes/defs/claude.ts` 中确认 Claude Code adapter 的固定路径：
   - `-p --input-format stream-json --output-format stream-json --verbose`
   - `--dangerously-skip-permissions`（等价 `--permission-mode bypassPermissions`）
   - `--resume <session-id>` / `--session-id <uuid>`
   - `--include-partial-messages`
   - prompt 注入方式：OD 通过 stdin stream-json 注入；需验证是否改用 `--append-system-prompt-file`
2. 从 `runtimes/defs/codex.ts` 中确认 Codex adapter 的固定路径：
   - `codex exec --dangerously-bypass-approvals-and-sandbox --json`
   - `--cd <worker-cwd>`
   - `--output-last-message <artifact>`
   - resume 的 flag 位置（`--cd` 和 `--dangerously-bypass-approvals-and-sandbox` 放在 `resume` 前）
3. 写 adapter capability probe：
   - 检测 CLI 是否安装及版本
   - 检测每个固定 flag 是否可用
   - 检测 session store 是否可读写
   - 检测 no-approval mode 是否生效
4. 写 adapter contract smoke test
5. 写 `myhead-worker.ts`：用固定路径启动 worker 并捕获 stdout/stderr/exit code

**验收**：
- adapter capability probe 对 Codex 和 Claude 都返回完整能力矩阵
- smoke test 能成功启动 Codex 和 Claude 并收到响应
- no-approval mode 在真实 run 中生效（无审批提示出现）
- 能力不满足时正确返回 `blocked`

### Phase 2：MyHead 配置与 CLI 骨架（2 天）

**目标**：实现 `myhead .` 入口、全局配置、workspace 绑定。

**步骤**：

1. 配置 schema（`~/.myhead/config.json`）：
   ```ts
   const MyHeadConfig = z.object({
     protocol: z.enum(['openai', 'claude']),
     apiKey: z.string(),
     baseUrl: z.string().optional(),
     model: z.string(),
     systemPromptPath: z.string().optional(),
   });
   ```
2. 首次配置引导：`myhead .` 检测 `~/.myhead/config.json` 不存在时，进入交互式配置流程
3. CLI 入口 `myhead .`：
   - 解析 `.` 为当前目录绝对路径
   - 检测 `~/.myhead/config.json` → 存在则进入规划对话，不存在则配置引导
   - 拒绝 `myhead <path>`、`myhead chat --workspace <path>` 等变体
4. Workspace 绑定：当前目录 `.myhead/` 作为本地状态根
5. `myhead config` 子命令：展示当前配置（隐藏 apiKey）
6. 保留 Open Design 的 `od` CLI 作为 `myhead`（改名）

**验收**：
- `myhead .` 在无配置时进入引导
- `myhead .` 在有配置时进入规划对话
- `myhead /path` 等错误用法给出简短错误
- `myhead config` 展示配置

### Phase 3：Message Hub 数据结构与存储（3-4 天）

**目标**：完整实现 message hub JSON 的 schema、存储和操作。

**步骤**：

1. 完整 hub JSON schema（zod）：
   - `schemaVersion`、`hubId`、`workspacePath`、`createdAt`/`updatedAt`
   - `status`（15 个状态）
   - `confirmedPlan`（文本、hash、摘要、prompt 快照）
   - `promptInjection`（每个 worker 的固定注入方式）
   - `permissionMode`（每个 worker 的 no-approval mode）
   - `selectedAgents`（`codex` | `claude` | `both`）
   - `agentSessions`（worker 原生 session id、cwd/worktree、命令元数据、版本）
   - `hubLog`（`myhead`/`codex`/`claude` 可见消息，append-only array）
   - `pendingQueue`（未审查的 worker 响应）
   - `agentCursors`（每个 worker 已看到的 hubLog offset）
   - `contextPolicy`（MVP: `{ mode: "full", version: 1 }`）
   - `contextSnapshots`（每次出站的元数据：目标 worker、hubLog offset、token 估算）
   - `turnInvocations`（每次 CLI 调用的命令元数据和 exit code）
   - `agentStatus`（每个 worker: `idle`/`running`/`blocked`/`failed`/`cancelled`/`done`）
   - `turns`（inbound message、review、reply、verification、status transition）
   - `blockedEvents`（权限请求、ask 选项、上下文超限等）
   - `artifacts`（raw log、diff、验证输出路径）
   - `finalResult`（verdict、changed files、验证证据、风险、下一步建议）
   - `resumeCheckpoint`（最后稳定 checkpoint）

2. HubWriter（`packages/myhead-core/src/hub/writer.ts`）：
   - 单 writer 队列（所有 hubLog/pendingQueue/turns/状态变更必须经过同一个 writer）
   - 原子保存：写临时文件 → `fs.rename` 原子重命名
   - 串行化保证：`writeLock`（async mutex）
   - API：`appendMessage(hubId, message)`、`updateStatus(hubId, status)`、`appendTurn(hubId, turn)` 等

3. HubStore（`packages/myhead-core/src/hub/store.ts`）：
   - `createHub(workspacePath, plan, agents)` → `<workspace>/.myhead/sessions/<hub-id>.json`
   - `loadHub(hubId)` → 完整 hub JSON
   - `listHubs(workspacePath)` → 当前 workspace 的所有 hub
   - `getHubSummary(hubId)` → 摘要（不加载完整 hubLog）

4. Context builder（`packages/myhead-core/src/hub/context.ts`）：
   - MVP 固定 `mode: "full"` —— 完整 hubLog 注入
   - `buildOutboundContext(hubId, targetAgent, task)` → worker prompt package
   - Token 估算（保守上限）：如果完整 hubLog 超过 worker 上下文，返回 null → controller 标�� `blocked`
   - 接口预留 `contextPolicy` 字段，后续可加入压缩策略

5. 状态机（`packages/myhead-core/src/hub/state-machine.ts`）：
   - 15 个状态及合法转换
   - `listening → message_queued → reviewing → verifying/replying → listening`（主循环）
   - `→ needs_user_decision | accepted | failed | blocked | cancelled`（终端状态）

**验收**：
- HubWriter 单 writer 队列能正确串行化并发写入
- 原子保存：写入过程中崩溃不产生半写文件
- hub JSON 包含所有必需字段
- Context builder 能在上下文超限时返回 null
- 状态机拒绝非法转换

### Phase 4：Supervisor Model 接入与规划对话（3-4 天）

**目标**：MyHead 可以用配置的模型与用户对话、生成实施方案。

**步骤**：

1. Model client 接口（`packages/myhead-core/src/model/client.ts`）：
   ```ts
   interface ModelClient {
     chat(messages: Message[], options?: ChatOptions): AsyncIterable<ChatDelta>;
     completeJson<T>(messages: Message[], schema: ZodSchema<T>): Promise<T>;
   }
   ```
2. OpenAI client（`packages/myhead-core/src/model/openai.ts`）：
   - 使用官方 `openai` SDK
   - 支持自定义 baseUrl
   - 流式 chat completion
   - 结构化 JSON 输出
3. Claude client（`packages/myhead-core/src/model/claude.ts`）：
   - 使用官方 `@anthropic-ai/sdk`
   - 流式 messages
   - 结构化 JSON 输出（tool_use with strict schema）
4. 统一工厂：根据 `config.protocol` 选择 client
5. 规划提示词（`packages/myhead-core/src/planning/prompt.ts`）：
   - 默认系统提示词：主动帮助用户梳理需求、约束、风险、验收标准和实施方案
   - 从 `.myhead/prompts/default.md` 加载（用户可编辑）
6. 规划对话（`apps/daemon/src/myhead-routes.ts` 中的 `POST /api/plan`）：
   - 接收用户输入
   - 调用 model client 流式生成实施方案
   - 实施方案结构化字段：目标、步骤、约束、成功标准、风险、worker 策略、验证计划
   - 生成 `plan hash`
7. 规划对话不持久化到 hub JSON
8. 实施方案确认流程：
   - 用户可 `accept`（保存到 `.myhead/runs/<run-id>/plan.md` 和 `task.json`）
   - 用户可 `edit`（修改后保存编辑版）
   - 用户可 `cancel`（不产生副作用）

**验收**：
- MyHead 可以用配置的模型（OpenAI 或 Claude 协议）流式生成回复
- 模糊需求会追问，能生成结构化实施方案
- 用户确认后的实施方案保存到 `.myhead/runs/<run-id>/`
- 规划对话不创建 hub JSON
- cancel 干净退出

### Phase 5：单 Worker 执行循环（4-5 天）

**目标**：MyHead 启动 Codex worker、接收响应、审查、回应，完成至少一轮完整循环。

**步骤**：

1. Prompt 打包（`apps/daemon/src/myhead-prompt.ts`）：
   - 组装 worker prompt package：`MYHEAD_CONFIRMED_IMPLEMENTATION_PLAN` + `plan hash` + `hubLog` + 当前步骤 + 约束 + 期望输出格式
   - 明确声明：worker 只能回复 MyHead
2. Worker 启动（`apps/daemon/src/myhead-worker.ts`）：
   - Codex 固定命令：`codex exec --cd <cwd> --dangerously-bypass-approvals-and-sandbox --json --output-last-message <artifact> -`
   - Prompt 从 stdin 传入
   - Claude 固定命令：`claude -p --verbose --output-format stream-json --dangerously-skip-permissions --session-id <uuid> <turn-prompt>`
   - 子进程 stdout/stderr 流式读取
   - 输出解析：复用 OD 的 claude-stream.ts / codex-cli.ts
3. Controller 事件流（`packages/myhead-core/src/controller/events.ts`）：
   ```ts
   type MyHeadEvent =
     | { type: "hub_message"; message: HubMessage }
     | { type: "worker_visible_text"; agent: AgentName; text: string }
     | { type: "review_started" }
     | { type: "review_completed"; verdict: ReviewVerdict }
     | { type: "verification_started"; command: string }
     | { type: "verification_completed"; exitCode: number; summary: string }
     | { type: "user_decision_required"; reason: string; options: string[] }
     | { type: "loop_closed"; status: HubStatus; summary: string }
     | { type: "myhead_status"; text: string }
   ```
4. Controller 主循环（`packages/myhead-core/src/controller/loop.ts`）：
   ```
   while (hub.status in activeStates) {
     // 1. 从 pendingQueue 取一条 worker 响应
     // 2. 追加到 hubLog
     // 3. 调用 supervisor model 审查
     // 4. 根据 verdict 决定下一步
     // 5. 每次分发前构建 contextSnapshot，注入完整 hubLog
     // 6. 每次循环后调用 HubWriter 原子保存
   }
   ```
5. PendingQueue（`packages/myhead-core/src/controller/pending-queue.ts`）：
   - Worker 响应到达时立即入队
   - Controller 串行出队审查
   - 双 worker 时支持并发入队

**验收**：
- MyHead 能启动 Codex 并收到响应
- 响应追加到 hubLog
- Controller 能完成一轮 "dispatch → receive → review → reply" 循环
- hub JSON 正确保存所有中间状态
- 状态机正确推进

### Phase 6：Supervisor Review 引擎（3-4 天）

**目标**：MyHead 使用配置的模型审查 worker 每次响应。

**步骤**：

1. Supervisor prompt template（`packages/myhead-core/src/supervisor/prompt.ts`）：
   - 输入：已确认实施方案、完整 hubLog、worker 本轮响应、changed files/diff、verification results
   - 输出：结构化 review verdict
2. Review schema（`packages/myhead-core/src/supervisor/schema.ts`）：
   ```ts
   const ReviewVerdict = z.object({
     status: z.enum([
       'accepted',    // 已完成，接受
       'continue',    // 继续下一步
       'revise',      // 要求修正
       'verify',      // 需要验证
       'needs_user_decision',
       'failed',
       'blocked',
     ]),
     summary: z.string(),
     findings: z.array(z.object({
       severity: z.enum(['info', 'warning', 'critical']),
       description: z.string(),
       file: z.string().optional(),
       line: z.number().optional(),
     })),
     missingVerification: z.array(z.string()),
     recommendedReply: z.string(),
     nextStep: z.string().optional(),
   });
   ```
3. 审查引擎（`packages/myhead-core/src/supervisor/review.ts`）：
   - 调用 model client 的 `completeJson()`
   - 比较 worker 响应的 `seenHubOffset` 和最新 hub offset
   - 如果响应基于旧快照，审查结论中标记
4. 审查结果追加到 hubLog 和 hub JSON

**验收**：
- 每次 worker 响应后能生成结构化 review
- review verdict 能正确驱动 controller 状态推进
- 切换 OpenAI/Claude 协议均能正常工作

### Phase 7：Verification 引擎（2 天）

**目标**：MyHead 能运行验证命令，把结果反馈给 supervisor。

**步骤**：

1. 验证命令配置
2. 验证命令执行器（`packages/myhead-core/src/verification/runner.ts`）：
   - 在 workspace 目录下运行命令
   - 捕获 exit code + stdout/stderr
   - 超时保护
3. 验证触发：
   - 自动触发（supervisor verdict 为 `verify`）
   - 用户手动触发
4. 验证结果 schema：
   ```ts
   const VerificationResult = z.object({
     command: z.string(),
     exitCode: z.number().nullable(),
     stdout: z.string(),
     stderr: z.string(),
     summary: z.string(),
     passed: z.boolean(),
   });
   ```
5. 验证结果追加到 hubLog 和 hub JSON

**验收**：
- 能运行 test/build/lint/typecheck
- 验证失败后 supervisor 能要求 worker 修正

### Phase 8：双 Worker Compare（3-4 天）

**目标**：Codex 和 Claude 同时执行同一计划，共享 message hub。

**步骤**：

1. 工作区隔离（默认 compare 模式）：
   - git repo：`git worktree add` 创建隔离 worktree
   - 非 git repo：递归复制到临时目录
   - 无法隔离时 `blocked`
2. 双 worker 启动：
   - 同一份 plan + hubLog 分别发给 Codex 和 Claude
   - 各自在隔离 cwd 中启动
   - 各自维护独立的 agent cursor
3. 共享 message hub：
   - 所有消息写入同一个 hubLog
   - 所有 hub message 对两方可见（通过下一轮 contextSnapshot）
   - Codex 和 Claude 只能回复 MyHead，不能互相直连
4. Supervisor compare review：
   - 比较两个 worker 的输出质量、diff 风险、验证证据、可维护性
   - 推荐一个结果，或生成融合建议
5. Cooperate 模式（MVP 后置）：
   - 同一工作树串行化写入型 turn
   - `writeLock` 保证单写者

**验收**：
- 两个 worker 同时运行不互相覆盖
- Codex 和 Claude 都能看到完整 hubLog
- MyHead 能处理一个 worker 先返回、另一个仍在运行的情况
- 比较结论包含推荐和理由

### Phase 9：Web UI 改造（5-6 天）

**目标**：Web UI 支持 MyHead 的规划对话和执行直播。

**步骤**：

1. 重写主页面（替代 Open Design 的 Studio View）：
   - 左侧：对话区（PlanningView / LiveTranscript 切换）
   - 右侧：Hub 状态面板（HubStatus、WorkerOutput、ArtifactList）
   - 顶部：workspace 路径、hub id、状态指示器
2. PlanningView：
   - 流式显示 MyHead 的规划回复
   - 实施方案展示（可折叠的步骤列表）
   - 确认/编辑/取消按钮
   - Worker 选择器（codex/claude/both）
3. LiveTranscript：
   - 实时消息流（hub_message、worker_visible_text、review_*、verification_*）
   - 消息按角色着色（MyHead、Codex、Claude）
   - raw output 默认折叠，点击展开
   - 自动滚动到最新消息
4. SupervisorVerdict：
   - 审查状态标签
   - findings 列表（按 severity 分级）
   - 下一步预览
5. DecisionPrompt：
   - 需要用户决策时高亮显示
   - 选项按钮
6. 历史视图（HistoryList / HubDetail）
7. 设置页面（ConfigPage / PromptEditor）

**验收**：
- 完整规划→确认→执行→查看历史的 UI 流程
- 流式消息实时显示
- 审查和验证结果清晰可读

### Phase 10：桌面壳品牌化与发布（2-3 天）

**目标**：桌面壳更名为 MyHead，可构建和分发。

**步骤**：

1. 品牌替换：
   - App 名称：`Open Design` → `MyHead`
   - Bundle ID：从 open-design 改为 myhead
   - 图标、启动屏
   - 窗口标题
2. 桌面壳与 daemon 通信：
   - Sidecar IPC 路径从 `open-design` 改为 `myhead`
   - Web URL 自动发现
3. 构建配置调整：
   - `tools-pack mac build --to all` → MyHead.app
   - `tools-pack win build --to nsis` → MyHead Setup.exe
4. Auto-update：更新 URL 和 channel 配置
5. 基本 smoke test

**验收**：
- MyHead.app 在 macOS 上能启动
- Web UI 加载正确
- 窗口标题和图标是 MyHead 的

## 5. 关键风险与缓解

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| Open Design daemon 对 design 模块的隐式耦合比预期深 | 中 | 高 | Phase 0 立即验证——先删后跑，卡住就具体分析耦合点 |
| Claude Code `--append-system-prompt-file` 在当前版本不可用 | 中 | 中 | 先用 OD 已证明可靠的 stdin stream-json 路径；在 capability facts 中记录 |
| 完整 hubLog 超出 worker 上下文 | 高 | 中 | MVP 固定 `blocked`，不裁剪。实施时做保守 token 估算 |
| 双 worker 并行时 hub JSON 写入竞争 | 中 | 高 | HubWriter 的原子写入是 Phase 3 第一验收标准 |
| Web UI 改造工作量比预期大 | 中 | 中 | OD web 框架层不动，只改页面内容 |
| pnpm workspace 依赖树清理后出现隐式缺失 | 低 | 中 | Phase 0 的 `pnpm install && pnpm typecheck` 是硬门 |

## 6. 与原 MVP 切片映射

| 原 Slice | 描述 | 在新计划中的位置 |
|----------|------|-----------------|
| Slice 1 | First-Run Config and CLI Skeleton | Phase 2 |
| Slice 1.5 | Message Hub JSON History | Phase 3 |
| Slice 2 | Workspace Chat and Implementation Plan | Phase 4 |
| Slice 3 | Codex Conversation Run | Phase 5 |
| Slice 4 | Claude Conversation Run | Phase 5（同结构） |
| Slice 5 | Fixed Worker No-Approval Mode | Phase 1（capability probe 内验证） |
| Slice 6 | Git Diff and Final-Result Artifacts | Phase 5（worker run 结果捕获） |
| Slice 7 | Verification Commands | Phase 7 |
| Slice 8 | Supervisor Review | Phase 6 |
| Slice 9 | Implementation Push Loop | Phase 5（controller loop） |
| Slice 10 | Compare Codex and Claude | Phase 8 |
| Slice 11 | Streaming Terminal UX | Phase 9（Web UI LiveTranscript） |

## 7. 总时间估算

| Phase | 描述 | 预估 |
|-------|------|------|
| Phase 0 | 工程骨架（删 design + 跑通） | 1-2 天 |
| Phase 1 | Agent Adapter 验证与适配 | 2-3 天 |
| Phase 2 | MyHead 配置与 CLI 骨架 | 2 天 |
| Phase 3 | Message Hub 数据结构与存储 | 3-4 天 |
| Phase 4 | Supervisor Model 接入与规划对话 | 3-4 天 |
| Phase 5 | 单 Worker 执行循环 | 4-5 天 |
| Phase 6 | Supervisor Review 引擎 | 3-4 天 |
| Phase 7 | Verification 引擎 | 2 天 |
| Phase 8 | 双 Worker Compare | 3-4 天 |
| Phase 9 | Web UI 改造 | 5-6 天 |
| Phase 10 | 桌面壳品牌化与发布 | 2-3 天 |
| **总计** | | **30-39 天** |

## 8. 产品原则对齐

| 原则 | 本计划如何遵守 |
|------|---------------|
| 简单好用是最高优先级 | Web UI + 桌面壳，用户不需要理解终端 REPL 语义 |
| MVP 只支持 `myhead .` | 桌面壳作为 UI，CLI 作为启动入口 |
| worker 执行噪声默认隐藏 | Web UI 中 raw output 折叠，只展示 visible text |
| worker no-approval mode | Phase 1 的 capability probe 直接验证 |
| 不配置 worker CLI | 只读 OD 的 agent detection，不写 worker 配置 |
| 固定路径，不备用 | Phase 1 确认。不可用就 blocked |
| 官方 SDK | Phase 4 model client 封装 |
| macOS 本机 | Phase 1 只测 macOS；桌面壳 macOS 优先 |
| workspace 绑定 `.myhead/` | Phase 2 |
| 规划对话不持久化 | Phase 4 |
| 完整 hubLog 注入 | Phase 3 context builder，超限 blocked |
| HubWriter 原子写入 | Phase 3 第一验收标准 |

## 9. 开放问题

1. **Claude prompt 注入路径**：OD 当前用 stdin stream-json 给 Claude 注入 prompt，而非 `--append-system-prompt-file`。PRD 要求 `--append-system-prompt-file`，但 OD 的 stdin 路径已在 22 个 agent 上战验证。是否先用 stdin 路径，把 `--append-system-prompt-file` 作为后续改进？

2. **Web UI vs TUI**：本计划用 Web UI + 桌面壳，而非纯终端 TUI。之前的 UX 合同写的是终端 REPL。是否接受这个差异？是否需要额外做一个轻量 CLI transcript view？

3. **SQLite vs 文件 JSON**：OD 使用 better-sqlite3 做 session 存储。MyHead 的 hub JSON 是文件型。是否完全不需要 SQLite（删掉依赖），还是保留给 agent session 管理？

4. **Node.js vs Bun**：OD 要求 Node 24 + pnpm 10.33。当前 `myhead/` 目录已经是 Bun + turbo。是否统一到 OD 的 pnpm 工具链？还是保持 Bun？

5. **桌面壳时序**：可以在 Phase 5 单 worker 完成后先验证闭环，Phase 9-10 再上桌面壳。也可以 Phase 0 就把桌面壳留好，边做边测。建议哪种？
