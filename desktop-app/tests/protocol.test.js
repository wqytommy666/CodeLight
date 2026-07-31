'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { POWER_ON, POWER_OFF, MAX_BRIGHTNESS, ZERO_BRIGHTNESS, STATIC_MODE, colorFrame, burstSequence, hex } = require('../shared/protocol');
const source = fs.readFileSync(path.join(__dirname, '..', '..', 'Sources', 'AgentLightDaemon.swift'), 'utf8');

test('power frames match the captured JTX-RGB protocol', () => {
  assert.equal(hex(POWER_ON), 'BC 01 01 01 55');
  assert.equal(hex(POWER_OFF), 'BC 01 01 00 55');
  assert.equal(hex(MAX_BRIGHTNESS), 'BC 05 06 03 E8 00 00 00 00 55');
  assert.equal(hex(ZERO_BRIGHTNESS), 'BC 05 06 00 00 00 00 00 00 55');
  assert.equal(hex(STATIC_MODE), 'BC 06 02 00 93 55');
});

test('HSV frames encode the four semantic colors', () => {
  assert.equal(hex(colorFrame('red')), 'BC 04 06 00 00 03 E8 00 00 55');
  assert.equal(hex(colorFrame('yellow')), 'BC 04 06 00 3C 03 E8 00 00 55');
  assert.equal(hex(colorFrame('green')), 'BC 04 06 00 78 03 E8 00 00 55');
  assert.equal(hex(colorFrame('blue')), 'BC 04 06 00 F0 03 E8 00 00 55');
  assert.throws(() => colorFrame('purple'), /Unsupported color/);
});

test('burst flashes six times and ends steady in the selected color', () => {
  const sequence = burstSequence('blue');
  assert.equal(sequence.length, 17);
  assert.deepEqual(sequence.map(([at]) => at), [
    0, 200, 400, 600, 800, 1040, 1280, 1520, 1760,
    2000, 2240, 2480, 2720, 2960, 3200, 3440, 3680,
  ]);
  assert.equal(hex(sequence[3][1]), hex(colorFrame('blue')));
  assert.equal(hex(sequence.at(-1)[1]), hex(MAX_BRIGHTNESS));
  assert.equal(sequence.slice(1).some(([, frame]) => hex(frame) === hex(POWER_OFF)), false);
});

test('multi-lamp demos support a shared wall-clock start for synchronized flashing', () => {
  assert.match(source, /case "demo-at":/);
  assert.match(source, /startMilliseconds \/ 1000/);
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
  assert.match(main, /demo-at \$\{demo\[1\]/);
  assert.match(main, /Date\.now\(\) \+ 1400/);
  assert.match(source, /maintenanceSuspendedUntil/);
  assert.match(source, /prepareSynchronizedDemo/);
  assert.match(source, /animatePrepared/);
  assert.match(source, /prepared=1/);
  assert.match(source, /BLE_WRITE_ACK latency_ms=/);
});
