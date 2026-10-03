#!/usr/bin/env bash
# Build, hot-reload the plugin in the running Blockbench, wait for the bridge.
set -e
cd "$(dirname "$0")/.."
npm run build 2>&1 | grep -E "error|✘" && exit 1
node scripts/call-tool.mjs eval_code '{"code":"setTimeout(() => Plugins.devReload(), 300); \"ok\"","undo":false}' >/dev/null 2>&1 || true
for i in $(seq 1 20); do
  sleep 1
  if node scripts/call-tool.mjs get_status '{}' 2>/dev/null | grep -q '"connected": true'; then echo "reloaded"; exit 0; fi
done
echo "bridge did not reconnect"; exit 1
