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
    [20, POWER_ON],
    [30, STATIC_MODE],
    [40, colorFrame(color)],
    [60, MAX_BRIGHTNESS],
    [180, ZERO_BRIGHTNESS],
    [280, colorFrame(color)],
    [300, MAX_BRIGHTNESS],
    [420, ZERO_BRIGHTNESS],
    [520, colorFrame(color)],
    [540, MAX_BRIGHTNESS],
    [660, ZERO_BRIGHTNESS],
    [760, colorFrame(color)],
    [780, MAX_BRIGHTNESS],
    [900, ZERO_BRIGHTNESS],
    [1000, colorFrame(color)],
    [1020, MAX_BRIGHTNESS],
    [1140, ZERO_BRIGHTNESS],
    [1240, colorFrame(color)],
    [1260, MAX_BRIGHTNESS],
    [1380, ZERO_BRIGHTNESS],
    [1480, colorFrame(color)],
    [1500, MAX_BRIGHTNESS],
  ];
}

function hex(frame) {
  return [...frame].map((byte) => byte.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}

module.exports = { POWER_ON, POWER_OFF, MAX_BRIGHTNESS, ZERO_BRIGHTNESS, STATIC_MODE, HUES, colorFrame, burstSequence, hex };
