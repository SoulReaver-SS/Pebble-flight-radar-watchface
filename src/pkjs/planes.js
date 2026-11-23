// Aircraft sources (Wingbits customer API, adsb.lol) normalized to one shape:
// { hex, cs, lat, lon, alt (ft or null), ground (bool), hdg (deg or null), gs (kt or null), cat (string) }
var net = require('./net');

var WINGBITS_URL = 'https://customer-api.wingbits.com/v1/flights';
var ADSBLOL_URL = 'https://api.adsb.lol/v2/lat/';
var MAX_AGE_S = 90;

function num(v) { return (typeof v === 'number' && isFinite(v)) ? v : null; }

function fromWingbits(a, now) {
  var alt = num(a.ab);
  if (alt === null) { alt = num(a.ag); }
  var age = a.ra ? (now - Date.parse(a.ra)) / 1000 : 0;
  return {
    hex: String(a.h || ''), cs: String(a.f || '').trim(),
    lat: num(a.la), lon: num(a.lo), alt: alt, ground: a.og === true,
    hdg: num(a.th), gs: num(a.gs), cat: String(a.c || ''), age: isFinite(age) ? age : 0
  };
}

function fromAdsbLol(a) {
  var ground = a.alt_baro === 'ground';
  var alt = ground ? 0 : num(a.alt_baro);
  if (alt === null) { alt = num(a.alt_geom); }
  var hdg = num(a.track);
  if (hdg === null) { hdg = num(a.true_heading); }
  if (hdg === null) { hdg = num(a.mag_heading); }
  return {
    hex: String(a.hex || ''), cs: String(a.flight || '').trim(),
    lat: num(a.lat), lon: num(a.lon), alt: alt, ground: ground,
    hdg: hdg, gs: num(a.gs), cat: String(a.category || ''), age: num(a.seen_pos) || 0
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

function fetchAdsbLol(lat, lon, radiusNm, hideGround, cb) {
  var r = Math.min(250, Math.ceil(radiusNm));
  var url = ADSBLOL_URL + lat.toFixed(4) + '/lon/' + lon.toFixed(4) + '/dist/' + r;
  net.get(url, { json: true, timeout: 15000 }, function (err, status, body) {
    if (err || status !== 200 || !body) { cb(err || new Error('adsb.lol HTTP ' + status)); return; }
    var list = (body.ac || []).map(fromAdsbLol).filter(function (p) { return usable(p, hideGround); });
    cb(null, list, 'ADSB.LOL');
  });
}

function fetchWingbits(key, lat, lon, radiusNm, hideGround, cb) {
  var r = Math.min(150, Math.ceil(radiusNm));
  var url = WINGBITS_URL + '?by=radius&la=' + lat.toFixed(4) + '&lo=' + lon.toFixed(4) + '&rad=' + r + '&unit=nm';
  net.get(url, { json: true, timeout: 15000, headers: { 'x-api-key': key } }, function (err, status, body) {
    if (err || status !== 200 || !Array.isArray(body)) {
      cb(err || new Error('Wingbits HTTP ' + status), null, null, status);
      return;
    }
    var now = Date.now();
    var list = body.map(function (a) { return fromWingbits(a, now); })
      .filter(function (p) { return usable(p, hideGround); });
    cb(null, list, 'WINGBITS');
  });
}

// Wingbits when a key is set, falling back to adsb.lol on any failure (bad key, quota, outage).
function fetchPlanes(opts, cb) {
  if (opts.wbKey) {
    fetchWingbits(opts.wbKey, opts.lat, opts.lon, opts.radiusNm, opts.hideGround, function (err, list, src, status) {
      if (!err) { cb(null, list, src, ''); return; }
      console.log('Wingbits failed (' + (status || err.message) + '), falling back to adsb.lol');
      var warn = (status === 401 || status === 403) ? 'WB KEY?' : (status === 429 ? 'WB QUOTA' : 'WB DOWN');
      fetchAdsbLol(opts.lat, opts.lon, opts.radiusNm, opts.hideGround, function (e2, l2, s2) {
        cb(e2, l2, s2, warn);
      });
    });
  } else {
    fetchAdsbLol(opts.lat, opts.lon, opts.radiusNm, opts.hideGround, function (e, l, s) { cb(e, l, s, ''); });
  }
}

// ADS-B emitter category -> small code for the watch.
var CAT = { A1: 1, A2: 2, A3: 3, A4: 4, A5: 5, A6: 6, A7: 7, B1: 9, B2: 10, B3: 11, B4: 12, B6: 14, B7: 15 };

// Pack up to `max` planes nearest the user. 20 bytes each:
// x i16, y i16 (4 m units from map anchor), alt i16 (25 ft units, -32768 = unknown),
// hdg u8 (256 = full circle), flags u8 (bit0 heading valid, bit1 on ground), cat u8, pad u8,
// gs u16 (kt), callsign 8 bytes ASCII.
var PLANE_BYTES = 20;
function packPlanes(list, proj, userXY, max, unitM, clamp16) {
  var withPos = list.map(function (p) {
    var xy = proj.toLocal(p.lat, p.lon);
    var dx = xy[0] - userXY[0], dy = xy[1] - userXY[1];
    return { p: p, x: xy[0], y: xy[1], d: dx * dx + dy * dy };
  }).sort(function (a, b) {
    // Airborne first, then by distance, so the "nearest" readout is a plane in the air.
    if (a.p.ground !== b.p.ground) { return a.p.ground ? 1 : -1; }
    return a.d - b.d;
  }).slice(0, max);

  var buf = new Uint8Array(withPos.length * PLANE_BYTES), dv = new DataView(buf.buffer);
  for (var i = 0; i < withPos.length; i++) {
    var e = withPos[i], p = e.p, o = i * PLANE_BYTES;
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
    var cs = (p.cs || p.hex.toUpperCase()).toUpperCase().substr(0, 8);
    for (var k = 0; k < 8; k++) { buf[o + 12 + k] = k < cs.length ? (cs.charCodeAt(k) & 0x7f) : 0; }
  }
  return { bytes: buf, count: withPos.length };
}

module.exports = { fetchPlanes: fetchPlanes, packPlanes: packPlanes, PLANE_BYTES: PLANE_BYTES };
