'use strict';
// Where runtime data lives. No .env files: the data directory is created automatically.
// Default (zero config): <system temp dir>/childpanel, i.e. /tmp/childpanel on Linux/Render.
// Optional override: `--data /var/data` or CHILD_PANEL_DATA (e.g. a Render persistent disk).
const path = require('path');
const fs = require('fs');
const os = require('os');

function arg(name) {
  const i = process.argv.indexOf('--' + name);
  if (i > -1 && process.argv[i + 1]) return process.argv[i + 1];
  const p = process.argv.find((a) => a.startsWith('--' + name + '='));
  return p ? p.split('=').slice(1).join('=') : undefined;
}

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.resolve(arg('data') || process.env.CHILD_PANEL_DATA || path.join(os.tmpdir(), 'childpanel'));
fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
try { fs.chmodSync(DATA_DIR, 0o700); } catch (_) { /* windows */ }

module.exports = {
  ROOT,
  DATA_DIR,
  PUBLIC_DIR: path.join(ROOT, 'public'),
  DB_FILE: path.join(DATA_DIR, 'panel.db'),
  KEY_FILE: path.join(DATA_DIR, 'secret.key'),
  CONTRACT_FILE: path.join(DATA_DIR, 'contract.json'),
  PORT: parseInt(arg('port') || process.env.PORT || '3000', 10),
  arg,
};
