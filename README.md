# battlerun-site

Newsletter signup page for Battlerun, reached by QR code at conventions and playtests.
Live at <https://devilinorbit.com/> (GitHub Pages custom domain; DNS at Namecheap). Everything runs on free tiers.

```
QR code → devilinorbit.com (GitHub Pages, this repo)
            │ form POST
            ▼
          Apps Script web app (apps-script/Code.gs)
            ├─► Google Sheet "Battlerun Subscribers"   ← master list, source of truth
            ├─► Kit (sends confirmation email + newsletters)
            └─► Cloudflare Worker relay ─► Discord "Sub requested"

Kit webhooks (instant) ─► Cloudflare Worker /kit-webhook ─► Discord "Sub confirmed" / "Sub cancelled" / bounce / spam
                                                        └─► broadcast channel: teaser + link when a broadcast is sent
Hourly trigger: syncFromProvider pulls Kit's subscriber states into the Sheet
```

## Start here (for agents and future changes)

1. **Read [docs/system.md](docs/system.md) before changing anything.** It has the component map, the request flow, every Sheet column, every setting and secret, the deploy steps for each part, why each decision was made, the gotchas we've hit, a troubleshooting table and recipes for common extensions. This README is the short version plus the operator runbook.
2. **Three parts of this system don't deploy from GitHub.** Pushing only updates the website. `apps-script/Code.gs` is pasted into the Apps Script editor, `discord-relay/worker.js` is pasted into the Cloudflare dashboard, and Kit and Discord are configured in their own dashboards. The repo is the source of record; keep it identical to what's deployed.
3. **Things that will bite you:**
   - Redeploy Apps Script as a **new version** of the existing deployment, never a **new deployment** (that changes the URL the site calls).
   - Editor "Run" uses saved code; the live `/exec` URL uses the deployed version. Check `revision` in the health check.
   - Changing `installTriggers()` does nothing until you run `installTriggers` again.
   - Running `registerKitWebhook()` again creates a duplicate Kit endpoint (every alert arrives twice). To change which Kit events are delivered, edit `KIT_WEBHOOK_EVENTS` and run `updateKitWebhookEvents()`.
   - Discord blocks Apps Script's IPs (429 / error 1015), so Apps Script must post through the Worker relay, never to discord.com directly.
   - Repeat tests with the same email do nothing (dedupe). Use a new `+tag` address every time.
   - The consent line in `index.html` must match `CONSENT_TEXT` in `Code.gs` word for word.
4. **Testing tools available on the dev machine:** Python (local server, QR generation). No Node.js. The Worker was tested by importing `worker.js` as a module in a browser page served by `python -m http.server`, stubbing `fetch`, and checking signatures against a Python-computed HMAC.

## Files

| File | Purpose |
|---|---|
| `index.html`, `main.js`, `style.css` | Signup page. After signup the form is replaced by "One more step: check your email" (showing the typed address) and a "Wrong email? Fix it" link |
| `confirmed.html` | "You're in!" page with the Discord button. Kit redirects here after someone clicks the confirmation link |
| `privacy.html` | Privacy notice. The system must keep its promises (email used only for Battlerun news, deletion on request) |
| `config.js` | **The only file to edit for URLs and post-signup text**: Apps Script `/exec` URL, Discord invite, success title/message |
| `apps-script/Code.gs` | Backend source of record: signup handling, Kit forwarding, Sheet sync, Discord "Sub requested" alert, one-time setup functions |
| `discord-relay/worker.js` | Cloudflare Worker: (1) relays Apps Script's alerts to Discord, (2) receives Kit webhooks, verifies their signature, and posts confirm/cancel/bounce/spam alerts |
| `qr/make_qr.py`, `qr/*.svg`, `qr/*.png` | QR code generator and the generated codes |
| `docs/system.md` | Full system documentation |
| `CLAUDE.md` | Short rules Claude Code loads automatically in this repo |

## Where things live

