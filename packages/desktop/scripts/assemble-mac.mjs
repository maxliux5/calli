/**
 * Assembles a runnable macOS app on any machine that can run node, unzip and python3 — including
 * this Linux build host. There is no code signing here: the zip that comes out is for yourself and
 * people who trust you; a signed, notarised build belongs to the release pipeline (Phase 2).
 *
 *   npm run dist:mac [-- --arch universal|arm64]
 *
 * Downloads the official Electron darwin zip (cache: release/cache), renames the bundle, points
 * its icon and Info.plist at Calli, drops our built dist in as Resources/app, and zips the result
 * with symlinks and permissions intact (python's zipfile, since no `zip` here).
 */
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = path.join(here, '..');
const argArch = process.argv.includes('--arch') ? process.argv[process.argv.indexOf('--arch') + 1] : process.argv.find((a) => !a.endsWith('.mjs') && !a.startsWith('--') && ['universal', 'arm64', 'x64'].includes(a));
const arch = argArch ?? 'universal';
const { version: appVersion } = JSON.parse(await readFile(path.join(pkg, 'package.json'), 'utf8'));
// Workspaces hoist electron to the root node_modules; resolve it the way node itself would.
const electronMeta = createRequire(path.join(pkg, 'package.json')).resolve('electron/package.json');
const { version: electronVersion } = JSON.parse(await readFile(electronMeta, 'utf8'));

// Zips the app with symlinks as symlinks and permissions as they are; macOS unzip honours both.
const ZIP_SCRIPT = `
import os, stat, sys, zipfile
root, out = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    for dirpath, dirnames, filenames in os.walk(root):
        # A symlink to a directory walks in as a dirname: it must be stored as a symlink, not descended.
        for name in sorted(dirnames) + sorted(filenames):
            p = os.path.join(dirpath, name)
            st = os.lstat(p)
            if stat.S_ISDIR(st.st_mode):
                continue
            arc = os.path.relpath(p)
            info = zipfile.ZipInfo(arc, (2020, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = (stat.S_IFMT(st.st_mode) | (st.st_mode & 0o777)) << 16
            if stat.S_ISLNK(st.st_mode):
                z.writestr(info, os.readlink(p))
            else:
                with open(p, 'rb') as f:
                    z.writestr(info, f.read())
`;

const release = path.join(pkg, 'release');
const cache = path.join(release, 'cache');
const zipName = `electron-v${electronVersion}-darwin-${arch}.zip`;
const mirror = (process.env.ELECTRON_MIRROR ?? 'https://npmmirror.com/mirrors/electron').replace(/\/$/, '');
const url = `${mirror}/v${electronVersion}/${zipName}`;
await mkdir(cache, { recursive: true });

if (!existsSync(path.join(pkg, 'dist', 'main.cjs'))) throw new Error('run `npm run build` first');
if (!existsSync(path.join(cache, zipName))) {
  console.log(`downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: ${res.status} ${url}`);
  await writeFile(path.join(cache, zipName), Buffer.from(await res.arrayBuffer()));
}

const stage = await mkdtemp(path.join(os.tmpdir(), 'calli-mac-'));
try {
  console.log('unzipping Electron');
  await run('unzip', ['-q', path.join(cache, zipName), '-d', stage]);
  const appDir = path.join(stage, 'Calli.app');
  await run('mv', [path.join(stage, 'Electron.app'), appDir]);

  console.log('editing Info.plist');
  const plist = path.join(appDir, 'Contents', 'Info.plist');
  let text = await readFile(plist, 'utf8');
  const set = (key, value) => {
    const re = new RegExp(`(<key>${key}</key>\\s*<string>)[^<]*(</string>)`);
    if (!re.test(text)) throw new Error(`Info.plist has no ${key}`);
    text = text.replace(re, `$1${value}$2`);
  };
  set('CFBundleName', 'Calli');
  set('CFBundleDisplayName', 'Calli');
  set('CFBundleIdentifier', 'dev.calli.desktop');
  set('CFBundleShortVersionString', appVersion);
  set('CFBundleVersion', appVersion);
  if (!/<key>CFBundleURLTypes<\/key>/.test(text)) {
    // calli:// links: registered at runtime as well; declared here so it survives moves.
    text = text.replace(
      /<\/dict>\s*<\/plist>\s*$/,
      `\t<key>CFBundleURLTypes</key>\n\t<array>\n\t\t<dict>\n\t\t\t<key>CFBundleURLName</key>\n\t\t\t<string>Calli hub address</string>\n\t\t\t<key>CFBundleURLSchemes</key>\n\t\t\t<array>\n\t\t\t\t<string>calli</string>\n\t\t\t</array>\n\t\t</dict>\n\t</array>\n</dict>\n</plist>\n`,
    );
  }
  await writeFile(plist, text, 'utf8');

  console.log('drawing the icon');
  const iconSource = path.join(pkg, '..', 'web', 'public', 'calli-icon.png');
  await run('python3', [
    '-c',
    'import sys\nfrom PIL import Image\nimg = Image.open(sys.argv[1]).convert("RGBA")\nimg.resize((1024, 1024)).save(sys.argv[2], format="ICNS", append_images=[img.resize((s, s)) for s in (512, 256, 128, 64, 32, 16)])',
    iconSource,
    path.join(appDir, 'Contents', 'Resources', 'electron.icns'),
  ]);

  console.log('adding the app');
  const appResources = path.join(appDir, 'Contents', 'Resources', 'app');
  await mkdir(appResources, { recursive: true });
  await writeFile(
    path.join(appResources, 'package.json'),
    `${JSON.stringify({ name: 'calli-desktop', version: appVersion, main: 'dist/main.cjs', private: true }, null, 2)}\n`,
    'utf8',
  );
  await cp(path.join(pkg, 'dist'), path.join(appResources, 'dist'), { recursive: true });

  console.log('zipping');
  const outZip = path.join(release, `Calli-${appVersion}-mac-${arch}.zip`);
  await run('python3', ['-c', ZIP_SCRIPT, 'Calli.app', outZip], { cwd: stage });
  const { size } = await (await import('node:fs/promises')).stat(outZip);
  console.log(`built ${outZip} (${(size / 1024 / 1024).toFixed(0)} MB)`);
  console.log('first run on a Mac: unzip, then `xattr -cr Calli.app` if the Mac calls it damaged (no signature in this build)');
} finally {
  await rm(stage, { recursive: true, force: true });
}
