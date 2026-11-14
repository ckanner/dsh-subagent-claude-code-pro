# 原生能力（0.5.0 源码候选）

[English](native-capabilities.md) | 中文

本候选版本把原生 Agent、Workflow、Advisor、独立云端 Review 和真实交互式 Team
接入了桌面插件。公开 `dsh-subagent-claude-code-pro/machine` 仍可独立用于调度器；
两者复用同一份 CLI 控制、事件账本与受监督运行实现。运行的是用户本机安装并登录的
Claude CLI。插件不安装第二套 SDK、不改登录态、不把完整任务缩成只读 helper。

## 桌面设置与 PTC 的关系

在 **插件 → dsh-subagent-claude-code-pro → Claude Code Pro 配置行** 打开设置页。
页面编辑 `native` JSON，通过 DSH 自己的配置表单带 revision 保存。冲突或校验失败
会保留草稿；“恢复配置文件默认值”会 unset 用户覆盖，重新露出 profile 值；
“编辑为全部关闭”会把草稿设成 `null`，仍需显式保存。加载示例、保存设置不会启动任务。

`native` 是运行时 Config 中唯一的实时字段。每次调用在开始时读取一次最新快照；
已经运行的任务继续使用它启动时的配置。command、凭据、根权限等仍来自 profile。

| 调用与插件的值 | 有效行为 |
| --- | --- |
| 调用省略 native | 继承调用开始时的插件 native 默认值 |
| 调用和插件均未设置 | 保留原 CLI 的原生默认行为 |
| 调用提供对象 | 整体替换插件默认值，未出现的能力关闭 |
| 调用提供 native:null | 明确全部关闭，不回落到 CLI 默认 |
| 能力声明 enabled:false | 只能保留 enabled:false，不能残留 model、definitions 或并发限制 |

公开 machine 协议不读取桌面配置，也不接收桌面专用的 null 简写；它用
`{version:1}` 显式关闭能力。原生 worker 是 CLI 的能力，PTC 是父 Agent 发起调用的
外层工具通道，两者可以同时使用。最新 DSH 中依旧从 `run_code` 内调用
`await tools.subagent_claude_code({...})`。

下面是可在设置页或 profile 中使用的完整默认值。示例没有人为缩小工具列表；
工具选择与根权限遵循用户配置及 Claude 原生规则。

```yaml
native:
  version: 1
  agents:
    enabled: true
    maxConcurrent: 4
    maxDepth: 2
    definitions:
      implementer:
        description: 完整实现并验证一个模块
        prompt: 使用已批准的原生工具完成整个任务并验证结果。
        model: sonnet
        maxTurns: 20
  workflows:
    enabled: true
    maxConcurrent: 4
  advisor:
    enabled: true
    model: opus
```

definitions 中还可指定 tools、disallowedTools、permissionMode。每个定义必须有
description 和 prompt；最多 128 个定义，名称为字母/数字开头的 1–128 位字母、数字、
下划线或连字符。工具数组最多 256 项；文本、数值及配置总大小由原生校验器限制。
未知字段、错误类型、关闭项残留控制、缺少 Advisor 模型等会在设置保存或调用前失败。

子级的 permissionMode 不能扩大当前根权限。`modelSelection:false` 不会禁用
profile 已配置的子模型和 Advisor 默认模型；单次调用不能新增或修改模型，也不能在
保持 Agent 能力启用时省略已固定的子模型定义。需要完整保留受保护的模型，或明确
关闭该能力。这里不会隐式深度合并旧 definitions，null/关闭仍可用。

在 run_code 中：

```ts
const result = await tools.subagent_claude_code({
  description: "完成迁移",
  prompt: "完整实现并验证迁移，按需使用配置的原生 Agent 和 Workflow。",
});
inspect(result.content);
inspect(result.native);

// 单次完整替换；未出现的 Workflow / Advisor 关闭。
const another = await tools.subagent_claude_code({
  description: "检查实现",
  prompt: "使用已批准工具检查实现并报告证据。",
  native: { version: 1, agents: { enabled: true, maxConcurrent: 2 } },
});
inspect(another.native);
```

## 配置确实如何生效

普通委派把 native 传到真实 CLI 的 argv、settings 与进程环境：

| 控制 | CLI 接口 |
| --- | --- |
| Agent definitions | --agents JSON |
| Advisor | --advisor model，关闭时 CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1 |
| Agent 并发 / 深度 | CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS / CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH |
| Workflow 并发 | CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS |
| Workflow 关闭 | disableWorkflows、CLAUDE_CODE_DISABLE_WORKFLOWS=1 和 Workflow deny |
| 普通 print 调用关闭 Team | CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=0，并拒绝 TeamCreate/TeamDelete |

整替换会清掉 plugin env 中旧的并发/深度值，避免 off 或新值留着旧限制。进程级覆盖
不修改用户全局配置文件。已有 project/user agent 定义仍由 CLI 原生加载。

