'use strict';

// Linux application controller for Capri (Arch Linux / generic Linux).
// Lists open windows, discovers installed XDG desktop applications,
// launches apps via gtk-launch / xdg-open / direct spawn, and closes apps via wmctrl / pkill.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');

// Processes Capri should never terminate or take over
const KEEP = new Set([
  'capri', 'electron', 'claude', 'ollama', 'ollama app',
  'systemd', 'init', 'kthreadd', 'bash', 'zsh', 'fish', 'sh',
  'xorg', 'xwayland', 'wayland', 'hyprland', 'sway', 'i3', 'kwin', 'mutter',
  'picom', 'waybar', 'polybar', 'tint2', 'xfce4-panel', 'gnome-shell',
  'dunst', 'mako', 'pipewire', 'wireplumber', 'pulseaudio',
]);

const ALIASES = {
  kalkulator: 'calculator',
  calc: 'calculator',
  catatan: 'texteditor',
  teks: 'texteditor',
  editor: 'texteditor',
  notepad: 'texteditor',
  browser: 'browser',
  peramban: 'browser',
  google: 'chrome',
  chrome: 'googlechrome',
  firefox: 'firefox',
  penjelajah: 'filemanager',
  berkas: 'filemanager',
  filemanager: 'filemanager',
  files: 'filemanager',
  fileexplorer: 'filemanager',
  nautilus: 'nautilus',
  dolphin: 'dolphin',
  thunar: 'thunar',
  musik: 'spotify',
  music: 'spotify',
  lagu: 'spotify',
  pemutarmusik: 'spotify',
  spotify: 'spotify',
  vscode: 'code',
  code: 'visualstudiocode',
  wa: 'whatsapp',
  wame: 'whatsapp',
  taskmgr: 'systemmonitor',
  taskmanager: 'systemmonitor',
  pengelola: 'systemmonitor',
  pengelolatugas: 'systemmonitor',
  terminal: 'terminal',
  konsol: 'terminal',
  setelan: 'settings',
  pengaturan: 'settings',
  setting: 'settings',
  gambar: 'gimp',
  lukis: 'gimp',
  gimp: 'gimp',
};

function execPromise(cmd, args, timeout = 2500) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout }, (err, stdout) => {
      if (err) resolve(null);
      else resolve(stdout ? stdout.trim() : '');
    });
  });
}

const simple = (text) => String(text || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

// [{ name, process: name, label, ids }]: one per windowed application currently open
async function list() {
  const apps = new Map();

  // Try 1: wmctrl (X11 / XWayland)
  const wmctrlOut = await execPromise('wmctrl', ['-lxp']);
  if (wmctrlOut) {
    const lines = wmctrlOut.split('\n');
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 5) continue;
      const pid = parseInt(parts[2], 10);
      const wmClass = parts[3] || '';
      const title = parts.slice(5).join(' ') || '';

      const name = (wmClass.split('.')[0] || wmClass || 'app').toLowerCase();
      if (!name || KEEP.has(name)) continue;

      const app = apps.get(name) || { name, process: name, label: title, ids: [] };
      if (!isNaN(pid) && pid > 0 && !app.ids.includes(pid)) app.ids.push(pid);
      if (title && !app.label) app.label = title;
      apps.set(name, app);
    }
  }

  // Try 2: Hyprland clients (if wmctrl didn't yield windows or we are on Wayland)
  if (apps.size === 0 && process.env.HYPRLAND_INSTANCE_SIGNATURE) {
    const raw = await execPromise('hyprctl', ['-j', 'clients']);
    if (raw) {
      try {
        const clients = JSON.parse(raw);
        for (const c of clients) {
          const name = (c.class || '').toLowerCase();
          if (!name || KEEP.has(name)) continue;
          const app = apps.get(name) || { name, process: name, label: c.title || '', ids: [] };
          if (c.pid && !app.ids.includes(c.pid)) app.ids.push(c.pid);
          apps.set(name, app);
        }
      } catch (_) {}
    }
  }

  // Try 3: Process fallback
  if (apps.size === 0) {
    const psOut = await execPromise('ps', ['-eo', 'pid,comm,args']);
    if (psOut) {
      const lines = psOut.split('\n').slice(1);
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 2) continue;
        const pid = parseInt(parts[0], 10);
        const comm = (parts[1] || '').toLowerCase();
        if (KEEP.has(comm) || comm.startsWith('kworker') || comm.startsWith('systemd')) continue;
        const app = apps.get(comm) || { name: comm, process: comm, label: comm, ids: [] };
        if (!isNaN(pid) && pid > 0) app.ids.push(pid);
        apps.set(comm, app);
      }
    }
  }

  return [...apps.values()];
}

