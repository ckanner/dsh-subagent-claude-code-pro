# Machine API v1

`dsh-subagent-claude-code-pro/machine` 从 **0.3.2 源码候选**开始提供，是供
Flywheel 等调度器使用的公开 ESM 接口，不增加运行时依赖。源码更新不代表已发布
npm 新版本，也不会升级用户已有桌面安装。

```js
import { parseMachineRequest, runMachine } from 'dsh-subagent-claude-code-pro/machine'

const controller = new AbortController()
const request = parseMachineRequest({
  protocol: 1,
  requestId: 'task-42-execute-attempt-1',
  cwd: '/absolute/task/worktree',
  prompt: '完成这个自包含任务，并输出约定格式的报告。',
  model: 'sonnet',
  effort: 'high',
  permissionMode: 'bypassPermissions', // 显式 Claude CLI 工具审批策略
  sessionMode: 'persistent',
  timeoutMs: 600000,
})

const receipt = await runMachine(request, { signal: controller.signal })
// 调度器先持久保存完整、关联到本次调用的回执，再推进任务状态。
if (receipt.ok && receipt.session.resumable) {
  // 同一任务、同一角色下，后续可显式用 receipt.session.id 作为 sessionId。
}
```

完整类型随包发布，见 [`lib/machine.d.ts`](../lib/machine.d.ts)。公开导出为
`MACHINE_PROTOCOL_VERSION`、`MachineInputError`、`parseMachineRequest`、
`runMachine`；0.4.0 源码候选还提供 `MACHINE_LIFECYCLE_VERSION`、
`MACHINE_LIFECYCLE_CAPABILITIES` 与 `recoverMachine`。详见[生命周期协议](machine-lifecycle.zh.md)。需要 macOS/Linux 与 Node.js 22.18.0 或以上，以及用户已安装、
已登录的本地 Claude Code CLI；接口不捆绑 Claude，也不负责登录。

## 请求与会话身份

必填字段为 `protocol: 1`、非空 `requestId`、实际存在的绝对目录 `cwd`、
自包含任务 `prompt`、显式原生 `permissionMode`，以及
`sessionMode: 'ephemeral' | 'persistent'`。可选字段为 `command`、`model`、
`effort`、`sessionId`、`timeoutMs`、`disposeGraceMs`、`maxOutputBytes` 与
`settingSources`。未知字段、非法组合和不支持的 runtime 参数会在派发前抛出
`MachineInputError`。

- `cwd` 在调用前解析为物理目录。
- 每个新的 persistent 调用创建独立 UUID；API 不隐式记忆或共享会话，不自动重试。
- `sessionId` 只用于显式续接 UUID，必须配合 persistent；会话不存在时直接失败，
  不悄悄新建替代会话。
- ephemeral 使用 `--no-session-persistence`，不提供可续接检查点。
- `session.resumed` 只在实际观察到匹配的 CLI `system/init` 后为 true；仅请求
  resume 不算已打开会话。`session.resumable` 要求成功终态和已确认清理。
- `requestId` 关联调用者的 attempt，`runId` 是本次 API 调用新建的 UUID；它们
  都不是 Provider 侧的幂等键。

默认超时 600,000 毫秒，`timeoutMs: 0` 关闭时限；终止宽限默认 3,000 毫秒，
随后执行有界 SIGKILL 与清理核对。最终文本默认上限 1 MiB，最高可配 16 MiB。
每条 NDJSON 帧最多 16 MiB，未换行帧也计入限制；持续活动不消耗累计 stdout 字节预算。
内部展示文本只保留最近 65,536 个字符，可选展示回调在 4 MiB 或 4,096 条后以一条省略提示
停止；activity 和完整最终答案独立保留。输出图片限制为 64 MiB、1,024 张；帧或回执超限
会明确失败并清理所拥有进程。原始 ultrareview JSON 仍限制为 64 MiB，capability help 为 256 KiB。
`settingSources` 默认 `user/project/local`；显式空数组会传递
`--setting-sources ''`，不会意外恢复默认设置。

## 配置证据

`requested` 记录请求给 CLI 的参数，`configuration.observed` 只记录
`system/init` 实际报告的内容。成功需要目录、原生权限和会话身份匹配。显式完整
模型 ID 必须完全一致；`sonnet`、`opus`、`haiku` 三个别名可匹配对应
`claude-<family>-…` 模型家族，不固定模型版本。其他别名要求原样匹配；无法证明
别名解析时，应使用完整模型 ID。

`low/medium/high/xhigh/max` 原样传为 `--effort`，实际支持能力由本地 CLI 决定，
不支持时明确失败。init 没有提供有效 effort，因此回执不伪造“实际生效的思考级别”。

`plan/dontAsk/acceptEdits/auto/bypassPermissions` 是 Claude 工具审批策略，
**不等价于操作系统或文件系统沙箱**。集成方不能把 plan 宣称为只读隔离，也不能
把 acceptEdits 宣称为仅可写工作区。Flywheel 首次接入只将显式 full-access 映射
为 bypassPermissions；不能证明等价的沙箱模式在派发前拒绝。

