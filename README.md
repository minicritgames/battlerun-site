# battlerun-site

Newsletter signup page for Battlerun, reached by QR code at conventions and playtests.
Static site on GitHub Pages; signups go to a Google Apps Script web app that writes them to a private Google Sheet and forwards them to Kit for sending.

```
QR code → GitHub Pages (this repo) → Apps Script (apps-script/Code.gs) → Google Sheet (source of truth) → Kit
```

## Files

| File | Purpose |
|---|---|
| `index.html`, `main.js`, `style.css` | Signup page |
| `privacy.html` | Privacy notice |
| `config.js` | **The only file to edit for URLs**: Apps Script `/exec` URL, Discord invite, success message |
| `apps-script/Code.gs` | Backend source of record. Paste into the Apps Script editor bound to the Sheet |
| `qr/` | Generated QR codes |

## No secrets in this repo

The Kit API key lives only in Apps Script → Project Settings → Script Properties. Never commit it.
The Apps Script `/exec` URL is public by design.

## Updating the backend

1. Paste `apps-script/Code.gs` into the Apps Script editor and save.
2. **Deploy → Manage deployments → (pencil) Edit → Version: New version → Deploy.**
   Do not use "New deployment": it creates a new URL and breaks the live site.
3. Health check (should print `{"ok":true,"service":"battlerun-signup"}`):
   ```bash
   curl -sL "<signupEndpoint from config.js>"
   ```

## Local testing

```bash
python -m http.server 8000
```
Then open <http://localhost:8000/?src=localtest>.

## QR codes

Encode `https://<site host>/?src=<event-slug>`. Generate static codes locally with `segno` (error correction Q). Never use a dynamic-QR service.
