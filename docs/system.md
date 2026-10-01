# Battlerun Newsletter Signup: System Documentation

> **Audience:** AI agents and developers maintaining, debugging, or extending this system. Read this before changing anything.
> **Companion doc:** [`README.md`](../README.md) is the operator runbook (sending newsletters, removing people, paper signups). This doc covers how the system works, why it's built this way, and what breaks.
> **Status (2026-10-01):** Live at <https://devilinorbit.com/>. All components deployed and verified end to end, including the "Sub requested" alert through the relay and the Kit-webhook "Sub confirmed" / "Sub cancelled" alerts. The project is considered done; this doc and the README are the handoff for future work.

---

## 1. What it does

A visitor scans a printed QR code at a convention or playtest. The code opens a one-field signup page. Their email is:
1. written to a private **Google Sheet**, the operator's master list, along with consent records,
2. forwarded to **Kit** (kit.com), which sends a confirmation email (double opt-in) and later the newsletters,
3. announced in a private **Discord** channel as a masked alert ("Sub requested", `ga*****@g****.com`, `source: ocig-2026`).

Later lifecycle events also alert instantly in the same channel through Kit webhooks: **Sub confirmed** (they clicked the confirmation link), **Sub cancelled** (unsubscribed), plus bounces and spam complaints.

The page also shows a Discord invite button. Everything runs on free tiers.

**Core design principle: the operator owns the list.** Every signup lands in the Sheet *before* any third party is involved, so the newsletter provider can be swapped without losing anyone. Kit is treated as a replaceable sending pipe.

---

## 2. Component map

| Component | Lives in | Code source of record | How code gets deployed | Owner account |
|---|---|---|---|---|
| Static site | GitHub Pages, repo `minicritgames/battlerun-site`, branch `main`, root | This repo | `git push` to `main`; Pages redeploys in ~1 min | GitHub (minicritgames org) |
| Domain `devilinorbit.com` | Namecheap (registrar + DNS) | `CNAME` file in repo | DNS at Namecheap; Pages custom domain setting, HTTPS enforced | Namecheap |
| Contact email `news@devilinorbit.com` | Namecheap email forwarding to the owner's Gmail | n/a | Namecheap dashboard | Namecheap |
| Backend | Google Apps Script project `battlerun-signup`, **bound** to the Sheet (Sheet → Extensions → Apps Script) | [`apps-script/Code.gs`](../apps-script/Code.gs) | **Manual paste** into the editor, then redeploy as a new version (§6) | Google account that owns the Sheet |
| Subscriber list | Google Sheet **Battlerun Subscribers**, tab **Subscribers** (private) | n/a (data) | n/a | Same Google account |
| Newsletter provider | Kit, free Newsletter plan; form **Website signup**, ID `9984140` | n/a | Kit dashboard | Kit account |
| Discord relay + Kit webhook receiver | Cloudflare Worker `discord-relay` on `*.workers.dev` | [`discord-relay/worker.js`](../discord-relay/worker.js) | **Manual paste** into the Cloudflare dashboard editor → Deploy | Cloudflare account (free) |
| Kit webhook endpoint | Registered in Kit via the API (no dashboard UI used), name "Discord subscriber alerts", URL `https://<worker-host>/kit-webhook` | `registerKitWebhook()` in `Code.gs` | Run once from the Apps Script editor | Kit account |
| Signup alerts | Private Discord channel with a webhook named for the newsletter | n/a | Discord channel settings → Integrations → Webhooks | Discord server |
| QR codes | `qr/*.svg` / `qr/*.png` | [`qr/make_qr.py`](../qr/make_qr.py) | Run locally, then print the files | n/a |

**Important:** GitHub is the source of record for the Apps Script and Worker code, but **neither deploys from GitHub**. Changing `Code.gs` or `worker.js` in the repo does nothing until someone pastes it into the respective dashboard. Always keep the repo and the deployed code identical (§6).

---

## 3. Request flow

