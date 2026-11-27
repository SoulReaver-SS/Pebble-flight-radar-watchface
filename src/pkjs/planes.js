// Aircraft sources normalized to one shape:
// { hex, cs, reg, type, lat, lon, alt (ft or null), ground, hdg, gs, cat, squawk, emergency, mil, age }
// Order: your own receiver (home network) -> Wingbits (with key) -> adsb.lol -> adsb.fi.
var net = require('./net');
var wbpace = require('./wbpace');

var WINGBITS_URL = 'https://customer-api.wingbits.com/v1/flights';
var ADSBLOL_URL = 'https://api.adsb.lol/v2/lat/';
var ADSBFI_URL = 'https://opendata.adsb.fi/api/v2/lat/';
var MAX_AGE_S = 90;

function num(v) { return (typeof v === 'number' && isFinite(v)) ? v : null; }
function str(v) { return v === undefined || v === null ? '' : String(v).trim(); }

function fromWingbits(a, now) {
  var alt = num(a.ab);
  if (alt === null) { alt = num(a.ag); }
  var age = a.ra ? (now - Date.parse(a.ra)) / 1000 : 0;
  return {
    hex: str(a.h), cs: str(a.f), reg: '', type: '',
    lat: num(a.la), lon: num(a.lo), alt: alt, ground: a.og === true,
    hdg: num(a.th), gs: num(a.gs), cat: str(a.c), squawk: str(a.sq), emergency: '',
    mil: false, age: isFinite(age) ? age : 0
  };
}

// readsb JSON, as served by adsb.lol, adsb.fi and a home receiver (tar1090 / readsb aircraft.json).
function fromReadsb(a) {
  var ground = a.alt_baro === 'ground';
  var alt = ground ? 0 : num(a.alt_baro);
  if (alt === null) { alt = num(a.alt_geom); }
  var hdg = num(a.track);
  if (hdg === null) { hdg = num(a.true_heading); }
  if (hdg === null) { hdg = num(a.mag_heading); }
  var emergency = str(a.emergency);
  return {
    hex: str(a.hex), cs: str(a.flight), reg: str(a.r), type: str(a.t),
    lat: num(a.lat), lon: num(a.lon), alt: alt, ground: ground,
    hdg: hdg, gs: num(a.gs), cat: str(a.category), squawk: str(a.squawk),
    emergency: emergency === 'none' ? '' : emergency,
    mil: !!((a.dbFlags || 0) & 1), age: num(a.seen_pos) || num(a.seen) || 0
  };
}

function usable(p, hideGround) {
  if (p.lat === null || p.lon === null) { return false; }
  // Targets without an ICAO address are flagged with "~" (mostly airport ground vehicles).
  if (!p.hex || p.hex.charAt(0) === '~') { return false; }
  if (p.cat === 'C1' || p.cat === 'C2' || p.cat === 'C3') { return false; } // surface vehicles, obstacles
  if (hideGround && p.ground) { return false; }
  if (p.age > MAX_AGE_S) { return false; }
  return true;
}

function readsbList(body) { return (body && (body.ac || body.aircraft)) || null; }

function fetchReadsbArea(base, name, lat, lon, radiusNm, hideGround, cb) {
  var r = Math.min(250, Math.ceil(radiusNm));
  var url = base + lat.toFixed(4) + '/lon/' + lon.toFixed(4) + '/dist/' + r;
  net.get(url, { json: true, timeout: 15000 }, function (err, status, body) {
    var list = readsbList(body);
    if (err || status !== 200 || !list) { cb(err || new Error(name + ' HTTP ' + status)); return; }
    cb(null, list.map(fromReadsb).filter(function (p) { return usable(p, hideGround); }), name);
  });
}

function fetchWingbits(key, lat, lon, radiusNm, hideGround, cb) {
  var r = Math.min(150, Math.ceil(radiusNm));
  var url = WINGBITS_URL + '?by=radius&la=' + lat.toFixed(4) + '&lo=' + lon.toFixed(4) + '&rad=' + r + '&unit=nm';
  net.get(url, { json: true, timeout: 15000, headers: { 'x-api-key': key } }, function (err, status, body, header) {
    wbpace.record(key, status, header, Date.now());
    if (err || status !== 200 || !Array.isArray(body)) {
      cb(err || new Error('Wingbits HTTP ' + status), null, null, status);
      return;
    }
    var now = Date.now();
    cb(null, body.map(function (a) { return fromWingbits(a, now); })
      .filter(function (p) { return usable(p, hideGround); }), 'WINGBITS');
  });
}

// Your own readsb/tar1090 receiver on the home network (aircraft.json). Only reachable on that network.
function fetchReceiver(url, hideGround, cb) {
  net.get(url, { json: true, timeout: 6000 }, function (err, status, body) {
    var list = readsbList(body);
    if (err || status !== 200 || !list) { cb(err || new Error('receiver HTTP ' + status)); return; }
    cb(null, list.map(fromReadsb).filter(function (p) { return usable(p, hideGround); }), 'RECEIVER');
  });
}

