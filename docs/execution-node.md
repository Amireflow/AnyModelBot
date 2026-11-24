# Local Execution Node — FlowAuto bridge

## First vertical slice

The local app can run an outbound-only workstation node. It uses the existing SQLite database for a stable node identity and the existing `TaskService` for durable execution, retries, approvals, result delivery and restart recovery.

### Configuration

Set all three environment variables before launching the desktop app:

- `AMB_EXECUTION_CONTROL_URL=wss://<your-control-plane>/node`
- `AMB_EXECUTION_CONTROL_TOKEN=<random-secret-at-least-24-characters>`
- `AMB_EXECUTION_BOT_ID=<dedicated-flowauto-bot-id>`

The token is read from the environment and never written to SQLite. The node id is stored locally. Plain `ws://` is rejected except for loopback development.

### Required bot policy

The configured bot must be a dedicated user-owned bot with:

- Permission preset `Workspace` (Full access is rejected).
- Computer Use enabled and approval set to `Ask before input actions`.
- Memory disabled, to keep private chat memories out of remote task context.
- Connected apps set to `Selected` with no app selected.
- Background work not paused.

The node refuses task submission if any of these requirements are not met. It does not accept remote shell commands, arbitrary paths, browser profiles, account selection, or app connector calls.

### Supported message contract (protocol v1)

The Control Plane authenticates the WebSocket handshake with `Authorization: Bearer <token>`.

Node → Control Plane:

- `node.hello`: node id, platform, architecture, configured bot, capabilities and current state.
- `node.heartbeat`: state and count of active remote tasks every 15 seconds. Task updates are sent on connection/reconnect and only when task state or summary changes, not on every heartbeat.
- `task.accepted`, `task.rejected`, `task.update`, `task.cancelled`.
- `node.pong`, `node.state`, `node.revoked`, `node.goodbye`, `node.error`.

Control Plane → Node:

- `node.ping`, `node.pause`, `node.resume`, `node.revoke`.
- `task.submit` with exactly `{ id, kind: "flowauto", title, instruction }`.
- `task.cancel` with `task_id`.

A pause blocks new requests but lets already accepted tasks finish. Revocation blocks reconnection and stops all remote tasks. To re-pair after revocation, configure a newly issued Control Plane token, set `AMB_EXECUTION_NODE_RESET=1` in the local launcher environment for one startup, and remove that variable immediately after the reset. The flag is consumed from the running process environment; remote messages cannot reset a revoked node.

### Safety and execution

Remote requests become local background tasks; the existing TaskService remains the durable source of truth. Each request gets its own conversation, task id, and workspace root. The node derives the local task id from the node id and remote id for idempotent redelivery.

The fixed task policy limits work to the existing Chrome profile and FlowAuto / Google Flow. It prohibits profile/account switching, credential access, direct network calls, arbitrary scripts, external publishing, purchases, account changes and deletion without a local human decision. Computer Use input actions are separately gated by the existing per-action approval mechanism. Files may be saved only in the configured bot workspace.

### Current boundary

This commit implements the local outbound node client and its protocol contract. It does **not** include the hosted Control Plane server, pairing UI, or an end-to-end remote session test. The node stays disconnected until all three environment variables are configured and the dedicated bot passes the policy checks. Do not treat remote operation as production-ready until the server counterpart and the acceptance test are added.
