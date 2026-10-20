#!/usr/bin/env node
// The GitHub repository this project is published from lives in one place: "repository" in
// worker/package.json. The setup scripts run on their own from the web (irm | iex, curl | bash) and the docs
// are plain markdown, so they spell it out; this changes it there and in all of them (a fork runs it once).
// worker/test/node/repository.test.js fails when any of them disagrees.
//   node scripts/dev/set-repository.mjs owner/name
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const pkgPath = join(root, 'worker', 'package.json');

/** The files that name the repository. */
export const FILES = ['README.md', 'docs/setup.md', 'scripts/setup.ps1', 'scripts/setup.sh', 'CONTRIBUTING.md', 'worker/public/join.html'];

export function repoOf(pkg) {
  const m = /github\.com\/([^/]+)\/([^/.]+)/.exec(pkg.repository?.url ?? '');
  if (!m) throw new Error('worker/package.json has no "repository" with a github.com URL');
  return { owner: m[1], name: m[2] };
}
const pagesOf = ({ owner, name }) => `https://${owner.toLowerCase()}.github.io/${name}/`;

/** Every reference to this project's repository in a text, as found: [{ form, repo }] ("owner/name"). */
export function references(text) {
  const out = [];
  const add = (form, re) => { for (const m of text.matchAll(re)) if (!m[1].includes('$')) out.push({ form, repo: m[1] }); };   // $Repo/$Branch: built from the variable
  add('raw', /raw\.githubusercontent\.com\/([^/\s]+\/[^/\s]+)\//g);
  add('archive', /codeload\.github\.com\/([^/\s]+\/[^/\s]+)\//g);
  add('clone', /github\.com\/([^/\s]+\/[^/\s]+?)\.git\b/g);
  add('$Repo', /^\$Repo = '([^']+)'/gm);
  add('REPO', /^REPO="\$\{SAQME_REPO:-([^}]+)\}"/gm);
  for (const m of text.matchAll(/https:\/\/([a-z0-9-]+)\.github\.io\/([^/\s]+)\//g)) out.push({ form: 'pages', repo: `${m[1]}/${m[2]}` });
  return out;
}

function replaceRepo(text, from, to) {
  const a = `${from.owner}/${from.name}`;
  const b = `${to.owner}/${to.name}`;
  return text
    .replaceAll(`raw.githubusercontent.com/${a}/`, `raw.githubusercontent.com/${b}/`)
    .replaceAll(`codeload.github.com/${a}/`, `codeload.github.com/${b}/`)
    .replaceAll(`github.com/${a}/`, `github.com/${b}/`)
    .replaceAll(`github.com/${a})`, `github.com/${b})`)
    .replaceAll(`github.com/${a}.git`, `github.com/${b}.git`)
    .replace(/^(\$Repo = ')[^']*(')/m, `$1${b}$2`)
    .replace(/^(REPO="\$\{SAQME_REPO:-)[^}]*(\}")/m, `$1${b}$2`)
    .replaceAll(pagesOf(from), pagesOf(to));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const arg = process.argv[2] ?? '';
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(arg)) { console.error('usage: node scripts/dev/set-repository.mjs owner/name'); process.exit(2); }
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const from = repoOf(pkg);
  const [owner, name] = arg.split('/');
  const to = { owner, name };
  pkg.repository = { type: 'git', url: `https://github.com/${owner}/${name}` };
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  for (const f of FILES) {
    const p = join(root, f);
    const before = readFileSync(p, 'utf8');
    const after = replaceRepo(before, from, to);
    if (after !== before) { writeFileSync(p, after); console.log(`updated ${f}`); }
  }
  console.log(`repository: ${owner}/${name}; the phone app on GitHub Pages: ${pagesOf(to)}`);
}