```
QR code ──► https://devilinorbit.com/?src=<event-slug>
              │  index.html + config.js + main.js (GitHub Pages)
              │  fetch POST, body = URLSearchParams (application/x-www-form-urlencoded)
              ▼
Apps Script web app  /exec   (Execute as: owner, Access: Anyone)
  doPost(e):
   1. honeypot field `website` filled → return ok, do nothing
   2. normalize + validate email; sanitize source to [a-z0-9_-]{1,40} (default "direct")
   3. 10-min CacheService dedupe on the email
   4. LockService lock → if email already in column B, return ok (no new row, no alert)
                       → else appendRow(...) with status "unconfirmed" (DOI on) or "active"
   5. forwardToProvider_ → Kit API: create subscriber (state inactive) + add to form 9984140
                           (adding to the form is what triggers Kit's confirmation email)
   6. writeProviderResult_ → provider_status / provider_subscriber_id / notes
   7. notifyDiscord_ → POST embed to the relay → Discord; result appended to notes ("discord:204")
   8. return {"ok":true}
              │
              ▼
Site replaces the form with "One more step: check your email" + "Wrong email? Fix it"
              │
Person clicks the confirmation link in Kit's email ──► Kit marks them active
              ├─► Kit redirects to https://devilinorbit.com/confirmed.html ("You're in!" + Discord button)
              └─► Kit webhook (subscriber.activated) ──► Worker /kit-webhook ──► Discord "Sub confirmed"

Kit webhooks (instant), registered by registerKitWebhook():
  subscriber.activated → "Sub confirmed" (green)    subscriber.unsubscribed → "Sub cancelled" (red)
  subscriber.bounced   → "Email bounced" (orange)   subscriber.complained   → "Marked as spam" (red)
  Worker /kit-webhook: verify X-Kit-Signature (HMAC-SHA256 of "<t>.<raw body>", 5-min tolerance)
                       → reply 200 immediately → post masked embeds to Discord in the background (ctx.waitUntil)
  These alerts do NOT update the Sheet; the hourly sync does.

Time-based triggers (installed by installTriggers()):
  syncFromProvider     hourly    : pulls every Kit subscriber state into the Sheet
  retryFailedForwards  every 6h  : re-forwards rows whose provider_status is error_* or pending
```

Failures are isolated by design. A Kit failure still returns success to the visitor (the row is saved and retried later). A Discord failure never affects the signup.

---

## 4. Data model (Sheet columns, in order)

| Column | Meaning |
|---|---|
| `timestamp` | Signup time |
| `email` | Lowercased, validated. Column B is formatted as plain text (formula-injection guard) |
| `source` | `?src=` value from the URL, sanitized; `direct` if absent |
| `consent_text` | Exact consent wording shown at signup (`CONSENT_TEXT`) |
| `consent_version` | `CONSENT_VERSION` at signup time (currently `v2-2026-10`) |
| `provider` | `kit` |
| `provider_status` | Kit-side state. Right after signup: `pending_confirmation`/`subscribed`, or `error_create_<code>`, `error_form_<code>`, `error_fetch`, `error_config`. After a sync, Kit's own state words: `inactive`, `active`, `cancelled`, `bounced`, `complained` |
| `provider_subscriber_id` | Kit subscriber ID |
| `status` | **The column that matters.** `unconfirmed`, `active`, `unsubscribed`, `bounced`, `complained`. This is the suppression list for any future migration |
| `last_synced` | Last time `syncFromProvider` saw this email in Kit |
| `notes` | Kit error detail (if any), then ` \| discord:<code>` from the alert attempt |

Mapping applied by `syncFromProvider`: Kit `cancelled` → `unsubscribed`; `bounced`/`complained` → same; `active` → `active`; `inactive` → left as-is (still `unconfirmed`).

Rows are append-only. Code relies on that: `doPost` captures the row number under the lock and writes to it after releasing the lock. **Don't add code that deletes or sorts rows during normal operation.** Manual row deletion for data-deletion requests is fine (it's rare, and it isn't concurrent with a signup in practice).

---

## 5. Configuration and secrets inventory

Nothing secret is in this repo. The repo is **public** (free GitHub Pages requires it), and Pages also serves every file in it, e.g. `devilinorbit.com/apps-script/Code.gs`. That's acceptable because the code holds no secrets and reveals nothing the site's public source doesn't already.

