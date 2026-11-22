# 原生订阅准入

本源码候选在现有“官方 Agent SDK → 配置的本机 Claude Code”链路上增加可选的
`subscription-only` 策略。插件不实现 OAuth、不导出 token、不更改账号设置、不替换
原生程序，也不自动转 API。没有设置策略的既有调用继续保留显式 API／原生认证兼容行为。

## DSH 配置

在既有插件行中加入策略，权限保持原任务的授权：

```yaml
config:
  command: claude
  model: claude-opus-5-5
  reasoningEffort: high
  subscription: {version: 1, mode: subscription-only}
  env: {}
```

使用同一 `HOME`／`CLAUDE_CONFIG_DIR` 下原版 CLI 的本机登录。此配置不能包含 API
key、bearer token、导出的 OAuth token、自定义 base URL 或云供应商选择器。策略要求
当前原生进程确认第一方订阅，并明确返回 `extra_usage.is_enabled: false`；证据未知时阻断。

这个静态插件策略覆盖前台、PTC 与 DSH 后台委派；单次模型／native 参数不能关闭策略。
独立远程 Review 和交互 Team 的启动，以及 Team send／attach，在启用策略时拒绝：
这些传输没有同进程、prompt 前的同等费用预检。已有自有作业仍可恢复、capture、resize
或取消。普通 SDK 委派及其获准的 Agent／Workflow／Advisor 能力继续可用。

## Machine 请求与诊断

```js
import { runMachine, inspectSubscription } from 'dsh-subagent-claude-code-pro/machine'

const selection = {
  protocol: 1, requestId: 'task-plan', cwd: '/absolute/worktree',
  command: '/absolute/path/to/claude', model: 'opus', effort: 'high',
  settingSources: ['user', 'project', 'local'],
}

const diagnostic = await inspectSubscription(selection) // 不提交 prompt／模型查询
const result = await runMachine({
  ...selection, prompt: '为已批准的改动制定方案和验证步骤。',
  permissionMode: 'plan', sessionMode: 'persistent',
  subscription: { version: 1, mode: 'subscription-only' },
})
```

`inspectSubscription` 接受 `protocol`、`requestId`、`cwd`、`command`、`model`、
`effort`、`settingSources`、`timeoutMs` 和 `disposeGraceMs`；可选 runtime 接受与
执行相同的 `env`、`credentialEnv`、`signal`。不接受 prompt、session、账号声明或
调用方提供的计费布尔值。返回 `type:'subscription-inspection'`、`ok`、`subscription`、
`promptDispatched:false`、`cleanup` 和 `failure`。实际执行会在自己的进程重新预检。

命令行 doctor 复用同一个公开实现：

```sh
CLAUDE_PRO_COMMAND=/absolute/path/to/claude node scripts/doctor.mjs \
  --subscription-only --model claude-opus-5-5 --effort high --cwd /absolute/worktree
```

可选 `--setting-sources user,project,local`。doctor 与执行使用同一 command、cwd、HOME、
配置目录、所选设置和过滤后的子进程环境。不加此开关时，保留原来的可执行文件／认证／
flags 静态诊断兼容路径。

## 实际准入顺序

1. 校验策略和显式模型，拒绝已知凭据／供应商、fallback、fast mode、effort 冲突，冻结模型 ID。
2. 使用同一子进程环境运行既有的有界 CLI help 探测。
3. 通过固定 **`@anthropic-ai/claude-agent-sdk@0.3.326`** 在 guardian 的自有进程组中启动
   配置的本机程序，核对真实 initialize 响应和原生目录中明确的 effort 能力冲突。
4. 异步用户消息生成器保持关闭，在**同一个 SDK query／CLI 进程**调用 `accountInfo()` 和
   公开实验接口 `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({skipBehaviors:true})`。
   不发送 `/usage` prompt，不触发 token-count 模型调用，不调用私有 endpoint，不读取凭据文件或改账号。
5. 必须同时得到第一方 `pro`／`max`／`team`／`enterprise` 订阅、两处一致的订阅类型、可用的
   plan rate limits、符合固定版本契约的完整响应，以及
   `rate_limits.extra_usage.is_enabled === false`，才放行唯一一条任务消息。独立诊断直接清理进程。

实验接口可能变动或移除。版本、方法、完整准入响应 shape 都会校验；新增未知字段、null、
缺失值、矛盾、错误或不支持均阻断。即使任务不设 deadline，预检仍有 10 秒上限；更短的
总任务期限或取消优先。所有路径保持进程组清理。

