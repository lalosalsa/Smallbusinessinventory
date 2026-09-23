'use strict';

/**
 * Serverless entry point. On Vercel every /api/* request is rewritten here (see
 * vercel.json) and handed to the same Express app that `npm start` runs.
 *
 * A serverless instance starts cold, so the one-off boot work — checking the
 * database is configured, applying sql/schema.sql — happens on the first request
 * each instance sees and is remembered for the rest of its life.
 */

require('../src/env').load();

const app = require('../server');
const { migrate, CONNECTION } = require('../src/db');
const { explainConnectionError } = require('../src/db-errors');
const { assertSecretConfigured } = require('../src/auth');

let ready = null;

function prepare() {
  if (!ready) {
    ready = (async () => {
      if (!CONNECTION) {
        throw configError('DATABASE_URL is not set. Add it under the project\'s Environment Variables, then redeploy.');
      }
      try { assertSecretConfigured(); } catch (err) { throw configError(err.message); }
      if (process.env.SKIP_MIGRATE !== '1') await migrate();
    })().catch((err) => {
      ready = null; // try again on the next request rather than staying broken
      throw err;
    });
  }
  return ready;
}

/** A missing setting is already a complete sentence; only database failures need explaining. */
function configError(message) {
  const err = new Error(message);
  err.code = 'CONFIG';
  return err;
}

module.exports = async (req, res) => {
  try {
    await prepare();
  } catch (err) {
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: err.code === 'CONFIG' ? err.message : explainConnectionError(err) }));
    return;
  }

  // Vercel's Node runtime reads the request body before we see it and exposes the
  // result as req.body. Express's body parsers would then wait on a stream that has
  // already ended, so tell them the body is done with.
  if (req.body !== undefined && (req.readableEnded || req.complete)) req._body = true;

  app(req, res);
};