| Setting | Where | Secret? | Notes |
|---|---|---|---|
| `KIT_API_KEY` | Apps Script → Project Settings → Script Properties | **Yes** | Kit V4 API key (Kit → Settings → Developer). Free plan includes API keys |
| `KIT_FORM_ID` | Script Properties | No | `9984140` |
| `DOUBLE_OPT_IN` | Script Properties | No | `true`. Decides the initial Kit `state` (`inactive` vs `active`) and the initial Sheet `status` |
| `SITE_ORIGIN` | Script Properties | No | Should be `https://devilinorbit.com`; used to build the Kit `referrer` |
| `DISCORD_SIGNUP_WEBHOOK_URL` | Script Properties | **Yes** (contains the webhook token) | **Relay host**, not discord.com: `https://discord-relay.<subdomain>.workers.dev/api/webhooks/<id>/<token>`. Unset = no alerts |
| `ALLOWED_WEBHOOK_ID` | Cloudflare → Worker `discord-relay` → Settings → Variables and Secrets (Text) | No | The numeric `<id>` only. Restricts the relay to this one webhook |
| `DISCORD_WEBHOOK_URL` | Cloudflare Worker → Variables and Secrets (**Secret**) | **Yes** | The same Discord webhook with the normal `https://discord.com/...` host. Used by `/kit-webhook` to post directly |
| `KIT_WEBHOOK_SECRET` | Cloudflare Worker → Variables and Secrets (**Secret**) | **Yes** | The `whsec_...` signing secret Kit returned **once** from `registerKitWebhook()`. Lost → rotate it via Kit's API (rotate-secret endpoint) or delete and re-register the endpoint |
| `signupEndpoint` | `config.js` | No | Apps Script `/exec` URL. Public by design |
| `discordInvite` | `config.js` | No | Permanent invite (never expires, unlimited uses) |
| `successTitle` / `successMessage` | `config.js` | No | Post-signup screen text; `{email}` is replaced with the typed address |
| `CONSENT_TEXT` / `CONSENT_VERSION` | `Code.gs` constants | No | Must match `index.html`'s consent line word for word |
| `SCRIPT_REVISION` | `Code.gs` constant | No | Reported by GET `/exec`. Bump on every code change |

Script Property changes take effect immediately, with no redeploy. If the Discord webhook token leaks, delete the webhook in Discord, create a new one, then update `DISCORD_SIGNUP_WEBHOOK_URL` (relay host), `ALLOWED_WEBHOOK_ID` and the Worker's `DISCORD_WEBHOOK_URL`.

---

## 6. Deploying changes

### Site (HTML/CSS/JS, config.js)
Commit and push to `main`. GitHub Pages redeploys in about a minute. Browsers may cache the old files for up to ~10 minutes; test in a private window. Verify with `curl -s https://devilinorbit.com/config.js`.

### Apps Script backend
1. Bump `SCRIPT_REVISION` in `apps-script/Code.gs`.
2. Operator pastes the **entire** file into the Apps Script editor (replacing everything) and saves.
3. **Deploy → Manage deployments → pencil (Edit) → Version: New version → Deploy.**
   **Never "New deployment"**: that mints a new `/exec` URL while the site keeps calling the old one, which silently runs old code.
4. Verify: `curl -sL "<signupEndpoint>"` must return `{"ok":true,"service":"battlerun-signup","revision":"<new revision>"}`.

Editor "Run" uses the latest *saved* code; the `/exec` URL uses the latest *deployed version*. A function working in the editor proves nothing about the live web app.

### Cloudflare Worker
Workers & Pages → `discord-relay` → Edit code → paste `discord-relay/worker.js` → Deploy. Sanity check: opening the Worker URL in a browser (a GET) returns `Not found`, which is correct. To debug Kit webhook deliveries, open the Worker's **Logs/Observability** and start live logs; responses are `401 Bad signature`, `503 Not configured` (a secret is missing), or `200 ok`.

### Triggers
Changing `installTriggers()` doesn't change existing triggers. After pasting new code, run `installTriggers` once from the editor (it deletes and recreates all of them). Check under **Triggers** (clock icon) in the sidebar.

### Kit webhook endpoint
Registered once with `registerKitWebhook()`. Running it again creates a **duplicate** endpoint (duplicate alerts). `listKitWebhooks()` shows what's registered. To change the event list or URL, use Kit's update-endpoint API rather than re-registering.

### Testing a signup without a browser
```bash
curl -sL -d "source=curltest" --data-urlencode "email=you+test1@example.com" "<signupEndpoint>"
```
Use `-d` (which implies POST). **Don't add `-X POST`**: with `-L`, curl re-POSTs to Apps Script's 302 redirect target and gets a Google 411 error page. Each test needs a new address (`+tag` aliases); repeats are deduped and produce no row or alert. A real test creates a real Kit subscriber and sends a real confirmation email, so delete test addresses afterward (Kit profile → Delete Subscriber, and delete the Sheet row).

