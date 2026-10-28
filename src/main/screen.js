'use strict';

// Screen capture for Capri's desktop vision.
// Captures a display via Electron's desktopCapturer and returns a JPEG base64 string.

const { desktopCapturer } = require('electron');

async function captureScreen({ displayId = null, maxWidth = 1280, maxHeight = 720, quality = 80 } = {}) {
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: maxWidth, height: maxHeight },
    fetchWindowIcons: false,
  });

  if (!sources || sources.length === 0) {
    throw new Error('No screen sources available');
  }

  let source = sources[0];
  if (displayId !== null) {
    const match = sources.find((s) => String(s.display_id) === String(displayId));
    if (match) source = match;
  }

  if (!source.thumbnail || source.thumbnail.isEmpty()) {
    throw new Error('Screen capture thumbnail is empty');
  }

  const jpegBuffer = source.thumbnail.toJPEG(quality);
  return jpegBuffer.toString('base64');
}

module.exports = { captureScreen };
