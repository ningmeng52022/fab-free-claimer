/**
 * Runs inside a https://www.fab.com page and performs the actual API calls.
 *
 * Why a content script: Fab validates the Origin/Referer header on unsafe
 * methods, and a browser forbids scripts from setting those headers. Calling
 * from the page itself makes the request genuinely same-origin, so cookies and
 * the CSRF token line up exactly like the website's own requests.
 */

(() => {
  if (globalThis.__fabFreeClaimerLoaded) return;
  globalThis.__fabFreeClaimerLoaded = true;

  function csrfToken() {
    const match = document.cookie.match(/(?:^|;\s*)fab_csrftoken=([^;]+)/);
    return match ? decodeURIComponent(match[1]) : null;
  }

  async function perform(message) {
    const headers = { Accept: "application/json" };
    const token = csrfToken();
    if (token) headers["X-CsrfToken"] = token;

    let body;
    if (message.form) {
      body = new FormData();
      for (const [key, value] of Object.entries(message.form)) body.append(key, value);
    } else if (message.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(message.json);
    }

    const response = await fetch(message.url, {
      method: message.method || "GET",
      headers,
      body,
      credentials: "include",
    });
    const text = await response.text();
    return { status: response.status, text };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message) return undefined;
    if (message.type === "ping") {
      sendResponse({ ok: true });
      return undefined;
    }
    if (message.type !== "fabRequest") return undefined;

    perform(message)
      .then(sendResponse)
      .catch((error) => sendResponse({ error: String((error && error.message) || error) }));
    return true; // async reply
  });
})();
