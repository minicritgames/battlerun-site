// Battlerun newsletter signup backend.
// Source of record for the Apps Script project bound to the "Battlerun Subscribers" Sheet.
// Paste this into the Apps Script editor's Code.gs, then redeploy as a NEW VERSION of the existing deployment.
//
// Secrets/config live in Project Settings → Script Properties (never in this file):
//   KIT_API_KEY, KIT_FORM_ID, DOUBLE_OPT_IN ("true" | "false"), SITE_ORIGIN (e.g. "https://minicritgames.github.io/battlerun-site")

const SHEET_NAME = 'Subscribers';
// Must match the consent line on the site (index.html) word for word. Bump CONSENT_VERSION whenever the text changes.
const CONSENT_TEXT = 'Get Battlerun news and playtest invites by email. Unsubscribe anytime. You must be 13 or older.';
const CONSENT_VERSION = 'v1-2026-10';
const DEDUPE_SECONDS = 600;
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
  return json_({ ok: true, service: 'battlerun-signup' });
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
      sheet.appendRow([
        new Date(), email, source, CONSENT_TEXT, CONSENT_VERSION,
        'kit', 'pending', '', 'active', '', '',
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

// Pulls every subscriber's state from Kit and mirrors it into the Sheet.
// Keeps the Sheet's suppression list (unsubscribed/bounced/complained) correct for any future migration.
function syncFromProvider() {
  const apiKey = PropertiesService.getScriptProperties().getProperty('KIT_API_KEY');
  const states = {};
  let after = '';
  for (let page = 0; page < 100; page++) { // hard cap; 100 pages × 1000 = 100k subscribers
    let url = 'https://api.kit.com/v4/subscribers?status=all&per_page=1000&slim=true';
    if (after) url += '&after=' + encodeURIComponent(after);
    const res = UrlFetchApp.fetch(url, { headers: { 'X-Kit-Api-Key': apiKey }, muteHttpExceptions: true });
    if (res.getResponseCode() >= 300) throw new Error('Kit list failed: ' + res.getResponseCode());
    const body = JSON.parse(res.getContentText());
    body.subscribers.forEach(s => { states[String(s.email_address).toLowerCase()] = s.state; });
    if (!body.pagination || !body.pagination.has_next_page) break;
    after = body.pagination.end_cursor;
    Utilities.sleep(600); // stays well under Kit's 120 req/60s API-key limit
  }

  const sheet = getSheet_();
  const last = sheet.getLastRow();
  if (last < 2) return;
  const range = sheet.getRange(2, 1, last - 1, HEADERS.length);
  const values = range.getValues();
  const now = new Date();
  values.forEach(r => {
    const state = states[String(r[COL.email - 1]).toLowerCase()];
    if (!state) return;
    r[COL.provider_status - 1] = state;
    r[COL.last_synced - 1] = now;
    if (state === 'cancelled') r[COL.status - 1] = 'unsubscribed';
    else if (state === 'bounced' || state === 'complained') r[COL.status - 1] = state;
    else if (state === 'active') r[COL.status - 1] = 'active';
    // 'inactive' = has not confirmed double opt-in yet; leave status alone
  });
  range.setValues(values);
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
  ScriptApp.newTrigger('syncFromProvider').timeBased().everyDays(1).atHour(3).create();
  ScriptApp.newTrigger('retryFailedForwards').timeBased().everyHours(6).create();
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
