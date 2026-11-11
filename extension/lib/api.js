/**
 * Fab API transport.
 *
 * Every call is relayed to a fab.com tab (content.js) so that Origin, Referer,
 * cookies and the CSRF token are exactly what the website itself would send.
 * Calling straight from the service worker fails with 403 on POST, because the
 * extension origin can never match the CSRF check.
 */

const API = "https://www.fab.com/i";

export class AuthError extends Error {}

/** Fab/Cloudflare throttling - must back off, never treated as a permanent failure. */
export class RateLimitError extends Error {}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Cloudflare answers a throttled request with an HTML challenge page. */
function looksBlocked(text) {
  if (!text) return false;
  const head = text.slice(0, 400).toLowerCase();
  return head.startsWith("<") || head.includes("cf_challenge") || head.includes("just a moment");
}

let activeTabId = null;
let tabPromise = null;

async function ping(tabId) {
  try {
    const reply = await chrome.tabs.sendMessage(tabId, { type: "ping" });
    return Boolean(reply && reply.ok);
  } catch {
    return false;
  }
}

/**
 * Find a fab.com tab that runs content.js, or open a background one.
 * Memoized so a burst of concurrent claims opens at most one tab.
 */
function ensureTab() {
  if (tabPromise) return tabPromise;
  tabPromise = resolveTab().catch((error) => {
    tabPromise = null;
    throw error;
  });
  return tabPromise;
}

async function resolveTab() {
  if (activeTabId !== null && (await ping(activeTabId))) return activeTabId;

  const tabs = await chrome.tabs.query({ url: "https://www.fab.com/*" });
  for (const tab of tabs) {
    if (tab.id !== undefined && (await ping(tab.id))) {
      activeTabId = tab.id;
      return activeTabId;
    }
  }

  const created = await chrome.tabs.create({ url: "https://www.fab.com/", active: false });
  activeTabId = created.id;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (await ping(activeTabId)) return activeTabId;
    await sleep(250);
  }
  activeTabId = null;
  tabPromise = null;
  throw new AuthError("could not reach a fab.com tab - open fab.com once, then retry");
}

async function call({ method = "GET", url, form, json }) {
  const tabId = await ensureTab();
  const target = url.startsWith("http") ? url : `${API}${url}`;
  let reply;
  try {
    reply = await chrome.tabs.sendMessage(tabId, { type: "fabRequest", method, url: target, form, json });
  } catch (error) {
    activeTabId = null;
    tabPromise = null;
    throw new Error(`tab relay failed: ${(error && error.message) || error}`);
  }
  if (!reply) throw new Error("empty reply from fab.com tab");
  if (reply.error) throw new Error(reply.error);
  return reply;
}

function parse(reply) {
  try {
    return JSON.parse(reply.text);
  } catch {
    throw new Error(`unexpected response (HTTP ${reply.status})`);
  }
}

/** GET a JSON document with bounded retries. */
export async function get(path, tries = 3) {
  let lastError;
  for (let attempt = 0; attempt < tries; attempt += 1) {
    let reply;
    try {
      reply = await call({ url: path });
    } catch (error) {
      lastError = error;
      await sleep(1000 * (attempt + 1));
      continue;
    }
    if (reply.status === 429 || looksBlocked(reply.text)) {
      throw new RateLimitError(`throttled on ${path}`);
    }
    if (reply.status === 200) return parse(reply);
    if (reply.status === 401 || reply.status === 403) {
      throw new AuthError(`HTTP ${reply.status}`);
    }
    lastError = new Error(`HTTP ${reply.status} for ${path}`);
    await sleep(1000 * (attempt + 1));
  }
  throw lastError;
}

export function me() {
  return get("/users/me");
}

/** Whether the signed-in account already owns a listing (null if unknown). */
export async function owned(uid) {
  try {
    const data = await get(`/users/me/listings-states/${uid}`, 2);
    return Boolean(data.acquired);
  } catch {
    return null;
  }
}

/**
 * Add one listing to the library.
 * Returns { status, detail } where status is "ok", "fatal_401"/"fatal_403",
 * "http_<code>" or "retry_exhausted", and detail keeps the server's own message.
 * The endpoint is idempotent: claiming an owned listing returns 204 again.
 */
export async function claim(uid, offerId) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    let reply;
    try {
      reply = await call({
        method: "POST",
        url: `/listings/${uid}/add-to-library`,
        form: { offer_id: offerId },
      });
    } catch (error) {
      if (attempt === 3) {
        return { status: "retry_exhausted", detail: String((error && error.message) || error) };
      }
      await sleep(1000 * 1.5 ** (attempt + 1) + Math.random() * 500);
      continue;
    }
    if ([200, 201, 204].includes(reply.status)) return { status: "ok", detail: "" };
    if (reply.status === 429 || looksBlocked(reply.text)) {
      return { status: "rate_limited", detail: trim(reply.text) };
    }
    if (reply.status === 401 || reply.status === 403) {
      return { status: `fatal_${reply.status}`, detail: trim(reply.text) };
    }
    if ([500, 502, 503, 504].includes(reply.status)) {
      if (attempt === 3) return { status: `http_${reply.status}`, detail: trim(reply.text) };
      await sleep(1000 * 1.5 ** (attempt + 1) + Math.random() * 500);
      continue;
    }
    return { status: `http_${reply.status}`, detail: trim(reply.text) };
  }
  return { status: "retry_exhausted", detail: "gave up after 4 attempts" };
}

function trim(text) {
  return String(text || "").replace(/\s+/g, " ").slice(0, 200);
}

/** One page of search results. Accepts a params string or a full URL (cursor). */
export function search(paramsOrUrl) {
  if (paramsOrUrl.startsWith("http")) return get(paramsOrUrl);
  return get(`/listings/search?count=24&${paramsOrUrl}`);
}

export function categoriesTree() {
  return get("/taxonomy/categories/tree").then((data) => data.results.bundle);
}

export { API, sleep };
