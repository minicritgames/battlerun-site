// Battlerun newsletter signup backend.
// Source of record for the Apps Script project bound to the "Battlerun Subscribers" Sheet.
// Paste this into the Apps Script editor's Code.gs, then redeploy as a NEW VERSION of the existing deployment.
//
// Secrets/config live in Project Settings → Script Properties (never in this file):
//   KIT_API_KEY, KIT_FORM_ID, DOUBLE_OPT_IN ("true" | "false"), SITE_ORIGIN ("https://devilinorbit.com"),
//   DISCORD_SIGNUP_WEBHOOK_URL (optional; unset = no signup alerts). Use the relay host from discord-relay/worker.js,
//   not discord.com: Discord blocks Apps Script's shared IPs with 429 / error code 1015.

// Bump on every code change; the health check (GET on the /exec URL) reports it, which shows what is actually live.
const SCRIPT_REVISION = '2026-10-01-sync-adds-kit-only';
const SHEET_NAME = 'Subscribers';
// Must match the consent line on the site (index.html) word for word. Bump CONSENT_VERSION whenever the text changes.
const CONSENT_TEXT = 'Get news and playtest invites by email. Unsubscribe anytime. You must be 13 or older.';
const CONSENT_VERSION = 'v2-2026-10';
const DEDUPE_SECONDS = 600;
// Rows the sync adds for people who subscribed outside this site (Kit's newsletter site, or added by hand in Kit).
// Their consent was collected by Kit's form, not ours, so the row says so rather than claiming our wording.
const KIT_ONLY_SOURCE = 'kit';
const KIT_ONLY_CONSENT_TEXT = 'Subscribed outside devilinorbit.com (Kit newsletter site or added in Kit); consent collected by Kit.';
const HEADERS = [
  'timestamp',
  'email',
  'source',
  'consent_text',
  'consent_version',
  'provider',
  'provider_status',
  'provider_subscriber_id',
  'status',
  'last_synced',
  'notes',
];
const COL = Object.fromEntries(HEADERS.map((h, i) => [h, i + 1]));

// Entry points

function doGet() {
  return json_({ ok: true, service: 'battlerun-signup', revision: SCRIPT_REVISION });
}

function doPost(e) {
  try {
    const p = (e && e.parameter) || {};

    // Honeypot: hidden field humans never fill in. Pretend success so bots learn nothing.
    if (p.website) return json_({ ok: true });

    const email = normalizeEmail_(p.email);
    if (!email) return json_({ ok: false, error: 'invalid_email' });
    const source = sanitizeSource_(p.source);

    // Cheap dedupe against double-taps and resubmits. Only marked "seen" once the row is safely
    // written (below), so a busy/error response never turns a retry into a silent no-op.
    const cache = CacheService.getScriptCache();
    const cacheKey = 'seen:' + email;
    if (cache.get(cacheKey)) return json_({ ok: true });

    let row;
    const lock = LockService.getScriptLock();
    if (!lock.tryLock(15000)) return json_({ ok: false, error: 'busy' });
    try {
      const sheet = getSheet_();
      if (findRow_(sheet, email)) {
        cache.put(cacheKey, '1', DEDUPE_SECONDS);
        return json_({ ok: true }); // already on the list
      }
      // With double opt-in, people aren't real subscribers until they confirm; syncFromProvider flips them to active.
      const doubleOptIn = PropertiesService.getScriptProperties().getProperty('DOUBLE_OPT_IN') === 'true';
      sheet.appendRow([
        new Date(), email, source, CONSENT_TEXT, CONSENT_VERSION,
        'kit', 'pending', '', doubleOptIn ? 'unconfirmed' : 'active', '', '',
      ]);
      row = sheet.getLastRow();
      cache.put(cacheKey, '1', DEDUPE_SECONDS);
    } finally {
      lock.releaseLock();
    }

    // Rows are append-only, so `row` stays valid after the lock is released.
    // A provider failure is recorded on the row and retried later; the signup itself already succeeded.
    const result = forwardToProvider_(email, source);
    writeProviderResult_(getSheet_(), row, result);
    const discord = notifyDiscord_(email, source, result);
    const notes = getSheet_().getRange(row, COL.notes);
    notes.setValue([notes.getValue(), discord].filter(String).join(' | '));
    return json_({ ok: true });
  } catch (err) {
    console.error(err);
    return json_({ ok: false, error: 'server_error' });
  }
}

// Provider adapter. This is the ONLY provider-specific code for signups; swap it to change providers.

