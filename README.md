# MyHead

AI 编程 supervisor。Plans → confirms → dispatches workers → reviews → iterates → closes。

## 前置条件

- Node.js >= 20
- pnpm >= 10.33（`corepack enable && corepack prepare pnpm@10.33.2 --activate`）
- Claude Code CLI（`claude`）和/或 Codex CLI（`codex`）已安装

## 安装

```bash
cd myhead
pnpm install
pnpm -r build
```

## 配置

推荐在 Web UI 中配置。启动 `myhead .` 后打开页面，点击左上角 "Config"，填写 MyHead 自己使用的 supervisor 模型配置：

- protocol：`openai` 或 `claude`
- API key
- base URL
- model

保存后会写入 `~/.myhead/config.json`。这个配置只用于 MyHead 自己的规划、审查和验证判断，不会修改 Codex CLI / Claude Code CLI 的账号、模型或配置。

也可以手动创建 `~/.myhead/config.json`：


```json
{
  "protocol": "openai",
  "apiKey": "sk-your-key-here",
  "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
  "model": "qwen3.6-plus"
}
```

字段说明：
- `protocol` — `"openai"` 或 `"claude"`，选 Supervisor 模型协议
- `apiKey` — API 密钥
- `baseUrl` — API 地址（OpenAI 兼容），不填默认 `https://api.openai.com/v1`
- `model` — 模型名

验证配置：

```bash
curl -s http://127.0.0.1:17573/api/config
# {"configured":true,"protocol":"openai","model":"qwen3.6-plus"}
```

## 启动

用户入口是在目标工作区运行：

```bash
cd /path/to/your/workspace
myhead .
```

`myhead .` 会绑定当前目录为 workspace，启动本机 daemon，并打开内置 Web UI。首次打开后，左上角会自动选中当前 workspace。

源码开发时也可以直接启动 daemon。未传 workspace 时，页面会显示空 workspace 列表，需要手动选择；如需模拟正式入口，可设置 `MYHEAD_WORKSPACE`：

```bash
cd myhead
MYHEAD_WORKSPACE=/path/to/your/workspace pnpm --filter @myhead/daemon dev
```

如果要单独调前端开发服务器，可以再开一个终端：

**终端 1 — daemon（后端）：**

```bash
cd myhead
MYHEAD_WORKSPACE=/path/to/your/workspace pnpm --filter @myhead/daemon dev
```

输出 `MyHead daemon running at http://127.0.0.1:17573` 即启动成功。

**终端 2 — Web UI（前端）：**

```bash
cd myhead
pnpm --filter @myhead/web dev
```

输出 `Local: http://localhost:5173/` 后在浏览器打开这个地址。

Vite 自动把 `/api/*` 代理到 daemon 的 `127.0.0.1:17573`，前端无需额外配置。

Web UI 界面：
- 左栏：聊天面板，规划对话 + 执行直播
- 右栏：Hub 状态面板，Worker 输出 + Review 结论
- 规划阶段输入需求 → MyHead 回复 → 点击 "Confirm Plan & Start" 进入执行阶段

## 纯 CLI 手动测试（不用前端）

### 1. 检查 agent 可用

```bash
curl -s http://127.0.0.1:17573/api/agents | python3 -m json.tool
```

输出：
```json
{
  "agents": [
    {
      "id": "claude",
      "name": "Claude Code",
      "version": "2.1.153 (Claude Code)",
      "path": "/opt/homebrew/bin/claude",
      "capabilities": { "partialMessages": true, "addDir": true }
    },
    {
      "id": "codex",
      "name": "Codex CLI",
      "version": "codex-cli 0.140.0",
      "path": "/Users/justin/.local/bin/codex",
      "capabilities": { "stdinDash": true }
    }
  ]
}
```

### 2. 规划对话（流式 SSE）

```bash
curl -s -N -X POST http://127.0.0.1:17573/api/plan \
  -H 'Content-Type: application/json' \
  -d '{"message":"Create a hello.js file that prints Hello MyHead. Single file, Node.js."}'
```

输出（SSE 流）：
```
data: {"type":"text_delta","content":"I will help you create..."}
data: [DONE]
```

### 3. 创建 Hub（提交 plan，启动 supervisor 循环）

```bash
curl -s -X POST http://127.0.0.1:17573/api/hub \
  -H 'Content-Type: application/json' \
  -d '{
    "planText": "Create hello.js that prints Hello MyHead using console.log. Single file, Node.js.",
    "workerStrategy": "codex"
  }'
```

输出：
```json
{"hubId":"xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"}
```

记下 `hubId`，后续都用这个。

### 4. 查看 Hub 状态

```bash
HUB_ID="你的hubId"
curl -s http://127.0.0.1:17573/api/hub/$HUB_ID | python3 -m json.tool
```

### 5. 连接 SSE 事件流（另一个终端）

```bash
HUB_ID="你的hubId"
curl -s -N http://127.0.0.1:17573/api/hub/$HUB_ID/events
```

连接后立即收到 snapshot（当前状态 + 历史消息），之后实时接收事件：
```
data: {"type":"hub_status","status":"listening"}
data: {"type":"hub_message","role":"user","content":"...",...}
data: {"type":"hub_status","status":"message_queued"}
data: {"type":"hub_status","status":"reviewing"}
data: {"type":"review_started"}
data: {"type":"review_completed","verdict":{...}}
data: {"type":"hub_status","status":"continue"}
data: {"type":"worker_dispatch","agent":"codex","stepId":"next"}
data: {"type":"hub_message","role":"codex","content":"..."}
```

### 6. 推送用户消息（触发 supervisor）

```bash
HUB_ID="你的hubId"
curl -s -X POST http://127.0.0.1:17573/api/hub/$HUB_ID/message \
  -H 'Content-Type: application/json' \
  -d '{"content":"Execute the plan"}'
```

推送后，SSE 流会依次收到：
1. `hub_status: message_queued` — 消息入队
2. `hub_status: reviewing` — supervisor 开始审查
3. `review_started` — 调用 LLM
4. `review_completed` — 拿到 verdict
5. 根据 verdict：
   - `continue` → `worker_dispatch` → agent 实际执行 → agent 输出 → 回到 `reviewing`
   - `verify` → 运行验证命令
   - `accepted` / `failed` / `blocked` → 终止

### 7. 列出所有 Hub

```bash
curl -s http://127.0.0.1:17573/api/hubs | python3 -m json.tool
```

## Event 类型

| type | 说明 |
|------|------|
| `hub_status` | Hub 状态变更（listening/message_queued/reviewing/verifying/continue/revise/accepted/failed/blocked/cancelled） |
| `hub_message` | 消息（user/myhead/claude/codex），包含 role/content/timestamp |
| `review_started` | Supervisor 开始审查 |
| `review_completed` | 审查完成，包含 verdict（status/summary/findings/missingVerification/recommendedReply） |
| `worker_dispatch` | 派发 worker，包含 agent/stepId |
| `error` | 错误，包含 message/code |

## Hub JSON 存储

Hub 数据存储在 `<workspace>/.myhead/sessions/<hubId>.json`。每次事件发生后原子写入（临时文件 + fs.rename）。

## 项目结构

```
myhead/
├── packages/
│   ├── agent-runtime/     # Agent CLI adapter（从 Open Design 提取）
│   ├── myhead-core/       # 业务核心（hub/supervisor/controller/model）
│   └── contracts/         # HTTP DTO 类型
├── apps/
│   ├── daemon/            # Express HTTP/SSE 服务
│   └── web/               # Vite + React 前端
└── docs/                  # 设计文档
```
