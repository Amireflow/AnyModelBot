# AnyModelBot — FlowAuto Control Plane

Minimal self-hosted Control Plane for the outbound workstation node in `src/execution-node/service.ts`.

## What it does

- Receives authenticated outbound WebSocket connections from paired AnyModelBot workstations.
- Stores nodes, queued tasks and status events in SQLite.
- Dispatches only `flowauto` tasks; no arbitrary shell commands, scripts, filesystem paths or model prompts are accepted as separate fields.
- Provides a small administrator dashboard to submit tasks, inspect node/task state, review Computer Use approvals, pause, resume, cancel or revoke.
- Uses separate bearer secrets for the workstation node and the administrator.

The Control Plane never accesses Chrome cookies, browser profiles, model credentials or local file contents. It receives pending Computer Use approval metadata and, when a task reports output files, a bounded manifest of verified workspace-relative paths, file types and sizes. Approval decisions are revalidated by the local ApprovalCenter before application.

## Deploy

Use Node.js 22.13 or newer. For Coolify, create a Docker Compose service from this folder and expose internal port `8787` on a domain with HTTPS. The reverse proxy must preserve WebSocket upgrades and set `X-Forwarded-Proto: https`.

Generate two independent secrets (do not reuse either token elsewhere):

```sh
openssl rand -hex 32
openssl rand -hex 32
```

Set these server-side environment variables in the deployment panel:

- `AMB_CP_ADMIN_TOKEN`: first secret, at least 32 characters.
- `AMB_CP_NODE_TOKEN`: second secret, at least 24 characters.
- `AMB_CP_TRUST_PROXY=1`: trust the reverse proxy's HTTPS scheme header.
- `AMB_CP_DB=/data/control-plane.sqlite`: persistent SQLite database.
- `PORT=8787`, `HOST=0.0.0.0`.

Persist the `/data` volume. Do not publish port 8787 directly to the public internet without a TLS reverse proxy. The dashboard and API must be accessed over HTTPS.

For local-only development, set `AMB_CP_ALLOW_INSECURE=1` and use `ws://127.0.0.1:8787/node`; never enable this on a public deployment.

## Pair the workstation

On the workstation running AnyModelBot, configure the app's environment before launch:

- `AMB_EXECUTION_CONTROL_URL=wss://YOUR-DOMAIN/node`
- `AMB_EXECUTION_CONTROL_TOKEN`: the exact value of `AMB_CP_NODE_TOKEN`.
- `AMB_EXECUTION_BOT_ID`: the id of a dedicated, user-owned FlowAuto bot.

The local app refuses to connect unless the selected bot uses Workspace permission, Computer Use with approval before every input action, memory disabled, no connected apps selected, and background tasks enabled. The security gate further restricts remote task sessions to Computer Use and `task_report`.

A workstation reports its stable node id after the first successful connection. Use the web dashboard at `https://YOUR-DOMAIN/`, paste the administrator token and submit a FlowAuto task to that node.

## Protocol v1

Node authentication uses the WebSocket handshake header `Authorization: Bearer <node-token>`. The first message must be `node.hello` with protocol 1 and both `flowauto` and `computer-use-approval` capabilities.

The Control Plane may send:

- `node.ping`, `node.pause`, `node.resume`, `node.revoke`
- `task.submit`: `{ id, kind: "flowauto", title, instruction }`
- `task.cancel`: `{ task_id }`
- `task.approval.decision`: an allow/deny decision for a pending Computer Use input.
- `task.question.answer`: a text answer to a pending FlowAuto `task_report(needs_you)` question.

The node reports accepted/rejected tasks, task states, Computer Use approval requests, non-blocking FlowAuto questions and output-file metadata. A `task.update` may contain `artifacts: [{ path, size, kind }]`; paths are relative to the bot workspace, and the local node includes only existing, non-empty regular files within that workspace (maximum 8 files, 50 MiB each). Symlinks that escape the workspace are excluded. The Control Plane validates the manifest again before storing it. It exposes the manifest in `GET /api/v1/tasks` and displays it in the dashboard; this metadata is not a file transfer or download URL.

The Control Plane persists remote answers while the workstation is offline and replays them after reconnect. The local ApprovalCenter remains authoritative: it verifies that the question or approval is still pending before applying the response. A stale or rejected response is acknowledged and can be retried. Task messages are idempotent by remote task id; approval and question updates are idempotent by their local approval id.

## Admin API

All endpoints except `GET /healthz` and static dashboard assets require `Authorization: Bearer <admin-token>`.

- `GET /api/v1/nodes`
- `GET /api/v1/tasks?limit=50` (includes `node_connected`, `node_state` and `node_last_seen_at`; a task's last status is retained while its workstation is offline)
- `POST /api/v1/tasks` JSON: `{ "node_id": "...", "kind": "flowauto", "title": "...", "instruction": "..." }`
- `POST /api/v1/tasks/:id/cancel`
- `POST /api/v1/approvals/:id/answer` JSON: `{ "answer": "..." }` (FlowAuto `task_report` questions only)
- `POST /api/v1/nodes/:id/pause`
- `POST /api/v1/nodes/:id/resume`
- `POST /api/v1/nodes/:id/revoke`

The administrator dashboard can answer non-blocking FlowAuto `task_report(needs_you)` questions remotely. Answers are persisted while the workstation is offline and replayed on reconnect; the local ApprovalCenter revalidates the question before applying an answer. Computer Use input approvals remain allow/deny decisions and cannot be substituted with a free-text answer.

The admin token is held only in dashboard memory and is not written to localStorage or cookies. Revoke is irreversible from the dashboard: the workstation requires a local re-pair reset and a newly issued token to reconnect.

## Validation

From the repository root, after installing the main dependencies:

```sh
npm run test:control-plane
```

Or run the suite independently from this folder:

```sh
npm install
npm test
```

The integration tests start the real HTTP/WebSocket server on loopback with a temporary SQLite database. They cover task dispatch, approval/question replay, terminal-state protection, artifact-manifest validation and workstation disconnect/reconnect visibility. The root command is also part of the main GitHub Actions CI workflow.

## Current limitation

The Control Plane does not stream a live desktop video feed and does not transfer artifact contents. Remote task-question, artifact-metadata and Computer Use approval transport have integration coverage, but the complete local runtime has not yet been validated in a real Chrome/Google Flow generation, save and playback-verification run. Live view and remote artifact transfer must be designed separately and must not bypass the per-action local approval mechanism.
