'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const run = (args) => {
    const result = spawnSync('/usr/bin/codesign', args, { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr || `codesign failed: ${args.join(' ')}`);
  };
  run(['--force', '--deep', '--sign', '-', appPath]);
  run([
    '--force', '--sign', '-', '--identifier', 'com.local.agent-status-light',
    '--requirements', '=designated => identifier "com.local.agent-status-light"', appPath,
  ]);
};
