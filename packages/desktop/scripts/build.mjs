// Bundles the desktop app: the Electron main process, the preload bridge, and the shell page
// (the connect / offline screens shown before a hub takes over the window). esbuild also resolves
// the web package's i18n, pulled in by relative import, so one bundle carries every locale.
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const root = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(root, '..', 'dist');
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

// The main process and the preload run on Electron's node; the shell page runs in a browser.
// `electron` stays external: it is provided by the runtime, not bundled.
for (const [src, file, platform] of [
  ['main/main.ts', 'main.cjs', 'node'],
  ['preload/preload.ts', 'preload.cjs', 'node'],
  ['shell/shell.ts', 'shell.js', 'browser'],
]) {
  await esbuild.build({
    entryPoints: [path.join(root, '..', 'src', src)],
    bundle: true,
    platform,
    format: 'cjs',
    target: platform === 'browser' ? 'es2022' : 'node20',
    outfile: path.join(out, file),
    external: platform === 'browser' ? [] : ['electron'],
    sourcemap: 'inline',
    logLevel: 'info',
  });
}

for (const file of ['shell.html', 'shell.css']) {
  await cp(path.join(root, '..', 'src', 'shell', file), path.join(out, file));
}
// The app icon, shared with the web package; also the source for the .icns at packaging time.
await cp(path.join(root, '..', '..', 'web', 'public', 'calli-icon.png'), path.join(out, 'calli-icon.png'));

// The bundle's own version, stamped for assemble-mac.mjs.
const { version } = JSON.parse(await readFile(path.join(root, '..', 'package.json'), 'utf8'));
await writeFile(path.join(out, 'version.json'), `${JSON.stringify({ version })}\n`, 'utf8');
console.log(`desktop built into ${path.relative(process.cwd(), out)}`);
