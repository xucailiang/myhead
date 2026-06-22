# MyHead Terminal Conversation Choreography

日期：2026-06-18

本文补充 `Terminal-streaming-ux-contract-claude-code-style-2026-06-18.md`，专门定义“用户如何自然地和 MyHead 对话，然后旁观 MyHead 与 Codex / Claude Code CLI 对话”的交互编排。

UI/UX 基线：MyHead 应尽量复用 MiMo-Code 的 TUI 样式、主题系统、prompt 组件、dialog/status/footer/sidebar 模式和键盘交互。MyHead 的新增体验是“监督编排层”，不是一套新的终端视觉系统。

## 1. 核心反思

现有 docs 已经明确了 message hub、流式事件和 `myhead .` 唯一入口，但还不够细的是：

- 用户什么时候是在“和 MyHead 说话”，什么时候是在“旁观执行”。
- 用户确认计划后，终端如何从 planning mode 自然切到 live transcript。
- MyHead、Codex、Claude、review、verification 的发言如何区分而不吵。
- 执行期间用户输入如何处理，避免普通补充被误判成新任务。
- worker 运行很久、失败、需要用户决策或被 Ctrl+C 打断时，怎么保持连续关系。

产品体验目标不是“打印更多日志”，而是让用户感觉 MyHead 一直在场：先帮他想清楚，再替他指挥 worker，并把关键过程直播给他看。

## 2. 对话角色

终端上始终只有一个主关系：用户和 MyHead。

Codex / Claude 是被 MyHead 请进 message hub 的 worker。用户可以看见 worker 的可见回复，但默认不直接和 worker 对话。用户的普通输入仍先交给 MyHead，由 MyHead 判断它是规划补充、执行确认、用户决策、取消指令，还是无效输入。

| 角色 | 终端身份 | 是否直接接收用户普通输入 |
| --- | --- | --- |
| User | `>` prompt 后输入；transcript 中不额外加用户前缀 | 是 |
| MyHead | `MyHead:` / `MyHead -> codex:` / `MyHead -> claude:` | 是，作为唯一对话锚点 |
| Codex | `codex:` visible text | 否 |
| Claude | `claude:` visible text | 否 |
| Supervisor review | `MyHead: review ...` | 否 |
| Verification | `MyHead: verify ...` | 否 |

## 3. 顶层状态机

```text
boot
  -> first_run_config?
  -> planning_chat
  -> plan_ready
  -> execution_starting
  -> live_transcript
  -> needs_user_decision?
  -> live_transcript
  -> loop_closed
  -> planning_chat
```

### boot

用户运行：

```text
cd <workspace>
myhead .
```

终端进入同一个 REPL。这里不应该展示大段介绍，只做必要状态确认：

```text
MyHead: workspace /repo/name
>
```

### planning_chat

用户普通输入都视为“继续和 MyHead 梳理需求”。MyHead 可以流式回应、追问、总结、提出风险。

要求：

- 不创建 execution hub。
- 不显示 Codex / Claude。
- 不要求用户选择 worker。
- MyHead 需要表现得像一个正在帮用户想清楚的工程伙伴，而不是表单向导。

### plan_ready

MyHead 生成实施方案后，不立即启动 worker。终端仍留在 `>` prompt，但输入语义变成“确认、编辑、取消、补充”。

示例：

```text
MyHead: plan ready

目标: ...
步骤:
1. ...
2. ...
验证: ...
风险: ...

Choose worker: codex / claude / both
Or continue editing the plan.
>
```

用户输入规则：

- `codex`：确认当前计划并用 Codex 执行。
- `claude`：确认当前计划并用 Claude 执行。
- `both`：确认当前计划并 compare。
- `edit ...` 或普通补充：继续修改计划，不启动 worker。
- `cancel`：取消，不创建 hub。

### execution_starting

用户选择 worker 后，MyHead 进入短暂切换段。这个切换必须让用户明确知道：从现在开始你主要是在旁观 MyHead 指挥 worker。

示例：

```text
MyHead: confirmed plan saved: run_01HX...
MyHead: hub created: hub_01HX...
MyHead: live transcript started
MyHead -> codex: dispatching step 1/3
```

要求：

