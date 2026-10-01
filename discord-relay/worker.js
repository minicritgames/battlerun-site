// Cloudflare Worker that relays Discord webhook calls from Apps Script.
// Discord's Cloudflare protection intermittently blocks Google's shared Apps Script IPs (429, error code 1015);
// requests from a Worker don't share those IPs. Paste this into the Worker's code editor in the Cloudflare dashboard.
//
// Usage: take the Discord webhook URL and swap only the host:
//   https://discord.com/api/webhooks/<id>/<token>  ->  https://<worker-host>/api/webhooks/<id>/<token>
// Variable (Worker → Settings → Variables and Secrets): ALLOWED_WEBHOOK_ID = <id>, so this can't be used as an
// open relay to other people's webhooks. The token never needs to be stored here; it travels in the request path.

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const allowedPrefix = '/api/webhooks/' + env.ALLOWED_WEBHOOK_ID + '/';
    if (request.method !== 'POST'
      || !env.ALLOWED_WEBHOOK_ID
      || !url.pathname.startsWith(allowedPrefix)) {
      return new Response('Not found', { status: 404 });
    }

    const res = await fetch('https://discord.com' + url.pathname + url.search, {
      method: 'POST',
      headers: { 'Content-Type': request.headers.get('Content-Type') || 'application/json' },
      body: request.body,
    });
    return new Response(res.body, {
      status: res.status,
      headers: { 'Content-Type': res.headers.get('Content-Type') || 'text/plain' },
    });
  },
};
