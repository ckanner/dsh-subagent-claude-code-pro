# dsh-subagent-claude-code-pro

DeepSeek Harness 的 Claude Code 委派插件：**直接驱动你本机已登录的 `claude`
CLI**，不下载、不内置官方 Agent SDK 的平台载荷，同时补上官方
`@deepseek-ai/dsh-subagent-claude-code` 无法表达的几件事：

- 每次调用可选 **model 与思考等级**（`--model`、`--effort`）；
- **可复用的 Claude Code Session**（`--session-id` / `--resume`，或每个 DSH
  Agent 会话固定一个 session 自动续接）；
- 调用只能收窄、不能放大配置的权限模式；
- 单次委派的 deadline、调用方取消、进程组清理；
- 诊断日志 `~/.dsh/claude-code-pro.log`（插件没有会话可读的日志面）。

> **状态**：`0.3.0` 是首个完成真实环境全量验证的版本：文本、图片/PDF 输入、
> 图片输出、`output_schema`、后台任务、Session（含 fork）均已用本地 `claude`
> CLI 与真实 DSH 会话跑通。见 `docs/live-verification.md` 与 `CHANGELOG.md`。

## 为什么要这个插件

官方 provider 是刻意的一次性 SDK 适配器：

- 每次新建 SDK query，且 `persistSession: false`；
- 拒绝文本以外的 prompt 内容块；
- 它的工具行不能暴露 `model` / `reasoning_effort`（`NO_START_CAPABILITIES`，无
  `agentOptions`）；
- DSH 的 subagent seam 把外部执行的子级定义为一次性，本身就不接受后续消息或
  resume。

本插件自己注册模型工具（与 Codex Pro / LCU 相同的
`agent/created → agent.ctx.tools.register` 路径），并通过本地 CLI 的
`--print --input-format stream-json --output-format stream-json` 协议驱动。
CLI 的原生设置、hooks、MCP、模型默认值和登录态保持权威——用户自己安装并登录
过的那一份。

## 安装

```sh
dsh plugin --profile <profile> add dsh-subagent-claude-code-pro
# 或从本地检出：
# dsh plugin --profile <profile> add /absolute/path/to/dsh-subagent-claude-code-pro
```

Desktop 应用的托管 profile 请用应用内的插件页安装。bundle 会插入一条 root row，
并在 `presets` 列出的 preset 会话里注册 `subagent_claude_code` 工具。工具名与官方
一致，因此这个 per-Agent 注册会遮蔽官方全局工具；同一作用域不要再挂同名工具行。

## 使用

```js
subagent_claude_code({
  description: "修重定向循环",
  prompt: "……完整任务；它看不到本对话……",
  model: "sonnet",              // 别名或完整 id；省略用配置/原生默认
  reasoning_effort: "high",     // low | medium | high | xhigh | max
  permission_mode: "acceptEdits",
  session_mode: "session",
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
session 只在创建它的 cwd 中、且没有其他委派占用时复用；记忆 session 不存在时自动
新建并记录原因；`fork_session: true` 分支出新 session。

### 多模态输入与输出

`images` 传绝对路径（PNG/JPEG/GIF/WebP），`documents` 传 PDF 路径。所有附件在
spawn 之前校验——不存在或超限会让调用失败，而不是起一个缺少文件的委派；随后
编码成 Anthropic Messages API 的 `image` / `document` content block 放进
stream-json 用户消息，Claude 原生接收，不需要自己打开文件。其它文件类型继续可以
在 prompt 里写路径，让 Claude Code 用它自己的 Read 工具读取。

输出方向：Claude Code 工具读图/截图产生的 base64 图片会进入 DSH attachment
store，并作为 image block 与答案一起返回给父模型（父模型 route 不支持图片时降级
成文字说明）。后台任务的结果按契约是字符串，图片会写到
`$DSH_HOME/claude-code-pro-images/` 并在文本里给出宿主路径。

### 结构化输出与后台任务

`output_schema` 映射为 CLI 的 `--json-schema`：最终答案是 JSON，插件用受支持的
schema 子集二次校验，非 JSON 或不合规即失败关闭；带 schema 的结果保持纯 JSON，
不追加 session marker。

挂载了 DSH jobs 服务时，`run_in_background: true` 立刻返回 job id，委派在 jobs
worker 里执行（`job_output` 取结果、`job_kill` 取消）。Claude Code 自己的 `--bg`
是终端会话功能，不是工具结果通道，所以这里用官方 subagent 工具与 Codex Pro 相同
的 harness 机制。

### 认证与 CLI 凭据存储

插件不读取/创建/刷新/改写凭据——凭据完全由本地 CLI 管理。两条实测注意事项：

- CLI 的 OAuth 会话存在系统钥匙串（macOS）/配置目录中。多个 CLI 进程并发刷新同一
  会话可能产生竞态；刷新失败时 CLI 可能清空已存 token，并报
  `OAuth session expired and could not be refreshed`。遇到时先跑
  `node scripts/doctor.mjs`，再 `claude auth login`。
- 无人值守或高频使用，建议用静态子进程凭据：`claude setup-token` 生成长期 token，
  通过插件 `env` 传 `CLAUDE_CODE_OAUTH_TOKEN`（或用 `ANTHROPIC_API_KEY`），
  这样不依赖钥匙串刷新。

doctor 只打印 token 长度，不打印值。

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
    command: claude                  # 或绝对路径
    presets: [daily, heavy, cordis]
    modelSelection: true
    permissionMode: dontAsk
    sessionMode: session
    runTimeoutMs: 600000             # 0 表示不设 deadline
    model: sonnet                    # 可选默认
    reasoningEffort: high            # 可选默认
    settingSources: [user, project, local]
    env: {}                          # 仅传子进程真正需要的变量
    disposeGraceMs: 3000
```

