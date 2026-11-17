# dsh-subagent-claude-code-pro

English | [中文](README.zh.md)

**0.4.0:** a public, typed
[`/machine` API](docs/machine-api.md) now supports orchestration with explicit
session identity, observed configuration, per-invocation usage, and confirmed
process-group cleanup. It also provides durable pre-prompt checkpoints and
[read-only recovery](docs/machine-lifecycle.md), without inventing a Claude
pre-prompt configuration handshake. 0.4.0 is now published to npm; the desktop behavior and live-verification
record below still refer to 0.3.1.

A Claude Code delegation tool for DeepSeek Harness. From **0.6.0**, ordinary
delegations use the official **`@anthropic-ai/claude-agent-sdk@0.3.326`** with
your configured local `claude` executable. The plugin adds the choices the
official `@deepseek-ai/dsh-subagent-claude-code` provider cannot express:

- **a model and a thinking level per call** (`--model`, `--effort`);
- **durable Claude Code sessions that later calls can continue**
  (`--session-id` / `--resume`, or one session per DSH Agent session);
- the permission mode a call may narrow, never widen;
- a per-delegation deadline, caller cancellation, and process-group cleanup;
- diagnostics in `~/.dsh/claude-code-pro.log`, because a plugin has no log
  surface a session can read.

The 0.6.0 migration is a source candidate. See the [SDK validation record](docs/sdk-migration-validation.md)
for exact SDK/native versions, independent review and real native history checks.

> **Status:** `0.3.1` is the first fully live-verified release and ships the DSH
> plugin display metadata (icon, eight locales). Text, model-native image and PDF
> input, image output, `output_schema`, background jobs, and the session core
> (including fork) were exercised against a real local `claude` CLI and a real
> DSH session. See the verification record ([English](docs/live-verification.md) ·
> [中文](docs/live-verification.zh.md)) and `CHANGELOG.md`.

## Native desktop and machine capabilities

The plugin exposes native Agent/Workflow/advisor controls from its **own Configure page and PTC tool**, as well as the independent machine API. The Plugins page saves live `native` defaults; ordinary calls inherit them, a per-call object replaces them, and `native:null` explicitly turns all off. With no plugin default, existing omitted-native calls retain their CLI behavior.

