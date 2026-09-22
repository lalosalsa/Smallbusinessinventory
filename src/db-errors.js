'use strict';

/**
 * Turns the handful of connection failures people actually hit into advice.
 * Everything else is passed through as-is rather than guessed at.
 */
function explainConnectionError(err) {
  const message = err?.message || String(err);

  if (/password authentication failed/i.test(message)) {
    return [
      'The database refused the password.',
      '',
      '  - Check it against Supabase: Project Settings -> Database -> Reset database password.',
      '  - A password with @ : / ? # or % in it must be percent-encoded inside the',
      '    connection string (@ becomes %40, # becomes %23, and so on).',
    ].join('\n');
  }

  if (/getaddrinfo|ENOTFOUND|EAI_AGAIN/i.test(message)) {
    return [
      'That host could not be looked up.',
      '',
      '  - Copy the connection string from Supabase again: Project Settings ->',
      '    Database -> Connection string -> Transaction pooler.',
      '  - The pooler host looks like aws-0-<region>.pooler.supabase.com, not',
      '    <project>.supabase.co, which is the API address rather than the database.',
    ].join('\n');
  }

  if (/ENETUNREACH|EHOSTUNREACH/i.test(message)) {
    return [
      'The database host could not be reached from this machine.',
      '',
      '  - Supabase\'s direct connection (db.<project>.supabase.co) is IPv6-only, and',
      '    most home and office networks are IPv4. Use the Transaction pooler string',
      '    instead: Project Settings -> Database -> Connection string -> Transaction pooler.',
      '  - If you are behind a company firewall, port 6543 may need opening.',
    ].join('\n');
  }

  if (/ECONNREFUSED/i.test(message)) {
    return [
      'Nothing is listening at that address and port.',
      '',
      '  - For Supabase, the pooler is on port 6543 and the direct connection on 5432.',
      '  - For a local Postgres, check it is running and add PGSSL=disable to .env.',
    ].join('\n');
  }

  if (/ETIMEDOUT|timeout/i.test(message)) {
    return [
      'The connection timed out.',
      '',
      '  - A firewall or VPN is the usual cause; try from another network.',
      '  - Check the project is not paused in the Supabase dashboard (free projects',
      '    pause after a spell of inactivity and take a moment to wake).',
    ].join('\n');
  }

  if (/self[- ]signed certificate|unable to verify|certificate/i.test(message)) {
    return [
      'The TLS certificate could not be verified.',
      '',
      '  - Supabase uses a public certificate, so this usually means a proxy is in the',
      '    way. As a last resort, PGSSL_NO_VERIFY=1 in .env skips verification.',
    ].join('\n');
  }

  if (/Tenant or user not found/i.test(message)) {
    return [
      'The pooler did not recognise that user.',
      '',
      '  - The pooler username includes the project reference:',
      '    postgres.<project-ref>, not plain "postgres".',
      '  - Copy the whole string from Project Settings -> Database -> Connection string.',
    ].join('\n');
  }

  return `${message}\n\nCheck DATABASE_URL in your .env against Project Settings -> Database -> Connection string.`;
}

module.exports = { explainConnectionError };
