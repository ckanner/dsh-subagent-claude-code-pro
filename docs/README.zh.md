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

> **状态**：`0.1.0` 完成文本 + Session 核心。图片/PDF 输入、图片输出、
> `output_schema`、后台任务属于下一阶段，进度见 `CHANGELOG.md`。

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
    presets: [daily, heavy]
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

## 诊断

`~/.dsh/claude-code-pro.log` 记录：应用配置（不含 env 值）、每次委派解析出的
model/effort/session/permission/timeout、`system/init` 报告的 CLI 版本与模型、
完成/失败分类、清理确认、cache read tokens。委派"看起来没动静"时先看这里。

## 开发

```sh
npm test                        # 确定性测试，使用 tests/fixtures/fake-claude.mjs
node scripts/probe-live.mjs     # 真实 CLI 冒烟，需要已登录的本地 CLI
```

fake CLI 说同样的 stream-json 协议，因此 session 复用、续接修复、超时、取消、
认证失败、协议失败都能在无网络环境下覆盖。

## License

MIT。
