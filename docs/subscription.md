# Native subscription admission

This source candidate adds an **opt-in** `subscription-only` policy to the existing
official Agent SDK → configured local Claude Code execution path. The plugin
does not implement OAuth, export tokens, change account settings, replace the
executable, or fall back to an API account. Existing callers that omit the policy
keep their explicit API/native authentication behavior.

## DSH configuration

Add the policy to the existing plugin row, retaining its authorized permissions:

```yaml
config:
  command: claude
  model: claude-opus-5-5
  reasoningEffort: high
  subscription: {version: 1, mode: subscription-only}
  env: {}
```

Use the official CLI's existing login in this machine's `HOME` /
`CLAUDE_CONFIG_DIR`. Do not put an API key, bearer token, OAuth token export, base
URL or cloud-provider selector in this configuration. The policy requires a
first-party subscription reported by that native process and an explicit native
`extra_usage.is_enabled: false`. Missing evidence is a blocking result.

The static plugin policy applies to foreground, PTC and DSH background
delegations. A per-call model/native override cannot disable it. Separate
remote Review and interactive Team dispatch (including Team send/attach) is
blocked while this policy is configured: those transports have no equivalent
same-process, pre-prompt usage check. Recovery, capture, resize and cancellation
remain available for previously created owned jobs. Ordinary SDK delegation
and its allowed native Agent/Workflow/Advisor capabilities remain available.

## Machine request and inspection

```js
import { runMachine, inspectSubscription } from 'dsh-subagent-claude-code-pro/machine'

const selection = {
  protocol: 1, requestId: 'task-plan', cwd: '/absolute/worktree',
  command: '/absolute/path/to/claude', model: 'opus', effort: 'high',
  settingSources: ['user', 'project', 'local'],
}

// Read-only native controls; no task prompt or model query is submitted.
const diagnostic = await inspectSubscription(selection)

// Execution independently repeats admission in its own initialized process.
const result = await runMachine({
  ...selection, prompt: 'Plan the approved change and its verification.',
  permissionMode: 'plan', sessionMode: 'persistent',
  subscription: { version: 1, mode: 'subscription-only' },
})
```

`inspectSubscription` accepts `protocol`, `requestId`, `cwd`, `command`, `model`,
`effort`, `settingSources`, `timeoutMs` and `disposeGraceMs`. Its optional runtime
accepts the same `env`, `credentialEnv` and `signal` semantics as execution.
It does not accept a prompt, session, account attestation or billing boolean.
Inspection returns `type: 'subscription-inspection'`, `ok`, `subscription`,
`promptDispatched: false`, `cleanup` and `failure`.

The command-line doctor calls the same public implementation:

```sh
CLAUDE_PRO_COMMAND=/absolute/path/to/claude node scripts/doctor.mjs \
  --subscription-only --model claude-opus-5-5 --effort high --cwd /absolute/worktree
```

`--setting-sources user,project,local` is optional. The check uses the same
configured command, cwd, HOME, configuration directory, selected settings and
filtered child environment as execution. The default doctor without this flag
continues to perform its compatible static executable/auth/flags checks.

## Exact admission sequence

1. Validate the policy and explicit model, reject known credential/provider,
   fallback, fast-mode and effort conflicts, and freeze the requested model ID.
2. Perform the existing bounded CLI help probe with the same child environment.
3. Start the configured executable through **`@anthropic-ai/claude-agent-sdk@0.3.326`**
   in the existing owned guardian/process group. Verify its actual initialize
   response and any reported model effort-capability conflict.
4. While the async user-message generator remains closed, read `accountInfo()`
   and call the public experimental
   `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({skipBehaviors:true})`
   on **that same query/process**. No `/usage` prompt, token-count model call,
   private endpoint, credential-file read or account mutation is used.
5. Require a first-party `pro`, `max`, `team` or `enterprise` subscription,
   matching subscription types in both responses, available plan limits, the
   pinned response shape, and `rate_limits.extra_usage.is_enabled === false`.
   Only then release the single task message. Inspection closes the process
   without releasing a task message.

The experimental API can change or disappear. The exact SDK version and full
admission response contract are checked; unsupported controls, unexpected
fields, null/missing flags, contradictory evidence and errors block dispatch.
Preflight has a 10-second bound even when the task deadline is disabled. A
shorter task deadline or cancellation still wins. Every path retains physical
process-group cleanup.

