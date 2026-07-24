'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { POWER_ON, POWER_OFF, MAX_BRIGHTNESS, ZERO_BRIGHTNESS, colorFrame, burstSequence, hex } = require('../shared/protocol');

test('power frames match the captured JTX-RGB protocol', () => {
  assert.equal(hex(POWER_ON), 'BC 01 01 01 55');
  assert.equal(hex(POWER_OFF), 'BC 01 01 00 55');
  assert.equal(hex(MAX_BRIGHTNESS), 'BC 05 06 03 E8 00 00 00 00 55');
  assert.equal(hex(ZERO_BRIGHTNESS), 'BC 05 06 00 00 00 00 00 00 55');
});

test('HSV frames encode the four semantic colors', () => {
  assert.equal(hex(colorFrame('red')), 'BC 04 06 00 00 03 E8 00 00 55');
  assert.equal(hex(colorFrame('yellow')), 'BC 04 06 00 3C 03 E8 00 00 55');
  assert.equal(hex(colorFrame('green')), 'BC 04 06 00 78 03 E8 00 00 55');
  assert.equal(hex(colorFrame('blue')), 'BC 04 06 00 F0 03 E8 00 00 55');
  assert.throws(() => colorFrame('purple'), /Unsupported color/);
});

test('burst flashes three times and ends steady in the selected color', () => {
  const sequence = burstSequence('blue');
  assert.equal(sequence.length, 13);
  assert.deepEqual(sequence.map(([at]) => at), [0, 20, 40, 60, 200, 300, 320, 460, 560, 580, 720, 820, 840]);
  assert.equal(hex(sequence.at(-2)[1]), hex(colorFrame('blue')));
  assert.equal(hex(sequence.at(-1)[1]), hex(MAX_BRIGHTNESS));
  assert.equal(sequence.slice(1).some(([, frame]) => hex(frame) === hex(POWER_OFF)), false);
});
