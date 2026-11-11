# fab-free-claimer

[![CI](https://github.com/ningmeng52022/fab-free-claimer/actions/workflows/ci.yml/badge.svg)](https://github.com/ningmeng52022/fab-free-claimer/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Python 3.9+](https://img.shields.io/badge/python-3.9%2B-blue.svg)](https://www.python.org/)

Bulk-claim **every free asset on [Fab](https://www.fab.com)** into your library — Quixel Megascans, free 3D models, materials, plugins, decals and more. Resumable, incremental, multi-account.

一键把 Fab 上的**全部免费素材**领取到你的账号库 —— Quixel Megascans、免费 3D 模型、材质、插件、贴花等。支持断点续跑、增量同步、多账号。

> [!WARNING]
> **Unofficial project.** Not affiliated with, endorsed by, or supported by Epic Games or Fab.
> It drives the same private web endpoints the Fab site itself uses, so it can break at any time.
> Use it only on accounts you own, only to claim assets that are genuinely free for you, and abide by Fab's Terms of Service.
>
> **非官方项目**，与 Epic Games / Fab 无任何关联。它调用的是 Fab 网页自身使用的非公开接口，随时可能失效。请仅在自有账号上使用，只领取对你确实免费的资源，并遵守 Fab 服务条款。

---

## Why

Fab gives away tens of thousands of free assets. Claiming them by hand means tens of thousands of clicks.
This tool walks the whole free catalogue, adds each listing to your library with the same call the website makes,
and remembers what it already claimed so you can re-run it later to pick up new releases.

Fab 上免费素材有数万个，手动领取要点上万次。这个工具会遍历整个免费目录，用网页同款请求逐条加入素材库，
并记录已领内容，之后再运行即可只补新上架的。

**Typical scale (observed 2026-11):**

| Scope | Listings |
|---|---|
| Quixel Megascans + Megaplants | ~22.6k |
| Free 3D models | ~21.1k |
| All other free types (material, plugin, decal, audio, …) | ~3.1k |
| **Total, de-duplicated** | **~46k** |

## Two ways to run it

| | Python CLI | Browser extension |
|---|---|---|
| Best for | servers, automation, CI | everyday use in Chrome/Edge |
| Cookie handling | copy the `cookie` header yourself | **automatic** — the browser already has your session |
| Install | `pip install` | load the unpacked folder once |
| Status | stable | stable |

The extension lives in [`extension/`](extension/) — see [extension/README.md](extension/README.md).

## Install

```bash
git clone https://github.com/ningmeng52022/fab-free-claimer.git
cd fab-free-claimer
pip install -r requirements.txt

# or install as a command
pip install -e .
fab-free-claimer --help
```

Requires Python 3.9+ and `requests`.

## Get your cookie

The tool reuses your existing browser session, so it never sees your password.

1. Log in at <https://www.fab.com>
2. Open DevTools (`F12`) → **Network** → reload the page
3. Right-click any `www.fab.com` request → **Copy → Copy as cURL (bash)**
4. Extract the `cookie:` header and save it to a file:

```bash
mkdir -p fab-state/my-account
printf '%s\n' 'PASTE_COOKIE_HEADER_HERE' > fab-state/my-account/cookie.txt
chmod 600 fab-state/my-account/cookie.txt
```

The cookie **must** contain `fab_sessionid` (the HttpOnly session cookie). `document.cookie` in the
console is *not* enough — it cannot see that cookie.

> Treat this file like a password. `cookie.txt`, `*.cookie` and `fab-state/` are git-ignored.
> When you are done, sign out of all devices in your Fab account settings to revoke it.

## Usage

```bash
# 1) verify the session works
fab-free-claimer --cookie fab-state/my-account/cookie.txt --account my-account --check

# 2) first full run (~46k listings)
fab-free-claimer --cookie fab-state/my-account/cookie.txt --account my-account --workers 16

# 3) later: incremental sync, catches new releases in minutes
fab-free-claimer --cookie fab-state/my-account/cookie.txt --account my-account \
  --known-pages 3 --reconcile --verify --sample 50

# 4) Quixel only / free types only
fab-free-claimer --cookie ... --account my-account --mode quixel
fab-free-claimer --cookie ... --account my-account --mode free

# 5) see what would happen, change nothing
fab-free-claimer --cookie ... --account my-account --dry-run

# 6) many accounts, isolated state
for acc in alice bob carol; do
  fab-free-claimer --cookie fab-state/$acc/cookie.txt --account $acc --workers 16
done
```

### Options

| Flag | Meaning |
|---|---|
| `--cookie PATH` | File with the logged-in cookie header (required) |
| `--account NAME` | Account label; each one keeps an isolated state folder (required) |
| `--state-dir DIR` | Where checkpoints live (default `./fab-state`) |
| `--workers N` | Claim concurrency, default **16** |
| `--enum-workers N` | Parallel enumeration workers, default 8 |
| `--mode all\|quixel\|free` | Scope, default `all` |
| `--known-pages N` | **Fast incremental**: newest-first, stop a partition after N new-less pages |
| `--skip-enum` | Reuse the existing `listings.jsonl` (resume / verify) |
| `--time-budget SECONDS` | Stop claiming gracefully and keep progress (handy on CI time limits) |
| `--reconcile` | Re-check failures against real ownership (network timeouts are often false alarms) |
| `--verify`, `--sample N`, `--full-verify` | Post-run verification |
| `--dry-run` | Enumerate only |
| `--check` | Validate the cookie and exit |

## How it works

Everything happens through `https://www.fab.com/i`, the private API the Fab front-end calls.

| Step | Endpoint |
|---|---|
| Session check | `GET /i/users/me` |
| Enumerate free catalogue | `GET /i/listings/search?aggregate_on=category_per_listing_type&count=0&is_free=1` |
| Enumerate one partition | `GET /i/listings/search?count=24&categories=<slug>&listing_types=<type>&is_free=1` |
| Claim one listing | `POST /i/listings/<uid>/add-to-library` with `offer_id=<startingPrice.offerId>` |
| Verify ownership | `GET /i/users/me/listings-states/<uid>` |

Key constraints discovered while building this:

- **Deep-pagination cap.** A single search query only serves ~5,016 rows (209 pages × 24), even though
  aggregations report far more. The catalogue must be split into `category × listing-type` partitions,
  each small enough to walk to the end.
- **Claims are idempotent.** Re-posting an already owned listing returns `204` again, so retries and
  re-runs are safe.
- **Region-dependent catalogue.** The free set an account sees varies by region, so enumeration is
  always done with the target account's own session.
- **Some things cannot be enumerated.** The `bundle` listing type rejects the query (`400`) and its
  category page is broken on Fab's side; a few individual listings fail server-side with `500`.

## Performance

Measured on one account, 300 claims per point (idempotent re-claims):

| `--workers` | Throughput | Result |
|---|---|---|
| 8 | 13/s | all `204` |
| 12 | 20/s | all `204` |
| **16 (default)** | **27/s** | **all `204`, no rate limiting** |
| 24 | 31/s | hits `429`, backs off |

16 is the sweet spot: pushing to 24 triggers throttling and the retry back-off makes it slower overall.

- First full run: ~10 min enumeration + ~30 min claiming for ~46k listings
- Incremental run (`--known-pages 3`): ~1–2 min enumeration + a handful of new claims

## Reliability

Long runs get killed — laptops sleep, CI jobs time out, shells get recycled. The design assumes that:

1. **Everything is checkpointed.** Enumeration is saved after *each partition*; claims are appended one by one.
2. **Resume instead of restart.** Re-run with the same `--account`; finished work is skipped.
3. **`--time-budget`** stops cleanly before a hard kill, so you can drive the tool in short slices.
4. **`--reconcile`** fixes the main source of false failures: under concurrency, a timeout can be reported
   even though the server already added the listing.
5. **Enumeration is parallel** — one page takes ~2.5 s, so partitions are walked concurrently.

## State files

`<state-dir>/<account>/`:

| File | Purpose |
|---|---|
| `listings.jsonl` | Every free listing discovered (`uid`, `offer`, `title`, `seller`) |
| `claimed.jsonl` | UIDs successfully claimed — drives incremental and resume logic |
| `failed.jsonl` | Failures with their status code |
| `progress.json` | Enumeration checkpoint and run summary |

Safe to delete `failed.jsonl` / `progress.json`. Deleting `claimed.jsonl` makes the next run re-claim
everything (harmless, just slow).

## FAQ

**Do I need to download the assets?**
No. This only adds them to *My Library*, exactly like clicking "Add to library". Downloading is separate.

**Will it claim paid assets?**
No. Only listings whose starting price is `0`. A free-looking listing with a non-zero offer is skipped
and shows up in `failed.jsonl`.

**Is it safe for my account?**
It uses your own session and a modest, rate-limited request pattern. Still: use at your own risk, and
read the disclaimer at the top. Don't raise `--workers` far beyond 16.

**Why are a few listings always failing?**
Some listings are broken server-side (`500 Internal error` on every attempt). They are recorded in
`failed.jsonl`; retrying later usually doesn't help.

**The tool stopped with 401/403.**
Your cookie expired or the session was revoked. Grab a fresh cookie and re-run — progress is preserved.

## Contributing

Issues and PRs are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). Please never paste real cookies,
account names or `epicId` values into issues.

## License

[MIT](LICENSE)

---

## 中文说明

### 它解决什么问题

Fab 的免费素材有几万个，手动一个个点「加入素材库」不现实。本工具会遍历整个免费目录，用网页同款接口
批量领取，并记录已领内容，之后重复运行只补新上架的。

### 安装

```bash
git clone https://github.com/ningmeng52022/fab-free-claimer.git
cd fab-free-claimer
pip install -r requirements.txt
```

需要 Python 3.9+。

### 两种用法

- **命令行（Python）**：适合服务器、自动化、CI，需要手动提供 Cookie
- **浏览器插件（Chrome/Edge）**：日常使用首选，**不用碰 Cookie**，装好后点「Start」即可

插件安装：`chrome://extensions` → 打开右上角「开发者模式」→「加载已解压的扩展程序」→ 选择 `extension/` 目录。
也可以用 `./scripts/build-extension.sh` 打包成 zip 分发。详见 [extension/README.md](extension/README.md)。

### 准备 Cookie

1. 浏览器登录 <https://www.fab.com>
2. `F12` → **Network** → 刷新页面
3. 任意 `www.fab.com` 请求右键 → **Copy → Copy as cURL (bash)**
4. 取出其中的 `cookie:` 头，保存到文件：

```bash
mkdir -p fab-state/我的账号
printf '%s\n' '把 Cookie 粘贴在这里' > fab-state/我的账号/cookie.txt
chmod 600 fab-state/我的账号/cookie.txt
```

Cookie 必须包含 `fab_sessionid`（HttpOnly 会话 Cookie），控制台里 `document.cookie` 看不到它。

### 用法

```bash
# 校验登录态
fab-free-claimer --cookie fab-state/我的账号/cookie.txt --account 我的账号 --check

# 首次全量领取（约 4.6 万条）
fab-free-claimer --cookie fab-state/我的账号/cookie.txt --account 我的账号 --workers 16

# 日后增量同步（几分钟，只补新上架的）
fab-free-claimer --cookie fab-state/我的账号/cookie.txt --account 我的账号 \
  --known-pages 3 --reconcile --verify --sample 50

# 只领 Quixel / 只领免费类型
fab-free-claimer --cookie ... --account 我的账号 --mode quixel
fab-free-claimer --cookie ... --account 我的账号 --mode free
```

### 主要参数

| 参数 | 说明 |
|---|---|
| `--workers 16` | 领取并发，16 是实测最稳的高吞吐值 |
| `--known-pages 3` | 快速增量：按发布时间倒序，连续 3 页无新条目就结束该分区 |
| `--skip-enum` | 跳过枚举，直接用已有清单（续跑/复核） |
| `--time-budget 180` | 跑满 N 秒优雅停止并保存，适合被限时回收的环境 |
| `--reconcile` | 复查失败项：网络超时误判但实际已入库的会修正 |
| `--dry-run` | 只枚举不领取 |

### 注意事项

- 仅把素材加入「我的素材库」，**不会下载文件**，下载需另行操作
- 只领取起售价为 `0` 的资源，付费资源会被跳过并记入 `failed.jsonl`
- `bundle` 类型在 Fab 侧接口异常（`400`），无法枚举领取
- 极少数资源服务端持续 `500`，属 Fab 数据问题
- 不同账号/地区可见的免费目录不完全相同，因此枚举始终用目标账号自己的会话
- 用完请到 Fab 账号设置里「登出所有设备」，让 Cookie 失效
