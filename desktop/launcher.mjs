// Pokédex desktop launcher, started by Pokedex.exe (see desktop/install.ps1). Each time it opens:
//  1. It asks GitHub for the newest commit on the branch. If the app folder holds an older version
//     (or none), it downloads that commit, unpacks it next to the app folder, installs its packages
//     (or reuses the old ones when package-lock.json didn't change), moves the collection (data/)
//     across and swaps the folders. The code it replaced is kept as "<folder>.previous".
//  2. It starts the server and waits until it answers. A new version that doesn't start is rolled
//     back to the previous one, collection included.
//  3. It opens the app in its own window (Edge or Chrome "app" mode); closing the window stops
//     the server.
//  4. While the app is open it checks GitHub every 30 minutes and tells the app about a new
//     version, which offers "Restart to update".
// Everything is logged to launcher.log next to this file.

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import zlib from 'node:zlib';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const USER_AGENT = 'pokedex-collection-desktop/1.0 (+https://github.com/ksotox/LLMModel)';
const VERSION_FILE = '.pokedex-version';

export const DEFAULTS = {
  repo: 'ksotox/LLMModel',
  branch: 'main',
  appDir: path.join(process.env.USERPROFILE ?? process.env.HOME ?? HERE, 'LLMModel-main'),
  port: 3000,
  git: 'https://github.com',
  api: 'https://api.github.com',
  codeload: 'https://codeload.github.com',
  checkEveryMinutes: 30,
};

export function loadConfig(dir = HERE) {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8').replace(/^\uFEFF/, '')) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function makeLogger(file) {
  try {
    if (fs.statSync(file).size > 1024 * 1024) fs.rmSync(file); // keep the log small
  } catch { /* no log yet */ }
  return (...parts) => {
    const line = `${new Date().toISOString()} ${parts.join(' ')}\n`;
    try { fs.appendFileSync(file, line); } catch { /* logging must never stop the app */ }
    if (process.stdout.isTTY) process.stdout.write(line);
  };
}

// ---------------------------------------------------------------------------
// GitHub

/**
 * The newest commit on the branch: { sha, message, date }. The commit id comes from the same
 * address `git` uses (no API rate limit); the API, limited to 60 requests an hour per address,
 * only adds the commit message for the update banner, so its failure doesn't matter.
 */
export async function latestCommit({ git, api, repo, branch }) {
  const res = await fetch(`${git}/${repo}.git/info/refs?service=git-upload-pack`, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  const escaped = branch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const sha = (await res.text()).match(new RegExp(`([0-9a-f]{40}) refs/heads/${escaped}(?![\\w/.-])`))?.[1];
  if (!sha) throw new Error(`GitHub has no branch "${branch}"`);
  try {
    const info = await fetch(`${api}/repos/${repo}/commits/${sha}`, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(10000),
    });
    const body = info.ok ? await info.json() : null;
    return { sha, message: String(body?.commit?.message ?? '').split('\n')[0], date: body?.commit?.committer?.date ?? null };
  } catch {
    return { sha, message: '', date: null };
  }
}

async function download(url) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(5 * 60 * 1000) });
  if (!res.ok) throw new Error(`download failed: ${res.status} ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

// ---------------------------------------------------------------------------
// Unpacking GitHub's zip (stored or deflated entries), without the top folder it adds.

export function unzip(zip, destDir) {
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip file');
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  const root = path.resolve(destDir);
  fs.mkdirSync(root, { recursive: true });
  let files = 0;
  for (let n = 0; n < count; n++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) throw new Error('damaged zip file');
    const method = zip.readUInt16LE(p + 10);
    const size = zip.readUInt32LE(p + 20);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const local = zip.readUInt32LE(p + 42);
    const name = zip.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    const rel = name.split('/').slice(1).join('/'); // drop "LLMModel-<sha>/"
    if (!rel) continue;
    const target = path.resolve(root, rel);
    if (!target.startsWith(root + path.sep)) throw new Error(`unsafe path in zip: ${name}`);
    if (name.endsWith('/')) {
      fs.mkdirSync(target, { recursive: true });
      continue;
    }
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const raw = zip.subarray(start, start + size);
    const data = method === 0 ? raw : method === 8 ? zlib.inflateRawSync(raw) : null;
    if (!data) throw new Error(`unsupported zip compression ${method} for ${name}`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
    files++;
  }
  return files;
}

// ---------------------------------------------------------------------------
// Installing a version

export function installedVersion(appDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(appDir, VERSION_FILE), 'utf8'));
  } catch {
    return null;
  }
}

const fileHash = (file) => {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return null;
  }
};

function run(cmd, args, cwd, log) {
  return new Promise((resolve, reject) => {
    const win = process.platform === 'win32';
    const child = spawn(win ? `${cmd}.cmd` : cmd, args, { cwd, shell: win, windowsHide: true });
    child.stdout.on('data', (d) => log(String(d).trimEnd()));
    child.stderr.on('data', (d) => log(String(d).trimEnd()));
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(' ')} failed (exit ${code})`))));
  });
}

