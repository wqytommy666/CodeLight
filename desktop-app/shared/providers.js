'use strict';

const PROVIDER_ASSETS = Object.freeze({
  claude: 'claude.svg', codex: 'codex.svg', opencode: 'opencode.svg', mimo: 'mimo.ico',
  zcode: 'zcode.svg', hermes: 'hermes.png', qwen: 'qwen.svg', gemini: 'gemini.svg',
  kimi: 'kimi.png', kilo: 'kilo.png', copilot: 'copilot.svg', cursor: 'cursor.svg',
  windsurf: 'windsurf.svg', trae: 'trae.png', cline: 'cline.svg', roo: 'roo.png',
  kiro: 'kiro.png', antigravity: 'antigravity.png', aider: 'aider.png',
  openhands: 'openhands.png', goose: 'goose.png', amp: 'amp.png', continue: 'continue.png',
  pi: 'pi.png', crush: 'crush.png',
});

const PROVIDERS = Object.freeze([
  { id: 'claude', name: 'Claude Code', short: 'Claude', accent: '#d97757', tier: 'native', apps: ['Claude'] },
  { id: 'codex', name: 'OpenAI Codex', short: 'Codex', accent: '#20c997', tier: 'native', apps: ['Codex', 'ChatGPT'] },
  { id: 'opencode', name: 'OpenCode', short: 'OpenCode', accent: '#8b9cff', tier: 'plugin', apps: ['OpenCode'] },
  { id: 'mimo', name: 'MiMo Code', short: 'MiMo', accent: '#ff8a45', tier: 'plugin', apps: ['MiMo Code', 'MiMoCode'] },
  { id: 'zcode', name: 'Zed Code (ZCode)', short: 'ZCode', accent: '#7c8cff', tier: 'hook', apps: ['Zed', 'ZCode'] },
  { id: 'hermes', name: 'Hermes Agent', short: 'Hermes', accent: '#ad7cff', tier: 'hook', apps: ['Hermes'] },
  { id: 'qwen', name: 'Qwen Code', short: 'Qwen', accent: '#6e8cff', tier: 'hook', apps: ['Qwen Code'] },
  { id: 'gemini', name: 'Gemini CLI', short: 'Gemini', accent: '#4aa8ff', tier: 'hook', apps: ['Gemini'] },
  { id: 'kimi', name: 'Kimi Code', short: 'Kimi', accent: '#56c5ff', tier: 'bridge', apps: ['Kimi Code', 'Kimi'] },
  { id: 'kilo', name: 'Kilo Code / KCode', short: 'Kilo', accent: '#b276ff', tier: 'bridge', apps: ['Visual Studio Code', 'Cursor'] },
  { id: 'copilot', name: 'GitHub Copilot', short: 'Copilot', accent: '#9aa5ff', tier: 'hook', apps: ['Visual Studio Code'] },
  { id: 'cursor', name: 'Cursor', short: 'Cursor', accent: '#f0f3f6', tier: 'hook', apps: ['Cursor'] },
  { id: 'windsurf', name: 'Windsurf', short: 'Windsurf', accent: '#58d7bf', tier: 'bridge', apps: ['Windsurf'] },
  { id: 'trae', name: 'Trae', short: 'Trae', accent: '#4f8cff', tier: 'bridge', apps: ['Trae'] },
  { id: 'cline', name: 'Cline', short: 'Cline', accent: '#62a8ff', tier: 'bridge', apps: ['Visual Studio Code'] },
  { id: 'roo', name: 'Roo Code', short: 'Roo', accent: '#5bd5a6', tier: 'bridge', apps: ['Visual Studio Code'] },
  { id: 'kiro', name: 'Kiro', short: 'Kiro', accent: '#a98bff', tier: 'bridge', apps: ['Kiro'] },
  { id: 'antigravity', name: 'Antigravity', short: 'Antigravity', accent: '#ff6da8', tier: 'hook', apps: ['Antigravity'] },
  { id: 'aider', name: 'Aider', short: 'Aider', accent: '#6fdd87', tier: 'bridge', apps: [] },
  { id: 'openhands', name: 'OpenHands', short: 'OpenHands', accent: '#ffb057', tier: 'bridge', apps: ['OpenHands'] },
  { id: 'goose', name: 'Goose', short: 'Goose', accent: '#ffd05d', tier: 'bridge', apps: ['Goose'] },
  { id: 'amp', name: 'Amp', short: 'Amp', accent: '#ef7cff', tier: 'bridge', apps: ['Amp'] },
  { id: 'continue', name: 'Continue', short: 'Continue', accent: '#7bd3ff', tier: 'bridge', apps: ['Visual Studio Code', 'JetBrains Toolbox'] },
  { id: 'commandcode', name: 'Command Code', short: 'Command', accent: '#ff8f68', tier: 'hook', apps: ['Command Code'] },
  { id: 'pi', name: 'Pi', short: 'Pi', accent: '#57d6c6', tier: 'plugin', apps: [] },
  { id: 'crush', name: 'Crush', short: 'Crush', accent: '#ff6e82', tier: 'bridge', apps: [] },
].map((provider) => ({
  ...provider,
  asset: PROVIDER_ASSETS[provider.id] || '',
  pinned: provider.id === 'claude' || provider.id === 'codex',
})));

const PROVIDER_ALIASES = Object.freeze({
  'claude-code': 'claude', openai: 'codex', 'codex-cli': 'codex',
  mimocode: 'mimo', 'mimo-code': 'mimo', qwen_code: 'qwen', 'qwen-code': 'qwen',
  kcode: 'kilo', kilocode: 'kilo', 'kilo-code': 'kilo', 'kimi-code': 'kimi',
  'gemini-cli': 'gemini', githubcopilot: 'copilot', 'github-copilot': 'copilot',
  roocode: 'roo', 'roo-code': 'roo', open_hands: 'openhands', command_code: 'commandcode',
});

function normalizeProviderId(value) {
  const raw = String(value || 'custom').trim().toLowerCase().replace(/\s+/g, '-');
  return PROVIDER_ALIASES[raw] || raw;
}

function providerById(value, providers = PROVIDERS) {
  const id = normalizeProviderId(value);
  return providers.find((provider) => provider.id === id) || {
    id, name: value || 'Custom Agent', short: value || 'Custom', accent: '#8aa0b3', tier: 'bridge', apps: [],
  };
}

module.exports = { PROVIDERS, PROVIDER_ASSETS, PROVIDER_ALIASES, normalizeProviderId, providerById };