- 自动创建 hub。
- 自动开始 live transcript。
- 不要求用户输入 hub id。
- 不退出当前终端。

### live_transcript

这是默认执行观察态。用户主要旁观，终端持续显示可见 hub 消息。

可见信息优先级：

1. MyHead 正在做什么。
2. MyHead 发给 worker 的短摘要。
3. worker 的 assistant visible text delta。
4. review verdict 和下一步。
5. verification command 和结果。
6. loop closed summary。

默认隐藏：

- raw stdout / stderr。
- tool result dump。
- thinking。
- 完整 prompt package。
- 大段 diff。
- debug artifact。

### needs_user_decision

只有 MyHead 明确进入该状态时，用户普通输入才被当作执行决策写入 hub。

示例：

```text
MyHead: decision needed
Reason: tests pass, but the worker changed public API naming.
Options:
1. accept the rename
2. ask codex to preserve the old API
3. stop here
>
```

用户输入后：

- 输入写入 hubLog，role = `user`，visibility = `hub`。
- MyHead 生成下一步回应。
- 重新进入 `live_transcript`。

### loop_closed

结束时要把控制权还给用户，而不是像脚本一样退出。

示例：

```text
MyHead: loop closed: accepted
Changed: 3 files
Verification: npm test passed
Risk: low, no public API change
Hub: hub_01HX...

>
```

## 4. 用户输入语义

| 当前状态 | 普通文本含义 | 特殊输入 |
| --- | --- | --- |
| planning_chat | 对需求的补充或澄清 | `plan`、`cancel`、`/history` |
| plan_ready | 默认继续改计划；明确 worker 名才执行 | `codex`、`claude`、`both`、`cancel` |
| execution_starting | 不建议接受普通输入；可缓冲或提示稍等 | Ctrl+C |
| live_transcript | 默认不是新任务；提示用户执行中 | `/pause`、`/status`、`/logs`、Ctrl+C |
| needs_user_decision | 用户决策，写入 hub | `1`、`2`、`3`、自然语言决策 |
| loop_closed | 新一轮 planning_chat 输入 | `/show <hub-id>`、`/history` |

用户消息展示规则：

- 交互输入只通过 `>` prompt 表示，不再额外渲染 `User:`、`user:`、`myhead>` 或类似用户前缀。
- planning 阶段用户的原始输入默认不持久化；执行期只有 `needs_user_decision` 下的用户决策会写入 hubLog。
- 写入 hubLog 的用户决策在回放时可以显示为无前缀正文，或用淡化 metadata 标明来源；默认 live transcript 不需要用户前缀。

执行期间如果用户直接输入一段新需求，MyHead 不应默默派给 worker。应温和确认：

```text
MyHead: current run is still active. I can queue this as a note, pause the run, or ignore it.
>
```

MVP 可以先只支持：

- `/status`
- `/logs`
- `/show <hub-id>`
- `/history`
- Ctrl+C

## 5. 发言格式

### MyHead 状态

```text
MyHead: reviewing codex response...
MyHead: verification passed: bun test
MyHead: loop closed: accepted
```

### MyHead 发给 worker

只显示摘要，不显示完整 prompt。

```text
MyHead -> codex: implement step 2/4, preserve existing CLI behavior
MyHead -> claude: review codex diff against the confirmed plan
```

### worker 可见回复

worker 文本应边到边显示，不能等进程结束。

```text
codex: I found the CLI parser in packages/runtime/src/cli...
codex: I am adding a guard for non-dot workspace arguments...
```

### review

```text
MyHead: review completed: continue
Reason: implementation matches step 1, but tests have not run yet.
```

### verification

```text
MyHead: verify: bun test packages/myhead-core
MyHead: verify passed
```

## 6. MiMo TUI 复用原则

MyHead 的终端 UI 优先复用 MiMo-Code 已有的 TUI 基础：

- theme provider 和默认 `mimocode` theme。
- plain terminal theme 的透明背景策略。
- prompt 输入组件和历史 / autocomplete / keybinding 行为。
- dialog、status、footer、sidebar、spinner、border 等组件。
- message delta 渲染、markdown / code / diff 渲染能力。
- permission、status、session list 等已有信息面板的布局语言。

