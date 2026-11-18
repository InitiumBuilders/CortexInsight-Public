#!/usr/bin/env node
// The public tree: HEAD's tree without private/, the instance layer that lives
// only in the private repos. It is built as a git tree object (nothing in the
// working copy changes), exported to a folder, and checked there the way a
// stranger's clone would be: the open-source gate (with .oss-private copied in
// for the run), a scan for words that only the instance layer uses, and a
// syntax check of every script. It prints the tree id, then PUBLIC TREE READY
// or the reason it is not.
//
//   node scripts/public-tree.js            build, export, check
//   node scripts/public-tree.js --keep     the same, and leave the export in place
//
// Publishing is a separate, deliberate step: `git commit-tree <tree> -p
// <public main>` for an ordinary release, or with no parent for a fresh root.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PRIVATE_DIR = 'private/';
const keep = process.argv.includes('--keep');
const git = (args, env) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...(env || {}) }, maxBuffer: 64 * 1024 * 1024 }).trim();
const fail = (why) => { console.log('NOT READY: ' + why); process.exit(1); };

// 1. the tree: HEAD's index, minus private/, written as a tree object
const idx = path.join(os.tmpdir(), 'ci-public-index-' + process.pid);
let tree;
try {
  git(['read-tree', 'HEAD'], { GIT_INDEX_FILE: idx });
  git(['rm', '-r', '--cached', '-q', '--ignore-unmatch', '--', PRIVATE_DIR], { GIT_INDEX_FILE: idx });
  tree = git(['write-tree'], { GIT_INDEX_FILE: idx });
} finally { try { fs.unlinkSync(idx); } catch {} }
const names = git(['ls-tree', '-r', '--name-only', tree]).split('\n').filter(Boolean);
if (names.some((n) => n.startsWith(PRIVATE_DIR))) fail('the tree still holds a path under ' + PRIVATE_DIR);
if (names.includes('.oss-private')) fail('the tree holds .oss-private');
console.log('tree ' + tree + ' · ' + names.length + ' files (HEAD ' + git(['rev-parse', '--short', 'HEAD']) + ')');

// 2. the export, as a stranger's checkout would see it
const out = path.join(os.tmpdir(), 'ci-public-tree');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
// git writes the files itself (a tar would read "C:" in a Windows path as a host)
const idx2 = idx + '-x';
try {
  git(['read-tree', tree], { GIT_INDEX_FILE: idx2 });
  git(['checkout-index', '-a', '-f', '--prefix=' + out.replace(/\\/g, '/') + '/'], { GIT_INDEX_FILE: idx2 });
} catch (e) { fail('the export did not write: ' + String((e && e.message) || e).split('\n')[0]); } finally { try { fs.unlinkSync(idx2); } catch {} }
if (names.some((n) => !fs.existsSync(path.join(out, n)))) fail('the export is missing files');

const problems = [];
try {
  // 3. the gate, with the private terms for this run only
  const priv = path.join(ROOT, '.oss-private');
  if (!fs.existsSync(priv)) problems.push('.oss-private is missing, so the gate cannot check the private terms');
  else fs.copyFileSync(priv, path.join(out, '.oss-private'));
  const g = spawnSync(process.execPath, [path.join(out, 'scripts', 'oss-check.js')], { cwd: out, encoding: 'utf8' });
  fs.rmSync(path.join(out, '.oss-private'), { force: true });
  if (g.status !== 0) problems.push('the gate blocked the export:\n' + String(g.stdout || '').split('\n').filter((l) => /BLOCK|private term/i.test(l)).slice(0, 12).join('\n'));

  // 4. words only the instance layer uses, as whole words (too short to be private terms)
  const WORDS = [/\bOmi\b/, /\bASI\b/];
  const TEXT = /\.(js|json|md|html|css|sh|ps1|py|yml|yaml|txt)$/i;
  for (const n of names) {
    if (!TEXT.test(n)) continue;
    const s = fs.readFileSync(path.join(out, n), 'utf8');
    for (const w of WORDS) { const m = w.exec(s); if (m) problems.push(n + ': "' + m[0] + '" belongs to the instance layer'); }
  }

  // 5. every script parses without the instance layer beside it
  for (const n of names.filter((f) => /\.js$/.test(f) && !/^node_modules\//.test(f))) {
    const c = spawnSync(process.execPath, ['--check', path.join(out, n)], { encoding: 'utf8' });
    if (c.status !== 0) problems.push(n + ' does not parse: ' + String(c.stderr || '').split('\n').find((l) => /Error/.test(l)));
  }
} finally {
  if (!keep) fs.rmSync(out, { recursive: true, force: true });
}

if (problems.length) fail(problems.length + ' problem(s)\n' + problems.join('\n'));
console.log((keep ? 'export kept at ' + out + '\n' : '') + 'PUBLIC TREE READY ' + tree);