| Thing | Where |
|---|---|
| Subscriber list (master copy) | Google Sheet **Battlerun Subscribers** → tab **Subscribers** (private, never share) |
| Backend script, its settings, triggers, logs | From the Sheet: **Extensions → Apps Script**. Settings: gear icon → Script Properties. Triggers: clock icon. Runs: Executions |
| Sending newsletters | Kit (kit.com), free Newsletter plan, form **Website signup** (ID 9984140), double opt-in on |
| Newsletter archive site | <https://news.devilinorbit.com>: Kit's Newsletter Site (Kit → Grow → Newsletter site; click **Publish** after edits). Shows broadcasts you publish to the web, and has Kit's own signup form (those signups reach the Sheet via the hourly sync) |
| `news` subdomain DNS | Namecheap → Advanced DNS: three `A` records with host `news` pointing to Kit (`3.13.222.255`, `3.13.246.91`, `3.130.60.26`). Leave every other record alone |
| Kit webhook endpoint | Registered through Kit's API by `registerKitWebhook()`, named "Discord subscriber alerts", pointing at `<worker-host>/kit-webhook`. Inspect with `listKitWebhooks()` |
| Discord relay / webhook receiver | Cloudflare → **Workers & Pages → `discord-relay`** (`*.workers.dev`). Secrets under Settings → Variables and Secrets; live logs under Logs/Observability |
| Discord alerts | A private channel in the Battlerun Discord server, fed by one channel webhook |
| Discord broadcast announcements | A separate channel with its own webhook (`DISCORD_BROADCAST_WEBHOOK_URL` in the Worker) |
| Discord invite on the site | `discordInvite` in `config.js` (permanent invite: never expires, unlimited uses) |
| Domain, DNS, email forwarding | Namecheap → devilinorbit.com (`news@devilinorbit.com` forwards to the owner's Gmail) |
| Site hosting | This repo → Settings → Pages (branch `main`, root; custom domain devilinorbit.com, HTTPS enforced) |

## Secrets and settings (none of these are in the repo)

The repo is public (required for free GitHub Pages), and Pages serves every file in it. That's fine because nothing secret is committed.

| Name | Where | Secret? |
|---|---|---|
| `KIT_API_KEY` | Apps Script Script Properties | **Yes** |
| `KIT_FORM_ID` (`9984140`), `DOUBLE_OPT_IN` (`true`), `SITE_ORIGIN` (`https://devilinorbit.com`) | Apps Script Script Properties | No |
| `DISCORD_SIGNUP_WEBHOOK_URL` | Apps Script Script Properties. Discord webhook URL with the host swapped to the Worker's host | **Yes** |
| `ALLOWED_WEBHOOK_ID` | Cloudflare Worker variable (Text): the numeric webhook ID | No |
| `DISCORD_WEBHOOK_URL` | Cloudflare Worker secret: the same webhook with the normal `discord.com` host | **Yes** |
| `KIT_WEBHOOK_SECRET` | Cloudflare Worker secret: the `whsec_...` signing secret Kit showed **once** at registration | **Yes** |
| `DISCORD_BROADCAST_WEBHOOK_URL` | Cloudflare Worker secret: the broadcast channel's webhook (normal `discord.com` host) | **Yes** |
| `KIT_API_KEY` | Cloudflare Worker secret (same key as in Apps Script): looks up a broadcast's web link | **Yes** |
| `BROADCAST_PUBLIC_ONLY` | Cloudflare Worker variable (Text): `true` = announce only web-published broadcasts; unset/anything else = every broadcast (current) | No |

Script Property and Worker secret changes apply immediately, with no code redeploy. If the Discord webhook leaks, make a new webhook and update all three Discord settings.

## Running it

### Reading the Sheet

- **status** is the column that matters: `unconfirmed` (hasn't clicked the confirmation email yet), `active`, `unsubscribed`, `bounced`, `complained`.
- **provider_status** is Kit's side: `pending_confirmation` / `subscribed` right after signup, then Kit's own words (`inactive`, `active`, `cancelled`, …) after each sync.
- **source** is which QR code or link they came from (`direct` = typed the address). `kit` means they subscribed outside this site (on the Kit newsletter site, or you added them in Kit); the hourly sync adds those rows and sends a "Sub requested" alert with `source: kit`.
- **notes** holds Kit's error detail if forwarding failed, then the Discord result, e.g. `discord:204` (delivered).
- The Sheet syncs with Kit every hour. To sync now: Apps Script → pick `syncFromProvider` → **Run**.
- A **provider_status** starting with `error_` means forwarding to Kit failed. It retries every 6 hours; if it keeps failing, the Kit API key or form ID is probably wrong (check Script Properties).

### Discord alerts

| Alert | Sent by | When |
|---|---|---|
| **Sub requested** (masked email + `source:`) | Apps Script, through the Worker relay | Someone submits the form (new emails only), or the hourly sync finds a new Kit-only subscriber (`source: kit`, up to an hour late) |
| **Sub confirmed** (green) | Kit webhook → Worker | They click the confirmation link |
| **Sub cancelled** (red) | Kit webhook → Worker | They unsubscribe (or you unsubscribe them in Kit) |
| **Email bounced** (orange) / **Marked as spam** (red) | Kit webhook → Worker | Kit reports a hard bounce or a spam complaint |
| **Broadcast announcement** (broadcast channel; subject as title, preview text, "Read it here" link if published to the web) | Kit webhook → Worker | A broadcast finishes sending |

Kit-webhook alerts can't show the source, because Kit doesn't send it. The Sheet catches up on the next hourly sync; alerts don't update it.

### Sending a newsletter

1. Kit → **Send → Broadcasts → New broadcast**.
2. First send to yourself only: recipients filter **Email address → Is exactly → your address**. Check links, the footer address and the unsubscribe link.
3. Then make the real broadcast to **All Subscribers** and send or schedule it. Unconfirmed people never receive broadcasts. That's expected with double opt-in; don't try to force them active.

### Removing someone

- **"Stop emailing me"** → in Kit, open their profile and unsubscribe them. Leave the Sheet row; the hourly sync marks it `unsubscribed`, and that row is the permanent do-not-email record.
- **"Delete my data"** (or test addresses) → **first** in Kit, open their profile → **Delete Subscriber**, **then** delete their row in the Sheet (right-click the row number → Delete row). Do both, in that order: the hourly sync re-adds anyone still in Kit but missing from the Sheet.
- **Someone who unsubscribed wants back in** → re-signing up does nothing automatically (their email is already in the Sheet, and Kit's API can't reactivate them). In Kit, resubscribe them, then set their Sheet **status** back to `active`.

### Paper signups (bad booth Wi-Fi)

Collect emails on a paper sheet with the consent line printed on it, then enter each one later on the site using `https://devilinorbit.com/?src=paper-<event>` so they're tagged as paper signups.

### Switching newsletter provider someday

Run `syncFromProvider`, then filter the Sheet: `status = active` is the import list; everything else (`unsubscribed`, `bounced`, `complained`, `unconfirmed`) must **not** be imported as active. Rewrite `forwardToProvider_` and `syncFromProvider` in `Code.gs` for the new provider and redeploy (below). Check that the new provider's **free plan includes API access** first (that's what ruled out Buttondown). The Kit-webhook alerts would need the new provider's equivalent. The site and printed QR codes don't change.

## Deploying changes

### Website (`*.html`, `*.js`, `style.css`, `config.js`)
Commit and push to `main`; GitHub Pages updates in about a minute. Browsers can cache the old files for about 10 minutes, so test in a private window.

### Apps Script (`apps-script/Code.gs`)
1. Bump `SCRIPT_REVISION` at the top of `Code.gs`.
2. Paste the **whole file** into the Apps Script editor (replace everything) and save.
3. If `installTriggers()` changed, run `installTriggers` once (it replaces all triggers). Check the clock icon: `syncFromProvider` hourly, `retryFailedForwards` every 6 hours.
4. **Deploy → Manage deployments → (pencil) Edit → Version: New version → Deploy.** Never "New deployment".
5. Health check: `revision` must match what you just bumped.
   ```bash
   curl -sL "<signupEndpoint from config.js>"
   ```
   Expected: `{"ok":true,"service":"battlerun-signup","revision":"..."}`
6. Test a signup with a new address:
   ```bash
   curl -sL -d "source=curltest" --data-urlencode "email=you+test1@example.com" "<signupEndpoint>"
   ```
   Don't add `-X POST`: it breaks on Apps Script's redirect and returns a Google 411 error page. A test creates a real Kit subscriber and sends a real confirmation email, so delete test addresses afterward (Kit + Sheet).

### Cloudflare Worker (`discord-relay/worker.js`)
Cloudflare → Workers & Pages → `discord-relay` → **Edit code** → paste → **Deploy**. Secrets survive code deploys. Opening the Worker URL in a browser should show `Not found` (correct). To debug, start live logs and repeat the action:
- `401 Bad signature`: `KIT_WEBHOOK_SECRET` is wrong.
- `503 Not configured`: a secret is missing.
- `Discord post failed` in the log: check `DISCORD_WEBHOOK_URL`.

## Changing wording

- **Page text, button, Discord button:** `index.html`. "You're in" page: `confirmed.html`.
- **After-signup screen:** `successTitle` and `successMessage` in `config.js` (`{email}` is replaced with the typed address). Error messages are in `main.js`.
- **Alert titles and colors:** "Sub requested" is in `notifyDiscord_` in `Code.gs`; the others are in `KIT_EVENTS` in `worker.js`.
- **Consent line:** `index.html` and `CONSENT_TEXT` in `Code.gs` must match word for word. Change both, bump `CONSENT_VERSION` (e.g. `v3-2026-11`), and redeploy the script.
- **Confirmation email and email footer:** edited in Kit, not here. Go to form **Website signup** → Settings → Incentive (subject, body, button text). The post-confirmation redirect should be `https://devilinorbit.com/confirmed.html`.

## Local testing

```bash
python -m http.server 8000
```
Then open <http://localhost:8000/?src=localtest>. Submitting the form here hits the **live** backend (a real signup); to test the page without that, stub `window.fetch` in the browser console.

## QR codes

Codes encode `https://devilinorbit.com/?src=<event-slug>`; the slug lands in the Sheet's `source` column and in the "Sub requested" alert. Current codes: `direct-qr`, `tiac-playtest`, `ocig-2026`.
To add an event, add its slug (`[a-z0-9_-]`) to `SOURCES` in `qr/make_qr.py` and run `python qr/make_qr.py` (needs `pip install segno`). Print the `.svg` files. Never use a dynamic-QR service.