MyHead 允许新增的 UI 只围绕监督层语义：

- planning state。
- plan ready / execution gate。
- hub live transcript。
- supervisor review。
- verification。
- decision needed。
- loop closed summary。

新增 UI 的规则：

- 颜色、边框、muted text、success / warning / error 全部走 MiMo theme token，不硬编码另一套 palette。
- 不新增和 MiMo prompt 冲突的输入前缀；用户输入仍只用 `>`。
- MyHead 状态行要像 MiMo 的 status surface 一样短、可扫读。
- worker visible text 复用现有 message rendering；只新增 agent label 和 visibility 策略。
- review / verification 优先作为轻量状态块，不做新的 dashboard。
- 如果 MiMo 已有组件能表达，不新写组件。

## 7. 自然流畅的关键细节

### 7.1 不要让用户感到“模式丢失”

每次状态转换都要用一句短状态确认：

- `plan ready`
- `hub created`
- `live transcript started`
- `decision needed`
- `loop closed`

这些句子像路标，避免用户猜当前终端在干什么。

### 7.2 不要把 worker 伪装成 MyHead

worker 的 visible text 可以展示，但必须带 `codex:` / `claude:` 前缀。MyHead 的判断、风险和最终结论必须由 `MyHead:` 发出。

### 7.3 不要把 live transcript 做成日志洪水

用户旁观的是“可理解执行过程”，不是 stdout。raw 内容进入 artifact 和 debug view。

### 7.4 不要过度打断

MyHead 只在这些情况下请求用户输入：

- 计划需要确认。
- 执行超出计划或出现产品决策。
- 风险不能由 worker 或验证自动解决。
- 用户按 Ctrl+C。

### 7.5 旁观不等于失控

即使用户主要旁观，也必须随时知道：

- 当前谁在工作。
- 工作到计划第几步。
- 是否有验证证据。
- MyHead 是否接受 worker 结果。
- 如何停止或查看历史。

## 8. 双 worker compare 的旁观体验

双 worker 时不能把输出交错成难读的混响。默认策略：

- Codex 和 Claude 的 visible text 都进入 hub。
- 终端以事件到达顺序显示，但每条必须有清晰 agent 前缀。
- MyHead 定期输出短状态，说明当前 compare 进度。
- 同一工作树写入必须串行；隔离 worktree 的输出可以并行显示。

示例：

```text
MyHead -> codex: implement the confirmed plan in worktree codex
MyHead -> claude: implement the confirmed plan in worktree claude
codex: I found the parser...
claude: I found the entry point...
MyHead: codex finished, waiting for claude...
MyHead: compare review started
MyHead: recommendation: codex, smaller diff and tests pass
```

MVP 如果无法让并行输出足够清晰，应先做单 worker，把 compare 后置。自然流畅优先于功能堆叠。

## 9. 验收脚本

人工验收时必须观察这些体验点：

1. 用户输入模糊任务时，MyHead 先对话而不是立刻派 worker。
2. MyHead 生成计划后，用户能自然继续补充，而不会误触执行。
3. 用户输入 `codex` 后，终端自动显示 `hub created` 和 `live transcript started`。
4. worker 文本在进程结束前逐段出现。
5. 用户输入只有 `>` prompt，不再出现额外用户前缀。
6. MyHead 和 worker 的发言前缀清晰，不混淆身份。
7. 执行中用户普通输入不会被误派给 worker。
8. MyHead 需要决策时能把用户拉回对话。
9. 结束后回到 `>` prompt，用户能继续下一轮任务。
10. 新增 MyHead 状态、review、verification、decision UI 能复用 MiMo theme token 和组件语言，不像另一套 CLI。

## 10. 对当前实施计划的修正建议

`MiMo-runtime-fork-implementation-plan-2026-06-18.md` 应增加一个早期阶段或验收门：

- 在接真实 Codex / Claude 前，先用 fake worker 做完整交互 choreography。
- fake worker 必须模拟慢速 token delta、长时间无输出、permission ask、verification fail、needs_user_decision 和 Ctrl+C。
- 只有 fake choreography 通过后，再接 MiMo runtime / Codex / Claude。

否则容易出现 runtime 能跑，但产品体验像“日志脚本”的问题。
