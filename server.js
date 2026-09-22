'use strict';

const path = require('path');
const express = require('express');
const api = require('./src/api');
const { DB_PATH } = require('./src/db');

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
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message || 'Something went wrong' });
});

if (require.main === module) {
  app.listen(PORT, HOST, () => {
    console.log(`Inventory app running at http://localhost:${PORT}`);
    console.log(`Database: ${DB_PATH}`);
  });
}

module.exports = app;