init 的 tools 和 agents 会用于校验请求的工具面；不匹配会失败。
`native.effective.verification:'tools-only'` 明确说明这是工具面验证，并未反射核实
并发/深度、Advisor 实际激活/模型、根与子权限优先级。Claude print 没有可证明的
prompt 发送前配置握手，不能把收到 init 当成派发前 ACK。权限模式是工具审批政策，
不是操作系统沙箱；根 bypassPermissions 在 Claude 自身规则下可能优先于子级 plan。

`native.resourceBounds.hard=false` 始终如实返回。普通 Agent 并发不是全局进程
硬上限；ultracode、部分 fork/resume 路径有原生例外，Workflow 使用独立 worker cap。
实现会在观察到超额普通 Agent 或 Workflow worker 后取消并清理本地进程组，但这不是
派发前 semaphore，缺失事件也无法证明精确并发。原生 USD budget 与账号实际账单、
订阅用量或远端责任不能混为一谈。

## 会话、事件和完成结果

自动 session 复用要求 cwd、native、model、effort、permission、settingSources 和
env 的有效快照一致，且该 session 空闲。实时设置变化后自动调用会新建 session；
显式续接本插件已绑定且配置不一致的 session 会拒绝。外部未知 session 可以显式
续接，并在本次调用重新发送 argv/settings/env，再验证 init 工具面。回执仍保留不能
反射确认的字段，不把调用参数当作实际运行证据。

原生账本关联 tool_use、parent_tool_use_id、task id、parent task id 与 opaque run id。
run id 不按字符串排序；旧 run 的迟到完成不能结束新 run；子 transcript 不能成为根
完成结果。background snapshot、tool_result 与 task 通知按身份对齐，避免重复 child。
Workflow 后续根结果必须带合法的原生 task-notification provenance。

根用量与子级 high-water snapshot 分开保存。子快照不是增量，不会再次加到根用量。
`childSnapshotsAreAdditive:false`，出现子任务时 family aggregate 仍可未知；
多个根结果各自保留观测值，不猜测会话累计值是否可加。价格估算不等于账号收费。

普通调用的 canonical result 在 content 旁附带 native，记录 requested/effective、
children/events、usage、completion 与 cleanup。后台进度也记录原生事件及终态摘要。
有 output_schema 的最终文本始终是纯 JSON；前台和后台都不拼 session marker、
原生摘要或图片投递提示到 JSON 正文。

根结果成功但仍有观测到的 child 未完成、native 配置不匹配，或远端清理未确认，都不能
返回普通委派成功。guardian 清理本地进程组与远端任务是否结束是独立事实。
取消会等待真实本地清理，并保留原生未决证据。

## 独立 Review 与 Team

第二个 PTC 工具名为 `subagent_claude_code_native_job`；若配置了自定义 toolName，
对应名称为 `<toolName>_native_job`。普通 native 默认开关不会自动启动这些作业。

| action | 行为 |
| --- | --- |
| review | 每次必须 consent:true，调用实际 ultrareview --json --no-post；trust_workspace 另行显式声明 |
| team | 真正的交互式 tmux/Claude Team；要求 Agent 能力启用。完全没有 native 默认或覆盖时，该显式操作启用其必需的 Agent 能力 |
| recover | 按当前 Agent 的 job_id 读取原始持久化回执，不扫描、不重放、不创建新作业 |
| control | 仅对当前 Agent 拥有的 Team 执行 capture/send/resize/attach/cancel |

Review 和 Team 都通过 DSH jobs 返回后台 jobId。启动记录即使在 DSH 延后运行 worker
时也会先持久化；调用方取消外层程序不会把云端 Review 变成无法定位的前台操作。
job_output 读取完整 JSON receipt，job_kill 调用真实 supervisor 取消。Agent 销毁时由
DSH owner cleanup 取消并等待作业；插件 reload 不额外杀死已被 jobs 接管的任务。

```ts
const review = await tools.subagent_claude_code_native_job({
  action: "review",
  description: "原生云端审查",
  consent: true,
  target: "main",
  timeout_minutes: 45,
  timeout_ms: 2730000,
});
inspect(review);

const team = await tools.subagent_claude_code_native_job({
  action: "team",
  prompt: "组织 Team，完整实现并交叉审查独立模块。",
  native: { version: 1, agents: { enabled: true, maxConcurrent: 4 } },
});
inspect(team);

// interactive-ready 后：
inspect(await tools.subagent_claude_code_native_job({
  action: "control", job_id: team.jobId, control: "capture",
}));
inspect(await tools.subagent_claude_code_native_job({
  action: "recover", job_id: review.jobId,
}));
```

独立作业必须有 DSH jobs 服务。review 的 timeout_minutes 是 CLI 等待远端的分钟数；
timeout_ms 是本地 deadline，默认继承 plugin runTimeoutMs，长作业应明确设置协调值。
Team 可传 columns/rows、cwd 及策略允许的根 model/effort/permission。tmux 默认从 PATH
寻找，可信 profile 可用 tmuxCommand 指定绝对路径，模型调用不能选任意可执行文件。

