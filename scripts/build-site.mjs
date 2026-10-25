// Build the GitHub Pages site into _site/.
//   npm run build && node scripts/build-site.mjs
// Pages in site/pages are content fragments that start with a meta comment:
//   <!--meta {"title": "Workflows", "description": "…", "layout": "docs"} -->
// This wraps them in the shared layout (top bar, docs sidebar, footer), copies
// site/assets and the logo, and writes data/tools.json from the built server.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const src = path.join(root, 'site');
const out = path.join(root, '_site');
const REPO = 'https://github.com/RenasDemirbas/BlockBenchMCP';
const SITE = 'https://renasdemirbas.github.io/BlockBenchMCP/';

const TOP_NAV = [
  ['docs/', 'Docs'],
  ['docs/workflows.html', 'Workflows'],
  ['docs/tools.html', 'Tools'],
  ['docs/recipes.html', 'Recipes'],
];
const SIDEBAR = [
  ['Guide', [['docs/', 'Getting started'], ['docs/workflows.html', 'Workflows'], ['docs/recipes.html', 'Recipes']]],
  ['Reference', [['docs/tools.html', 'Tools'], ['docs/extending.html', 'Adding tools'], ['docs/troubleshooting.html', 'Troubleshooting & security']]],
];

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function page(rel, meta, body) {
  const depth = rel.split('/').length - 1;
  const up = '../'.repeat(depth);
  const here = rel.replace(/index\.html$/, '');
  const current = (href) => (href === here ? ' aria-current="page"' : '');
  // "Docs" stays highlighted on every docs page.
  const topCurrent = (href) => (href === here || (href === 'docs/' && here.startsWith('docs/') && !TOP_NAV.some(([h]) => h === here)) ? ' aria-current="page"' : '');
  const title = meta.title === 'Blockbench MCP' ? meta.title : `${meta.title} · Blockbench MCP`;
  const sidebar = meta.layout === 'docs'
    ? `<nav class="sidebar" aria-label="Documentation">\n${SIDEBAR.map(([h, links]) => `    <p>${h}</p>\n${links.map(([href, label]) => `    <a href="${up}${href}"${current(href)}>${esc(label)}</a>`).join('\n')}`).join('\n')}\n  </nav>`
    : '';
  const main = meta.layout === 'docs'
    ? `<div class="wrap docs">\n  ${sidebar}\n  <article>\n${body}\n  </article>\n</div>`
    : `<main>\n${body}\n</main>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="description" content="${esc(meta.description)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(meta.description)}">
<meta property="og:image" content="${SITE}assets/social-preview.png">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="${up}assets/blockbench-mcp-small.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wght@600;700&family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap">
<link rel="stylesheet" href="${up}assets/style.css">
</head>
<body>
<header class="topbar">
  <div class="wrap">
    <a class="brand" href="${up || './'}"><img src="${up}assets/blockbench-mcp.svg" alt="">Blockbench MCP</a>
    <button class="menu-btn" type="button" aria-expanded="false">Menu</button>
    <nav class="topnav">
${TOP_NAV.map(([href, label]) => `      <a href="${up}${href}"${topCurrent(href)}>${label}</a>`).join('\n')}
      <a href="${REPO}">GitHub</a>
    </nav>
  </div>
</header>
${main}
<footer>
  <div class="wrap">
    <span class="grow">© 2026 Renas Demirbas · <a href="${REPO}/blob/main/LICENSE">GPL-3.0-or-later</a> · v${pkg.version}</span>
    <a href="${REPO}">GitHub</a>
    <a href="${REPO}/blob/main/CHANGELOG.md">Changelog</a>
    <a href="${REPO}/issues">Issues</a>
  </div>
</footer>
<script src="${up}assets/site.js"></script>
${(meta.scripts || []).map((s) => `<script src="${up}assets/${s}"></script>`).join('\n')}
</body>
</html>
`;
}

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

fs.rmSync(out, { recursive: true, force: true });
fs.cpSync(path.join(src, 'assets'), path.join(out, 'assets'), { recursive: true });
for (const f of ['blockbench-mcp.svg', 'blockbench-mcp-small.svg', 'social-preview.png']) {
  fs.copyFileSync(path.join(root, 'assets', f), path.join(out, 'assets', f));
}

let count = 0;
for (const file of walk(path.join(src, 'pages')).filter((f) => f.endsWith('.html'))) {
  const rel = path.relative(path.join(src, 'pages'), file).split(path.sep).join('/');
  const text = fs.readFileSync(file, 'utf8');
  const m = /^<!--meta (\{.*?\}) -->\n/s.exec(text);
  if (!m) throw new Error(`${rel}: missing <!--meta {...} --> header`);
  const meta = JSON.parse(m[1]);
  const html = page(rel, meta, text.slice(m[0].length).replace(/\{\{version\}\}/g, pkg.version));
  fs.mkdirSync(path.dirname(path.join(out, rel)), { recursive: true });
  fs.writeFileSync(path.join(out, rel), html);
  count++;
}
fs.writeFileSync(path.join(out, '.nojekyll'), '');

// Tool reference data, from the built server.
execFileSync(process.execPath, [path.join(root, 'scripts', 'site-data.mjs'), path.join(out, 'data', 'tools.json')], { stdio: 'inherit' });
console.log(`_site: ${count} pages`);
