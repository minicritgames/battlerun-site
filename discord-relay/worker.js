// Cloudflare Worker with two jobs. Paste this into the Worker's code editor in the Cloudflare dashboard.
// See docs/system.md for how it fits into the signup system.
//
// 1) POST /api/webhooks/<id>/<token>: relays Apps Script's "Sub requested" alerts to Discord.
//    Discord's Cloudflare protection blocks Google's shared Apps Script IPs (429, error code 1015); Worker IPs aren't
//    affected. Apps Script uses the Discord webhook URL with only the host swapped to this Worker's host.
//    Variable ALLOWED_WEBHOOK_ID (Text) = <id>, so this can't be used as an open relay to other people's webhooks.
//
// 2) POST /kit-webhook: receives Kit webhook deliveries and verifies Kit's signature.
//    - Subscriber events (confirmed/unsubscribed/bounced/complained) → masked alert to DISCORD_WEBHOOK_URL.
//    - broadcast.sent → teaser embed (subject, preview text, "Read it here" link) to DISCORD_BROADCAST_WEBHOOK_URL.
//    Secrets: KIT_WEBHOOK_SECRET (the whsec_... value Kit returns once when the endpoint is registered),
//    DISCORD_WEBHOOK_URL and DISCORD_BROADCAST_WEBHOOK_URL (full https://discord.com/api/webhooks/<id>/<token> URLs),
//    KIT_API_KEY (looks up a broadcast's public link; the webhook payload doesn't include it).
//    Variable BROADCAST_PUBLIC_ONLY (Text): "true" announces only web-published broadcasts; anything else announces all.

const KIT_EVENTS = {
  'subscriber.activated': { title: 'Sub confirmed', color: 5763719 }, // green
  'subscriber.unsubscribed': { title: 'Sub cancelled', color: 15548997 }, // red
  'subscriber.bounced': { title: 'Email bounced', color: 15105570 }, // orange
  'subscriber.complained': { title: 'Marked as spam', color: 15548997 }, // red
};
const BROADCAST_COLOR = 16115650; // same as the "Sub requested" alert
const SIGNATURE_TOLERANCE_SECONDS = 300;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/kit-webhook') {
      return handleKitWebhook(request, env, ctx);
    }

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

async function handleKitWebhook(request, env, ctx) {
  // A non-2xx makes Kit retry (30s up to ~41h), so a missing secret is recoverable once it's added.
  if (!env.KIT_WEBHOOK_SECRET || !env.DISCORD_WEBHOOK_URL) {
    return new Response('Not configured', { status: 503 });
  }
  const body = await request.text();
  const signed = await verifyKitSignature(request.headers.get('X-Kit-Signature'), body, env.KIT_WEBHOOK_SECRET);
  if (!signed) {
    return new Response('Bad signature', { status: 401 });
  }

  let events = [];
  try {
    events = JSON.parse(body).events || [];
  } catch (err) {
    return new Response('Bad JSON', { status: 400 });
  }

  const embeds = [];
  const broadcasts = [];
  for (const event of events) {
    if (event.type === 'broadcast.sent' && event.data && event.data.broadcast) {
      broadcasts.push(event.data.broadcast);
      continue;
    }
    const kind = KIT_EVENTS[event.type];
    const email = event.data && event.data.subscriber && event.data.subscriber.email_address;
    if (!kind || !email) continue;
    embeds.push({ title: kind.title, description: '`' + maskEmail(email) + '`', color: kind.color });
  }

  // Acknowledge Kit immediately; the Discord posts finish in the background. A Discord failure is only logged,
  // because failing here would make Kit redeliver and could duplicate alerts that did go through.
  if (embeds.length) {
    ctx.waitUntil(postEmbeds(env.DISCORD_WEBHOOK_URL, embeds));
  }
  if (broadcasts.length) {
    ctx.waitUntil(announceBroadcasts(env, broadcasts));
  }
  return new Response('ok');
}

async function announceBroadcasts(env, broadcasts) {
  if (!env.DISCORD_BROADCAST_WEBHOOK_URL) {
    console.error('broadcast.sent received but DISCORD_BROADCAST_WEBHOOK_URL is not set');
    return;
  }
  const publicOnly = env.BROADCAST_PUBLIC_ONLY === 'true';
  const embeds = [];
  for (const broadcast of broadcasts) {
    if (publicOnly && !broadcast.public) continue;
    // Only web-published broadcasts have a public link, so private ones skip the lookup.
    const publicUrl = broadcast.public ? await fetchBroadcastPublicUrl(env, broadcast.id) : '';
    const teaser = broadcast.preview_text || broadcast.description || '';
    const lines = [];
    if (teaser) lines.push(teaser);
    if (publicUrl) lines.push('[Read it here](' + publicUrl + ')');
    const embed = { title: (broadcast.subject || 'Untitled broadcast').slice(0, 256), color: BROADCAST_COLOR };
    if (publicUrl) embed.url = publicUrl;
    if (lines.length) embed.description = lines.join('\n\n').slice(0, 4096);
    embeds.push(embed);
  }
  if (embeds.length) {
    await postEmbeds(env.DISCORD_BROADCAST_WEBHOOK_URL, embeds);
  }
}

async function fetchBroadcastPublicUrl(env, broadcastId) {
  if (!env.KIT_API_KEY || !broadcastId) return '';
  try {
    const res = await fetch('https://api.kit.com/v4/broadcasts/' + encodeURIComponent(broadcastId), {
      headers: { 'X-Kit-Api-Key': env.KIT_API_KEY },
    });
    if (!res.ok) {
      console.error('Kit broadcast lookup failed: ' + res.status);
      return '';
    }
    const data = await res.json();
    return (data.broadcast && data.broadcast.public_url) || '';
  } catch (err) {
    console.error('Kit broadcast lookup failed', err);
    return '';
  }
}

async function postEmbeds(webhookUrl, embeds) {
  // Discord allows at most 10 embeds per message; Kit batches up to 100 events per delivery.
  for (let i = 0; i < embeds.length; i += 10) {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ embeds: embeds.slice(i, i + 10), allowed_mentions: { parse: [] } }),
    });
    if (!res.ok) {
      console.error('Discord post failed: ' + res.status + ' ' + (await res.text()).slice(0, 200));
    }
  }
}

// X-Kit-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">[,v1=<hex during secret rotation>]
async function verifyKitSignature(header, body, secret) {
  if (!header) return false;
  let timestamp = '';
  const signatures = [];
  for (const part of header.split(',')) {
    const [key, value] = part.trim().split('=');
    if (key === 't') timestamp = value;
    else if (key === 'v1' && value) signatures.push(value.toLowerCase());
  }
  if (!timestamp || !signatures.length) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > SIGNATURE_TOLERANCE_SECONDS) return false;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(timestamp + '.' + body));
  const expected = [...new Uint8Array(mac)].map(b => b.toString(16).padStart(2, '0')).join('');
  return signatures.some(signature => timingSafeEqual(signature, expected));
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

// Same masking as the Apps Script alert: "player@example.com" -> "pl****@e******.com".
function maskEmail(email) {
  const at = email.lastIndexOf('@');
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const dot = domain.lastIndexOf('.');
  const domainName = domain.slice(0, dot);
  const tld = domain.slice(dot);
  const keep = local.length <= 2 ? 1 : 2;
  return local.slice(0, keep) + '*'.repeat(Math.max(local.length - keep, 1))
    + '@' + domainName.slice(0, 1) + '*'.repeat(Math.max(domainName.length - 1, 1)) + tld;
}