配置检查读取所选 user／project／local JSON 设置（包括祖先路径）和已安装的 managed
JSON 设置。单次调用还传入 `forceLoginMethod:'claudeai'`、`fallbackModel:[]`、
`fastMode:false` 和官方禁用 fast mode 的环境变量；不修改配置文件。服务端／MDM 设置
不能完全由本地文件重建，因此仍以初始化账号、原生 usage 响应和实际模型输出能证明的
事实为准。原生权限允许的 hooks、工具及其他程序不构成计费沙箱。

## 证据与边界

策略调用返回经过过滤的 `subscription`：

```json
{
  "version": 1,
  "mode": "subscription-only",
  "status": "verified",
  "source": "sdk-usage-0.3.326",
  "checkedAt": "2026-11-20T00:00:00.000Z",
  "apiProvider": "firstParty",
  "subscriptionType": "pro",
  "extraUsageEnabled": false,
  "resolvedModel": "claude-opus-5-5",
  "scope": "pre-prompt-snapshot",
  "diagnostic": null
}
```

`verified` 只表示这些原生派发前检查通过，**不代表**锁定账号后续设置、保证模型权益、
保证比原生响应更高的实时性或证明实际费用为零。时间戳是插件观察响应的时间；其他设备
之后仍可更改账号设置。Fable 权益、credits 和额度以实际账号为准；拒绝或额度耗尽直接
返回，不自动换模型、provider、付费 API 或 credits，也不宣称所有 Pro 均包含 Fable 用量。

`blocked` 表示已知冲突，`unknown` 表示证据不可用，两者都不发送任务。回执不保存邮箱、
组织、token、余额、credit 金额、使用百分比或原始账号／usage 响应。
`reportedCostUSD` 仍是原生 API 等价值估算；`costUSD:null`、`costStatus:'unknown'` 保持不变。

CLI 可以为预检而启动，同时 `execution.turnDispatch:'not-dispatched'`；原有
`execution.dispatch:'dispatched'` 仍只描述进程已启动。持久 lifecycle 和恢复回执保留这个区别。

## 模型与 effort

订阅策略使用经核对的第一方别名表冻结目标：

| 别名 | 精确目标 |
| --- | --- |
| `fable` | `claude-fable-5-2` |
| `opus`、`best` | `claude-opus-5-5` |
| `sonnet` | `claude-sonnet-5-5` |
| `haiku` | `claude-haiku-5-5` |

有效环境的显式 `ANTHROPIC_DEFAULT_<FAMILY>_MODEL` 只有解析为第一方完整 ID 时才保留。
完整 ID 和文档中的 `[1m]` 后缀保持原样；此策略拒绝 `default`／`opusplan` 等动态选择。
请求、解析后目标与原生回报分别记录，不互相冒充。
`[1m]` 窗口请求在派发时保留；wire model ID 可省略此后缀，回执不伪造原生未报告的实际窗口大小。

`configuration.modelEvidence.rootModels` 记录本次流中每个 root
`assistant.message.model`；一旦观察到偏离冻结目标，哪怕后来切回，也不能成功。
严格策略成功必须有真实 root 模型证据。`usageModels` 收集 root `result.modelUsage`
累计快照的模型键，作用域明确为 `native-cumulative-including-history-and-auxiliary`：
续接／fork 历史、子 Agent 和内部／压缩调用都可能贡献。这些键不能当成本轮 fallback
轨迹，累计快照不相加；`wholeRunVerified:false` 保留，不能从总量重建隐藏原生请求。

`CLAUDE_CODE_EFFORT_LEVEL` 覆盖、已知配置 cap，以及原生模型目录明确不支持的档位，
都会在 prompt 前拒绝。不伪造未报告的实际 effort。未启用订阅策略的旧调用也会拒绝
显式环境 effort 冲突。

## 验证与来源

确定性测试使用真实固定版本 SDK 和离线 CLI 协议 fixture，验证同 PID 的
`initialize → get_usage(skip_behaviors:true) → user`、拒绝／诊断零用户消息、累计模型
语义、同环境 doctor、DSH 策略传递和自有进程清理。这不是实际账号／模型权益验收记录；
生产绑定启用前需在真实安装中运行原生 doctor。

- [官方模型别名与 effort](https://code.claude.com/docs/en/model-config)
- [原生 CLI 与 auth status](https://code.claude.com/docs/en/cli-reference)
- [原生设置与优先级](https://code.claude.com/docs/en/settings-reference)
- [官方 Agent SDK](https://platform.claude.com/docs/en/agent-sdk/overview)
- 固定安装包 `sdk.d.ts` 中的 `Query.accountInfo`、公开实验 usage 方法、
  `SDKControlGetUsageResponse`、`ModelInfo` 以及累计 `ModelUsage` 契约。