Known settings conflicts are read from the selected user/project/local JSON
settings (including applicable ancestor paths) and installed managed JSON
files. The invocation also supplies `forceLoginMethod: 'claudeai'`,
`fallbackModel: []`, `fastMode: false` and the official fast-mode disable
environment variable. No configuration file is changed. Server/MDM settings
cannot all be reconstructed by a local file scan; the initialized native
account and usage response, and observed model output, remain authoritative
for the facts they actually expose. Hooks, tools and other programs authorized
by native permissions are not a billing sandbox.

## Evidence and limits

Each policy invocation includes a filtered `subscription` receipt:

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

`verified` means only that these native pre-prompt checks passed. It is **not**
an atomic lock on future account settings, a model-entitlement guarantee, a
freshness guarantee beyond the native response, or proof of zero billed cost.
The timestamp records when the plugin observed the response. Account changes
on another device can occur later. Fable access/credits and quota are determined
by the actual account; refusal or quota exhaustion is returned without another
model, provider, paid API or credits fallback. The plugin never claims that
every Pro account includes Fable usage.

`blocked` records a known conflict; `unknown` records unavailable evidence.
Both prevent sending a task. The receipt contains no email, organization,
token, balance, credit amount, utilization percentage or raw account/usage
response. `reportedCostUSD` remains the native API-equivalent estimate;
`costUSD` remains `null` and `costStatus` remains `unknown`.

A CLI process may have been started for inspection while
`execution.turnDispatch === 'not-dispatched'`. The existing
`execution.dispatch === 'dispatched'` still describes process spawn. Durable
lifecycle records and final recovery receipts retain this distinction.

## Model and effort evidence

The documented first-party aliases are frozen to this reviewed catalog:

| Alias | Canonical target |
| --- | --- |
| `fable` | `claude-fable-5-2` |
| `opus`, `best` | `claude-opus-5-5` |
| `sonnet` | `claude-sonnet-5-5` |
| `haiku` | `claude-haiku-5-5` |

Explicit `ANTHROPIC_DEFAULT_<FAMILY>_MODEL` values in the effective environment
are honored only when they resolve to a canonical first-party ID. Full IDs
and the documented `[1m]` suffix are retained; dynamic `default` / `opusplan`
selection is rejected by this policy. The original request, resolved target
and native initialization/output observations remain separate.
The `[1m]` context request is retained in dispatch; wire model identity may omit
that suffix, and the receipt does not claim an unreported effective context size.

`configuration.modelEvidence.rootModels` observes every root
`assistant.message.model` seen in the current stream. An observed switch away
from the frozen target fails the invocation, including a later switch back.
Strict-policy success requires root model evidence.
`usageModels` is the bounded set of keys from root `result.modelUsage` snapshots.
Its `usageScope` is `native-cumulative-including-history-and-auxiliary`:
resumed/forked history, subagents and internal/compaction calls may contribute.
Those cumulative keys are **not** a current-turn fallback trace, and snapshots
are not summed. `wholeRunVerified` stays `false`; hidden native requests are
not reconstructed from totals.

Conflicting `CLAUDE_CODE_EFFORT_LEVEL`, configured effort caps, and unsupported
levels reported by the native model catalog fail before prompt dispatch.
Unreported effective effort is never invented. Existing callers without the
subscription policy also reject an explicit environment effort override.

## Validation and sources

Deterministic tests use the real pinned SDK with an offline native protocol
fixture. They assert `initialize → get_usage(skip_behaviors:true) → user` in one
PID, rejection/inspection without any user message, cumulative-model semantics,
same-environment doctor behavior, DSH policy propagation and owned cleanup.
This is not a live-account or model-entitlement acceptance record; use the
native doctor on the actual installation before enabling a production binding.

- [Official model aliases and effort rules](https://code.claude.com/docs/en/model-config)
- [Native CLI and auth status](https://code.claude.com/docs/en/cli-reference)
- [Native settings, environment and precedence](https://code.claude.com/docs/en/settings-reference)
- [Official Agent SDK](https://platform.claude.com/docs/en/agent-sdk/overview)
- Pinned installed SDK `sdk.d.ts`: `Query.accountInfo`, public experimental
  usage method, `SDKControlGetUsageResponse`, `ModelInfo` and cumulative `ModelUsage`.
