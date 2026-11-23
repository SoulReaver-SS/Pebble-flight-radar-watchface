// Trails built from our own refreshes: recent positions per aircraft, kept on the phone.
var KEEP_MS = 12 * 60000;
var MAX_POINTS = 12;
var history = {}; // hex -> [{ t, lat, lon }]

function record(list) {
  var now = Date.now();
  list.forEach(function (p) {
    var h = history[p.hex] || (history[p.hex] = []);
    var last = h[h.length - 1];
    if (!last || last.lat !== p.lat || last.lon !== p.lon) { h.push({ t: now, lat: p.lat, lon: p.lon }); }
    while (h.length > MAX_POINTS || (h.length && now - h[0].t > KEEP_MS)) { h.shift(); }
  });
  for (var hex in history) {
    if (history.hasOwnProperty(hex)) {
      var pts = history[hex];
      if (!pts.length || now - pts[pts.length - 1].t > KEEP_MS) { delete history[hex]; }
    }
  }
}

// Bytes: [plane index u8][count u8][count x (x i16, y i16)] per trail, oldest point first,
// excluding the plane's current position (the watch connects the trail to the live icon).
// mode: 'sel' = nearest plane only, 'all' = every plane (shorter trails), 'off'.
function pack(arranged, mode, proj, unit, clamp16, maxBytes) {
  if (mode === 'off' || !arranged.length) { return null; }
  var out = [], size = 0, perPlane = mode === 'all' ? 5 : MAX_POINTS;
  var n = mode === 'all' ? arranged.length : 1;
  for (var i = 0; i < n; i++) {
    var h = history[arranged[i].p.hex];
    if (!h || h.length < 2) { continue; }
    var pts = h.slice(0, h.length - 1).slice(-perPlane);
    var need = 2 + pts.length * 4;
    if (size + need > maxBytes) { break; }
    out.push({ i: i, pts: pts });
    size += need;
  }
  if (!out.length) { return null; }
  var buf = new Uint8Array(size), dv = new DataView(buf.buffer), o = 0;
  out.forEach(function (t) {
    buf[o] = t.i; buf[o + 1] = t.pts.length; o += 2;
    t.pts.forEach(function (q) {
      var xy = proj.toLocal(q.lat, q.lon);
      dv.setInt16(o, clamp16(Math.round(xy[0] / unit)), true);
      dv.setInt16(o + 2, clamp16(Math.round(xy[1] / unit)), true);
      o += 4;
    });
  });
  return buf;
}

module.exports = { record: record, pack: pack };