function forwardToProvider_(email, source) {
  try {
    const props = PropertiesService.getScriptProperties();
    const apiKey = props.getProperty('KIT_API_KEY');
    const formId = props.getProperty('KIT_FORM_ID');
    const doubleOptIn = props.getProperty('DOUBLE_OPT_IN') === 'true';
    const origin = props.getProperty('SITE_ORIGIN') || '';
    if (!apiKey || !formId) return { status: 'error_config', detail: 'KIT_API_KEY or KIT_FORM_ID missing' };
    const headers = { 'X-Kit-Api-Key': apiKey };

    // 1) Create (upsert) the subscriber. Kit's upsert does NOT change state for existing subscribers.
    const create = UrlFetchApp.fetch('https://api.kit.com/v4/subscribers', {
      method: 'post',
      contentType: 'application/json',
      headers: headers,
      payload: JSON.stringify({
        email_address: email,
        state: doubleOptIn ? 'inactive' : 'active',
      }),
      muteHttpExceptions: true,
    });
    const createCode = create.getResponseCode();
    if (createCode >= 300) {
      return { status: 'error_create_' + createCode, detail: create.getContentText().slice(0, 300) };
    }
    let subscriberId = '';
    try {
      subscriberId = String(JSON.parse(create.getContentText()).subscriber.id);
    } catch (ignored) {}

    // 2) Add to the form (subscriber must already exist). With DOI on, this is what triggers Kit's confirmation email.
    const add = UrlFetchApp.fetch('https://api.kit.com/v4/forms/' + encodeURIComponent(formId) + '/subscribers', {
      method: 'post',
      contentType: 'application/json',
      headers: headers,
      payload: JSON.stringify({
        email_address: email,
        referrer: origin + '/?src=' + encodeURIComponent(source),
      }),
      muteHttpExceptions: true,
    });
    const addCode = add.getResponseCode();
    if (addCode >= 300) {
      return { status: 'error_form_' + addCode, id: subscriberId, detail: add.getContentText().slice(0, 300) };
    }

    return { status: doubleOptIn ? 'pending_confirmation' : 'subscribed', id: subscriberId };
  } catch (err) {
    // Network errors/timeouts from UrlFetchApp throw; record them so retryFailedForwards picks the row up.
    return { status: 'error_fetch', detail: String(err).slice(0, 300) };
  }
}

// Pulls every subscriber's state from Kit and mirrors it into the Sheet, and adds anyone who is in Kit but not in
// the Sheet (signed up on Kit's newsletter site, or added by hand in Kit) so the Sheet stays the complete list.
// Keeps the Sheet's suppression list (unsubscribed/bounced/complained) correct for any future migration.
function syncFromProvider() {
  const apiKey = PropertiesService.getScriptProperties().getProperty('KIT_API_KEY');
  const kitSubscribers = {};
  let after = '';
  for (let page = 0; page < 100; page++) { // hard cap; 100 pages × 1000 = 100k subscribers
    let url = 'https://api.kit.com/v4/subscribers?status=all&per_page=1000&slim=true';
    if (after) url += '&after=' + encodeURIComponent(after);
    const res = UrlFetchApp.fetch(url, { headers: { 'X-Kit-Api-Key': apiKey }, muteHttpExceptions: true });
    if (res.getResponseCode() >= 300) throw new Error('Kit list failed: ' + res.getResponseCode());
    const body = JSON.parse(res.getContentText());
    body.subscribers.forEach(s => { kitSubscribers[String(s.email_address).toLowerCase()] = s; });
    if (!body.pagination || !body.pagination.has_next_page) break;
    after = body.pagination.end_cursor;
    Utilities.sleep(600); // stays well under Kit's 120 req/60s API-key limit
  }

  // Same lock as doPost: this function now appends rows, and doPost relies on rows never moving under it.
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  const added = [];
  try {
    const sheet = getSheet_();
    const now = new Date();
    const inSheet = {};
    const last = sheet.getLastRow();
    if (last >= 2) {
      const range = sheet.getRange(2, 1, last - 1, HEADERS.length);
      const values = range.getValues();
      values.forEach(r => {
        const email = String(r[COL.email - 1]).toLowerCase();
        inSheet[email] = true;
        const subscriber = kitSubscribers[email];
        if (!subscriber) return;
        r[COL.provider_status - 1] = subscriber.state;
        r[COL.last_synced - 1] = now;
        r[COL.status - 1] = statusForKitState_(subscriber.state, r[COL.status - 1]);
      });
      range.setValues(values);
    }

    Object.keys(kitSubscribers).forEach(email => {
      if (inSheet[email] || !normalizeEmail_(email)) return;
      const subscriber = kitSubscribers[email];
      const row = [];
      row[COL.timestamp - 1] = subscriber.created_at ? new Date(subscriber.created_at) : now;
      row[COL.email - 1] = email;
      row[COL.source - 1] = KIT_ONLY_SOURCE;
      row[COL.consent_text - 1] = KIT_ONLY_CONSENT_TEXT;
      row[COL.consent_version - 1] = 'kit';
      row[COL.provider - 1] = 'kit';
      row[COL.provider_status - 1] = subscriber.state;
      row[COL.provider_subscriber_id - 1] = subscriber.id ? String(subscriber.id) : '';
      row[COL.status - 1] = statusForKitState_(subscriber.state, 'unconfirmed');
      row[COL.last_synced - 1] = now;
      row[COL.notes - 1] = 'added by sync';
      sheet.appendRow(row);
      added.push({ email: email, state: subscriber.state, row: sheet.getLastRow() });
    });
  } finally {
    lock.releaseLock();
  }

  // Alerts go out after the lock is released so a slow Discord call never delays a signup.
  // Only for people who are, or may become, subscribers; an old unsubscribed address isn't a new signup.
  added.forEach(entry => {
    if (entry.state !== 'active' && entry.state !== 'inactive') return;
    const discord = notifyDiscord_(entry.email, KIT_ONLY_SOURCE, { status: 'subscribed' });
    const notes = getSheet_().getRange(entry.row, COL.notes);
    notes.setValue([notes.getValue(), discord].filter(String).join(' | '));
    Utilities.sleep(1000); // spaces out a burst (e.g. the first sync after this shipped) under Discord's webhook limits
  });
}

