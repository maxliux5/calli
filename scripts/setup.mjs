#!/usr/bin/env node
// One command to a working .env: creates it from the template if missing, fills in a random
// access token when empty, and prints the token so it can be pasted straight into the browser.
// Also installs the repository's pre-commit hook (the publish check).
//
//   npm run setup
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const envPath = join(root, '.env');
const examplePath = join(root, '.env.example');

if (!existsSync(examplePath)) {
  console.error('.env.example not found — run this from a full checkout of the repository.');
  process.exit(1);
}
if (!existsSync(envPath)) {
  copyFileSync(examplePath, envPath);
  console.log(`Created ${envPath} from the template.`);
}

let lines = readFileSync(envPath, 'utf8').split('\n');
// RAH_TOKEN is its name from before the rename to Calli; a token set then is kept as it is.
const at = lines.findIndex((l) => /^(CALLI|RAH)_TOKEN=/.test(l));
const current = at >= 0 ? lines[at].slice(lines[at].indexOf('=') + 1).trim() : '';
if (current) {
  console.log('The access token is already set. To see it:');
  console.log(`  grep -E '^(CALLI|RAH)_TOKEN=' ${envPath}`);
} else {
  const token = randomBytes(24).toString('hex');
  if (at >= 0) lines[at] = `CALLI_TOKEN=${token}`;
  else lines.push(`CALLI_TOKEN=${token}`);
  writeFileSync(envPath, lines.join('\n'));
  console.log('Generated a random access token:');
  console.log(`  ${token}`);
  console.log('Use it to sign in at http://127.0.0.1:8787/ .');
}

// The publish check as a pre-commit hook: installed by pointing git at the hooks kept in the
// repository, so every checkout gets it without copying anything around.
try {
  execFileSync('git', ['config', 'core.hooksPath', 'scripts/hooks'], { cwd: root });
  console.log('Pre-commit hook installed (scripts/hooks; the publish check runs on what a commit adds).');
} catch {
  console.log('Not a git checkout — skipped the pre-commit hook.');
}

console.log(`
Next:
  npm run build
  CALLI_ENV_FILE=../../.env npm start -w @calli/daemon   # from the repo root`);
