'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const mainSource = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');

test('CodeLight stays stopped until the user opens it', () => {
  assert.match(mainSource, /setLoginItemSettings\(\{ openAtLogin: false \}\)/);
  assert.match(mainSource, /<key>RunAtLoad<\/key><false\/><key>KeepAlive<\/key><false\/>/);
  assert.match(mainSource, /function stopMacWatcher\(\)/);
  assert.match(mainSource, /before-quit[\s\S]{0,160}stopMacWatcher\(\)/);
});

test('closing the main window quits instead of hiding in the background', () => {
  const closeHandler = mainSource.match(/mainWindow\.on\('close',[\s\S]*?\n  \}\);/u)?.[0] || '';
  assert.match(closeHandler, /app\.quit\(\)/);
  assert.doesNotMatch(closeHandler, /mainWindow\.hide\(\)/);
});
