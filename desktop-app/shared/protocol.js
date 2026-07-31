'use strict';

const POWER_ON = Uint8Array.from([0xbc, 0x01, 0x01, 0x01, 0x55]);
const POWER_OFF = Uint8Array.from([0xbc, 0x01, 0x01, 0x00, 0x55]);
const MAX_BRIGHTNESS = Uint8Array.from([0xbc, 0x05, 0x06, 0x03, 0xe8, 0, 0, 0, 0, 0x55]);
const ZERO_BRIGHTNESS = Uint8Array.from([0xbc, 0x05, 0x06, 0, 0, 0, 0, 0, 0, 0x55]);
const STATIC_MODE = Uint8Array.from([0xbc, 0x06, 0x02, 0, 0x93, 0x55]);

const HUES = Object.freeze({ red: 0, yellow: 60, green: 120, blue: 240 });

function colorFrame(color) {
  if (!(color in HUES)) throw new Error(`Unsupported color: ${color}`);
  const hue = HUES[color];
  const saturation = 1000;
  return Uint8Array.from([
    0xbc, 0x04, 0x06,
    (hue >> 8) & 0xff, hue & 0xff,
    (saturation >> 8) & 0xff, saturation & 0xff,
    0, 0, 0x55,
  ]);
}

function burstSequence(color) {
  return [
    [0, ZERO_BRIGHTNESS],
    [200, POWER_ON],
    [400, STATIC_MODE],
    [600, colorFrame(color)],
    [800, MAX_BRIGHTNESS],
    [1040, ZERO_BRIGHTNESS], [1280, MAX_BRIGHTNESS],
    [1520, ZERO_BRIGHTNESS], [1760, MAX_BRIGHTNESS],
    [2000, ZERO_BRIGHTNESS], [2240, MAX_BRIGHTNESS],
    [2480, ZERO_BRIGHTNESS], [2720, MAX_BRIGHTNESS],
    [2960, ZERO_BRIGHTNESS], [3200, MAX_BRIGHTNESS],
    [3440, ZERO_BRIGHTNESS], [3680, MAX_BRIGHTNESS],
  ];
}

function hex(frame) {
  return [...frame].map((byte) => byte.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}

module.exports = { POWER_ON, POWER_OFF, MAX_BRIGHTNESS, ZERO_BRIGHTNESS, STATIC_MODE, HUES, colorFrame, burstSequence, hex };