普通 print 流程不能冒充交互 Team：后者使用隔离 tmux socket、fresh session id、
--teammate-mode in-process，并实际把 Agent Teams 环境开关置为 1。尚未 ready 时控制
返回 pending；若需要在准备阶段取消，用 DSH job_kill。capture 是有界显示文本；
attach 返回用户终端应执行的命令与参数；send 通过 tmux buffer 发送字面文本；
cancel 接受请求不代表已经清理完毕，最终 receipt 才报告本地清理证据。

所有恢复证据放在 `$DSH_HOME/data/claude-code-pro/native-jobs/` 下，按 Agent hash
分桶。目录为私有 owned 0700，映射文件为 0600，拒绝 symlink，并 fsync 文件/目录。
machine 运行目录由底层 journal 独占创建；第一次 awaited lifecycle 会先持久化
owner/job/request/run 映射，再 ACK 允许继续派发。recover/control 只接受 job_id，
不会接受任意 recoveryDirectory、PID 或 socket，也不能接管其他 Agent 的记录。
映射不保存凭据；显式 Anthropic API/auth、Claude OAuth 和 base URL 值使用 machine
的 credentialEnv 通道，避免被 ambient-secret filter 再次过滤。

Review 的非零退出、超时或取消可能留下远端未知责任。本地 CLI 已停止不代表云端
已取消；remote.querySupported/cancelSupported 仍为 false，未知状态不可自动重跑。
重新 review 可能重复收费。receipt.ok=false 会落为 failed/killed，不因为 Promise
正常 resolve 就伪报 completed。恢复只读取原始证据。

Team 的干净 pane exit 可以证明进程正常结束，但
`completion.businessOutcome:'unknown'` 不会认证代码任务完成或 Reviewer 通过。
不承诺不可靠的 Team/teammate 自动续接；无人值守结构化调度应使用普通 Agent/Workflow
machine 查询。

## 独立 machine API

```js
import { runMachine, runNativeReview, runInteractiveTeam,
  recoverNativeJob, controlInteractiveTeam } from 'dsh-subagent-claude-code-pro/machine'

const receipt = await runMachine({
  protocol: 1, requestId: 'implementation-1', cwd: '/repo/worktree',
  prompt: '完整实现并验证任务。',
  permissionMode: 'acceptEdits', sessionMode: 'persistent',
  native: { version: 1, agents: { enabled: true, maxConcurrent: 4 } },
}, {
  recoveryDirectory: '/repo/evidence/implementation-1',
  onLifecycle: async event => { /* 先持久化检查点，再返回 */ },
  onNativeEvent: event => { /* 仅显示，不是派发 ACK */ },
})
```

machine 不导入桌面 Config、home-paths 或 React。调用方自己传显式 machine 请求和
owned recoveryDirectory；桌面配置不会隐式影响 Flywheel 的 machine request。
machine 还支持图片、结构化输出与 budget；详见
[Machine API](machine-api.zh.md)、[Lifecycle](machine-lifecycle.zh.md) 及
[英文原生协议示例](native-capabilities.md#normal-machine-queries)。

## 验证范围

CI 在 Linux/macOS、Node 22/24 上使用真实子进程 fixture 校验 PTC 参数到 CLI 的
argv/env、普通 native completion/failure/cancel、独立 Review/Team 的真实命令和
控制协议、owned journal 恢复、取消及未知远端责任。设置测试使用真实 Schemastery，
包括序列化后 new Schema 的再解析；浏览器入口通过真实 React 渲染并测试 revision
冲突、显式 off/reset 和单参数 ModuleLoader。Host 契约还运行实际 published DSH
和固定当前桌面源码的 schema validator / PTC SDK codegen，防止参数整体退化为 unknown。

打包 consumer 在没有 DSH runtime peers 的安装中验证公开 machine API。测试没有调用
付费 Claude 模型，也没有实际账号的云 Review 或真人交互 Team 验收。本轮本地执行服务
不可用，运行证据来自 GitHub Actions；源码仍是 0.5.0 候选，不代表已经发布 npm。

主要原生参考（2026-11-14）：
[Subagents](https://code.claude.com/docs/en/sub-agents)、
[Workflows](https://code.claude.com/docs/en/workflows)、
[Agent Teams](https://code.claude.com/docs/en/agent-teams)、
[Advisor](https://code.claude.com/docs/en/advisor)、
[Ultrareview](https://code.claude.com/docs/en/ultrareview)、
[Stream/task 协议](https://code.claude.com/docs/en/agent-sdk/typescript)。
DSH 对照版本为
[39163dd30f703a79079e2d2446545cff3c453738](https://github.com/deepseek-ai/deepseek-harness/tree/39163dd30f703a79079e2d2446545cff3c453738)。
