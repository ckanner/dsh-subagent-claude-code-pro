# dsh-subagent-claude-code-pro

**0.4.0：**新增公开、带类型的
[`/machine` API](docs/machine-api.zh.md)，供调度器使用显式会话身份、实际配置
证据、逐次用量与进程组清理回执，以及[持久化检查点与只读恢复](docs/machine-lifecycle.zh.md)。
不会虚构 Claude prompt 发送前的配置握手。0.4.0 已发布到 npm；下文的桌面版本及
真实账号验收记录对应 0.3.1。

[English](README.md) | 中文

DeepSeek Harness 的 Claude Code 委派插件：从 **0.6.0** 起，普通委派通过官方
**`@anthropic-ai/claude-agent-sdk@0.3.326`** 调用配置指定的本地 `claude`
可执行文件，同时补上官方 `@deepseek-ai/dsh-subagent-claude-code` 无法表达的能力：

- 每次调用可选 **model 与思考等级**（`--model`、`--effort`）；
- **可复用的 Claude Code Session**（`--session-id` / `--resume`，或每个 DSH
  Agent 会话固定一个 session 自动续接）；
- 调用只能收窄、不能放大配置的权限模式；
- 单次委派的 deadline、调用方取消、进程组清理；
- 诊断日志 `~/.dsh/claude-code-pro.log`（插件没有会话可读的日志面）。

0.6.0 迁移为源码候选；精确 SDK／原生版本、独立审查及真实历史验证见
[SDK 验证记录（英文）](docs/sdk-migration-validation.md)。

> **状态**：`0.3.1` 是首个完成真实环境全量验证的版本：文本、图片/PDF 输入、
> 图片输出、`output_schema`、后台任务、Session（含 fork）均已用本地 `claude`
> CLI 与真实 DSH 会话跑通。证据见
> [docs/live-verification.zh.md](docs/live-verification.zh.md) 与 `CHANGELOG.md`。

## 桌面插件与原生能力

插件把原生 Agent／Workflow／Advisor 同时接到了**自己的配置页、PTC 工具和独立 machine API**。在插件页打开 Claude Code Pro 配置行，可编辑实时 `native` 默认值；普通调用省略该参数时继承默认值，对象按整体替换，`native:null` 明确全部关闭。插件也未设默认值时，既有调用保持原 CLI 行为。

