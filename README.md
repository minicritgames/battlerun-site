# battlerun-site

Newsletter signup page for Battlerun, reached by QR code at conventions and playtests.
Live at <https://devilinorbit.com/> (GitHub Pages custom domain; DNS at Namecheap).
Static site on GitHub Pages; signups go to a Google Apps Script web app that writes them to a private Google Sheet and forwards them to Kit for sending.

```
QR code → GitHub Pages (this repo) → Apps Script (apps-script/Code.gs) → Google Sheet (source of truth) → Kit
                                                        └→ Cloudflare Worker relay (discord-relay/) → private Discord alert
```

This README is the operator runbook. For how the system works, why it's built this way, and troubleshooting, see [docs/system.md](docs/system.md).

## Files

| File | Purpose |
|---|---|
| `index.html`, `main.js`, `style.css` | Signup page |
| `privacy.html` | Privacy notice |
| `confirmed.html` | "You're in" page Kit redirects to after someone clicks the confirmation link |
| `config.js` | **The only file to edit for URLs**: Apps Script `/exec` URL, Discord invite, success title/message |
| `apps-script/Code.gs` | Backend source of record. Paste into the Apps Script editor bound to the Sheet |
| `discord-relay/worker.js` | Cloudflare Worker that relays signup alerts to Discord (Discord blocks Apps Script's IPs directly) |
| `qr/` | Generated QR codes |

## Where things live

| Thing | Where |
|---|---|
| Subscriber list (master copy) | Google Sheet **Battlerun Subscribers** → tab **Subscribers** (private, never share) |
| Backend script + its settings | From the Sheet: **Extensions → Apps Script** (settings under the gear icon → Script Properties) |
| Sending newsletters | Kit (kit.com), form **Website signup** (ID 9984140), double opt-in on |
| Domain + DNS + email forwarding | Namecheap → devilinorbit.com (`news@devilinorbit.com` forwards to the owner's Gmail) |
| Site hosting | This repo → Settings → Pages (custom domain devilinorbit.com, HTTPS enforced) |

## Running it

### Reading the Sheet

- **status** is the column that matters: `unconfirmed` (hasn't clicked the confirmation email yet), `active`, `unsubscribed`, `bounced`, `complained`.
- **provider_status** is Kit's side: `pending_confirmation` / `subscribed` right after signup, then Kit's own words (`inactive`, `active`, `cancelled`, …) after each sync.
- **source** is which QR code or link they came from (`direct` = typed the address).
- The Sheet syncs with Kit every night around 3am. To sync now: Apps Script → pick `syncFromProvider` → **Run**.
- A **provider_status** starting with `error_` means forwarding to Kit failed. It retries every 6 hours; if it keeps failing, the Kit API key or form ID is probably wrong (check Script Properties).

### Sending a newsletter

1. Kit → **Send → Broadcasts → New broadcast**.
2. First send to yourself only: recipients filter **Email address → Is exactly → your address**. Check links, the footer address and the unsubscribe link.
3. Then make the real broadcast to **All Subscribers** and send or schedule it.

### Removing someone

- **"Stop emailing me"** → in Kit, open their profile and unsubscribe them. Leave the Sheet row; the nightly sync marks it `unsubscribed`, and that row is the permanent do-not-email record.
- **"Delete my data"** (or test addresses) → in Kit, open their profile → **Delete Subscriber**, **and** delete their row in the Sheet (right-click the row number → Delete row). Do both.
- **Someone who unsubscribed wants back in** → re-signing up does nothing automatically. In Kit, resubscribe them, then set their Sheet **status** back to `active`.

### Paper signups (bad booth Wi-Fi)

Collect emails on a paper sheet with the consent line printed on it, then enter each one later on the site using `https://devilinorbit.com/?src=paper-<event>` so they're tagged as paper signups.

### Switching newsletter provider someday

Run `syncFromProvider`, then filter the Sheet: `status = active` is the import list; everything else (`unsubscribed`, `bounced`, `complained`, `unconfirmed`) must **not** be imported as active. Then rewrite `forwardToProvider_` and `syncFromProvider` in `Code.gs` for the new provider and redeploy (below). The site and printed QR codes don't change.

## No secrets in this repo

The Kit API key lives only in Apps Script → Project Settings → Script Properties. Never commit it.
The Apps Script `/exec` URL is public by design.

## Updating the backend

Script Properties changes (e.g. `DOUBLE_OPT_IN`, `SITE_ORIGIN`) apply immediately with no redeploy. Code changes need this:

1. Paste `apps-script/Code.gs` into the Apps Script editor and save.
2. **Deploy → Manage deployments → (pencil) Edit → Version: New version → Deploy.**
   Do not use "New deployment": it creates a new URL and breaks the live site.
3. Health check (should print `{"ok":true,"service":"battlerun-signup"}`):
   ```bash
   curl -sL "<signupEndpoint from config.js>"
   ```
   To test a signup, use `curl -sL -d "source=curltest" --data-urlencode "email=you+test@example.com" "<url>"`.
   Don't add `-X POST`: it breaks on Apps Script's redirect and returns a Google 411 error page.

## Changing wording

- Page text, button, Discord button: `index.html`. Success/error messages: `config.js` and `main.js`.
- The consent line in `index.html` must match `CONSENT_TEXT` in `apps-script/Code.gs` word for word. When changing it, change both, bump `CONSENT_VERSION` (e.g. `v2-2026-11`), and redeploy the script.
- The confirmation email (subject, body, button) and the email footer are edited in Kit, not here: form **Website signup** → Settings → Incentive. Its post-confirmation redirect should point to `https://devilinorbit.com/confirmed.html`.

## Local testing

```bash
python -m http.server 8000
```
Then open <http://localhost:8000/?src=localtest>.

## QR codes

Codes encode `https://devilinorbit.com/?src=<event-slug>`; the slug lands in the Sheet's `source` column.
To add an event, add its slug to `SOURCES` in `qr/make_qr.py` and run `python qr/make_qr.py` (needs `pip install segno`).
Print the `.svg` files. Never use a dynamic-QR service.
