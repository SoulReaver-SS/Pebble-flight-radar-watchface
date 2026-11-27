// Wingbits quota pacing. Every Wingbits response carries x-usage-remaining / x-usage-limit and
// x-ratelimit-remaining / x-ratelimit-reset headers, and the free /v1/account/usage call adds the
// date the monthly counter resets. With those we:
//   - skip Wingbits for the rest of the minute when the per-minute limit is used up (429),
//   - skip it until the reset date when the monthly quota is gone (402),
//   - spread the monthly quota evenly: a refresh that would run ahead of an even pace goes to adsb.lol.
// Skipped refreshes still update from adsb.lol, so the face never stalls.
var net = require('./net');

var USAGE_URL = 'https://customer-api.wingbits.com/v1/account/usage';
var KEY = 'fr-wb';
var DAY = 86400000;
var PERIOD = 30 * DAY;      // monthly counter; only the time left until periodResetAt matters
var SLACK = 0.01;           // may run up to 1% of the monthly limit ahead of an even pace
var USAGE_EVERY = 6 * 3600000;

function load(key) {
  var s = {};
  try { s = JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { s = {}; }
  var tag = key ? key.slice(-6) : '';
  if (s.k !== tag) { s = { k: tag }; }  // different key, start over
  return s;
}
function save(s) { localStorage.setItem(KEY, JSON.stringify(s)); }
function numOr(v, d) { var n = parseInt(v, 10); return isNaN(n) ? d : n; }
function when(v) { var t = Date.parse(v); return isNaN(t) ? 0 : t; }

// Does the state need a fresh /v1/account/usage reading?
function needsUsage(key, now) {
  var s = load(key);
  return !s.resetAt || now >= s.resetAt || !s.checkedAt || now - s.checkedAt > USAGE_EVERY;
}

// Free call (does not count against the monthly quota). cb(state or null)
function usage(key, cb, timeout) {
  net.get(USAGE_URL, { json: true, timeout: timeout || 8000, headers: { 'x-api-key': key } }, function (err, status, body) {
    var s = load(key), now = Date.now();
    if (err || status !== 200 || !body) { cb(null); return; }
    s.plan = String(body.plan || '');
    s.limit = numOr(body.monthlyLimit, s.limit);
    s.remaining = numOr(body.monthlyRemaining, s.remaining);
    s.resetAt = when(body.periodResetAt) || s.resetAt;
    s.checkedAt = now;
    if (s.remaining > 0 && s.quotaUntil) { s.quotaUntil = 0; }
    save(s);
    cb(s);
  });
}

// '' = go ahead with Wingbits; otherwise why not: 'quota', 'rate' or 'pace'.
function gate(key, now) {
  var s = load(key);
  if (s.quotaUntil && now < s.quotaUntil) { return 'quota'; }
  if (s.rateUntil && now < s.rateUntil) { return 'rate'; }
  if (s.limit > 0 && typeof s.remaining === 'number' && s.resetAt > now) {
    var keep = s.limit * Math.min(1, (s.resetAt - now) / PERIOD) - s.limit * SLACK;
    if (s.remaining - 1 < keep) { return 'pace'; }
  }
  return '';
}

// After a Wingbits flights call. hdr(name) reads a response header (may return null).
function record(key, status, hdr, now) {
  var s = load(key);
  var rem = hdr && hdr('x-usage-remaining'), lim = hdr && hdr('x-usage-limit');
  var rlRem = hdr && hdr('x-ratelimit-remaining'), rlReset = hdr && hdr('x-ratelimit-reset');
  if (rem !== null && rem !== undefined && rem !== '') {
    s.remaining = numOr(rem, s.remaining);
    s.limit = numOr(lim, s.limit);
  } else if (status === 200 && typeof s.remaining === 'number') {
    s.remaining -= 1;  // no headers: count locally until the next usage reading
  }
  if (status === 429 || (rlRem !== null && rlRem !== undefined && numOr(rlRem, 1) <= 0)) {
    s.rateUntil = when(rlReset) || now + 60000;
  }
  if (status === 402) {
    s.remaining = 0;
    s.quotaUntil = s.resetAt > now ? s.resetAt : now + 3600000;
  } else if (status === 200) {
    s.quotaUntil = 0;
  }
  save(s);
}

function fmt(n) { return String(Math.max(0, n)).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// One line for the settings page, or '' when nothing is known yet.
function summary(key) {
  var s = load(key);
  if (!(s.limit > 0) || typeof s.remaining !== 'number') { return ''; }
  var d = s.resetAt ? new Date(s.resetAt) : null;
  return (s.plan ? s.plan + ' plan: ' : '') + fmt(s.remaining) + ' of ' + fmt(s.limit) + ' requests left' +
    (d ? ', resets ' + MONTHS[d.getMonth()] + ' ' + d.getDate() : '') + '.';
}

module.exports = { needsUsage: needsUsage, usage: usage, gate: gate, record: record, summary: summary };
