# battlerun-site

Newsletter signup site for Battlerun (live at https://devilinorbit.com/).

Before changing anything, read the "Start here" section of [README.md](README.md), then [docs/system.md](docs/system.md): how the site, Apps Script backend, Google Sheet, Kit, Kit webhooks, and the Cloudflare Worker fit together, why each decision was made, and the known gotchas.

Rules:
- Never commit secrets. The Kit API key and Discord webhook URL live only in Apps Script Script Properties; the Kit webhook signing secret, the Discord webhook URLs and a copy of the Kit API key live only in the Cloudflare Worker's secrets.
- `apps-script/Code.gs` and `discord-relay/worker.js` don't deploy from GitHub; they're pasted into their dashboards. Keep the repo identical to what's deployed, and bump `SCRIPT_REVISION` on every `Code.gs` change.
- Redeploy Apps Script as a new **version** of the existing deployment, never a new deployment.