从插件 0.5.1 起，原生 Agent 定义可为每个子级分别请求 `model` 和 `effort`；详见[子 Agent 推理等级与 CLI 优先级](docs/native-capabilities.zh.md#子-agent-推理等级)。

从 0.5.2 起，长查询会传递主/子会话的有界真实活动，包括 thinking 和工具工作；发送 prompt 前检查 CLI 必需 flags，并为新的 persistent machine 会话设置可读名称。详见[活动、兼容性和命名](docs/machine-api.zh.md#真实活动与-cli-兼容性052)。

单独的 `subagent_claude_code_native_job` PTC 工具提供显式 Review／交互 Team、恢复和控制。Review 每次要求 `consent:true`；普通 native 开关不会自动创建独立作业。完整原生工具保持可用，并发配置仍如实报告 `resourceBounds.hard=false`。详见[中文完整契约、PTC 示例与验证范围](docs/native-capabilities.zh.md)（[English](docs/native-capabilities.md)）。

## 为什么要这个插件

官方 provider 是刻意的一次性 SDK 适配器：

- 每次新建 SDK query，且 `persistSession: false`；
- 拒绝文本以外的 prompt 内容块；
- 它的工具行不能暴露 `model` / `reasoning_effort`（`NO_START_CAPABILITIES`，无
  `agentOptions`）；
- DSH 的 subagent seam 把外部执行的子级定义为一次性，本身就不接受后续消息或
  resume。

本插件自己注册模型工具（与 Codex Pro / LCU 相同的
`agent/created → agent.ctx.tools.register` 路径）。普通调用使用 SDK 的 `query()`
与控制协议，由 SDK 在既有受监督进程组内启动指定的本地程序；插件继续维护会话
身份、真实活动、终态验证和物理清理。原生 Review 与交互式 Team 保留各自的专用
CLI 入口。

### 程序、配置与认证

`command` 保持权威，默认 `claude`，也可配置绝对路径。本地命令缺失或不兼容时，
不会静默改用 SDK 自带程序。安装 SDK 时可能同时安装其可选平台程序包，但实际
运行程序仍由显式配置决定。

`HOME`、`CLAUDE_CONFIG_DIR` 与 `settingSources` 保持原有语义，由原生程序解析
认证；插件不读取或复制登录凭据。本地登录态是否可用属于程序和环境的技术行为，
不表示所有订阅都已获准用于第三方集成。Anthropic 的
[Agent SDK 官方文档](https://code.claude.com/docs/en/agent-sdk/overview)要求第三方
产品使用 API 认证，另行获准提供 claude.ai 登录或额度的情况除外。通过 `env`
（machine API 使用 `credentialEnv`）显式配置获准使用的凭据；环境中凭据形状
变量仍默认过滤。安装 SDK 本身不会完成认证或切换账号。

## 安装

从 npm registry 安装（不需要本地 checkout、不使用 `link:`）：

```sh
dsh plugin --profile <profile> add dsh-subagent-claude-code-pro
```

Desktop 应用的托管 profile 用应用内的**插件**页 →「添加插件」→ 输入包名
`dsh-subagent-claude-code-pro` 安装；插件管理器执行同一个 pnpm 安装操作。安装后
profile 的依赖记录是版本号（例如 `0.3.1`），不是本地路径。

bundle 会插入一条 root row，并在 `presets` 列出的 preset 会话里注册
`subagent_claude_code` 工具。工具名与官方一致，因此这个 per-Agent 注册会遮蔽官方
全局工具；同一作用域不要再挂同名工具行。

## 使用

```js
subagent_claude_code({
  description: "修重定向循环",
  prompt: "……完整任务；它看不到本对话……",
  model: "sonnet",              // 别名或完整 id；省略用配置/原生默认
  reasoning_effort: "high",     // low | medium | high | xhigh | max
  permission_mode: "acceptEdits",
  session_mode: "persistent",
  session_id: "…uuid…",         // 续接上一次结果里报告的 session
  fork_session: false,
  images: ["/abs/shot.png"],    // 作为图片交给 Claude，而不是让它自己打开
  documents: ["/abs/spec.pdf"], // 作为文档交给 Claude
  output_schema: { … },         // 最终答案必须是符合该 schema 的 JSON
  run_in_background: false,     // 立即返回 DSH job id
  cwd: "/abs/path",
  timeout_ms: 600000,
})
```

成功的文本结果末尾会带一个 marker，供后续显式续接：

```
[claude-code session 3b5585e1-… · persistent · pass it as session_id to continue]
```

### Session 生命周期

| `sessionMode` | 行为 |
|---|---|
| `session`（默认） | 每个 DSH Agent 会话一个持久 Claude Code session，后续委派自动续接；适合顺序工作、缓存最好 |
| `persistent` | 每次调用新建持久 session，结果报告 id，可显式续接；独立任务不共享上下文 |
| `ephemeral` | `--no-session-persistence`：不写入任何可恢复内容 |

规则：显式 `session_id` 永远续接该 session（续接失败报错，绝不悄悄换）；记忆中的
session 只在创建它的 cwd 中、有效 native／模型／权限配置一致且没有其他委派占用时复用；记忆 session 不存在时自动
新建并记录原因；`fork_session: true` 分支出新 session。

历史持久化不代表会自动进入 Claude 的会话选择器或 Desktop 侧栏。Claude 会把
print／SDK 会话排除在普通选择器之外；应使用结果中的 UUID 执行
`claude --resume <session-id>`。已结束的会话也可以显式交给支持此能力的 Claude
Desktop 打开。具体命令、配置目录要求和接管规则见
[原生 CLI 与 Desktop 历史](docs/machine-api.zh.md#原生-cli-与-desktop-历史)。
从 0.5.3 起，若转发的 `CLAUDE_CODE_SKIP_PROMPT_HISTORY` 启用了历史禁用，persistent
请求会在 CLI 派发前失败。需要取消该设置或显式选择 ephemeral；插件保留用户的偏好。

### 多模态输入

`images` 传绝对路径（PNG/JPEG/GIF/WebP），`documents` 传 PDF 路径。所有附件在
spawn 之前校验——不存在或超限会让调用失败，而不是起一个缺少文件的委派；随后
编码成 Anthropic Messages API 的 `image` / `document` content block 放进
stream-json 用户消息，Claude 原生接收，不需要自己打开文件。其它文件类型继续可以
在 prompt 里写路径，让 Claude Code 用它自己的 Read 工具读取。

### 图片输出

Claude Code 工具读图/截图产生的 base64 图片会进入 DSH attachment store，并作为
image block 与答案一起返回给父模型，所以接受图片输入的父模型能直接看到它们。这里
的任何失败都不会让委派失败：缺少 attachment store、父模型 route 声明不支持图片、
或图片无法解析，都会降级为文字说明。后台任务的结果按契约是字符串，图片会写到
`$DSH_HOME/claude-code-pro-images/` 并在文本里给出宿主路径。

### 结构化输出与后台任务

`output_schema` 映射为 SDK 的 `outputFormat` schema：最终答案是 JSON，插件用受支持的
schema 子集二次校验，非 JSON 或不合规即失败关闭；带 schema 的结果保持纯 JSON，
不追加 session marker。

挂载了 DSH jobs 服务时，`run_in_background: true` 立刻返回 job id，委派在 jobs
worker 里执行（`job_output` 取结果、`job_kill` 取消）。Claude Code 自己的 `--bg`
是终端会话功能，不是工具结果通道，所以这里用官方 subagent 工具与 Codex Pro 相同
的 harness 机制。

### 认证与 CLI 凭据存储

插件不读取、创建、刷新或改写凭据，由原生程序管理认证。使用官方 CLI 的本机登录时，
配置 `subscription: {version: 1, mode: subscription-only}` 和显式模型。每次调用在
prompt 前检查同一初始化进程的原生账号与 usage，必须明确额外用量已关闭才能派发；
未知状态阻断，不接受调用方计费布尔声明，不自动转 API／credits，也不改账号。
详见[完整策略、doctor、模型绑定与证据契约](docs/subscription.zh.md)
（[English](docs/subscription.md)）。

既有显式 API 用户不设置此策略即可继续使用获准的 `env.ANTHROPIC_API_KEY` 等配置。
安装 SDK 本身不建立订阅资格或模型权益。

运行 `node scripts/doctor.mjs` 检查所选程序的 `auth status`。Doctor 只报告原生
认证是否可用，不读取钥匙串，不输出 token、token 长度或原始认证响应；修复建议
针对实际失败的前提，不统一要求重新登录。
[早期真实验证记录](docs/live-verification.zh.md)保留历史 CLI 凭据刷新观察。

### 权限

默认 `dontAsk`：无人值守，CLI 不会等待人工，未预先批准的操作一律拒绝
（`--permission-prompts none`）。调用只能收窄配置策略。`plan` 用于只读规划；
`acceptEdits` / `auto` / `bypassPermissions` 需要在插件配置里显式放开。

## 配置

```yaml
- id: claude-code-pro
  name: 'dsh-subagent-claude-code-pro'
  config:
    toolName: subagent_claude_code
    # tmuxCommand: /absolute/path/to/tmux  # 可选，仅独立 Team 作业
    command: claude                  # 或绝对路径
    presets: [daily, heavy, cordis]
    modelSelection: true
    permissionMode: dontAsk
    sessionMode: session
    runTimeoutMs: 600000             # 0 表示不设 deadline
    model: sonnet                    # 可选默认
    reasoningEffort: high            # 可选默认
    settingSources: [user, project, local]
    # subscription: {version: 1, mode: subscription-only} # 原生账号，额外用量关闭
    env: {}                          # 仅传子进程真正需要的变量
    disposeGraceMs: 3000
```

子进程环境 = 当前环境去掉 `DSH_*` 与凭据形状名称（`KEY`/`PASSWORD`/`SECRET`/
`TOKEN`），再叠加显式 `env`。这样 DSH 部署密钥不会进入一个模型可以对话的进程；
确实需要的 API key / 中转 token 要写进 `env`。

## 前提与限制

- 本地 `claude` 可执行文件能从其环境取得获准使用的认证；插件不负责登录或管理
  凭据刷新。
- 本地程序须为稳定的 **Claude Code 2.1.325 或更新版本**，这是 SDK 0.3.326 的
  最低已验证版本；SDK 核对同一进程的 initialize 响应后才放行任务输入。固定版本
  的 Agent SDK 与本地程序须支持实际使用的初始化、权限和流式选项。
  插件在任务前检查所需 CLI flags，并验证返回流；不兼容或无法读取的终态明确
  失败，不能只凭版本号放行。
- Desktop 应用在启动时捕获环境；如果 PATH 里没有 `claude`，请把 `command` 指向
  绝对路径。
- 子进程使用 CLI 的原生设置、hooks、MCP、plugins、skills；它不是沙箱，权限模式
  才是边界。
- 图片/PDF 输入和 SDK 结构化输出要求兼容的原生支持；初始化或输出验证失败时，
  不会静默丢弃这些请求。
- 并发委派会并发启动 CLI 进程。这通常是可行的，但 CLI 自己的凭据刷新是共享状态，
  重度并发是 CLI 的限制，本插件不接管。
- Windows 缺少进程树清理支持，因此在派发前拒绝调用；支持的 POSIX 平台按进程组清理。

## 排障 / doctor

本地 CLI 自检，不发模型请求：

```sh
node scripts/doctor.mjs
```

检查精确的 Agent SDK 安装及公开 query 导入、本地可执行文件／版本、
`claude auth status` 和所需 CLI flags。原生 API 认证不要求另有订阅 token，
也不打开钥匙串或凭据文件。前提不满足时退出码非 0。这些只是静态检查，每次实际
查询仍会在任务输入前核对自己的 initialize 响应；认证状态不等于付费模型验收。

检查与执行完全一致的无 prompt 订阅准入：

```sh
node scripts/doctor.mjs --subscription-only --model claude-opus-5-5 --effort high --cwd /absolute/worktree
```

这条路径使用固定 SDK 的原生账号／usage 控制，不发送 `/usage` prompt。结果是派发前
观察到的状态，不是计费锁或模型包含权益保证；完整边界见[订阅准入](docs/subscription.zh.md)。

## 诊断

`~/.dsh/claude-code-pro.log` 记录：应用配置（不含 env 值）、每次委派解析出的
model/effort/session/permission/timeout、`system/init` 报告的 CLI 版本与模型、
完成/失败分类、清理确认、cache read tokens。委派"看起来没动静"时先看这里。

## 验证情况

- `npm test`：确定性测试（fake `claude` CLI），覆盖 session 生命周期、续接
  修复、多模态编码、图片投递与 route 门控、结构化输出、后台任务、超时、取消、
  失败分类。
- `node scripts/probe-live.mjs`：真实 CLI 冒烟——新建 session、最终文本、跨进程
  续接并回忆上一轮内容（cache_read 命中）。
- 安装后的真实 DSH 会话 E2E：文本、session 复用、`fork_session`、图片输入、
  图片输出（真实 attachment block 回到调用方）、PDF 输入、`output_schema`、
  后台任务均通过。证据见
  [docs/live-verification.zh.md](docs/live-verification.zh.md)
  （英文版：[docs/live-verification.md](docs/live-verification.md)）。

## 开发

```sh
npm ci                         # 安装开发依赖
npm test                       # 确定性 CLI/Schema/React/作业测试
npm run test:host              # published 与固定当前 DSH 源码的真实 schema/PTC 契约
npm run test:package           # 无 DSH runtime peer 的打包 machine consumer
node scripts/probe-live.mjs     # 真实 CLI 冒烟，需要已登录的本地 CLI
```

fake CLI 说同样的 stream-json 协议，因此 session 复用、续接修复、超时、取消、
认证失败、协议失败都能在无网络环境下覆盖。

## License

MIT。
