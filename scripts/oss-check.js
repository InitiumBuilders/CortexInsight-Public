#!/usr/bin/env node
// oss-check — the open-source gate. Run before any public push:
//     node scripts/oss-check.js
// It scans what would ship (source, docs, package files) for secret shapes,
// baked credentials, and personal identifiers, prints an inventory with the
// first location of each hit, and exits 1 on anything that must never be
// public. A clean run means "nothing of these shapes was found", not "safe";
// read OPEN-SOURCE.md for the rest of the gate.
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
// every text file at the root ships (source, docs, helper scripts, lockfile), plus these trees
const SHIP_EXT = /\.(js|json|md|ps1|sh|yml|yaml|txt|html|css)$/i;
const SHIP_DIRS = ['src', 'docs', 'scripts', 'assets', '.github'];
const SKIP = /node_modules|^release|\.bak|\.asar|\.png$|\.ico$|\.jpg$|\.woff/;

const HARD = [
  ['OpenAI / ElevenLabs style key', /\bsk[-_][A-Za-z0-9_\-]{20,}\b/g],
  ['Anthropic key', /\bsk-ant-[A-Za-z0-9_\-]{20,}\b/g],
  ['Slack token', /\bxox[bap]-[A-Za-z0-9\-]{10,}\b/g],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/g],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g],
  ['Telegram bot token', /\b[0-9]{8,10}:[A-Za-z0-9_\-]{35}\b/g],
  ['private key block', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g],
  ['baked password hash (PASS_SHA)', /9ac7efdd6293fe9bf2c85e47e70464dddd59e6b6a53d24c66e8f4ef79111ed5a/g],
  ['baked password in a comment', /JustAugustCanSeeThis/g],
  ['baked hardware fingerprint', /8934df007b008ff35e9067036482e7586a5b678c1b53995a9ef6eea9d8d982ab/g],
  // the private relay's one-token name and any tunnel hostname never ship; the
  // spaced product name (SEMBLE CORTEX) is the public form. The pattern is
  // assembled from the two public words so the token itself is not in this file.
  ['private relay name', new RegExp(['semble', 'cortex'].join(''), 'gi')],
  ['tunnel hostname', /\.ts\.net\b|trycloudflare\.com|cfargotunnel\.com/gi],
];
// a line that is a detector or a harness fixture holds a secret SHAPE on
// purpose; it is reported as information, never as a block
const FIXTURE = /new RegExp\(|\bok\('|omniSecretish\(|omniApi\(|omniParse\(|omniCompile\(|looksLike\w+Key\(|SECRET internal|\bid: 'tsk|oss:fixture/;
const SOFT = [
  ['personal email', /[A-Za-z0-9._%+-]+@(?:gmail|outlook|proton|icloud)\.[a-z]+/gi],
  ['personal Windows path', /C:\\\\?Users\\\\?Initi/g],
  ['personal WSL home', /home[\\/]{1,2}initium/g],
  // the login name in path or account position; the product word "Initium" is vocabulary, not identity
  ['personal username', /\binitium@|[\\/]initium\b|\binitium[\\/]/g],
  ['personal IP or tunnel name', /\b(?:100\.\d{1,3}\.\d{1,3}\.\d{1,3})\b|\.ts\.net\b/g],
  ['backup file present in tree', null],
];

function walk(dir, out) {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    const rel = path.relative(ROOT, p);
    if (SKIP.test(rel) || SKIP.test(f)) continue;
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}
const files = [];
for (const f of fs.readdirSync(ROOT)) {
  const p = path.join(ROOT, f);
  if (SHIP_EXT.test(f) && !SKIP.test(f) && fs.statSync(p).isFile()) files.push(p);
}
for (const d of SHIP_DIRS) { const p = path.join(ROOT, d); if (fs.existsSync(p)) walk(p, files); }

const hits = [];
const self = path.resolve(__filename);
const scan = (label, re, hard) => {
  for (const f of files) {
    if (path.resolve(f) === self) continue;                       // the gate holds the shapes it hunts
    const txt = fs.readFileSync(f, 'utf8');
    const lines = txt.split('\n');
    let m, n = 0, fx = 0, first = null, firstFx = null;
    re.lastIndex = 0;
    while ((m = re.exec(txt))) {
      const ln = txt.slice(0, m.index).split('\n').length;
      const where = path.relative(ROOT, f) + ':' + ln;
      if (FIXTURE.test(lines[ln - 1] || '')) { fx++; if (!firstFx) firstFx = where; }
      else { n++; if (!first) first = where; }
      if (n + fx > 500) break;
    }
    if (n) hits.push({ label, hard, n, first });
    if (fx) hits.push({ label: label + ' (fixture or detector)', hard: false, info: true, n: fx, first: firstFx });
  }
};
for (const [label, re] of HARD) scan(label, re, true);
for (const [label, re] of SOFT) if (re) scan(label, re, false);
// backups and dead copies in the tree ship by accident; name them
const junk = fs.readdirSync(ROOT).filter((f) => /\.bak|^\.cortexinsight-bak|^renderer\.js$|^app\.asar/.test(f));
for (const j of junk) hits.push({ label: 'backup or dead copy in the tree', hard: false, n: 1, first: j });

const pad = (s, n) => String(s).padEnd(n);
console.log('oss-check · ' + files.length + ' files scanned\n');
const hard = hits.filter((h) => h.hard), soft = hits.filter((h) => !h.hard && !h.info), info = hits.filter((h) => h.info);
if (!hits.length) console.log('  nothing of these shapes found');
for (const h of hard) console.log('  BLOCK  ' + pad(h.label, 44) + pad(h.n + 'x', 6) + h.first);
for (const h of soft) console.log('  warn   ' + pad(h.label, 44) + pad(h.n + 'x', 6) + h.first);
for (const h of info) console.log('  info   ' + pad(h.label, 44) + pad(h.n + 'x', 6) + h.first);
console.log('\n' + (hard.length ? hard.length + ' blocking finding(s): not publishable as it stands.' : 'no blocking findings.') + (soft.length ? ' ' + soft.length + ' warning(s) to review (personal defaults, backups).' : ''));
process.exit(hard.length ? 1 : 0);
