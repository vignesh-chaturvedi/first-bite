# Runner startup/shutdown race

Date: 2026-09-21. The user supplied GitHub Actions run `35562999231` showing
`foundation` failed in `pnpm test:smoke`: 157 tests passed and one failed with
`Journal lock remained after clean shutdown`. The separate `registry-proof` job
is green in the screenshot. The run was unavailable through GitHub's unauthenticated
API, so no private log access or GitHub login was performed.

## Cause and fix

The CLI printed its readiness message before installing SIGINT/SIGTERM handlers.
The test waits for that message and immediately signals the detached package-manager
process group. A signal in that interval can terminate the runner with its normal
default signal behavior, before asynchronous journal cleanup is protected.

The same reported failure was reproduced locally on macOS; it is a scheduling
race, not evidence of a Linux-only journal defect. Installing both handlers before
the readiness message closes that interval. The existing idempotent cleanup still
keeps the handlers installed while the server and journal close. Journal integrity
checks and uncertain-write lock retention are unchanged.

## Regression evidence

A test-only preload intercepts the readiness write and immediately delivers a
signal before the write returns. Separate cases cover SIGINT and SIGTERM, while
the original package-manager/process-group test remains. Each successful case
requires the lock to disappear and the encrypted initialized journal to reopen.
Failure cleanup removes only that test's detached process group, including any
descendant surviving the group leader. Port-binding errors now reject promptly.

Temporarily restoring the old readiness ordering makes both new deterministic
tests fail with the original lock error; restoring the fix makes them pass.
The temporary mutation was reversed before final validation.

| Local validation | Result |
| --- | --- |
| CLI tests, including all three shutdown paths | 21 passed |
| Complete smoke-runner suite | 160 passed across 5 files |
| TypeScript and ESLint | Passed |
| Whitespace check | Passed |

The first sandboxed test invocation could not bind localhost (`EPERM`). Running
the tests with loopback access exposed the actual lock failure and then verified
the fix. All test wallets/journals are synthetic temporary fixtures; no live
registration, signing or broadcast was performed, and the completed real journal
was not opened or modified by these tests.

## Hosted status

The fix is locally verified. A successful GitHub Actions rerun remains pending
the user's push. No tests were skipped or assertions relaxed to obtain the pass.
The registration and registry-proof evidence remain separate from this shutdown
regression. The local commit does not claim a green hosted workflow.
