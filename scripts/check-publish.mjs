#!/usr/bin/env node
// Looks for things that must not be published: your user name, host name and home directory,
// private IP addresses, long secrets, personal e-mail addresses, and words you list yourself.
//
//   npm run check:publish                      scan everything git would publish
//   node scripts/check-publish.mjs --staged    scan only what this commit adds (the hook)
//
// The staged mode checks added lines only, so findings already sitting in history do not block
// work on unrelated files, while new leaks never get in.
//
// Words of your own (company or project names, for example) go in a file outside the repository,
// one per line: $CALLI_PUBLISH_DENYLIST, or ~/.config/calli/publish-denylist by default.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir, hostname, userInfo } from 'node:os';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const rules = [];
const add = (label, pattern) => rules.push({ label, pattern });

const user = userInfo().username;
if (user.length >= 3) add('user name', new RegExp(`\\b${escape(user)}\\b`, 'i'));
const host = hostname().split('.')[0];
if (host.length >= 3 && host !== 'localhost') add('host name', new RegExp(`\\b${escape(host)}\\b`, 'i'));
for (const dir of new Set([homedir(), safeRealpath(homedir())])) if (dir && dir !== '/') add('home directory', new RegExp(escape(dir)));
add('private IP address', /\b(?:10\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])|192\.168)\.\d{1,3}\.\d{1,3}\b/);
add('long secret', /\b[a-f0-9]{32,}\b/i);
// A domain ends in letters, so package specs such as name@1.2.3 are not mistaken for addresses.
add('e-mail address', /\b[\w.+-]+@(?!example\.(?:com|org)\b|users\.noreply\.github\.com\b)(?:[\w-]+\.)+[a-z]{2,}\b/i);

const denylist = process.env.CALLI_PUBLISH_DENYLIST || join(homedir(), '.config', 'calli', 'publish-denylist');
if (existsSync(denylist)) {
  for (const word of readFileSync(denylist, 'utf8').split('\n').map((w) => w.trim()).filter((w) => w && !w.startsWith('#'))) {
    add('word from your denylist', new RegExp(escape(word), 'i'));
  }
}

function safeRealpath(p) {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

// What git would publish: tracked files plus untracked ones that are not ignored.
const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' })
  .split('\0')
  .filter(Boolean)
  .filter((f) => f !== 'package-lock.json'); // integrity hashes look like secrets

let findings = 0;

/** The lines this commit adds, so the hook can judge the change and not all of history. */
function stagedAddedLines(file) {
  const diff = execFileSync('git', ['diff', '--cached', '-U0', '--', file], { cwd: root, encoding: 'utf8' });
  return diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++'));
}

if (process.argv.includes('--staged')) {
  const staged = execFileSync('git', ['diff', '--cached', '--name-only', '-z'], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean)
    .filter((f) => f !== 'package-lock.json');
  for (const file of staged) {
    for (const line of stagedAddedLines(file)) {
      for (const rule of rules) {
        const m = rule.pattern.exec(line);
        if (!m) continue;
        findings += 1;
        const shown = m[0].length > 6 ? `${m[0].slice(0, 3)}…${m[0].slice(-2)}` : '…';
        console.log(`${file}: staged ${rule.label} (${shown})`);
      }
    }
  }
} else {
for (const file of files) {
  const path = join(root, file);
  if (!existsSync(path) || statSync(path).size > 2 * 1024 * 1024) continue;
  const buf = readFileSync(path);
  if (buf.includes(0)) continue; // binary
  const lines = buf.toString('utf8').split('\n');
  lines.forEach((line, i) => {
    for (const rule of rules) {
      const m = rule.pattern.exec(line);
      if (!m) continue;
      findings += 1;
      // The match itself is not printed in full: it may be the very thing that must not leak.
      const shown = m[0].length > 6 ? `${m[0].slice(0, 3)}…${m[0].slice(-2)}` : '…';
      console.log(`${file}:${i + 1}: ${rule.label} (${shown})`);
    }
  });
}
}
// The lockfile still gets one check of its own: whatever npm wrote as "resolved" must point at
// the public registry. A machine whose npm is configured for an internal mirror writes that
// mirror's host into every line it adds, which is exactly the name that must not be published.
const lockfile = join(root, 'package-lock.json');
if (existsSync(lockfile)) {
  readFileSync(lockfile, 'utf8').split('\n').forEach((line, i) => {
    const m = /"resolved": "https?:\/\/([^/\"]+)\//.exec(line);
    if (m && m[1] !== 'registry.npmjs.org' && m[1] !== 'registry.yarnpkg.com') {
      findings += 1;
      console.log(`package-lock.json:${i + 1}: non-public registry host (${m[1].slice(0, 4)}…)`);
    }
  });
}

if (findings > 0) {
  console.log(`\n${findings} finding(s)${process.argv.includes('--staged') ? ' in what this commit adds' : ` in ${files.length} files`}. Remove them before publishing.`);
  process.exit(1);
}
console.log(`No findings (${rules.length} checks${existsSync(denylist) ? ', including your denylist' : ''}${process.argv.includes('--staged') ? ' on staged changes' : ` in ${files.length} files`}).`);