// Maps Kit's subscriber state onto the Sheet's status column.
function statusForKitState_(state, currentStatus) {
  if (state === 'cancelled') return 'unsubscribed';
  if (state === 'bounced' || state === 'complained') return state;
  if (state === 'active') return 'active';
  // 'inactive' = has not confirmed double opt-in yet; keep what the row already says (normally 'unconfirmed')
  return currentStatus;
}

// Re-forwards rows whose provider call failed. Runs on a trigger; can also be run manually.
function retryFailedForwards() {
  const sheet = getSheet_();
  const last = sheet.getLastRow();
  for (let row = 2; row <= last; row++) {
    const providerStatus = String(sheet.getRange(row, COL.provider_status).getValue());
    if (!providerStatus.startsWith('error') && providerStatus !== 'pending') continue;
    const email = sheet.getRange(row, COL.email).getValue();
    const source = sheet.getRange(row, COL.source).getValue();
    writeProviderResult_(sheet, row, forwardToProvider_(email, source));
    Utilities.sleep(1200);
  }
}

// Private signup alert. Best-effort: a Discord failure must never fail the signup.
function notifyDiscord_(email, source, result) {
  const url = PropertiesService.getScriptProperties().getProperty('DISCORD_SIGNUP_WEBHOOK_URL');
  if (!url) return 'discord:no-webhook-property';
  const failed = String(result.status).startsWith('error');
  let description = '`' + maskEmail_(email) + '`\nsource: `' + source + '`';
  if (failed) {
    description += '\n:warning: Kit forward failed (`' + result.status + '`); will retry automatically.';
  }
  const embed = {
    title: 'Sub requested',
    description: description,
    color: failed ? 15548997 : 16115650, // red on failure, otherwise the normal accent
  };
  const request = {
    method: 'post',
    contentType: 'application/json',
    // allowed_mentions with an empty parse list means nothing in the message can ever ping anyone.
    payload: JSON.stringify({ embeds: [embed], allowed_mentions: { parse: [] } }),
    muteHttpExceptions: true,
  };
  // Returns a short outcome that doPost records in the row's notes, since web-app logs are hard to reach.
  try {
    let res = UrlFetchApp.fetch(url.trim(), request);
    let code = res.getResponseCode();
    // 429s here are often Cloudflare blocking Google's shared IPs rather than real rate limiting; one retry is cheap.
    if (code === 429 || code >= 500) {
      Utilities.sleep(2000);
      res = UrlFetchApp.fetch(url.trim(), request);
      code = res.getResponseCode();
    }
    if (code < 300) return 'discord:' + code;
    const body = res.getContentText().replace(/\s+/g, ' ').slice(0, 150);
    console.error('Discord notify failed: ' + code + ' ' + body);
    return 'discord:' + code + ' ' + body;
  } catch (err) {
    console.error('Discord notify failed', err);
    return 'discord:exception ' + String(err).slice(0, 150);
  }
}

// "player@example.com" -> "pl****@e******.com". Discord message history is less private than the Sheet.
function maskEmail_(email) {
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

// Run from the editor to preview the alert without a real signup.
function testDiscordAlert() {
  console.log(notifyDiscord_('player@example.com', 'editor-test', { status: 'subscribed' }));
}

// One-time setup (run manually from the editor; also triggers the authorization prompt)

function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);
  if (sheet.getLastRow() === 0) sheet.appendRow(HEADERS);
  sheet.setFrozenRows(1);
  sheet.getRange('B:C').setNumberFormat('@'); // store email/source as plain text, never formulas
}

