# Security

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Use GitHub's
[private vulnerability reporting](https://github.com/RenasDemirbas/BlockBenchMCP/security/advisories/new)
instead. You can expect a first answer within a week. Fixes go into the latest release; there are no
backports to older versions.

| Version | Supported |
| --- | --- |
| 1.10.x (latest) | Yes |
| 1.6.1 – 1.9.x | No, update |
| 1.6.0 and older | **No, and unsafe:** any website could reach the bridge |

## Threat model

Blockbench MCP runs two pieces on your computer: the MCP server that your MCP client starts, and a
Blockbench plugin that connects to it. Whatever reaches the bridge can edit your models and run code
in Blockbench, so the bridge is the asset this design protects.

| Threat | Defence |
| --- | --- |
| Another device on the network connects to the bridge | The WebSocket server binds to `127.0.0.1` only (`server/src/bridge.ts`). |
| A website open in your browser connects to `ws://127.0.0.1:8188` and sends commands (fixed in 1.6.1) | Browsers always send an `Origin` header and a page cannot fake it. The handshake accepts only connections without one (Node: the server's own relay instances and test scripts) and the Blockbench window (`file://`); everything else is refused before any message is read. `scripts/verify-bridge-origin.mjs` tests it. |
| `eval_code` freezes Blockbench | Node modules that make Blockbench open its synchronous permission dialog (`fs`, `child_process`, `net`…) are refused before the code runs, including computed `require()` names. `allow_native_modules: true` opts out on purpose. |
| A tool call leaves the model in a broken state | Every tool writes to Blockbench's undo history; batches that fail halfway roll back what they created. |
| A third-party Blockbench plugin registers a tool that shadows a built-in one | `BlockbenchMCP.registerTool` refuses names that are already taken and validates the name format. |
| A shared `.bbmodel` leaks your username | Blockbench stores the full path of animation files. Not something this project can change; check files before sharing them. |

**Out of scope:** programs already running on your computer under your account (they can connect
to a local port like any MCP client, and already have your permissions), Blockbench itself, your
MCP client, and the AI model's choices. The assistant can only do what the tools allow, but within
Blockbench those tools are powerful: `eval_code` runs JavaScript in Blockbench by design.

## Privacy

- **No telemetry, analytics, accounts or update checks.** Neither the server nor the plugin opens a
  network connection other than the local bridge.
- Screenshots and model data travel only to your MCP client, which sends them to the model
  provider you configured. That is the client's data handling, not this project's.
- Paths you give (exports, references) are used as given; nothing is uploaded.
