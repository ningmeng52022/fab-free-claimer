# Fab Free Claimer — browser extension

Manifest V3 extension for Chrome / Edge. Same job as the Python CLI, but it lives
inside your browser, so **there is no cookie to copy**: the browser already holds
your Fab session and attaches it to every request automatically.

## Install (unpacked)

1. Download the latest `fab-free-claimer-extension.zip` from
   [Releases](https://github.com/ningmeng52022/fab-free-claimer/releases) and unzip it,
   or clone this repository.
2. Open `chrome://extensions` (or `edge://extensions`).
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select the `extension/` folder.
5. Pin the extension, open it, press **Start**.

Sign in to <https://www.fab.com> in the same browser profile first — the extension
reuses that session and never asks for a password.

## What it does

| Phase | Behaviour |
|---|---|
| Enumerate | Splits the free catalogue into `category × listing-type` partitions, walks each one, stores listings in IndexedDB |
| Claim | Claims every listing not yet owned, 16 requests in flight |
| Reconcile | Optional: re-checks failures against real ownership (network errors produce false negatives) |
| Verify | Spot-check N claimed listings, or scan the whole library |

Buttons: `Start` · `Pause` · `Stop` · `Spot check 30` · `Reset data`.

Options:

- **Scope** — everything free / all free types except Quixel / Quixel only
- **Incremental** — newest-first, stops a partition after 3 new-less pages (minutes instead of ~10)
- **Re-check failures at the end** — the `--reconcile` equivalent

## How it survives being killed

Chrome terminates MV3 service workers after ~30 s of inactivity. So the engine never
runs to completion in one go:

- every tick does ≤ 25 s of work, then saves a checkpoint to IndexedDB
- a heartbeat keeps the worker alive while a tick runs
- `chrome.alarms` re-schedules the next tick, even across worker restarts and browser restarts
- progress is per partition (enumeration) and per listing (claims)

Close the popup freely — work continues in the background. The toolbar badge shows `on`
while running.

## Language

The popup follows your browser UI language via `chrome.i18n`. Chinese (`zh_CN`) is the
default locale, so a Chinese browser shows Chinese; any other language falls back to
English. To add a language, drop a `_locales/<code>/messages.json` next to the existing
ones — the key list is identical (45 keys).

界面文案通过 `chrome.i18n` 跟随浏览器语言，中文为默认语言，其他语言回退到英文。
新增语言只需在 `_locales/` 下加一个目录，键名与现有 45 个保持一致。

## Permissions

| Permission | Why |
|---|---|
| `host_permissions: https://www.fab.com/*` | Call the same endpoints the Fab website calls, with your session |
| `content_scripts` on fab.com | The API calls run **inside a fab.com page**, so `Origin`, `Referer`, cookies and the CSRF token match the website exactly |
| `alarms` | Resume work after the worker is suspended |
| `storage`, `unlimitedStorage` | Local checkpoints and the ~46k-listing catalogue |

No analytics, no external hosts, no data leaves your browser except to `www.fab.com`.

> **Why a content script instead of plain `fetch` from the service worker?**
> Fab validates `Origin`/`Referer` on `POST /add-to-library`. A service worker
> request carries `Origin: chrome-extension://...`, which can never pass that check
> — the result is `403`. Browsers forbid scripts from setting `Origin`, so the only
> correct approach is to issue the request from the page origin itself. The
> extension therefore relays every call through a fab.com tab (opened in the
> background if you don't have one open).

## Differences vs the Python CLI

| | CLI | Extension |
|---|---|---|
| Cookie handling | Copy `cookie` header by hand | Automatic |
| Install | Python + pip | Load unpacked |
| Multi-account | One `--account` per cookie file | One browser profile per account |
| CI / headless | Yes | No |
| Speed | ~27 claims/s | ~20–27 claims/s (same limits) |

Both share the same state format ideas but are independent implementations; do not
point them at the same account simultaneously.

## Build the zip

```bash
./scripts/build-extension.sh        # writes dist/fab-free-claimer-extension.zip
```

## Tests

```bash
node --test extension/tests/enum.test.mjs
```

Tests stub `chrome.cookies` and `fetch`, so they run offline.