## 终态、失败和清理

回执分别提供 execution、cleanup、session、configuration、output、usage 与
failure。各字段的意义为：

| 证据 | 含义 |
| --- | --- |
| `dispatch: 'not-dispatched'` | 没有 CLI 进程接受工作，例如派发前取消或可执行文件缺失；不宣称已打开请求中的会话。 |
| `dispatch: 'dispatched'` | 已启动 CLI 进程；这是保守判断，不等于证明已向模型发请求。 |
| `outcome: 'completed'` | 唯一且会话一致的成功终态，以及正常进程退出。 |
| `outcome: 'failed'` | 可信的失败终态及与之兼容的进程退出。 |
| `outcome: 'unknown'` | 无法确认终态，包括流损坏、结果缺失和异常退出。 |
| `cleanup.confirmed: true` | 已观察到所属 POSIX 进程组消失，或本来就未启动进程。 |
| `ok: true` | 终态、请求配置、输出和清理均已通过。 |

所有派发后的返回路径都等待进程组清理，包括终态错误、取消、超时、输出超限，
以及主进程退出但子孙进程仍存活的情况。只有 ESRCH 可以证明进程组不存在，
其他探测错误不能证明清理成功。无法确认清理时失败并阻断续接。

进度文本仅用于显示。缺失 is_error、缺失/损坏/截断结果、重复终态或 init、
冲突的会话 ID、终态之后出现的 assistant 内容均不能当成可恢复成功。未知事件
类型仍允许前向兼容。Machine API 的显式 resume 失败不自动换新会话；桌面工具
保留原有的隐式记忆修复，但现在要求可信失败终态与已确认清理。

调用者负责持久保存回执，隔离任务与角色，核对候选、预算和重放条件。新建会话
不会使前一次未知执行变得可重放。worker 在回执返回前被强杀时仍可能结果未知；
0.4.0 可显式启用[派发前持久化意图确认与只读恢复](machine-lifecycle.zh.md)，
但仍不提供任意崩溃点自动重放或 exactly-once 保证。
除 `MachineInputError` 外，没有回执的 promise rejection 不能证明“未派发”。

物理监督在**启动原生 CLI 之前**建立：独立进程组中的 guardian 自行启动并拥有
CLI，同时保持指向调用者的 IPC 生命线。调用者或其整个进程组被强杀后，生命线
断开，guardian 会取消 CLI、等待原生进程组清理，再自行退出。正常 API 返回需
等待 guardian 的终态回执及退出。如果 guardian 自身在报告原生进程组后异常
退出，仍存活的调用者会执行有界备用清理，并将执行结果标为 unknown。两个监督
进程同时丢失，或 guardian 在报告原生身份前被强杀，仍可能无法取得完整清理
证据；必须继续阻断，不能宣称可恢复。

## 用量、费用和凭据

usage 是每次 CLI 调用的用量。inputTokens 是未命中缓存的输入，cacheReadTokens
和 cacheCreationTokens 单独列出；完整 totalTokens 为这些输入与 outputTokens
之和。缺失计量保留 null，标记 partial/unknown，不假造零用量。损坏或异常退出
的终态流不会保留不可信计量。可信终态即使因配置、输出或清理问题不能接受结果，
仍可单独保留本次消耗。

reportedCostUSD 来自 CLI 的 total_cost_usd，只是 API 等价估算，**不是订阅用户
实际账单**。costUSD 始终为 null，costStatus 为 unknown。CLI 的 max-turn/输出
限制不证明账户额度不足，也不自动授权切换付费 Provider。

子进程环境默认移除 DSH_* 和凭据形态名称。runtime.credentialEnv 只允许显式传入
ANTHROPIC_API_KEY、ANTHROPIC_AUTH_TOKEN、CLAUDE_CODE_OAUTH_TOKEN 或
ANTHROPIC_BASE_URL；值不进入回执。接口不读取或改写凭据文件、系统钥匙串。

## 验证边界

npm test 通过真实派生的本地 fixture 进程验证普通调用、续接、配置证据、凭据
边界、取消、超时、协议错误、计量完整性和残存子孙清理；导出和安装检查使用实际
候选 tarball。这些是离线契约测试，不代表新 machine API 已通过真实 Claude
推理、账户可用性或 macOS 专项验收。

## 真实活动与 CLI 兼容性（0.5.2）

