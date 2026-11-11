# Contributing

Thanks for taking a look. A few ground rules keep this project safe and useful.

## Never post credentials

Do **not** paste any of the following into issues, PRs, screenshots or logs:

- session cookies (`fab_sessionid`, `cf_clearance`, `__cf_bm`, `fab_csrftoken`)
- account names, `epicId` values, email addresses
- contents of `fab-state/` (`listings.jsonl`, `claimed.jsonl`, `progress.json`)

Redact them. Issues containing credentials will be edited or closed.

## Good first issues

- Supporting a new listing type once Fab exposes it
- Better handling of server-side `500` listings
- Reporting accuracy improvements for `--full-verify`
- Documentation clarity (both English and 中文 sections)

## Development

```bash
git clone https://github.com/ningmeng52022/fab-free-claimer.git
cd fab-free-claimer
python -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt

python -m unittest discover -s tests -v   # unit tests, no network
python -m fab_free_claimer --help         # smoke check
```

### Guidelines

1. **No network in tests.** Mock `FabClient` or `iter_search`. CI has no cookies.
2. **Keep the request pattern gentle.** Do not raise the default `--workers` above 16 and do not remove
   the exponential back-off on `429`/`5xx`.
3. **Keep progress writers append-only.** The whole design relies on surviving a hard kill.
4. **Small, focused PRs.** One behaviour change per PR, with a test if it touches parsing or checkpointing.
5. **Type hints and docstrings** for new public functions; line length 100.

## Commit messages

Conventional-ish and in English:

```
fix: stop incremental enumeration from skipping republished free listings
feat: add --mode quixel
docs: clarify cookie extraction steps
```

## Scope

This project claims *free* listings into the account that owns the session. PRs that bypass licensing,
scrape paid content, or evade rate limiting will be rejected.