function installTriggers() {
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('syncFromProvider').timeBased().everyHours(1).create();
  ScriptApp.newTrigger('retryFailedForwards').timeBased().everyHours(6).create();
}

// Kit events delivered to the Worker's /kit-webhook. To change them on the live endpoint, edit this list and run
// updateKitWebhookEvents (never re-register: that creates a duplicate endpoint).
const KIT_WEBHOOK_EVENTS = [
  'subscriber.activated',
  'subscriber.unsubscribed',
  'subscriber.bounced',
  'subscriber.complained',
  'broadcast.sent',
];

// Registers the Kit → Worker webhook endpoint. Run once from the editor, ever.
// The response holds the signing secret (whsec_...) in plaintext exactly once: copy it from the Execution log into
// the Worker's KIT_WEBHOOK_SECRET secret. Running this twice creates a duplicate endpoint (see listKitWebhooks).
function registerKitWebhook() {
  const props = PropertiesService.getScriptProperties();
  const relayOrigin = String(props.getProperty('DISCORD_SIGNUP_WEBHOOK_URL') || '').match(/^https:\/\/[^/]+/);
  if (!relayOrigin || relayOrigin[0].indexOf('discord.com') !== -1) {
    throw new Error('DISCORD_SIGNUP_WEBHOOK_URL must already point at the relay Worker host');
  }
  const res = UrlFetchApp.fetch('https://api.kit.com/v4/webhook_endpoints', {
    method: 'post',
    contentType: 'application/json',
    headers: { 'X-Kit-Api-Key': props.getProperty('KIT_API_KEY') },
    payload: JSON.stringify({
      url: relayOrigin[0] + '/kit-webhook',
      events: KIT_WEBHOOK_EVENTS,
      name: 'Discord subscriber alerts',
    }),
    muteHttpExceptions: true,
  });
  console.log(res.getResponseCode() + ' ' + res.getContentText());
}

// Sets the existing /kit-webhook endpoint's events to KIT_WEBHOOK_EVENTS. Safe to run repeatedly; the secret is unchanged.
function updateKitWebhookEvents() {
  const apiKey = PropertiesService.getScriptProperties().getProperty('KIT_API_KEY');
  const list = UrlFetchApp.fetch('https://api.kit.com/v4/webhook_endpoints', {
    headers: { 'X-Kit-Api-Key': apiKey },
    muteHttpExceptions: true,
  });
  if (list.getResponseCode() >= 300) throw new Error('Kit list failed: ' + list.getResponseCode() + ' ' + list.getContentText());
  const endpoints = JSON.parse(list.getContentText()).webhook_endpoints
    .filter(endpoint => String(endpoint.url).endsWith('/kit-webhook'));
  if (endpoints.length !== 1) {
    throw new Error('Expected exactly one /kit-webhook endpoint, found ' + endpoints.length + '; check listKitWebhooks');
  }
  // Kit replaces the whole event list with what's sent, so always send the complete set.
  const res = UrlFetchApp.fetch('https://api.kit.com/v4/webhook_endpoints/' + endpoints[0].id, {
    method: 'patch',
    contentType: 'application/json',
    headers: { 'X-Kit-Api-Key': apiKey },
    payload: JSON.stringify({ events: KIT_WEBHOOK_EVENTS }),
    muteHttpExceptions: true,
  });
  console.log(res.getResponseCode() + ' ' + res.getContentText());
}

function listKitWebhooks() {
  const res = UrlFetchApp.fetch('https://api.kit.com/v4/webhook_endpoints', {
    headers: { 'X-Kit-Api-Key': PropertiesService.getScriptProperties().getProperty('KIT_API_KEY') },
    muteHttpExceptions: true,
  });
  console.log(res.getResponseCode() + ' ' + res.getContentText());
}

// Helpers

function getSheet_() {
  return SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
}

function findRow_(sheet, email) {
  const cell = sheet.getRange('B:B').createTextFinder(email).matchEntireCell(true).findNext();
  return cell ? cell.getRow() : 0;
}

function writeProviderResult_(sheet, row, result) {
  sheet.getRange(row, COL.provider_status).setValue(result.status);
  if (result.id) sheet.getRange(row, COL.provider_subscriber_id).setValue(result.id);
  sheet.getRange(row, COL.notes).setValue(result.detail || '');
}

function normalizeEmail_(raw) {
  const email = String(raw || '').trim().toLowerCase();
  if (email.length < 6 || email.length > 254) return '';
  if (/^[=+\-@]/.test(email)) return ''; // spreadsheet formula-injection guard
  if (!/^[a-z0-9._%+'-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(email)) return '';
  return email;
}

function sanitizeSource_(raw) {
  const s = String(raw || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40);
  return s || 'direct';
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