查询前先通过同一 guardian 执行只读 `claude --help`，不发送任务 prompt。必须实际宣告
`--include-partial-messages`、`--forward-subagent-text`，命名时还需 `--name` 或 `-n`。
子代理转发 flag 要求 Claude Code 2.1.211 或以上；以真实 help 能力而不是猜测版本号作准入。
缺少能力返回 `not-dispatched`，不降级执行、不自动重试。探测时间计入同一次 wall deadline，
help 最多读取 256 KiB，原文不会进入回执；`npm run doctor` 同样检查这些 flags。
参考[官方 CLI 参数](https://code.claude.com/docs/en/cli-reference)与
[流式契约](https://code.claude.com/docs/en/headless#stream-responses)。

公共接口新增 `MACHINE_ACTIVITY_VERSION: 1`，以及
`MACHINE_ACTIVITY_CAPABILITIES: { version: 1, metadataOnly: true, coalesced: true, rootAndChildren: true }`。
它描述 machine query 的能力，不涵盖独立 ultrareview 或 tmux interactive-team 协议。
调用时可传 `onActivity(event)` 和 `activityIntervalMs`（1–60000 的整数，默认 250ms）。

事件仅包含 `version`、`sequence`、`kind: 'provider-progress'`、`source: 'claude-code-pro'`、
`scope: 'root' | 'child' | 'mixed'`、`eventTypes`（最多 16 个已知类型）与 `observedEvents`。
类型覆盖主/子 assistant 文本与 thinking、tool use/result/progress、partial stream、task
生命周期和 progress、API retry、hook、init、compaction 与 result。没有正文、思考内容、
工具参数/结果、私有 ID、凭证或消耗计数。整个已观察任务树共享一个有界合并器；只有新收到
的真实事件触发回调，时间经过不会生成心跳。native 状态账本去重不会抹掉持续 task progress
的活动信号。取消/结束后停止回调；回调自身抛错不改变业务执行。

ambient 任务不属于本次会话工作。后续 progress 即使省略 `ambient`，也按已记录的任务/运行
身份排除，既不提供活性，也不在 native 账本留下虚假的未完成子任务。后台任务集合快照只更新
身份信息，不产生 activity。身份缓存最多 4,096 个 run、1 MiB 的键；超限后停止任务活动上报，
启用 native 追踪时不能确认 native 完成或清理。子任务所有权账本超限时也采用同一规则：
未保留的身份可能属于远程工作，不能因为现有 children 没列出它，就证明远程工作已停止。
独立的本地进程组清理仍可确认为完成；只有事件历史被截断、所有权身份完整时，也保留可信清理。
明确的 run ID 对应其精确运行；省略 run ID 的事件使用当前运行，即使历史中还有无 run ID
的旧 ambient 任务。重放旧 start 不能把当前运行回退；持久子任务记录仍按自己的精确运行
判断归属，旧 ambient 子任务不会重新变成未完成工作。同一 task 的当前 run 按 Provider
约定的普通字符串顺序选择，因此首次晚到的旧 start/snapshot 也不能覆盖更新的 run；
缺少 run ID 的 legacy 条目不能覆盖已经确立的 versioned current。`thinking_tokens` 的正数增量同样
提供实际思考活动。依据[官方任务消息契约](https://code.claude.com/docs/en/agent-sdk/typescript#sdktaskstartedmessage)。

通常由初始化确认的本次根会话提供活动。已知根事件出现冲突 session ID 时立即失败，
不会先转发 activity 或展示文本。本次独占 CLI 转发的子 transcript 可使用不同 session ID
及其 `parent_tool_use_id` 标记，不依赖是否启用 native profile。缺少 ID 或未知类型的事件
不提供活动，未知类型继续保持协议向前兼容。

启动 hook 是明确例外：其开始、输出及结束可以早于 `system/init`。新 persistent/resume
调用已经由调用者确定会话 ID，因此可接收与该 ID 完全匹配的启动 hook 活动；ephemeral
仍需等待 init，不能把任意观察到的 ID 当成归属证明。依据[官方 hook 消息时序](https://code.claude.com/docs/en/agent-sdk/typescript#sdkhookstartedmessage)。

`onProgress` 仍是可选展示文本，两个通道都不是派发 ACK、最终结果、usage 回执或重试授权；
activity 不写入 durable receipt。长工具在开始和完成之间仍可能没有事件，调用方必须把 idle
限制视为明确资源策略，不能从沉默推导模型已死锁。

开始进程组清理前固定最先发生的停止原因：wall timeout 后到来的 cancel 不会吞掉超时，
用户取消后的清理期间达到 wall deadline 也不会被改报超时。清理继续使用独立有界宽限和事实核对。

DSH/PTC 前台和后台查询可使用显式 Flywheel host extension：
`ctx.get('flywheelProviderActivity')` 提供 `{ version: 1, intervalMs, report(agent, event) }`。
插件传真实 DSH Agent、上述安全元数据与每次调用唯一的 `invocationId`，由 host 校验归属。
这不是伪造的 DSH assistant-stream；没有该扩展时保留普通桌面行为。

### 可读会话名称

新 persistent machine query 可传 `sessionName`（单行、最多 512 UTF-8 字节）；未传时，
从工作目录名生成有界的 `Claude · …` 标题，并通过 `-n` 设置，不把任务私密指令自动写入
会话列表。DSH 工具优先使用显式 description，缺省时使用工作目录名；新 interactive-team
同样支持 `sessionName` 和工作目录名回退。
`sessionId` resume 或 ephemeral query 携带 `sessionName` 会在 spawn 前拒绝，避免误改用户旧会话名。
恢复现有会话不会重新命名；ephemeral 不会为了显示名称而强制保存历史。

[0.5.2 离线活动与命名验证记录（英文）](activity-validation.md)。