// Public sources: Wingbits when a key is set, then adsb.lol, then adsb.fi.
function fetchPublic(opts, cb) {
  function lol(warn) {
    fetchReadsbArea(ADSBLOL_URL, 'ADSB.LOL', opts.lat, opts.lon, opts.radiusNm, opts.hideGround, function (err, list, src) {
      if (!err) { cb(null, list, src, warn); return; }
      console.log('adsb.lol failed (' + err.message + '), trying adsb.fi');
      fetchReadsbArea(ADSBFI_URL, 'ADSB.FI', opts.lat, opts.lon, opts.radiusNm, opts.hideGround, function (e2, l2, s2) {
        cb(e2, l2, s2, warn);
      });
    });
  }
  if (!opts.wbKey) { lol(''); return; }
  function wingbits() {
    var why = wbpace.gate(opts.wbKey, Date.now());
    if (why) {
      // Over the per-minute limit or ahead of an even monthly pace: use adsb.lol quietly this time.
      console.log('Wingbits skipped (' + why + ')');
      lol(why === 'quota' ? 'WB QUOTA' : '');
      return;
    }
    fetchWingbits(opts.wbKey, opts.lat, opts.lon, opts.radiusNm, opts.hideGround, function (err, list, src, status) {
      if (!err) { cb(null, list, src, ''); return; }
      console.log('Wingbits failed (' + (status || err.message) + '), falling back');
      // 402 = monthly quota used up, 429 = per-minute limit (not a problem, just wait a moment).
      lol((status === 401 || status === 403) ? 'WB KEY?' : (status === 402 ? 'WB QUOTA' : (status === 429 ? '' : 'WB DOWN')));
    });
  }
  if (wbpace.needsUsage(opts.wbKey, Date.now())) { wbpace.usage(opts.wbKey, wingbits); } else { wingbits(); }
}

function fetchPlanes(opts, cb) {
  if (!opts.receiver) { fetchPublic(opts, cb); return; }
  fetchReceiver(opts.receiver, opts.hideGround, function (err, list, src) {
    if (!err) { cb(null, list, src, ''); return; }
    // Away from home the receiver isn't reachable: fall back quietly to the public sources.
    fetchPublic(opts, cb);
  });
}

// ADS-B emitter category -> small code for the watch.
var CAT = { A1: 1, A2: 2, A3: 3, A4: 4, A5: 5, A6: 6, A7: 7, B1: 9, B2: 10, B3: 11, B4: 12, B6: 14, B7: 15 };

// Sort by distance from the user (airborne first). Adds x, y, d (meters) to each entry.
function arrange(list, proj, userXY, max, maxDistM) {
  return list.map(function (p) {
    var xy = proj.toLocal(p.lat, p.lon);
    var dx = xy[0] - userXY[0], dy = xy[1] - userXY[1];
    return { p: p, x: xy[0], y: xy[1], d: Math.sqrt(dx * dx + dy * dy) };
  }).filter(function (e) { return !maxDistM || e.d <= maxDistM; })
    .sort(function (a, b) {
      if (a.p.ground !== b.p.ground) { return a.p.ground ? 1 : -1; }
      return a.d - b.d;
    }).slice(0, max);
}

// Pack arranged planes, 24 bytes each:
// x i16, y i16 (map units from map anchor), alt i16 (25 ft units, -32768 = unknown),
// hdg u8 (256 = full circle), flags u8 (bit0 heading valid, bit1 on ground), cat u8, pad u8,
// gs u16 (kt), callsign 8 bytes ASCII, ICAO type 4 bytes ASCII.
var PLANE_BYTES = 24;
function packPlanes(arranged, unitM, clamp16) {
  var buf = new Uint8Array(arranged.length * PLANE_BYTES), dv = new DataView(buf.buffer);
  for (var i = 0; i < arranged.length; i++) {
    var e = arranged[i], p = e.p, o = i * PLANE_BYTES;
    dv.setInt16(o, clamp16(Math.round(e.x / unitM)), true);
    dv.setInt16(o + 2, clamp16(Math.round(e.y / unitM)), true);
    dv.setInt16(o + 4, p.alt === null ? -32768 : clamp16(Math.round(p.alt / 25)), true);
    var flags = 0, hdg = 0;
    if (p.hdg !== null) { flags |= 1; hdg = Math.round(((p.hdg % 360) + 360) % 360 * 256 / 360) & 255; }
    if (p.ground) { flags |= 2; }
    buf[o + 6] = hdg;
    buf[o + 7] = flags;
    buf[o + 8] = CAT[p.cat] || 0;
    dv.setUint16(o + 10, p.gs === null ? 0 : Math.max(0, Math.min(65535, Math.round(p.gs))), true);
    writeAscii(buf, o + 12, 8, (p.cs || p.hex).toUpperCase());
    writeAscii(buf, o + 20, 4, (p.type || '').toUpperCase());
  }
  return { bytes: buf, count: arranged.length };
}

function writeAscii(buf, at, len, s) {
  for (var k = 0; k < len; k++) { buf[at + k] = k < s.length ? (s.charCodeAt(k) & 0x7f) : 0; }
}

module.exports = { fetchPlanes: fetchPlanes, arrange: arrange, packPlanes: packPlanes, PLANE_BYTES: PLANE_BYTES };
