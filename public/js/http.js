// Fetch helpers shared by the session layer and the API client.

/**
 * Reads a JSON body, and says something useful when the answer is not JSON at all.
 * That happens when the page is served by something that is not running the API —
 * a static host, or a proxy answering with its own error page.
 */
export async function readJson(res, path = '') {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const where = path ? ` at ${path}` : '';
    if (res.status === 404) {
      throw new Error(`The API is not answering${where} — this page is being served without its server. `
        + 'Run "npm start" and open the address it prints, or deploy the whole app rather than the public/ folder alone.');
    }
    const snippet = text.trim().replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').slice(0, 120);
    throw new Error(`The server replied with a page instead of data (${res.status})${where}: ${snippet}`);
  }
}

/** fetch, with a plain-English message when the request cannot leave the browser. */
export async function request(url, options) {
  try {
    return await fetch(url, options);
  } catch {
    throw new Error('Could not reach the server. Check that it is running and that you are online.');
  }
}
