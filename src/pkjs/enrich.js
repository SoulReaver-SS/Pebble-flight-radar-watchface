// Route (origin-destination) and aircraft type for the highlighted plane, from adsbdb.com.
// Cached on the phone so each callsign/hex is looked up at most once a day.
var net = require('./net');

var ADSBDB = 'https://api.adsbdb.com/v0/';
var DAY = 86400000;
var mem = {};

function cached(key) {
  if (mem[key] && Date.now() - mem[key].t < DAY) { return mem[key]; }
  try {
    var c = JSON.parse(localStorage.getItem('fr-db-' + key));
    if (c && Date.now() - c.t < DAY) { mem[key] = c; return c; }
  } catch (e) { }
  return null;
}
function remember(key, v) {
  v.t = Date.now();
  mem[key] = v;
  try { localStorage.setItem('fr-db-' + key, JSON.stringify(v)); } catch (e) { }
}

function code(ap) { return ap ? (ap.iata_code || ap.icao_code || '') : ''; }
function pos(ap) { return (ap && isFinite(ap.latitude) && isFinite(ap.longitude)) ? [ap.latitude, ap.longitude] : null; }

function km(a, b) {
  var r = Math.PI / 180, dLat = (b[0] - a[0]) * r, dLon = (b[1] - a[1]) * r;
  var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 12742 * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Callsign routes in public databases go stale when airlines reuse flight numbers, so only show a
// route if the plane is roughly on the way from origin to destination (inside a loose ellipse).
function plausible(hit, at) {
  if (!hit.o || !hit.d || !at) { return true; }
  return km(hit.o, at) + km(at, hit.d) <= km(hit.o, hit.d) * 1.25 + 150;
}

// cb(route string like "SJC-LAS" or ''). at = [lat, lon] of the plane now.
function route(callsign, at, cb) {
  callsign = String(callsign || '').trim().toUpperCase();
  if (!/^[A-Z]{3}[0-9][0-9A-Z]{0,4}$/.test(callsign)) { cb(''); return; } // airline flights only
  function answer(hit) { cb(hit.v && plausible(hit, at) ? hit.v : ''); }
  var hit = cached('rt-' + callsign);
  if (hit) { answer(hit); return; }
  net.get(ADSBDB + 'callsign/' + callsign, { json: true, timeout: 8000 }, function (err, status, body) {
    var fr = body && body.response && body.response.flightroute;
    var v = fr ? (code(fr.origin) + '-' + code(fr.destination)) : '';
    if (v === '-') { v = ''; }
    var rec = { v: v, o: fr && pos(fr.origin), d: fr && pos(fr.destination) };
    if (!err && (status === 200 || status === 404)) { remember('rt-' + callsign, rec); }
    answer(rec);
  });
}

// cb(ICAO type like "B738" or '')
function aircraftType(hex, cb) {
  hex = String(hex || '').trim().toUpperCase();
  if (!/^[0-9A-F]{6}$/.test(hex)) { cb(''); return; }
  var hit = cached('hex-' + hex);
  if (hit) { cb(hit.v); return; }
  net.get(ADSBDB + 'aircraft/' + hex, { json: true, timeout: 8000 }, function (err, status, body) {
    var ac = body && body.response && body.response.aircraft;
    var v = ac ? String(ac.icao_type || ac.type || '').toUpperCase().substr(0, 4) : '';
    if (!err && (status === 200 || status === 404)) { remember('hex-' + hex, { v: v }); }
    cb(v);
  });
}

// Fill in type (if the source didn't send one) and route for one plane. cb({ type, route })
function lookup(p, cb) {
  var out = { type: p.type || '', route: '' }, pending = 2;
  function step() { if (--pending === 0) { cb(out); } }
  var at = (isFinite(p.lat) && isFinite(p.lon)) ? [p.lat, p.lon] : null;
  route(p.cs, at, function (r) { out.route = r; step(); });
  if (out.type) { step(); } else { aircraftType(p.hex, function (t) { out.type = t; step(); }); }
}

module.exports = { lookup: lookup };
