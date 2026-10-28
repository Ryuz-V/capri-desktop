'use strict';

// Feeds the overlay with the position of other windows on Linux (Hyprland, Sway, X11/wmctrl),
// so Capri can sit on them.

const { startLinuxWindowWatch } = require('./windows-linux.js');

function startWindowWatch({ overlay, onUpdate }) {
  return startLinuxWindowWatch({ overlay, onUpdate });
}

module.exports = { startWindowWatch };