---

## 7. Decisions and why (history)

| Decision | Why | Rejected alternatives |
|---|---|---|
| Static site on GitHub Pages | Free, no server, operator already knows it | Netlify forms (vendor-held data) |
| Google Sheet as source of truth, written first | Owning the list protects against provider price changes; consent records make migration credible | Provider-only storage with periodic CSV export (depends on remembering to export) |
| Apps Script as the backend | Free serverless endpoint with native Sheet access; secrets stay server-side | Cloudflare D1 + Worker (more to build), Google Forms (poor UX, no forwarding) |
| **Kit** as provider | Free plan: 10,000 subscribers, unlimited sends, CSV export, **API keys on all plans** | **Buttondown**: API requires the $29/mo plan, free tier only 100 subscribers. Mailchimp/MailerLite: smaller, shrinking free tiers. Brevo is the documented fallback |
| Double opt-in **on** (`c42eee2`) | Catches typos from phone typing at a booth; operator's choice | Single opt-in (the original default) |
| Consent by affirmative action, no checkbox | The form's only purpose is the newsletter; the consent line sits by the button; exact text + version stored per row | Required checkbox (extra friction) |
| "Check your email" screen showing the typed address + "Wrong email? Fix it" (`ee43cf6`) | Most failed confirmations at conventions are typos or emails people never notice | A one-line success message |
| `confirmed.html` as Kit's post-confirmation redirect | Lands confirmed people on our page with the Discord button instead of Kit's generic page | Kit's default page |
| Masked emails in Discord | Discord history is less private than the Sheet | Full addresses |
| **Discord alerts via a Cloudflare Worker relay** (`2af6147`) | Discord's Cloudflare front blocks Apps Script's shared Google IPs: live signups got `429` + `error code: 1015` while editor runs worked. The relay sends from Cloudflare's network instead | Retrying from Apps Script (same blocked IPs); email alerts via MailApp (kept as a fallback idea) |
| Discord result written to the `notes` column | Apps Script's Executions page often won't expand web-app runs to show logs; the Sheet is always readable | Relying on console logs |
| `SCRIPT_REVISION` in the health check | Hard to tell which code version is live otherwise | n/a |
| **Kit webhooks → Worker → Discord** for confirm/cancel alerts | Instant. Verified by test that the free Newsletter plan can list and create webhook endpoints, despite Kit's docs implying free plans get `401`. The Worker receives them because it already exists, always answers within Kit's 10s limit, and can reach Discord | Detecting state changes during `syncFromProvider` (works on any plan, but up to an hour late). Receiving in Apps Script (`doPost` replies via a 302 redirect, which webhook senders may treat as failure → duplicate retries) |
| Worker replies 200 before posting to Discord | A Discord failure must not make Kit redeliver (duplicate alerts for anything that did post) | No event-ID dedupe: the Cache API doesn't persist on `workers.dev`, and duplicates only happen if Kit redelivers |
| Hourly `syncFromProvider` | Keeps the Sheet's `status`/suppression list close to Kit's truth | Daily (the original) |
| Static QR codes encoding our own domain | No expiry or vendor dependence; the destination can change without reprinting | "Dynamic QR" services (can be paywalled later) |

---

## 8. Gotchas (things that already bit us or will)

