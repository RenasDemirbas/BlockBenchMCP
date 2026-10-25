// Collect the license texts of every npm package bundled into a build, from
// esbuild's metafile. MIT, ISC and BSD all require their notices to travel
// with copies of the code; the release bundles them into mcp-server.js, so
// THIRD_PARTY_LICENSES.txt ships next to it.
import fs from 'node:fs';
import path from 'node:path';

const LICENSE_FILE = /^(licen[cs]e|copying|notice)(\.(md|txt|markdown))?$/i;

/** Package roots ("node_modules/a" or "node_modules/@s/a", nested ones too) used by the build. */
export function bundledPackages(metafile, root) {
  const dirs = new Set();
  for (const input of Object.keys(metafile.inputs)) {
    const parts = input.split('/');
    const at = parts.lastIndexOf('node_modules');
    if (at < 0) continue;
    const len = parts[at + 1]?.startsWith('@') ? 3 : 2;
    dirs.add(path.join(root, ...parts.slice(0, at + len)));
  }
  return [...dirs].sort();
}

function describe(dir) {
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const files = fs.readdirSync(dir).filter((f) => LICENSE_FILE.test(f)).sort();
  const text = files.map((f) => fs.readFileSync(path.join(dir, f), 'utf8').trim()).join('\n\n');
  const license = typeof pkg.license === 'string' ? pkg.license : pkg.license?.type ?? 'UNKNOWN';
  return { name: pkg.name, version: pkg.version, license, text, repository: pkg.repository?.url ?? pkg.repository };
}

export function writeThirdPartyLicenses(metafile, root, outFile, product) {
  const packages = bundledPackages(metafile, root).map(describe);
  // One entry per package name and version (nested copies can repeat).
  const seen = new Set();
  const unique = packages.filter((p) => !seen.has(`${p.name}@${p.version}`) && seen.add(`${p.name}@${p.version}`));
  const missing = unique.filter((p) => !p.text).map((p) => `${p.name}@${p.version}`);
  if (missing.length) throw new Error(`No license file found for: ${missing.join(', ')}`);
  const rule = '-'.repeat(78);
  const body = unique.map((p) => [
    rule,
    `${p.name} ${p.version} (${p.license})`,
    p.repository ? String(p.repository).replace(/^git\+/, '') : null,
    rule,
    '',
    p.text,
    '',
  ].filter((l) => l !== null).join('\n')).join('\n');
  const header = `${product} bundles the following third-party packages.\n` +
    `Each one is distributed under the license reproduced below.\n\n`;
  fs.writeFileSync(outFile, header + body);
  return unique.map((p) => `${p.name}@${p.version} ${p.license}`);
}
