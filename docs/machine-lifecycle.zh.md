# 结构化生命周期与只读恢复（lifecycle 1）

**0.4.0 未发布源码候选**为公开
`dsh-subagent-claude-code-pro/machine` JavaScript API 增加检查点与恢复。
结果协议仍为 1，原 DSH 桌面工具保持兼容；源码更新不代表 npm 已发行或账号已升级。

## 显式启用

`runMachine(request, runtime)` 新增 `onLifecycle(event)` 和
`recoveryDirectory`。回调是程序持久化 ACK：调用者原子保存并 fsync 对应检查点
后才 resolve，拒绝则 reject；它不是新的用户审批。恢复目录必须是已有物理父目录
下的**全新绝对路径**，不是符号链接、别名或已有目录。supervisor 独占创建 0700
目录；每个 engine invocation 一个路径，不能复用原目录来自动再跑一次。

```js
import { runMachine, recoverMachine } from 'dsh-subagent-claude-code-pro/machine'
const receipt = await runMachine(request, {
  recoveryDirectory,
  signal: controller.signal,
  onLifecycle: event => engine.persistCheckpointAndFsync(event),
})
const recovered = await recoverMachine({
  protocol: 1, requestId: request.requestId,
  runId: savedCheckpoint.runId, recoveryDirectory,
})
```

`onProgress` 仍仅供展示，不能作为检查点。角色、任务、原候选／guard／报告与预算
由 Go 等调用者持有；插件只保存单次调用证据，不写 engine state。

## Claude 的实际能力

`MACHINE_LIFECYCLE_VERSION=1`，capability 为 `{version:1,
 durableJournal:true, readOnlyRecovery:true, threadReadyBeforeDispatch:false}`。

当前 stream-json 通路是在 prompt 提交后观察 `system/init`。本适配器没有验证过
prompt 前配置握手，也没有稳定 per-turn ID。因此**不发送 thread-ready 或
turn-accepted**，不猜 control request，也不把预分配 UUID 当作历史已打开证据。
实际目录、模型、原生权限和 session 仍在终态中用真实 init 核对；不匹配就失败。

事件统一包含 `lifecycleVersion:1`、`type:'lifecycle'`、`requestId`、`runId`、从 1
递增的 `sequence`、`event`、`threadId`、`turnId:null`、`persistent`、
`configuration`、`dispatch`、`outcome`、`cleanupConfirmed`。派发前 threadId
只是拟用／请求 UUID，ephemeral 可为 null；persistent 只是请求的历史模式，
configuration 为 null，都不能当作 CLI 已接受或 rollout 可恢复的证明。

| 事件 | 含义 |
| --- | --- |
| dispatch-intent | prompt 尚未送入，等待调用者持久化 ACK。 |
| dispatch-possible | 在交给 native runner 前落盘并等待 ACK；之后发送与确认之间仍可能不确定。 |
| terminal | native 终态与清理事实已形成，完整原始回执已先 fsync。 |
| cleanup-confirmed | 仅在清理真实确认、回执已持久化后发出；调用者可保存原候选／guard／报告再 ACK。 |

终态通知在 native 收尾后交付，两个最终事件携带相同事实。即使通知或最后 ACK
丢失，也不会把原已成功的 native 调用改写为 cancelled。未发送 prompt 的失败可
直接走失败终态。

`execution.dispatch` 保留原进程含义：not-dispatched／dispatched 表示是否启动
native 进程。新增 `execution.turnDispatch` 与事件 dispatch 表示请求边界：
not-dispatched／possible／accepted。可信 CLI 终态能证明接受，PID 启动不能。
possible 屏障拒绝仍保留 possible，即使测试未观察到 CLI 启动；实际观察到的
ENOENT 等完整启动失败则可以证明 not-dispatched。

## 监督、落盘与恢复

任一新选项启用后，独立进程组中的 machine supervisor 先建立 IPC lifeline，再
持有原 native guardian。调用者或其整个进程组被强杀，会拒绝正在等待的 ACK、
取消原调用；supervisor 等 native 清理完成后仍可持久化回执，不依赖调用者存活。

完整回执先于 terminal／cleanup 通知落盘。0600、最多 64 MiB 的 journal 写入独占
临时文件，fsync 后原子 rename，再 fsync 目录；新目录的父目录也 fsync。精确
request/run 身份与 SHA-256 检查识别损坏或错配。记录不是第二套状态机，不触发
自动重试。supervisor admission 与每次 ACK 有 10 秒上限，原调用 deadline 还
覆盖 prompt 前检查点与剩余 native 运行；断开会立即解除等待，不拖住清理。

`recoverMachine` 只读已知身份对应的一个 journal：不启动 CLI、不访问模型、
不 resume、不扫历史、不杀进程、不写文件、不重放。必须提供已知 runId；不会
用 PID 存在认领所有权，也不会从 PID 不存在伪造清理回执。

| status | 能证明什么 |
| --- | --- |
| terminal | 返回原始完整 receipt；可能仍是失败、unknown 或清理未确认，必须继续核对独立事实。 |
| pending | 身份匹配但没有持久化完整终态；不证明 owner 存活、调用仍运行或可安全重放。 |
| unknown | 缺失、不可读、损坏或身份不符；不猜派发、结果和清理。 |

回包含最新 lifecycle、已有的原始 receipt 和原因。事件在通知调用者前已保存，
所以其存在不证明 Go 已 ACK。只有 Go 自己的检查点能绑定原候选／guard／报告；
若这个快照保存前调用者就死了，可以核对原消耗，但不能重启后拿当前文件冒充旧
验证证据。若 machine supervisor 也在落盘前死亡，native guardian 可能完成
物理清理，但 journal 仍应保持 pending。未知 runId、丢失历史、逃离进程组、
多重 supervisor 丢失及超出 fsync 保证的断电，都不构成 exactly-once。
requestId 不是服务端幂等键；事实不足时 fresh 和 resume 都必须阻断。

保留与删除由调用者负责：原回执一次且仅一次应用／计量且满足审计期限后再删除，
未知调用的证据不能为绕开阻断而删除。插件导入不扫描历史、不自动删档、不改桌面
配置。环境凭证不复制到记录，但模型原始输出可能包含敏感用户内容，仍需按私有
任务材料保存。

离线测试使用真实子进程检查 ACK、拒绝、凭证边界、独占、损坏、只读以及派发前、
执行中、终态后的整组 SIGKILL，并证明最终通知丢失仍保留原成功回执。这些不是
真实账号、桌面、质量、缓存或费用测量，详见[验收记录](machine-lifecycle-validation.md)。
