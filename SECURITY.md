# Security Policy

## What this tool handles

`fab-free-claimer` reuses your logged-in Fab browser session. That cookie is equivalent to a temporary
password for your account:

- It is read from a file you create and is never transmitted anywhere except `www.fab.com`.
- There is **no telemetry, no analytics and no third-party endpoint** in the code. Verify with
  `grep -rn "http" fab_free_claimer/`.
- `cookie.txt`, `*.cookie` and `fab-state/` are git-ignored.

## Your responsibilities

1. Keep the cookie file private: `chmod 600`, never commit it, never paste it in a screenshot.
2. Prefer a throwaway/alt account if you are unsure.
3. When finished, sign out of all devices in your Fab account settings — this immediately revokes the
   session you handed over.
4. Keep `--workers` at or below 16. Aggressive concurrency looks like abuse to Fab and may get your
   account flagged.

## If you leaked a cookie

1. Go to Fab → account settings → sign out of all devices (this invalidates the session).
2. Change your Epic Games password if the account is shared.
3. Check your library and order history for anything you did not claim.

## Reporting a vulnerability

Open a private report via GitHub Security Advisories ("Report a vulnerability" on the Security tab) or
email the maintainer listed in `pyproject.toml`.

Please do not open a public issue for anything that could expose credentials or enable account takeover.

## Supported versions

Only the latest release on `main` is supported with security fixes.