1. **New deployment vs. new version** (§6). This is the most likely way to break the live site.
2. **CORS:** the site must send a "simple request" (form-encoded body, no custom headers, no JSON content type). Apps Script can't answer CORS preflight. Apps Script replies via a 302 to `script.googleusercontent.com`; `fetch` follows it automatically.
3. **Discord blocks Apps Script.** Never point the webhook property at `discord.com` directly. Cloudflare Worker IPs are shared too and can occasionally be rate-limited; if `notes` starts showing `discord:429` again, consider email alerts (`MailApp`) as a fallback.
4. **Kit's create-subscriber call is an upsert that can't change `state`.** Someone who unsubscribed and signs up again gets no new row (their email is already in the Sheet) and isn't reactivated. Resubscribe them manually in Kit and set the Sheet `status` back to `active`.
5. **Kit double opt-in via API was reported broken by one developer** (confirming left the subscriber `inactive`); another documented it working. **On this account it works:** confirming fires Kit's `subscriber.activated` webhook, which only happens on a transition to `active` (verified 2026-10-01 via the "Sub confirmed" alert). If "Sub confirmed" alerts ever stop arriving while confirmations still happen, re-check this. If they don't, set `DOUBLE_OPT_IN=false` and turn off the form's incentive email in Kit.
6. **Kit unconfirmed subscribers never receive broadcasts.** That's expected with DOI. Don't try to bulk-activate them: typos and spam complaints hurt deliverability.
7. **Consent text is duplicated** between `index.html` and `CONSENT_TEXT` in `Code.gs`. Change both, bump `CONSENT_VERSION`, redeploy the script.
8. **Dedupe means repeat tests do nothing.** Always test with a new address.
9. **Kit API-key rate limit:** 120 requests per rolling 60s. Each signup uses 2, so ~60 signups/min is the ceiling; overflow becomes `error_create_429` and is retried every 6h. `syncFromProvider` sleeps 600ms between pages for the same reason.
10. **Apps Script quotas (consumer account):** 20,000 URL fetches/day, 30 simultaneous executions, 90 min/day of trigger runtime. Far above expected load.
11. **Kit free plan limits:** 10,000 *active* subscribers; above that, sending stops until upgrade. One basic automation.
12. **The editor shows Google's "unverified app" warning** on authorization. That's expected for a personal script (Advanced → Go to battlerun-signup).
13. **Kit-webhook alerts have no `source`.** Kit's payload doesn't carry our `?src=` value; only the masked email is shown. Look up the source in the Sheet if needed.
14. **Kit-webhook alerts and the Sheet are independent.** An alert doesn't mean the Sheet is updated yet; it catches up on the next hourly sync.
15. **Kit's signing secret is shown once.** If it's lost, the Worker can't verify deliveries (every delivery gets `401`, and Kit retries for ~41h, then gives up).

---

## 9. Troubleshooting

| Symptom | Check |
|---|---|
| Site says "Couldn't reach the server" | GET the `/exec` URL with `curl -sL`. Not JSON → deployment broken or access isn't "Anyone". Compare `signupEndpoint` in `config.js` with the URL in Manage deployments |
| Signup "succeeds" but no row | The email was already in the Sheet (dedupe), or the honeypot was filled (autofill extensions can do this rarely) |
| Row exists, `provider_status` = `error_*` | `notes` has Kit's response. `401` → bad `KIT_API_KEY`; `404` on form → bad `KIT_FORM_ID`; `429` → rate limit (auto-retried). `error_config` → property missing |
| No confirmation email | Check Kit: is the subscriber on form 9984140, and is the form's incentive email on? Check spam/Promotions. Domain authentication (SPF/DKIM for devilinorbit.com in Kit) affects inbox placement |
| No Discord alert | Read `notes`: `discord:204` = delivered (check the webhook's channel); `discord:429 … 1015` = blocked (property not using the relay host?); `discord:404` from the relay = `ALLOWED_WEBHOOK_ID` mismatch or wrong path; `discord:401/404` from Discord = webhook deleted; `discord:no-webhook-property` = property missing; empty notes = old code deployed (check `revision`) |
| No "Sub confirmed"/"Sub cancelled" alert | Worker live logs while repeating the action: nothing arrives → check `listKitWebhooks()` (status `active`, URL ends `/kit-webhook`); `401 Bad signature` → `KIT_WEBHOOK_SECRET` wrong; `503` → a Worker secret missing; `200` but no message → Worker log shows `Discord post failed` (check `DISCORD_WEBHOOK_URL`) |
| Every alert arrives twice | Duplicate Kit endpoints (`registerKitWebhook` run twice); delete one via Kit's delete-endpoint API |
| Live behavior doesn't match the repo code | GET `/exec` and compare `revision` with `SCRIPT_REVISION` in the repo |
| Old text still on the site after a push | Browser cache (~10 min) or Pages still deploying; test in a private window |

---

## 10. Extending

- **New event QR code:** add the slug to `SOURCES` in `qr/make_qr.py`, run `python qr/make_qr.py` (`pip install segno`), commit the outputs. Slugs must match `[a-z0-9_-]`.
- **Change wording:** page text in `index.html`/`confirmed.html`; post-signup text in `config.js`; error strings in `main.js`; consent see gotcha 7; confirmation email in Kit (form → Settings → Incentive: subject, body, button, post-confirm redirect).
- **Switch provider:** rewrite only `forwardToProvider_` and `syncFromProvider` in `Code.gs`, put the new key in Script Properties, redeploy as a new version. Migration: run `syncFromProvider`, import only `status = active` rows; everything else is suppression (never import as active). Check the new provider's **free-tier API access** first (that's what ruled out Buttondown). Brevo is the noted fallback.
- **Turn off double opt-in:** `DOUBLE_OPT_IN=false`, turn off the form's incentive email in Kit, and change `successTitle`/`successMessage` in `config.js` (suggested text is in the comment there).
- **Spam protection, if bots appear:** add Cloudflare Turnstile (free). Widget on the page; verify the token in `doPost` via `UrlFetchApp` to Turnstile's siteverify endpoint, with the secret in Script Properties.
- **Visual redesign:** safe as long as the element IDs used by `main.js` stay (`signup`, `email`, `status`, `success`, `success-title`, `success-message`, `retry`, `discord`) and the honeypot input `website` stays hidden but present.
- **Collecting more fields (e.g. name):** add the input; read it from `e.parameter` in `doPost`; append a new column **at the end** of `HEADERS` and of the `appendRow` array, and add the header to row 1 of the Sheet manually (`setup()` only writes headers to an empty sheet); pass it to Kit as `first_name` or a custom field.

