'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Loads a .env file if one is sitting next to the app, without pulling in a
 * dependency for it. Real environment variables always win.
 */
function load(file = path.join(__dirname, '..', '.env')) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return {}; }

  const values = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return values;
}

module.exports = { load };