子进程环境 = 当前环境去掉 `DSH_*` 与凭据形状名称（`KEY`/`PASSWORD`/`SECRET`/
`TOKEN`），再叠加显式 `env`。这样 DSH 部署密钥不会进入一个模型可以对话的进程；
确实需要的 API key / 中转 token 要写进 `env`。

## 前提与限制

- 本机 `claude` CLI 已登录；插件不负责登录、刷新或改写凭据。
  `claude auth status` 应为 `loggedIn: true`。
- 假定 `claude --version` ≥ 2.1；协议是 SDK 的 stream-json 行格式，CLI 升级可能
  增删事件。插件忽略未知事件，无法解析终态则失败关闭。
- Desktop 应用在启动时捕获环境；如果 PATH 里没有 `claude`，请把 `command` 指向
  绝对路径。
- 子进程使用 CLI 的原生设置、hooks、MCP、plugins、skills；它不是沙箱，权限模式
  才是边界。
- 并发委派会并发启动 CLI 进程。这通常是可行的，但 CLI 自己的凭据刷新是共享状态，
  重度并发是 CLI 的限制，本插件不接管。
- Windows 进程树清理尚未实现；POSIX 下按进程组清理。

## 排障 / doctor

本地 CLI 自检，不发模型请求：

```sh
node scripts/doctor.mjs
```

输出可执行文件/版本、`claude auth status`、插件依赖的 CLI flags，以及 macOS 上
Claude Code 钥匙串项是否真的有 token（只打印长度与过期时间，不打印值）。有问题时
退出码非 0。委派返回 `category: auth` 时先跑这个。

## 诊断

`~/.dsh/claude-code-pro.log` 记录：应用配置（不含 env 值）、每次委派解析出的
model/effort/session/permission/timeout、`system/init` 报告的 CLI 版本与模型、
完成/失败分类、清理确认、cache read tokens。委派"看起来没动静"时先看这里。

## 验证情况

- `npm test`：51 项确定性测试（fake `claude` CLI），覆盖 session 生命周期、续接
  修复、多模态编码、图片投递与 route 门控、结构化输出、后台任务、超时、取消、
  失败分类。
- `node scripts/probe-live.mjs`：真实 CLI 冒烟——新建 session、最终文本、跨进程
  续接并回忆上一轮内容（cache_read 命中）。
- 安装后的真实 DSH 会话 E2E：文本、session 复用、`fork_session`、图片输入、
  图片输出（真实 attachment block 回到调用方）、PDF 输入、`output_schema`、
  后台任务均通过。证据见 [docs/live-verification.md](docs/live-verification.md)。

## 开发

```sh
npm test                        # 确定性测试，使用 tests/fixtures/fake-claude.mjs
node scripts/probe-live.mjs     # 真实 CLI 冒烟，需要已登录的本地 CLI
```

fake CLI 说同样的 stream-json 协议，因此 session 复用、续接修复、超时、取消、
认证失败、协议失败都能在无网络环境下覆盖。

## License

MIT。
