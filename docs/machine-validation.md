# Machine API source-candidate validation — 2026-11-07

This record covers the 0.3.2 source candidate and public machine protocol v1.
The released 0.3.1 real-account/desktop record remains separate. No npm version,
release tag, user account or existing desktop installation was changed.

## Offline test results

Environment: Linux x64 and Node.js 24.22.1. Tests used npm 11.9.0;
the final candidate pack/install used npm 12.2.1 to match Flywheel's toolchain.

| Check | Observed result |
| --- | --- |
| `npm test` | 80 passed, 0 failed, 0 skipped |
| Public `lib/machine.js` instrumentation | 100% lines, 100% functions, 94.64% branches |
| Existing desktop behaviors | Text/session, images/PDF, structured output, background jobs, permission narrowing and remembered-session repair passed |
| Correlated machine calls | Fresh/persistent/resume, independent tasks, failure/no-dispatch, actual configuration, partial usage and explicit credential boundaries passed |
| Process faults | Timeout, SIGTERM resistance, leader-first exit, inaccessible process-group probe, missing/corrupt/duplicate terminal streams passed |
| Hard-killed caller process group | Guardian and native groups disappeared for both normal and SIGTERM-resistant fixtures |
| Hard-killed guardian with live caller | Parent cleaned the known native group and returned `outcome: unknown`, without fabricating completion or usage |
| Whitespace/local documentation links | `git diff --check` and changed-document local-link checks passed |

The coverage command is intentionally scoped and is **not** a claim of 100%
repository-wide branch or line coverage:

```sh
node --test --experimental-test-coverage \
  --test-coverage-include='lib/machine.js' 'tests/*.spec.mjs'
```

The package has no runtime dependencies. Its real `npm pack` tarball includes
the public export, TypeScript declarations, guardian, local runner, bilingual
API guides and license. Delivery additionally installs that exact local
candidate in isolation and exercises the public import, persistent resume and
missing-CLI no-dispatch receipt. Candidate paths and digests belong in the PR
delivery evidence; they are not registry integrity claims.

## Review findings closed

- `session.resumed` now records a matching CLI initialization, not merely a
  request to resume. Pre-abort and missing executables do not claim an opened
  session or a physical exit code.
- Wrong model, native permission, directory or session observations cannot
  produce success. Unknown aliases cannot silently match an arbitrary model.
- Every local-runner failure settles the owned native process group. `EPERM`
  is not absence; a dead leader does not exempt surviving descendants.
- A detached native CLI originally outlived a SIGKILLed calling worker. The
  new guardian is established before native spawn and owns a separate IPC
  lifeline, so caller death now triggers independent physical cleanup.
- A guardian inherits neither `--input-type=module`/test flags nor ambient
  deployment credentials. Explicit target credentials travel only in its
  private request and do not enter the receipt.
- Unsupported Windows calls fail before native dispatch instead of starting a
  CLI that cannot meet cleanup requirements.
- Explicit persistent desktop calls remain independent; only the configured
  implicit session mode reuses remembered context. Empty setting sources stay
  empty in CLI argv.

## Limits

The fixtures launch real local processes and use real signals, pipes, IPC and
process groups; they make no model requests. New machine-interface behavior
has not been tested with a real Claude account or on macOS in this session.
`reportedCostUSD` is the CLI's API-equivalent report, not subscription billing.

Physical supervision is not early durable acknowledgement or read-only
session recovery. A killed worker may never persist its receipt, and loss of
both supervisors can leave an unknown outcome/cleanup state. Such an invocation
must remain blocked. See the [English](machine-api.md) and
[Chinese](machine-api.zh.md) contract guides for exact semantics.