// Find open app by name or label
async function find(wanted) {
  const key = simple(wanted);
  if (key.length < 2) return null;
  const apps = await list();
  const score = (app) => {
    const names = [simple(app.name), simple(app.label)].filter(Boolean);
    if (names.includes(key)) return 3;
    if (names.some((n) => n.startsWith(key) || key.startsWith(n))) return 2;
    if (key.length >= 3 && names.some((n) => n.includes(key) || key.includes(n))) return 1;
    return 0;
  };
  const best = apps.map((app) => [score(app), app]).filter(([s]) => s > 0).sort((a, b) => b[0] - a[0])[0];
  return best ? best[1] : null;
}

// Parse a single .desktop file
function parseDesktopFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');
    let inDesktopEntry = false;
    let name = '';
    let exec = '';
    let noDisplay = false;
    let icon = '';
    let comment = '';
    let categories = '';

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (line.startsWith('[')) {
        inDesktopEntry = line === '[Desktop Entry]';
        continue;
      }
      if (!inDesktopEntry || line.startsWith('#')) continue;

      const eq = line.indexOf('=');
      if (eq === -1) continue;
      const k = line.slice(0, eq).trim();
      const v = line.slice(eq + 1).trim();

      if (k === 'Name' && !name) name = v;
      else if (k === 'Exec' && !exec) exec = v;
      else if (k === 'NoDisplay') noDisplay = v.toLowerCase() === 'true';
      else if (k === 'Icon') icon = v;
      else if (k === 'Comment' && !comment) comment = v;
      else if (k === 'Categories') categories = v;
    }

    if (noDisplay || !name || !exec) return null;

    // Clean Exec placeholders (%f, %F, %u, %U, etc.)
    const cleanExec = exec.replace(/%[a-zA-Z]/g, '').trim();
    const appid = path.basename(filePath, '.desktop');

    return {
      name,
      appid,
      exec: cleanExec,
      icon,
      comment,
      categories,
    };
  } catch (_) {
    return null;
  }
}

let cachedInstalledApps = null;
let lastInstalledCacheTime = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

// Scans standard XDG application directories
async function getInstalledApps(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cachedInstalledApps && (now - lastInstalledCacheTime < CACHE_TTL_MS)) {
    return cachedInstalledApps;
  }

  const dirs = [
    path.join(os.homedir(), '.local', 'share', 'applications'),
    '/usr/local/share/applications',
    '/usr/share/applications',
    '/var/lib/flatpak/exports/share/applications',
  ];

  const appMap = new Map();

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    try {
      const files = fs.readdirSync(dir);
      for (const file of files) {
        if (!file.endsWith('.desktop')) continue;
        const fullPath = path.join(dir, file);
        const parsed = parseDesktopFile(fullPath);
        if (parsed && !appMap.has(parsed.appid)) {
          appMap.set(parsed.appid, parsed);
        }
      }
    } catch (_) {}
  }

  cachedInstalledApps = [...appMap.values()];
  lastInstalledCacheTime = now;
  return cachedInstalledApps;
}

