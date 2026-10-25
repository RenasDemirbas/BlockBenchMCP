// Build the Blockbench plugin and the MCP server.
//   node scripts/build.mjs             dist/blockbench_mcp.js + dist/mcp-server.js (reads node_modules)
//   node scripts/build.mjs --release   the server bundles its dependencies; dist/ also gets
//                                      LICENSE and THIRD_PARTY_LICENSES.txt to ship with it
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { writeThirdPartyLicenses } from './third-party-licenses.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const release = process.argv.includes('--release');
const dist = path.join(root, 'dist');
fs.mkdirSync(dist, { recursive: true });

const notice = (what, extra = []) => [
  `/*! Blockbench MCP ${pkg.version} — ${what}`,
  ' * Copyright (C) 2026 Renas Demirbas',
  ` * SPDX-License-Identifier: ${pkg.license}`,
  ' * Source and license: https://github.com/RenasDemirbas/BlockBenchMCP',
  ...extra.map((l) => ` * ${l}`),
  ' */',
].join('\n');

await esbuild.build({
  entryPoints: [path.join(root, 'plugin/src/index.ts')],
  bundle: true,
  format: 'iife',
  platform: 'node',
  external: ['electron'],
  // The logo is embedded as a data URL: Blockbench shows it in the plugin list
  // without a separate icon file next to the plugin.
  loader: { '.svg': 'dataurl' },
  banner: { js: notice('Blockbench plugin') },
  outfile: path.join(dist, 'blockbench_mcp.js'),
  logLevel: 'info',
});

const server = await esbuild.build({
  entryPoints: [path.join(root, 'server/src/index.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  metafile: release,
  ...(release
    ? {
        // Bundled CommonJS dependencies call require(); give the ESM bundle one.
        banner: { js: `${notice('MCP server', ['Bundled third-party packages and their licenses: THIRD_PARTY_LICENSES.txt'])}\nimport { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);` },
      }
    : { packages: 'external', banner: { js: notice('MCP server') } }),
  outfile: path.join(dist, 'mcp-server.js'),
  logLevel: 'info',
});

if (release) {
  const listed = writeThirdPartyLicenses(server.metafile, root, path.join(dist, 'THIRD_PARTY_LICENSES.txt'), `Blockbench MCP ${pkg.version} (mcp-server.js)`);
  fs.copyFileSync(path.join(root, 'LICENSE'), path.join(dist, 'LICENSE'));
  console.log(`\nTHIRD_PARTY_LICENSES.txt: ${listed.length} packages\nLICENSE copied to dist/`);
}
