# Local orchestrator (OpenCode V2) — yuzutaru/levela

This checkout is a fork of [BuffMcBigHuge/opencode-orchestrator](https://github.com/BuffMcBigHuge/opencode-orchestrator)
ported to OpenCode **V2** and to this repository's rules. The upstream README
describes the original V1 design (server API, oh-my-opencode, Sisyphus, Ralph
loop) and no longer applies.

## What changed vs upstream

| Area | Upstream | Here |
| --- | --- | --- |
| Transport | V1 HTTP server API (`/session`, `/event`, `prompt_async`) | `opencode run --format json` (CLI, V2), session resumed with `-s` |
| Orchestration stack | oh-my-opencode (Sisyphus, Oracle, Ralph loop) | None — plain `build` agent + repo `AGENTS.md` |
| Delivery | Agent commits, pushes, opens the PR via `gh` | **Orchestrator** commits, pushes, opens a draft PR after gates pass |
| Quality gates | Node heuristics (`npm run lint`, `tsc`) — vacuous here | Per-platform unit **and** UI gates: Android `testDebugUnitTest` + `connectedDebugAndroidTest`, iOS app/package unit tests + `LevelaUITests`, parity scripts |
| Blocked handling | Agent comments + `ai-blocked` | Same, and the reply check no longer loops on its own comments |
| Worktrees | `<repo>/.worktrees` | `../levela-worktrees` (outside the repo) |

Deleted: `src/tasks/opencode-client.ts`, `src/tasks/opencode-server.ts`.
Added: `src/tasks/delivery.ts`, `src/utils/git.ts`, `run.sh`, `.env`, this file.

## Identity model

| Role | Account | How |
| --- | --- | --- |
| Bot (commits, comments, PRs) | `quintonflyn` | `GH_TOKEN` pinned by `run.sh`, git push rewritten to HTTPS + token |
| Reviewer | `yuzutaru` | approve/review in the browser or `gh` after `gh auth switch` |

`GITHUB_USERNAME=quintonflyn` in `.env` is the **bot** identity: comments from any
other login are treated as human replies (`src/github/client.ts`). Setting it to
`yuzutaru` would make the agent's own comments count as answers and auto-resume
blocked issues.

`run.sh` refuses to start if the token does not belong to the bot.

## Run

```bash
npm install
npm run build
./run.sh                 # foreground
```

Token source: `run.sh` calls `gh auth token --user quintonflyn` unless
`GITHUB_TOKEN` is already exported. To use a scoped PAT instead, paste it into
`.env` and export it (`GITHUB_TOKEN=... ./run.sh`) or replace the lookup in
`run.sh`.

Background (optional):

```bash
npm install -g pm2
pm2 start run.sh --name levela-orchestrator
pm2 save && pm2 startup
```

## Issue lifecycle

1. Add `ai-task` (+ optional `ai-priority:high|medium|low`) to an open issue.
2. Next poll (5 min) creates `../levela-worktrees/issue-N` on `ai/issue-N-<slug>`.
3. The agent works, posts progress comments, keeps labels in sync.
4. On exit: `ai-blocked`? stop. Otherwise the orchestrator stages, runs gates,
   commits (`fix(android): …`), pushes as `quintonflyn`, opens a **draft** PR,
   swaps to `ai-review-ready`.
5. You review as `yuzutaru` and merge. The bot never merges or approves.

Blocked: the agent adds `ai-blocked` and asks. Your reply is the trigger — the
orchestrator resumes the same session (`--session <id>`, stored in
`.state/sessions.json`) with all comment history.

Quality gates fail or no changes → `ai-blocked` + a comment with the failure
output, so nothing reaches a PR unverified.

## Quality gates

Gates are selected from the changed paths, so an issue only pays for the platform
it touches. Unit runs before UI, and the run stops at the first failure.

| Changed | Gates (in order) | Budget |
| --- | --- | --- |
| `android/` | `assembleDebug testDebugUnitTest`, then `connectedDebugAndroidTest` (all modules) | 30 + 45 min |
| `ios/` | app scheme `test -skip-testing:LevelaUITests` + `Today`/`Nutrition` package schemes, then `-only-testing:LevelaUITests` | 30 + 45 min |
| `assets/` | theme / splash / onboarding / iOS-test-mirror parity | 10 min each |
| both platforms | both gate sets (then the commit is still rejected by the platform-split hook) | — |

Measured on this machine (Apple M4, 16 GB, warm caches): Android unit ~10 s,
Android instrumented 36 tests across 5 modules ~50 s plus emulator boot,
iOS unit 19 tests ~3.5 min, iOS UI 8 tests ~5.7 min.

Device handling lives in `scripts/gates/` **in this orchestrator**, not in the
repository under test, so an agent cannot weaken the check that verifies it:

- `android-instrumented.sh` reuses an attached emulator whose AVD matches
  `LEVELA_AVD`, otherwise boots that AVD headlessly (`-no-snapshot`, no
  window/audio) on a free console port and kills it again. The configured AVD
  runs API 37 (`Pixel_10a`, 16 KB page size), matching the app's compile/target
  SDK and CI's `google_apis_ps16k` image.
- `ios-tests.sh` resolves `LEVELA_IOS_DEVICE`, boots it only if shut down, and
  shuts it down again only if it started it — a simulator you already booted is
  reused and left running.
- Both take a device lock, refuse to start below `QUALITY_MIN_FREE_GB`, and
  write full logs to `<WORKTREE_DIR>/.gate-logs/issue-N/`.
- iOS runs pass `-onlyUsePackageVersionsFromResolvedFile`; after the gates the
  orchestrator blocks the issue if a gate modified tracked files, so the commit
  always matches the verified tree.


## Notes

- One issue must stay inside one platform; a change spanning `android/` and
  `ios/` is rejected (repository hooks) and the issue is blocked with an
  explanation.
- `.env`, `run.sh` and `.state/` hold credentials/state; do not commit them.
- `WORKTREE_DIR`, `PROJECT_PATH`, `OPENCODE_AGENT`, `OPENCODE_MODEL`,
  `TASK_TIMEOUT_MINUTES`, `QUALITY_TIMEOUT_MINUTES` are all configurable in `.env`.