function matchInstalledApp(wanted, apps) {
  const rawKey = simple(wanted);
  if (rawKey.length < 2) return null;
  const key = ALIASES[rawKey] || rawKey;

  const score = (app) => {
    const nameKey = simple(app.name);
    const appIdKey = simple(app.appid);
    const execKey = simple(app.exec.split(/\s+/)[0]);

    // Exact matches
    if (nameKey === key || nameKey === rawKey) return 100;
    if (appIdKey === key || appIdKey === rawKey) return 90;
    if (execKey === key || execKey === rawKey) return 85;

    // Starts with
    if (nameKey.startsWith(key) || (key.length >= 3 && key.startsWith(nameKey))) return 80;
    if (appIdKey.startsWith(key)) return 75;

    // Substring in app name
    if (key.length >= 3 && nameKey.includes(key)) return 60;
    // Substring in AppID
    if (key.length >= 3 && appIdKey.includes(key)) return 40;

    return 0;
  };

  const matches = apps
    .map((app) => ({ score: score(app), app }))
    .filter((m) => m.score > 0)
    .sort((a, b) => b.score - a.score);

  return matches.length > 0 ? matches[0].app : null;
}

// Opens/launches a desktop app by name or alias on Linux
// Returns { opened: true, app: 'Calculator' } or { opened: false, error: '...' }
async function open(wanted) {
  const trimmed = String(wanted || '').trim();
  if (!trimmed) return { opened: false, error: 'No app name provided' };

  const apps = await getInstalledApps();
  const matched = matchInstalledApp(trimmed, apps);

  if (matched) {
    // 1. Try launching with gtk-launch (standard across XDG desktop environments)
    if (matched.appid) {
      const out = await execPromise('gtk-launch', [matched.appid]);
      if (out !== null) {
        return { opened: true, app: matched.name };
      }
    }

    // 2. Try launching via executable defined in .desktop
    if (matched.exec) {
      try {
        const parts = matched.exec.match(/(?:[^\s"]+|"[^"]*")+/g) || [matched.exec];
        const cmd = parts[0].replace(/^"|"$/g, '');
        const args = parts.slice(1).map((a) => a.replace(/^"|"$/g, ''));
        const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
        child.unref();
        return { opened: true, app: matched.name };
      } catch (_) {}
    }
  }

  // 3. Fallback: check if binary exists in PATH (via which) with raw name or alias
  const rawKey = simple(trimmed);
  const alias = ALIASES[rawKey];
  const candidates = [trimmed, alias].filter(Boolean);

  for (const candidate of candidates) {
    const binaryPath = await execPromise('which', [candidate]);
    if (binaryPath) {
      try {
        const child = spawn(candidate, [], { detached: true, stdio: 'ignore' });
        child.unref();
        return { opened: true, app: matched ? matched.name : trimmed };
      } catch (_) {}
    }
  }

  return { opened: false, error: 'App not found or could not be launched' };
}

// Closes an app (gracefully via wmctrl or forcefully via pkill)
// Resolves with { running: Boolean }
async function close(name, { force = true } = {}) {
  const safeName = String(name || '').trim();
  if (!safeName || KEEP.has(safeName.toLowerCase())) return { running: true };

  const app = await find(safeName);
  const targetProcess = app ? app.process : safeName;

  if (!force) {
    // Graceful close: ask window to close
    await execPromise('wmctrl', ['-c', targetProcess]);
    await new Promise((r) => setTimeout(r, 600));
  } else {
    // Force close: send SIGTERM, then SIGKILL if needed
    if (app && app.ids && app.ids.length > 0) {
      for (const id of app.ids) {
        try { process.kill(id, 'SIGTERM'); } catch (_) {}
      }
      await new Promise((r) => setTimeout(r, 300));
      for (const id of app.ids) {
        try { process.kill(id, 'SIGKILL'); } catch (_) {}
      }
    } else {
      await execPromise('pkill', ['-15', '-f', targetProcess]);
      await new Promise((r) => setTimeout(r, 300));
      await execPromise('pkill', ['-9', '-f', targetProcess]);
    }
  }

  // Verify if it's still running
  const check = await execPromise('pgrep', ['-f', targetProcess]);
  return { running: Boolean(check && check.length > 0) };
}

module.exports = { list, find, close, open, getInstalledApps };