---

## 11. Compliance notes (not legal advice)

- CAN-SPAM: Kit adds an unsubscribe link and the sender's postal address to every email; both must stay valid. Unsubscribes are honored by Kit and mirrored to the Sheet hourly.
- Consent proof per row: `timestamp`, `source`, `consent_text`, `consent_version`, plus Kit's confirmation for DOI.
- The privacy page (`privacy.html`) promises: email only used for Battlerun news, never sold, stored in the Sheet + Kit, deletion on request via `news@devilinorbit.com`, 13+ only. Keep the system consistent with those promises.
- Data-deletion request: delete in Kit **and** delete the Sheet row. Unsubscribe-only request: unsubscribe in Kit and keep the row (it's the do-not-email record).

---

## 12. Open items

- [x] Confirmed double opt-in subscribers become `active` in Kit (verified 2026-10-01 through the `subscriber.activated` webhook; see gotcha 5).
- [ ] Customize Kit's confirmation email (subject "Confirm your Battlerun signup", button "Yes, sign me up", sender name "Battlerun") and set the post-confirm redirect to `https://devilinorbit.com/confirmed.html`, if not already done.
- [ ] Authenticate `devilinorbit.com` as a sending domain in Kit (SPF/DKIM records at Namecheap), if not already done.
- [ ] Confirm `SITE_ORIGIN` is `https://devilinorbit.com` (the `Code.gs` header comment shows an older github.io example). It only affects the referrer recorded in Kit.

These were not verified from the agent side; the operator may already have done them.

---

## 13. References

- Kit API: <https://developers.kit.com/llms.txt> (index); create subscriber, add to form, list subscribers, authentication + rate limits
- Kit API keys on all plans: <https://help.kit.com/en/articles/9902901-kit-api-overview>
- Kit Newsletter (free) plan: <https://help.kit.com/en/articles/9053602-the-kit-newsletter-plan>
- Kit DOI-via-API reports: <https://github.com/jbranchaud/til/blob/master/workflow/add-subscriber-to-kit-form-via-api.md> (works) vs <https://github.com/delgado-jason/dash/pull/499> (stayed inactive)
- Apps Script web apps: <https://developers.google.com/apps-script/guides/web>; quotas: <https://developers.google.com/apps-script/guides/services/quotas>
- Apps Script CORS pattern: <https://github.com/tanaikech/taking-advantage-of-Web-Apps-with-google-apps-script>
- Kit webhooks: <https://developers.kit.com/webhooks/overview.md> (event types, delivery format, verifying signatures, retries)
- Discord blocking Apps Script (429/1015): <https://github.com/discord/discord-api-docs/issues/8411>; Worker relay approach: <https://efo-yu.github.io/post/tech/cfw-proxy-for-discord-webhook/>
- GitHub Pages custom domains: <https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site>
- CAN-SPAM: <https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business>
