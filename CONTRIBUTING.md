# Contributing to Blockbench MCP

Thanks for wanting to help. Bug reports, new tools, fixes to existing tools and better tool
descriptions are all welcome.

## Ground rules

1. **The assistant reads the schema, nothing else.** A tool's `description` and parameter
   descriptions are its whole manual. Say what the tool is for, what each parameter does, units and
   defaults, and what to do next. Error messages say what went wrong and how to recover.
2. **Everything is undoable.** Every edit goes through `Undo.initEdit` / `Undo.finishEdit`, and a
   batch that fails halfway rolls back what it created (`cancelCreate` in `plugin/src/util.ts`).
3. **No dialogs.** A tool must never leave a Blockbench dialog open; the bridge cannot click it.
4. **No network access** besides the local bridge. No telemetry, no update checks.
5. **No new runtime dependencies** without a good reason in the pull request. The server already
   ships its dependencies bundled.
6. **Same license.** Blockbench MCP is licensed under the GNU GPL, version 3 or later. By sending a
   pull request you agree that your contribution is released under the same terms.

## Development setup

```bash
git clone https://github.com/RenasDemirbas/BlockBenchMCP.git
cd BlockBenchMCP
npm install
npm run build        # dist/blockbench_mcp.js + dist/mcp-server.js
npm run typecheck
```

Load `dist/blockbench_mcp.js` in Blockbench (**File → Plugins → Load Plugin from File**). After a
change, rebuild and reload it without restarting Blockbench:

```bash
npm run build
node scripts/call-tool.mjs eval_code '{"code":"setTimeout(() => Plugins.devReload(), 300); \"ok\"","undo":false}'
```

`scripts/call-tool.mjs` starts a fresh server for one call, so new tools and parameters can be tried
without restarting your MCP client.

## How the code is organized

| Layer | Folder | Holds |
| --- | --- | --- |
| Tool schemas | `server/src/tools/` | One file per area; each tool forwards to a plugin command of the same name |
| Bridge | `server/src/bridge.ts`, `plugin/src/socket.ts` | WebSocket hub, relaying between several clients |
| Handlers | `plugin/src/handlers/` | The Blockbench side of each command: read and write Blockbench state, undo, error messages |
| Pure modules | `plugin/src/rig/`, `mesh/`, `texturing/`, `pixelart/` | Math with no Blockbench globals: skinning, deformers, PBR maps, seam blending, pixel-art rendering |

Keep files focused. If a handler grows a second responsibility, split it; if it does math, move
the math to a pure module.

## Adding a tool

1. **Schema:** register it in the matching file in `server/src/tools/` (or a new file, added to
   `server/src/tools/index.ts`). Rarely used commands can share one tool as actions with
   `registerGroup`.
2. **Handler:** `register('<command>', handler)` in `plugin/src/handlers/` and import the file in
   `plugin/src/index.ts`. Fail with `fail('message with a way out')`, not `throw new Error`.
3. **Blockbench version:** if it needs a recent Blockbench feature, check for it and fail with
   "needs Blockbench X or newer"; add a flag to `featureSupport()` in `plugin/src/util.ts`.
4. **Test:** add checks to a `scripts/verify-*.mjs` script (they run against a live Blockbench and
   clean up their scratch projects).
5. **Docs:** the README tool table and `CHANGELOG.md`.

## Tests

`smoke-test.mjs` and `verify-bridge-origin.mjs` need nothing; the others need a running Blockbench
with the plugin loaded. The full list is in the README under *Development → Tests*. Run the scripts
that cover what you changed, plus `e2e-test.mjs`, before sending a pull request.

## Pull requests

- One topic per pull request; describe what changes for the person using the tools.
- Commit messages: a short summary line, then what changed and why.
- Include the test output, and a screenshot when the change is visual.
