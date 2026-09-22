'use strict';

const path = require('path');
const express = require('express');
const api = require('./src/api');
const { migrate, ping, CONNECTION } = require('./src/db');
const { explainConnectionError } = require('./src/db-errors');
const { authMode } = require('./src/auth');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

app.use(express.json({ limit: '25mb' }));
app.use(express.text({ type: 'text/csv', limit: '25mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api', api);
app.use('/api', (req, res) => res.status(404).json({ error: 'Unknown endpoint' }));

// Errors thrown inside routes carry an http status; everything else is a 500.
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  // Postgres constraint violations are nearly always something the person typed.
  if (err.code === '23505') {
    return res.status(400).json({ error: 'That name or code is already used here — pick another' });
  }
  if (err.code === '23503') {
    return res.status(400).json({ error: 'That refers to something which no longer exists' });
  }

  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message || 'Something went wrong' });
});

async function start() {
  if (!CONNECTION) {
    console.error('DATABASE_URL is not set.');
    console.error('Copy .env.example to .env and put your Supabase connection string in it, then try again.');
    process.exit(1);
  }
  await ping();
  if (process.env.SKIP_MIGRATE !== '1') await migrate();

  app.listen(PORT, HOST, () => {
    console.log(`Inventory app running at http://localhost:${PORT}`);
    console.log(`Sign-in: ${authMode()}`);
  });
}

if (require.main === module) {
  require('./src/env').load();
  start().catch((err) => {
    console.error('Could not start.\n');
    console.error(explainConnectionError(err));
    process.exit(1);
  });
}

module.exports = app;
