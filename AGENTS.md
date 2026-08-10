# AGENTS.md

## Repo-Specific Context

### Key Technologies
- **Runtime**: Node.js server (`server.js`)
- **WebSocket**: `ws` library with custom `GatewayWsManager` (`lib/gateway-ws.js`)
- **Gateway Connection**: WebSocket connection to OpenClaw Gateway at `ws://openclaw.llm.svc.cluster.local:18789`
- **Database**: SQLite via `lib/db.js`

### Environment Variables
- `GATEWAY_WS_URL`: WebSocket gateway URL (default: `ws://openclaw.llm.svc.cluster.local:18789`)
- `GATEWAY_WS_ORIGIN`: Origin header for gateway connection (default: `http://localhost:3000`)
- `GATEWAY_WS_WAIT_CHALLENGE_MS`: Challenge timeout in ms (default: 1200)
- `GATEWAY_WS_MAX_RECONNECT_ATTEMPTS`: Max reconnect attempts (0 = unlimited)

### WebSocket Connection Flow
1. Client opens WebSocket to gateway URL
2. Gateway sends `connect.challenge` event with nonce
3. Client responds with `connect` request using nonce and auth token
4. Gateway responds with connect ACK → connection established

### Release Process
Releases are started manually and completed by GitHub Actions. Branch protection remains enabled: the workflow opens a version-bump PR and enables auto-merge instead of pushing directly to `main`.

#### Steps

1. Open **Actions → Manual Release → Run workflow**.
2. Enter a plain semver version such as `0.4.15` (`v0.4.15` is also accepted).
3. Follow the release PR linked in the workflow log. It auto-merges after the required checks pass.
4. `Publish Release` tags the merge commit and creates the GitHub release.

Publishing the GitHub release triggers `Release Build & Verify` (`.github/workflows/release.yaml`): regression tests, auth smoke check, and release builds.

#### Version source of truth

- `package.json` is canonical
- Tags use plain semver (e.g. `0.4.12`, no `v` prefix)

#### Validation gates

The release PR must pass the protected branch's required checks, including lint and regression tests, before auto-merge.


## Guidelines

- Be direct and practical
- Provide working solutions, not just suggestions
- When debugging WebSocket issues, check gateway logs first
- Write clean, maintainable code
- Security first — don't expose secrets

## Research Before Task

**Before working any task, research the problem space first.** This is not optional.

Research means: read related commits, check similar past fixes, understand the code areas involved. Do not guess. Do not start coding before you understand the problem.

## Filing issues for the autonomous loop

Issues here are picked up by an autonomous coding loop (dispatch → foreman), and two
parts of the body feed deterministic reviewer rails. Agents filing issues in this repo
must include both.

**1. State the ask in one imperative sentence.** The reviewer quotes it verbatim to
prove it actually read the issue. If it can only paraphrase, its GO is demoted to NO-GO
unless the rail below vouches — costing a revision cycle and an escalation review.

**2. Name the concrete file paths the fix is expected to touch** (backticks are fine).
The scope-overlap rail vouches for a diff that touches a named file, and that vouch is
what survives a paraphrased ask.

Name only paths you are confident about. An issue that names files the diff does *not*
touch is read as scope drift and also gets the change rejected — so when unsure, name
none rather than guessing.
