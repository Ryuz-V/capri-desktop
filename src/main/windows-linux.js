'use strict';

// Linux window watcher for Capri (Arch Linux / generic Linux).
// Supports:
// 1. Hyprland (hyprctl)
// 2. Sway / i3 (swaymsg)
// 3. X11 / Xorg / XWayland (wmctrl + xprop)
// 4. Safe fallback (emits empty wins if tools are absent, keeping Capri alive on screen floor)

const { execFile } = require('node:child_process');

function execPromise(cmd, args, timeout = 1000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout }, (err, stdout) => {
      if (err) resolve(null);
      else resolve(stdout ? stdout.trim() : '');
    });
  });
}

class LinuxWindowWatcher {
  constructor() {
    this.detector = null; // 'hyprland' | 'sway' | 'x11' | 'none'
    this.detectTried = false;
  }

  async detect() {
    if (this.detectTried) return this.detector;
    this.detectTried = true;

    // 1. Check Hyprland
    if (process.env.HYPRLAND_INSTANCE_SIGNATURE) {
      const test = await execPromise('hyprctl', ['version']);
      if (test) {
        this.detector = 'hyprland';
        return this.detector;
      }
    }

    // 2. Check Sway / i3
    if (process.env.SWAYSOCK) {
      const test = await execPromise('swaymsg', ['-v']);
      if (test) {
        this.detector = 'sway';
        return this.detector;
      }
    }

    // 3. Check X11 (wmctrl)
    const testWmctrl = await execPromise('wmctrl', ['-m']);
    if (testWmctrl) {
      this.detector = 'x11';
      return this.detector;
    }

    this.detector = 'none';
    console.info('[capri] Window perching: no window tracker found (install wmctrl for X11 or use Hyprland/Sway). Running in floor mode.');
    return this.detector;
  }

  async snapshot() {
    const backend = await this.detect();

    if (backend === 'hyprland') {
      return this.snapshotHyprland();
    }
    if (backend === 'sway') {
      return this.snapshotSway();
    }
    if (backend === 'x11') {
      return this.snapshotX11();
    }

    return { fg: 0, wins: [] };
  }

  async snapshotHyprland() {
    const [clientsRaw, activeRaw] = await Promise.all([
      execPromise('hyprctl', ['-j', 'clients']),
      execPromise('hyprctl', ['-j', 'activewindow']),
    ]);

    let clients = [];
    let active = null;

    try { if (clientsRaw) clients = JSON.parse(clientsRaw); } catch (_) {}
    try { if (activeRaw) active = JSON.parse(activeRaw); } catch (_) {}

    const fg = active?.address ? parseInt(active.address.slice(-8), 16) || 0 : 0;
    const wins = [];

    for (const c of clients) {
      if (!c.at || !c.size || c.mapped === false) continue;
      const [x, y] = c.at;
      const [w, h] = c.size;
      if (w < 200 || h < 120) continue;
      const id = c.address ? parseInt(c.address.slice(-8), 16) || wins.length + 1 : wins.length + 1;
      wins.push({
        id,
        x,
        y,
        w,
        h,
        max: Boolean(c.fullscreen),
      });
    }

    return { fg, wins };
  }

  async snapshotSway() {
    const treeRaw = await execPromise('swaymsg', ['-t', 'get_tree']);
    if (!treeRaw) return { fg: 0, wins: [] };

    let tree;
    try { tree = JSON.parse(treeRaw); } catch (_) { return { fg: 0, wins: [] }; }

    const wins = [];
    let fg = 0;

    const walk = (node) => {
      if (!node) return;
      if (node.focused) fg = node.id || 0;
      if (node.rect && node.visible && node.name && node.rect.width >= 200 && node.rect.height >= 120) {
        wins.push({
          id: node.id || wins.length + 1,
          x: node.rect.x,
          y: node.rect.y,
          w: node.rect.width,
          h: node.rect.height,
          max: Boolean(node.fullscreen_mode),
        });
      }
      if (Array.isArray(node.nodes)) node.nodes.forEach(walk);
      if (Array.isArray(node.floating_nodes)) node.floating_nodes.forEach(walk);
    };

    walk(tree);
    return { fg, wins };
  }

  async snapshotX11() {
    const [wmctrlOut, xpropOut] = await Promise.all([
      execPromise('wmctrl', ['-lG']),
      execPromise('xprop', ['-root', '_NET_ACTIVE_WINDOW']),
    ]);

    let fg = 0;
    if (xpropOut) {
      const match = xpropOut.match(/#\s*(0x[0-9a-fA-F]+)/);
      if (match) fg = parseInt(match[1], 16) || 0;
    }

    const wins = [];
    if (wmctrlOut) {
      const lines = wmctrlOut.split('\n');
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 7) continue;
        const hexId = parts[0];
        const id = parseInt(hexId, 16) || 0;
        const desktop = parseInt(parts[1], 10);
        // Exclude sticky/minimized windows if desktop is negative
        if (desktop < -1) continue;
        const x = parseInt(parts[2], 10);
        const y = parseInt(parts[3], 10);
        const w = parseInt(parts[4], 10);
        const h = parseInt(parts[5], 10);

        if (isNaN(x) || isNaN(y) || isNaN(w) || isNaN(h)) continue;
        if (w < 200 || h < 120) continue;

        wins.push({
          id,
          x,
          y,
          w,
          h,
          max: false,
        });
      }
    }

    return { fg, wins };
  }
}

function startLinuxWindowWatch({ overlay, onUpdate }) {
  const watcher = new LinuxWindowWatcher();
  let timer = null;
  let stopped = false;
  let lastJson = '';

  const loop = async () => {
    if (stopped || overlay.isDestroyed()) return;

    try {
      const snap = await watcher.snapshot();
      const snapJson = JSON.stringify(snap);

      if (snapJson !== lastJson) {
        lastJson = snapJson;
        const bounds = overlay.getBounds();
        const wins = snap.wins
          .map((w) => {
            // Map coordinates relative to the overlay bounds
            return {
              id: w.id,
              x: w.x - bounds.x,
              y: w.y - bounds.y,
              w: w.w,
              h: w.h,
              max: w.max,
            };
          })
          .filter((w) => w.x < bounds.width && w.x + w.w > 0 && w.y < bounds.height && w.y + w.h > 0);

        onUpdate({ fg: snap.fg, wins });
      }
    } catch (_) {}

    if (!stopped) {
      timer = setTimeout(loop, 250);
    }
  };

  loop();

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

module.exports = { startLinuxWindowWatch };
