/**
 * Talks to the Fab web API from inside the browser.
 *
 * Because the extension holds host permissions for fab.com, the browser attaches
 * the session cookies automatically - there is no cookie to copy around.
 * Only the CSRF token has to be forwarded explicitly.
 */

const API = "https://www.fab.com/i";

export class AuthError extends Error {}

let csrfToken = null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function csrf() {
  if (csrfToken) return csrfToken;
  const cookie = await chrome.cookies.get({
    url: "https://www.fab.com/",
    name: "fab_csrftoken",
  });
  if (!cookie) {
    throw new AuthError(
      "fab_csrftoken cookie not found - open fab.com and sign in first."
    );
  }
  csrfToken = cookie.value;
  return csrfToken;
}

/** Forget the cached token, e.g. after the user signs in again. */
export function resetToken() {
  csrfToken = null;
}

async function raw(path, { method = "GET", body, headers = {} } = {}) {
  const url = path.startsWith("http") ? path : `${API}${path}`;
  const token = await csrf();
  return fetch(url, {
    method,
    body,
    credentials: "include",
    headers: {
      Accept: "application/json",
      "X-CsrfToken": token,
      ...headers,
    },
  });
}

/** GET a JSON document with bounded retries. */
export async function get(path, tries = 3) {
  let lastError;
  for (let attempt = 0; attempt < tries; attempt += 1) {
    let response;
    try {
      response = await raw(path);
    } catch (error) {
      if (error instanceof AuthError) throw error;
      lastError = error;
      await sleep(1000 * (attempt + 1));
      continue;
    }
    if (response.status === 200) return response.json();
    if (response.status === 401 || response.status === 403) {
      throw new AuthError(`HTTP ${response.status}`);
    }
    lastError = new Error(`HTTP ${response.status} for ${url}`);
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
 * Returns "ok", "fatal_401"/"fatal_403", "http_<code>" or "retry_exhausted".
 * The endpoint is idempotent: claiming an owned listing returns 204 again.
 */
export async function claim(uid, offerId) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const form = new FormData();
      form.append("offer_id", offerId);
      const response = await raw(`/listings/${uid}/add-to-library`, {
        method: "POST",
        body: form,
      });
      if ([200, 201, 204].includes(response.status)) return "ok";
      if (response.status === 401 || response.status === 403) {
        return `fatal_${response.status}`;
      }
      if ([429, 500, 502, 503, 504].includes(response.status)) {
        await sleep(1000 * 1.5 ** (attempt + 1) + Math.random() * 500);
        continue;
      }
      return `http_${response.status}`;
    } catch (error) {
      if (error instanceof AuthError) return "fatal_401";
      await sleep(1000 * 1.5 ** (attempt + 1) + Math.random() * 500);
    }
  }
  return "retry_exhausted";
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
