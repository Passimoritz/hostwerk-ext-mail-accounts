#!/usr/bin/env node
'use strict';
/*
 * Bündelt die Mail-Bibliotheken in EINE Datei: server/vendor/mail-libs.js (+ LICENSES.txt).
 * Hostwerk kopiert beim Installieren keine node_modules – deshalb liegt alles fertig gebündelt im Paket.
 *
 *   npm i --no-save            (Versionen fest in package.json: imapflow, nodemailer, mailparser, sanitize-html, esbuild)
 *   node scripts/vendor.js [node_modules-Ordner]
 *
 * Ohne Angabe wird ./node_modules benutzt. Das Ergebnis ist CommonJS für Node 20+, ohne Quelltext-Karten.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MODS = path.resolve(process.argv[2] || path.join(ROOT, 'node_modules'));
const OUT = path.join(ROOT, 'server', 'vendor');
const PKGS = ['imapflow', 'nodemailer', 'mailparser', 'sanitize-html'];

function loadEsbuild() {
  for (const p of [MODS, ROOT, path.join(ROOT, '..')]) { try { return require(require.resolve('esbuild', { paths: [p] })); } catch { /* weiter */ } }
  throw new Error('esbuild not found – npm i --no-save');
}

/** Lizenztexte aller gebündelten Pakete (direkte und indirekte) – aus dem Metafile von esbuild. */
function licenses(meta) {
  const seen = new Map();
  for (const file of Object.keys(meta.inputs)) {
    const m = file.replace(/\\/g, '/').match(/node_modules\/((?:@[^/]+\/)?[^/]+)\//g);
    if (!m) continue;
    const parts = m[m.length - 1].replace(/^node_modules\/|\/$/g, '');
    const base = file.replace(/\\/g, '/').slice(0, file.replace(/\\/g, '/').lastIndexOf(`node_modules/${parts}/`) + `node_modules/${parts}`.length);
    if (seen.has(parts)) continue;
    const dir = path.isAbsolute(base) ? base : path.join(process.cwd(), base);
    let pkg = {};
    try { pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch { /* ohne */ }
    const lic = fs.existsSync(dir) ? fs.readdirSync(dir).find((f) => /^(licen[sc]e|copying)(\.|$)/i.test(f)) : null;
    seen.set(parts, { name: parts, version: pkg.version || '?', license: pkg.license || '?', text: lic ? fs.readFileSync(path.join(dir, lic), 'utf8').trim() : '' });
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function main() {
  const esbuild = loadEsbuild();
  fs.mkdirSync(OUT, { recursive: true });
  const r = await esbuild.build({
    entryPoints: [path.join(__dirname, 'vendor-entry.js')],
    bundle: true, platform: 'node', target: 'node20', format: 'cjs', minify: true, legalComments: 'none', metafile: true,
    outfile: path.join(OUT, 'mail-libs.js'), nodePaths: [MODS], logLevel: 'warning',
    // pino (Protokoll von imapflow) lädt Transport-Worker nur auf Wunsch – wir übergeben logger: false
    external: ['pino-pretty'],
    banner: { js: '/* Bundled mail libraries for the Hostwerk extension "mail-accounts" – see LICENSES.txt (built by scripts/vendor.js). */' },
  });
  const list = licenses(r.metafile);
  const head = list.map((p) => `${p.name} ${p.version} (${p.license})`).join('\n');
  const body = list.map((p) => `==== ${p.name} ${p.version} – ${p.license} ====\n\n${p.text || '(no licence file in the package – see its package.json)'}\n`).join('\n');
  fs.writeFileSync(path.join(OUT, 'LICENSES.txt'), `Third-party code in mail-libs.js\n\n${head}\n\n${body}`);
  const versions = Object.fromEntries(PKGS.map((p) => { try { return [p, JSON.parse(fs.readFileSync(path.join(MODS, p, 'package.json'), 'utf8')).version]; } catch { return [p, null]; } }));
  fs.writeFileSync(path.join(OUT, 'versions.json'), `${JSON.stringify(versions, null, 2)}\n`);
  const kb = Math.round(fs.statSync(path.join(OUT, 'mail-libs.js')).size / 1024);
  console.log(`server/vendor/mail-libs.js – ${kb} KB, ${list.length} packages: ${PKGS.map((p) => `${p} ${versions[p]}`).join(', ')}`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