/** Packages for the new version: the old ones when the lock file is the same, else a clean install. */
async function installPackages(newDir, oldDir, log, { npm = run } = {}) {
  const same = oldDir && fileHash(path.join(newDir, 'package-lock.json')) === fileHash(path.join(oldDir, 'package-lock.json'));
  if (same && fs.existsSync(path.join(oldDir, 'node_modules'))) {
    // Copied, not moved, so the previous version still works if this one has to be rolled back.
    log('packages unchanged: copying them from the current version');
    fs.cpSync(path.join(oldDir, 'node_modules'), path.join(newDir, 'node_modules'), { recursive: true });
    return 'copied';
  }
  log('installing packages (npm ci)…');
  await npm('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], newDir, log);
  return 'installed';
}

/** A folder whose packages are missing (e.g. copied by hand) gets them installed before it starts. */
export async function ensurePackages(appDir, log, { npm = run } = {}) {
  if (fs.existsSync(path.join(appDir, 'node_modules', 'express'))) return false;
  log('packages missing: installing them (npm ci)…');
  await npm('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], appDir, log);
  return true;
}

const rmrf = (dir) => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });

/**
 * Bring the app folder up to `latest`. Returns { updated, from, to } (updated: false when it was
 * already current). Throws, leaving the current folder untouched, when anything before the swap fails.
 */
export async function update({ appDir, repo, codeload, latest, log, selfDir = null, npm }) {
  const current = installedVersion(appDir);
  if (current?.sha === latest.sha && fs.existsSync(path.join(appDir, 'package.json'))) return { updated: false, to: latest.sha };
  log(`updating ${current?.sha?.slice(0, 7) ?? '(unversioned)'} → ${latest.sha.slice(0, 7)}: ${latest.message}`);

  const staging = `${appDir}.new`;
  rmrf(staging);
  const zip = await download(`${codeload}/${repo}/zip/${latest.sha}`);
  const files = unzip(zip, staging);
  if (!fs.existsSync(path.join(staging, 'package.json'))) throw new Error('the download has no package.json');
  log(`unpacked ${files} files`);
  const hadApp = fs.existsSync(path.join(appDir, 'package.json'));
  await installPackages(staging, hadApp ? appDir : null, log, { npm });
  fs.writeFileSync(path.join(staging, VERSION_FILE), JSON.stringify({ ...latest, installedAt: new Date().toISOString() }, null, 2));

  // Swap: the current folder becomes .previous, its collection moves into the new one.
  const previous = `${appDir}.previous`;
  if (fs.existsSync(appDir)) {
    rmrf(previous);
    fs.renameSync(appDir, previous);
  }
  try {
    fs.renameSync(staging, appDir);
  } catch (err) {
    if (fs.existsSync(previous) && !fs.existsSync(appDir)) fs.renameSync(previous, appDir);
    throw new Error(`could not replace ${appDir} (is it open in another program?): ${err.message}`);
  }
  if (fs.existsSync(path.join(previous, 'data'))) fs.renameSync(path.join(previous, 'data'), path.join(appDir, 'data'));

  // The launcher updates itself too, from the next start.
  const nextLauncher = path.join(appDir, 'desktop', 'launcher.mjs');
  if (selfDir && fs.existsSync(nextLauncher)) fs.copyFileSync(nextLauncher, path.join(selfDir, 'launcher.mjs'));
  log(`updated to ${latest.sha.slice(0, 7)}`);
  return { updated: true, from: current?.sha ?? null, to: latest.sha };
}

/** Put the previous version back (with the collection) after a failed update. */
export function rollback({ appDir, log }) {
  const previous = `${appDir}.previous`;
  if (!fs.existsSync(path.join(previous, 'package.json'))) return false;
  const failed = `${appDir}.failed`;
  rmrf(failed);
  fs.renameSync(appDir, failed);
  if (fs.existsSync(path.join(failed, 'data'))) fs.renameSync(path.join(failed, 'data'), path.join(previous, 'data'));
  fs.renameSync(previous, appDir);
  log(`rolled back to ${installedVersion(appDir)?.sha?.slice(0, 7) ?? 'the previous version'}; the failed one is in ${failed}`);
  return true;
}

// ---------------------------------------------------------------------------
// Server and window

