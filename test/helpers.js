'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// Every test file gets its own throwaway database, set before src/db is required.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-test-'));
process.env.DB_PATH = path.join(dir, 'test.db');

process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

module.exports = { dbPath: process.env.DB_PATH };