From plugin 0.5.1, native Agent definitions can request a separate `model` and `effort` for each child; see [child effort and CLI precedence](docs/native-capabilities.md#per-agent-effort).

From 0.5.2, long-running queries expose bounded activity from root and child streams, including thinking and tool work. The plugin checks required CLI flags before sending a prompt and names fresh persistent machine sessions. See [activity, compatibility and names](docs/machine-api.md#observed-activity-and-cli-compatibility-052).

The separate `subagent_claude_code_native_job` PTC tool starts explicit native Review/interactive Team jobs and provides owned recovery/control. Review always requires `consent:true`; enabling ordinary native capabilities starts no independent job. See [desktop settings, PTC examples, exact native limits and validation](docs/native-capabilities.md) ([中文](docs/native-capabilities.zh.md)).

## Why this exists

The official provider is deliberately a one-shot adapter over the bundled Agent
SDK:

- it always starts a fresh SDK query and sets `persistSession: false`;
- it rejects non-text prompt blocks;
- its harness row cannot expose `model` or `reasoning_effort`
  (`NO_START_CAPABILITIES`, no `agentOptions`);
- DSH's subagent seam treats externally executed children as one-shot, so it
  cannot accept follow-up messages or resume at all.

This plugin owns its model-facing tool instead, the same registration path Codex
Pro uses (`ctx.on('agent/created')` → `agent.ctx.tools.register`). Ordinary calls
use the SDK's `query()` and control protocol. The SDK starts the configured
native executable inside the existing supervised process group; the plugin
retains session identity, real activity, terminal validation and physical cleanup.
Native Review and interactive Team remain explicit native CLI operations.

### Runtime, settings and authentication

`command` remains authoritative (`claude` by default, or an explicit absolute
path). The SDK does not silently switch a missing or incompatible local command
to its bundled runtime. Installing the SDK may also install its optional native
platform package; executable selection remains explicit.

`HOME`, `CLAUDE_CONFIG_DIR` and `settingSources` retain their existing meanings.
The native executable resolves authentication; the plugin does not read or copy
login credentials. Existing local login availability is a technical property of
that runtime and environment, not a promise that every subscription is authorized
for a third-party integration. Anthropic's [Agent SDK documentation](https://code.claude.com/docs/en/agent-sdk/overview)
directs third-party products to API authentication unless separately approved to
offer claude.ai login or rate limits. Configure authorized credentials explicitly
through `env` (or the machine API's `credentialEnv`); ambient credential-shaped
variables continue to be removed. SDK installation alone does not establish
authentication or change the selected account.

## Install

Install from the npm registry — no local checkout and no `link:` dependency:

```sh
dsh plugin --profile <profile> add dsh-subagent-claude-code-pro
```

For the desktop app's managed profile use the app's **Plugins** page →
**Add plugin** → enter the package name `dsh-subagent-claude-code-pro`; the plugin
manager runs the same pnpm install. The profile records the installed version
(for example `0.3.1`), not a path to a working copy.

The bundle adds one root row and registers a per-Agent tool named
`subagent_claude_code` for the presets named in `presets`. Because the tool name
is the official one, the scoped registration shadows the official global tool
for those Agents. Do not mount a second same-name tool row in the same scope.

## Use

The model-facing tool takes a self-contained task:

```js
subagent_claude_code({
  description: "Fix the redirect loop",
  prompt: "…complete task; you cannot see this conversation…",
  model: "sonnet",              // alias or full id; omit for the configured/native default
  reasoning_effort: "high",     // low | medium | high | xhigh | max
  permission_mode: "acceptEdits",
  session_mode: "persistent",
  session_id: "…uuid…",         // continue a session a previous run reported
  fork_session: false,
  images: ["/abs/shot.png"],    // handed to Claude as an image, not a path to open
  documents: ["/abs/spec.pdf"], // handed to Claude as a document
  output_schema: { … },         // the answer must be JSON conforming to this schema
  run_in_background: false,     // return a DSH job id instead of waiting
  cwd: "/abs/path",
  timeout_ms: 600000,
})
```

A completed human-text answer ends with a marker so the model can continue the
conversation deliberately:

```
[claude-code session 3b5585e1-… · persistent · pass it as session_id to continue]
```

### Session lifetime

| `sessionMode` | Behaviour |
|---|---|
| `session` (default) | One durable Claude Code session per DSH Agent session; later delegations continue it automatically. Cache-friendly, intended for sequential work. |
| `persistent` | A durable session per call; the id is reported and can be continued explicitly. Independent tasks do not share context. |
| `ephemeral` | `--no-session-persistence`: nothing is written that can be resumed. |

Rules: an explicit `session_id` always continues that session (a failed resume
is reported, never silently replaced); a remembered session is reused only in
the directory it was created in, with the same effective native/model/permission settings, and only when no other delegation is using it;
a remembered session that no longer exists is repaired by starting a fresh one,
with the reason in the diagnostic log. `fork_session: true` branches a continued
session into a new id.

Durable history does not imply automatic inclusion in Claude's session picker
or Desktop sidebar. Claude excludes print/SDK sessions from the ordinary picker;
use the reported UUID with `claude --resume <session-id>`. A completed session
can also be opened explicitly in a supported Claude Desktop installation. See
[native CLI and Desktop history](docs/machine-api.md#native-cli-and-desktop-history)
for the handoff commands, configuration-directory requirement and ownership rules.
From 0.5.3, a persistent request fails before CLI dispatch when its forwarded
`CLAUDE_CODE_SKIP_PROMPT_HISTORY` enables history suppression. Unset that setting
or explicitly choose ephemeral mode; the plugin preserves the user's preference.

### Multimodal input

`images` takes absolute paths (PNG, JPEG, GIF, WebP) and `documents` takes PDF
paths. They are checked before anything is spawned — a nonexistent or oversized
attachment fails the call instead of starting a run without the file the task was
about — then encoded as Anthropic Messages API `image` / `document` blocks in the
stream-json user message. Claude receives them natively; it is not asked to open
a file itself. Other file types stay referenceable by path in the prompt, because
Claude Code can read them with its own tools.

### Images out

Claude Code can look at pictures and take screenshots; those arrive as base64
image blocks inside `tool_result` messages. The plugin hands them to the DSH
attachment store and returns image blocks beside the answer, so a parent model
that accepts images sees them. Nothing here can fail the delegation: a missing
store, a parent route that declares no image input, or an unreadable payload
becomes a text note instead. A background run's result is a string by contract,
so its images are written under `$DSH_HOME/claude-code-pro-images/` and reported
as host paths in that text.

### Structured output and background runs

`output_schema` becomes the SDK's `outputFormat` schema: the final answer is JSON, the
plugin re-validates it against a supported schema subset and fails closed on a
non-JSON or non-conforming answer. A schema-constrained result stays pure JSON
(no session marker).

With DSH's jobs service mounted, `run_in_background: true` returns a job id at
once; the delegation runs in a jobs worker (`job_output` collects it, `job_kill`
stops it). Claude Code's own `--bg` is a terminal-session feature, not a tool
result channel, so the plugin uses the harness mechanism the official subagent
tools and Codex Pro use.

### Authentication and the CLI's credential store

The plugin never reads, creates, refreshes, or rewrites credentials; the native
runtime owns authentication. For this third-party SDK integration, configure
authorized API credentials explicitly, for example `env.ANTHROPIC_API_KEY`.
Other native authentication arrangements require the applicable authorization;
using the SDK does not grant subscription eligibility.

Run `node scripts/doctor.mjs` to check the selected executable's `auth status`.
Doctor reports only whether native authentication is available, without reading
keychain contents or printing tokens, token lengths, or the raw auth response.
Its guidance identifies the failing prerequisite instead of always requesting
a new login. The [earlier live verification record](docs/live-verification.md)
preserves historical CLI credential-refresh observations.

### Permissions

The default is `dontAsk`, the unattended mode: the CLI never waits for a human,
and anything not already approved is denied (`--permission-prompts none`). A call
may narrow the configured policy, never widen it. Use `plan` for planning-only
work and `acceptEdits`/`auto`/`bypassPermissions` only by changing the plugin
configuration explicitly.

## Configuration

```yaml
- id: claude-code-pro
  name: 'dsh-subagent-claude-code-pro'
  config:
    toolName: subagent_claude_code   # the official name; override to coexist
    command: claude                  # or an absolute path
    # tmuxCommand: /absolute/path/to/tmux  # optional, independent Team jobs only
    presets: [daily, heavy, cordis]
    modelSelection: true             # expose model / reasoning_effort
    permissionMode: dontAsk          # plan | dontAsk | acceptEdits | auto | bypassPermissions
    sessionMode: session             # ephemeral | persistent | session
    runTimeoutMs: 600000             # 0 disables the deadline
    model: sonnet                    # optional default
    reasoningEffort: high            # optional default
    settingSources: [user, project, local]
    env: {}                          # only the entries the child really needs
    disposeGraceMs: 3000
```

The child environment is the ambient environment minus `DSH_*` and minus
credential-shaped names (`KEY`, `PASSWORD`, `SECRET`, `TOKEN`); explicit `env`
entries are applied afterwards. This keeps harness deployment secrets out of a
process a model can talk to, and means an API key or relay token the child needs
must be named in `env`.

## Requirements and caveats

- A local `claude` executable with authorized authentication available to its
  environment. The plugin does not perform login or manage credential refresh.
- The local runtime must be stable Claude Code **2.1.325 or newer**, the minimum
  validated version for SDK 0.3.326. The SDK checks its actual initialize response
  before releasing task input. The pinned SDK and runtime must support the query initialization,
  permission and streaming options in use. The plugin checks required CLI flags
  before the task and validates the resulting stream; an unreadable result or
  incompatible runtime fails the call. A version label alone is not admission.
- The DSH desktop app captures its environment at launch. If `claude` is not on
  that PATH, set `command` to an absolute path.
- The child runs with the CLI's native settings, hooks, MCP servers, plugins and
  skills. It is not a sandbox: the permission mode is the boundary.
- PDF/image input and SDK structured output require compatible native support.
  Initialization or output validation failures do not silently discard them.
- Concurrent delegations spawn concurrent CLI processes. That is fine for most
  work, but the CLI's own credential refresh is shared state; heavy parallelism
  is the CLI's constraint, not something this plugin manages.
- Windows delegations are rejected before a CLI process starts because process-tree
  cleanup is not implemented there; supported POSIX runs own a process group.

## Troubleshooting / doctor

A local CLI check that sends no model request:

```sh
node scripts/doctor.mjs
```

It checks the exact installed Agent SDK and its public query import, the native
executable/version, `claude auth status` and required CLI flags. It supports native
API authentication without requiring subscription tokens and never opens the
keychain or credential files. Exit code is non-zero when a prerequisite fails.
These are static checks; every real query still verifies its own initialize
response before task input. Authentication status is not a paid model test.

## Diagnostics

`~/.dsh/claude-code-pro.log` records the applied configuration (not `env`
values), each delegation's resolved model/effort/session/permission/timeout, the
CLI version and model reported on `system/init`, completion or failure category,
cleanup confirmation, and cache-read tokens. Read it first when a delegation
appears to do nothing.

## Verification

- `npm test` — deterministic tests against a fake `claude` CLI covering
  session lifetime, resume repair, multimodal encoding, image delivery and route
  gating, structured output, background jobs, timeout, cancellation, and
  failure classification.
- Machine-contract tests additionally cover strict configuration/session
  observations, malformed terminal streams, no-dispatch receipts, and failed
  process-group probes. See [Machine API v1](docs/machine-api.md).
- `node scripts/probe-live.mjs` — real-CLI smoke: new session, final text, and a
  resumed turn that recalls the prior message with prompt-cache reuse.
- Real DSH-session E2E through the installed tool: text, session reuse,
  `fork_session`, image input, image output (a real attachment block reached the
  caller), PDF input, `output_schema`, and a background job all passed. Evidence
  and commands: [docs/live-verification.md](docs/live-verification.md)
  （[中文](docs/live-verification.zh.md)）.

## Development

```sh
npm ci               # development peers and React/DSH contract checks
npm test             # deterministic; uses tests/fixtures/fake-claude.mjs
npm run test:host    # actual published + pinned current DSH schema/PTC projection
npm run test:package # installed /machine consumer without DSH runtime peers
node scripts/probe-live.mjs   # real CLI smoke test; needs a logged-in local CLI
```

The fake CLI speaks the same stream-json shape, so session reuse, resume repair,
timeouts, cancellation, auth failures, and protocol failures are covered without
network access.

## License

MIT.
