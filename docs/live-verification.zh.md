# 真实验证记录

这里记录已经用真实产品跑过的验证、时间与结论。它是证据，不是承诺；fake-CLI
测试套件补充覆盖其余确定性分支，未覆盖的项会明确写出。

环境：

- DSH `0.2.2-rc.1`，desktop profile，插件从本仓库安装
  （`dsh-subagent-claude-code-pro` v0.3.1）。
- `claude` CLI `2.1.319`（本地安装、原生账号登录）。
- 委派使用模型 `haiku`；父会话使用 `cordis` preset。

## 确定性测试

```
$ npm test
ℹ tests 51
ℹ pass 51
ℹ fail 0
```

覆盖：session 生命周期与失效修复、显式续接、fork 参数、model/effort 透传、
权限收窄、图片/PDF 编码、`tool_result` 图片投递与父 route 门控、结构化输出校验、
后台任务结算、超时、取消、spawn 失败、认证失败分类、协议垃圾数据。

## 真实 CLI 冒烟（`scripts/probe-live.mjs`）

```
PASS  new session + text  cli=2.1.319 model=claude-haiku-5-5 text="LIVE_OK"
PASS  session resume + recall  text="8642" cacheRead=12134
LIVE PROBE OK
```

证明：真实 Claude Code session 可以使用调用方指定的 session id 创建；同一工作目录
下新的 CLI 进程可以续接该 session；续接轮次复用了 prompt cache
（`cache_read_input_tokens` > 0）。

## DSH 会话 E2E，第一轮（安装后的插件，通过 `subagent_claude_code`）

真实 DSH 会话中的探测子 Agent 顺序调用工具五次。括号内是
`~/.dsh/claude-code-pro.log` 的诊断证据。

| # | 能力 | 结果 | 证据 |
|---|---|---|---|
| 1 | 文本委派 | 通过 — `PROBE_ONE` | `run: ... session=new ...`；`cacheRead=9076` |
| 2 | Session 复用（默认 `session` 模式） | 通过 — 回答 `8642` | 第二次运行 `session=resume resume=6a947f18-...`，`cacheRead=11940` |
| 3 | 图片输入（`images`） | 通过 — 对注入的 PNG 回答 "red" | `run: ... images=1 ...` |
| 4 | `output_schema` | 通过 — 精确返回 `{"ok":true}`，无散文、无 session 后缀 | `schema=yes` |
| 5 | 后台任务（`run_in_background`） | 通过 — 返回 job id，`job_output` → `completed`，结果 `BG_OK` | `serve: background job subagent-... started` |

不存在的图片路径会在任何进程启动前被拒绝
（`claude-code-pro: image does not exist: ...`），已在真实 DSH 会话中验证。

## DSH 会话 E2E，第二轮（fork、图片输出、PDF）

重新登录本地 CLI 后，第二次探测的五次顺序调用全部通过、无重试。

| # | 调用 | 结果 | 证据 |
|---|---|---|---|
| 1 | 新建持久 session | 通过 — `SEQ_ONE`，session `671c4f61-198d-4a5e-ab71-0db8ecb3e4b0` | `run: ... session=new` |
| 2 | 对该 id 使用 `fork_session: true` | 通过 — 新 id `30a1cdf3-3201-4307-a5fb-9cf349fef501`，回忆出 `2468`（继承历史） | `session=resume resume=671c4f61-...` → `run done: session=30a1cdf3-...` |
| 3 | 图片输出（Claude Code `Read` 当前目录图片，`ephemeral`） | 通过 — 回答 "Red"；tool result 携带调用方可见的真实 `image/png` attachment block（`~/.dsh/attachments/...`） | `run done: ... images=1 delivered=1` |
| 4 | PDF 输入（`documents`） | 通过 — 从附件 PDF 中提取 `CCPRO-PDF-42` | `run: ... documents=1` |
| 5 | fork 之后显式续接原 session | 通过 — 回忆 `2468`；marker id 等于原始 `671c4f61-...` | `session=resume resume=671c4f61-...` |

## 本地 CLI 凭据注意事项（实测）

本地 Claude Code CLI 把 OAuth 会话存在系统钥匙串中。在反复启动新进程的运行中，
CLI 两次清空了已存 token，并报
`Failed to authenticate: OAuth session expired and could not be refreshed`。
插件从不读取或写入凭据；这是 CLI 自己的状态。恢复方式：`claude auth login`
（用 `node scripts/doctor.mjs` 验证）。无人值守或高频使用时，建议用静态子进程
凭据（`claude setup-token` → 插件 `env.CLAUDE_CODE_OAUTH_TOKEN`，或
`env.ANTHROPIC_API_KEY`），避免钥匙串刷新路径。