export async function isUp(url) {
  try {
    const res = await fetch(`${url}/api/meta`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function waitUntilUp(url, { timeoutMs = 60000, child = null } = {}) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (child && child.exitCode != null) return false;
    if (await isUp(url)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

export function startServer({ appDir, port, log }) {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], {
    cwd: appDir,
    env: { ...process.env, PORT: String(port), POKEDEX_DESKTOP: '1' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  });
  child.stdout.on('data', (d) => log('[server]', String(d).trimEnd()));
  child.stderr.on('data', (d) => log('[server]', String(d).trimEnd()));
  child.on('exit', (code) => log(`server stopped (exit ${code})`));
  return child;
}

export function stopServer(child, { timeoutMs = 8000 } = {}) {
  return new Promise((resolve) => {
    if (!child || child.exitCode != null) return resolve();
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    try {
      child.send({ type: 'shutdown' }); // lets the server close the database cleanly
    } catch {
      child.kill();
    }
  });
}

function findAppBrowser() {
  const roots = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean);
  const candidates = roots.flatMap((r) => [
    path.join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(r, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ]);
  return process.env.POKEDEX_BROWSER || candidates.find((c) => fs.existsSync(c)) || null;
}

/** The app in its own window. Returns the browser process (it ends when the window is closed), or null. */
export function openWindow(url, profileDir, log) {
  const browser = findAppBrowser();
  if (!browser) {
    log('no Edge or Chrome found: opening the default browser');
    if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '""', url], { windowsHide: true, windowsVerbatimArguments: true, stdio: 'ignore' });
    return null;
  }
  // Its own profile folder makes it a separate browser process, so we know when the window closes.
  return spawn(browser, [`--app=${url}`, `--user-data-dir=${profileDir}`, '--no-first-run', '--no-default-browser-check', '--window-size=1280,900'], { stdio: 'ignore' });
}

// ---------------------------------------------------------------------------

async function main() {
  const config = loadConfig();
  const log = makeLogger(path.join(HERE, 'launcher.log'));
  const url = `http://localhost:${config.port}`;
  const latestOrNull = () => latestCommit(config).catch((err) => { log(`update check failed: ${err.message}`); return null; });
  log(`starting (app folder ${config.appDir})`);

  // Already running (opened twice): just show another window.
  if (await isUp(url)) {
    log('already running: opening a window');
    openWindow(url, path.join(HERE, 'window'), log);
    return;
  }

  let server = null;
  let pending = null; // newest version known to be waiting

  const bringUp = async () => {
    const latest = await latestOrNull();
    let result = { updated: false };
    if (latest) {
      try {
        result = await update({ ...config, latest, log, selfDir: HERE });
      } catch (err) {
        log(`update failed, keeping the current version: ${err.message}`);
      }
    }
    if (!fs.existsSync(path.join(config.appDir, 'package.json'))) throw new Error(`The app isn't installed in ${config.appDir} and couldn't be downloaded (are you online?).`);
    await ensurePackages(config.appDir, log);
    server = startServer({ ...config, log });
    if (await waitUntilUp(url, { child: server })) return;
    if (result.updated) {
      log('the new version did not start: rolling back');
      await stopServer(server);
      if (rollback({ ...config, log })) {
        server = startServer({ ...config, log });
        if (await waitUntilUp(url, { child: server })) return;
      }
    }
    throw new Error(`The server didn't start. Details are in ${path.join(HERE, 'launcher.log')}.`);
  };

  const listen = () => {
    server.on('message', async (msg) => {
      if (msg?.type !== 'restart') return;
      log('restart requested from the app');
      await stopServer(server);
      try {
        await bringUp();
        pending = null;
        listen();
      } catch (err) {
        log(err.message);
        process.exit(1);
      }
    });
    if (pending) server.send({ type: 'update-available', ...pending });
  };

  await bringUp();
  listen();

  // Tell the app when a newer version is merged, so it can offer to restart.
  const timer = setInterval(async () => {
    const latest = await latestOrNull();
    if (!latest || latest.sha === installedVersion(config.appDir)?.sha) return;
    pending = latest;
    log(`update available: ${latest.sha.slice(0, 7)} ${latest.message}`);
    try { server.send({ type: 'update-available', ...latest }); } catch { /* restarting */ }
  }, config.checkEveryMinutes * 60 * 1000);

  const win = openWindow(url, path.join(HERE, 'window'), log);
  const quit = async () => {
    clearInterval(timer);
    await stopServer(server);
    log('closed');
    process.exit(0);
  };
  if (win) win.on('exit', quit);
  else server.on('exit', () => process.exit(0));
  process.on('SIGINT', quit);
  process.on('SIGTERM', quit);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((err) => {
    try { fs.appendFileSync(path.join(HERE, 'launcher.log'), `${new Date().toISOString()} FAILED ${err.stack ?? err}\n`); } catch { /* ignore */ }
    console.error(err.message);
    process.exit(1);
  });
}
