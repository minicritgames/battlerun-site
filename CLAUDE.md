# battlerun-site

Newsletter signup site for Battlerun (live at https://devilinorbit.com/).

Before changing anything, read [docs/system.md](docs/system.md): how the site, Apps Script backend, Google Sheet, Kit, and the Discord relay fit together, why each decision was made, and the known gotchas. [README.md](README.md) is the operator runbook.

Rules:
- Never commit secrets. The Kit API key and the Discord webhook URL live only in Apps Script Script Properties.
- `apps-script/Code.gs` and `discord-relay/worker.js` don't deploy from GitHub; they're pasted into their dashboards. Keep the repo identical to what's deployed, and bump `SCRIPT_REVISION` on every `Code.gs` change.
- Redeploy Apps Script as a new **version** of the existing deployment, never a new deployment.
