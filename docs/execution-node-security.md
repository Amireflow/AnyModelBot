# FlowAuto task tool boundary

The paired execution bot is treated as a dedicated browser operator. When its task session (or a descendant subagent) starts, the DSH host installs a fail-closed tool guard:

- Allowed: `mcp__computer-use__*` and the host-owned `task_report` tool.
- Denied: shell, scripts, filesystem tools, browser debugging, app connectors, web search, and subagent spawning.
- The Computer Use approval hook still asks the local owner before each input action.
- The local node rejects a bot unless it is user-owned, Workspace permission, Computer Use enabled with `ask-input`, memory disabled, connected apps empty, and background work not paused.

This is a tool-level restriction, not merely an instruction in the prompt. It applies to task sessions and nested subagents. The desktop chat outside a task session remains unaffected.
