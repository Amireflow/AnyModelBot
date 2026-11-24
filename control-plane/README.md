# AnyModelBot — FlowAuto Control Plane

Minimal self-hosted Control Plane for the outbound workstation node in `src/execution-node/service.ts`.

## What it does

- Receives authenticated outbound WebSocket connections from paired AnyModelBot workstations.
- Stores nodes, queued tasks and status events in SQLite.
- Dispatches only `flowauto` tasks; no arbitrary shell commands, scripts, filesystem paths or model prompts are accepted as separate fields.
- Provides a small administrator dashboard to submit tasks, inspect node/task state, review Computer Use approvals, pause, resume, cancel or revoke.
- Uses separate bearer secrets for the workstation node and the administrator.

The Control Plane does not see Chrome cookies, browser profiles, model credentials or local files. It receives only pending Computer Use approval metadata; decisions are revalidated by the local ApprovalCenter before application.

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

The server persists queued tasks and retries delivery until the workstation accepts them. It sends an application-level ping every 15 seconds and drops a node that has not checked in within 45 seconds. The node reports accepted/rejected tasks and changed task states. Task messages are idempotent by remote task id.

## Admin API

All endpoints except `GET /healthz` and static dashboard assets require `Authorization: Bearer <admin-token>`.

- `GET /api/v1/nodes`
- `GET /api/v1/tasks?limit=50`
- `POST /api/v1/tasks` JSON: `{ "node_id": "...", "kind": "flowauto", "title": "...", "instruction": "..." }`
- `POST /api/v1/tasks/:id/cancel`
- `POST /api/v1/nodes/:id/pause`
- `POST /api/v1/nodes/:id/resume`
- `POST /api/v1/nodes/:id/revoke`

The admin token is held only in dashboard memory and is not written to localStorage or cookies. Revoke is irreversible from the dashboard: the workstation requires a local re-pair reset and a newly issued token to reconnect.

## Local test

From this folder:

```sh
npm install
npm test
```

The integration tests start the real HTTP/WebSocket server on loopback with a temporary SQLite database.

## Current limitation

The Control Plane transports and queues jobs but does not stream a live desktop video feed. The administrator sees task status and local approval prompts through the AnyModelBot app. A future live-view feature must be designed separately and must not bypass the per-action local approval mechanism.
