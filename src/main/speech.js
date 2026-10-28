'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');

const SCRIPT = path.join(__dirname, 'stt.py');

function transcribe({ wavBase64, lang = 'id-ID' } = {}) {
  return new Promise((resolve) => {
    if (!wavBase64) {
      resolve({ ok: false, error: 'No audio data' });
      return;
    }

    const py = spawn('python', [SCRIPT], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    py.stdout.on('data', (d) => { stdout += d.toString(); });
    py.stderr.on('data', (d) => { stderr += d.toString(); });

    py.on('error', (err) => {
      resolve({ ok: false, error: `Failed to launch python STT: ${err.message}` });
    });

    py.on('close', (code) => {
      if (code !== 0 && !stdout.trim()) {
        resolve({ ok: false, error: stderr.trim() || `STT process exited with code ${code}` });
        return;
      }
      try {
        const res = JSON.parse(stdout.trim());
        resolve(res);
      } catch (err) {
        resolve({ ok: false, error: stdout.trim() || stderr.trim() || err.message });
      }
    });

    py.stdin.write(JSON.stringify({ wavBase64, lang }));
    py.stdin.end();
  });
}

module.exports = { transcribe };
