// Geometry helpers: local projection, tile math, clipping, simplification and map packing.

var M_PER_DEG_LAT = 110574;
var M_PER_DEG_LON = 111320;
var UNIT_M = 4; // base unit: map and plane coordinates are sent as int16 multiples of a unit

// Smallest power-of-two unit (from 4 m) that keeps everything we send inside int16 at this scale:
// the map box plus aircraft fetched out to ~1.75x the range (about 135 px).
function unitFor(mpp) {
  var unit = UNIT_M;
  while ((135 * mpp + 3000) / unit > 30000) { unit *= 2; }
  return unit;
}

// Local equirectangular projection around an anchor (lat0, lon0) in meters, y pointing north.
function makeProjection(lat0, lon0) {
  var kx = M_PER_DEG_LON * Math.cos(lat0 * Math.PI / 180);
  return {
    lat0: lat0, lon0: lon0,
    toLocal: function (lat, lon) { return [(lon - lon0) * kx, (lat - lat0) * M_PER_DEG_LAT]; },
    toLatLon: function (x, y) { return [lat0 + y / M_PER_DEG_LAT, lon0 + x / kx]; }
  };
}

function lonToTileX(lon, z) { return (lon + 180) / 360 * Math.pow(2, z); }
function latToTileY(lat, z) {
  var r = lat * Math.PI / 180;
  return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * Math.pow(2, z);
}
function tilePixelToLatLon(z, tx, ty, px, py, extent) {
  var n = Math.pow(2, z);
  var wx = (tx + px / extent) / n, wy = (ty + py / extent) / n;
  var lon = wx * 360 - 180;
  var lat = Math.atan(sinh(Math.PI * (1 - 2 * wy))) * 180 / Math.PI;
  return [lat, lon];
}
function sinh(x) { return (Math.exp(x) - Math.exp(-x)) / 2; }

// Tiles at zoom z covering a lat/lon box.
function tilesForBox(z, south, west, north, east) {
  var x0 = Math.floor(lonToTileX(west, z)), x1 = Math.floor(lonToTileX(east, z));
  var y0 = Math.floor(latToTileY(north, z)), y1 = Math.floor(latToTileY(south, z));
  var out = [];
  for (var x = x0; x <= x1; x++) { for (var y = y0; y <= y1; y++) { out.push([z, x, y]); } }
  return out;
}

// --- Clipping against an axis-aligned box {x0, y0, x1, y1} ---

function clipPolygon(ring, b) {
  var edges = [
    function (p) { return p[0] >= b.x0; }, function (p) { return p[0] <= b.x1; },
    function (p) { return p[1] >= b.y0; }, function (p) { return p[1] <= b.y1; }
  ];
  var cuts = [
    function (a, c) { return lerpX(a, c, b.x0); }, function (a, c) { return lerpX(a, c, b.x1); },
    function (a, c) { return lerpY(a, c, b.y0); }, function (a, c) { return lerpY(a, c, b.y1); }
  ];
  var out = ring;
  for (var e = 0; e < 4 && out.length; e++) {
    var input = out; out = [];
    for (var i = 0; i < input.length; i++) {
      var cur = input[i], prev = input[(i + input.length - 1) % input.length];
      var cin = edges[e](cur), pin = edges[e](prev);
      if (cin) {
        if (!pin) { out.push(cuts[e](prev, cur)); }
        out.push(cur);
      } else if (pin) {
        out.push(cuts[e](prev, cur));
      }
    }
  }
  return out;
}
function lerpX(a, c, x) { var t = (x - a[0]) / (c[0] - a[0]); return [x, a[1] + t * (c[1] - a[1])]; }
function lerpY(a, c, y) { var t = (y - a[1]) / (c[1] - a[1]); return [a[0] + t * (c[0] - a[0]), y]; }

// Liang-Barsky segment clip. Returns [p, q] or null.
function clipSegment(p, q, b) {
  var t0 = 0, t1 = 1, dx = q[0] - p[0], dy = q[1] - p[1];
  var P = [-dx, dx, -dy, dy], Q = [p[0] - b.x0, b.x1 - p[0], p[1] - b.y0, b.y1 - p[1]];
  for (var i = 0; i < 4; i++) {
    if (P[i] === 0) { if (Q[i] < 0) { return null; } }
    else {
      var r = Q[i] / P[i];
      if (P[i] < 0) { if (r > t1) { return null; } if (r > t0) { t0 = r; } }
      else { if (r < t0) { return null; } if (r < t1) { t1 = r; } }
    }
  }
  return [[p[0] + t0 * dx, p[1] + t0 * dy], [p[0] + t1 * dx, p[1] + t1 * dy]];
}

// Split a polyline into the pieces that fall inside the box.
function clipLine(line, b) {
  var out = [], cur = null;
  for (var i = 1; i < line.length; i++) {
    var s = clipSegment(line[i - 1], line[i], b);
    if (!s) { cur = null; continue; }
    if (cur && samePt(cur[cur.length - 1], s[0])) { cur.push(s[1]); }
    else { cur = [s[0], s[1]]; out.push(cur); }
    if (!samePt(s[1], line[i])) { cur = null; }
  }
  return out;
}
function samePt(a, c) { return Math.abs(a[0] - c[0]) < 1e-6 && Math.abs(a[1] - c[1]) < 1e-6; }

// --- Douglas-Peucker simplification (iterative) ---
function simplify(pts, tol) {
  if (pts.length < 3) { return pts.slice(); }
  var keep = new Uint8Array(pts.length), stack = [[0, pts.length - 1]], t2 = tol * tol;
  keep[0] = 1; keep[pts.length - 1] = 1;
  while (stack.length) {
    var seg = stack.pop(), a = seg[0], c = seg[1], best = -1, bestD = t2;
    for (var i = a + 1; i < c; i++) {
      var d = segDist2(pts[i], pts[a], pts[c]);
      if (d > bestD) { bestD = d; best = i; }
    }
    if (best >= 0) { keep[best] = 1; stack.push([a, best]); stack.push([best, c]); }
  }
  var out = [];
  for (var k = 0; k < pts.length; k++) { if (keep[k]) { out.push(pts[k]); } }
  return out;
}
function segDist2(p, a, c) {
  var dx = c[0] - a[0], dy = c[1] - a[1], l2 = dx * dx + dy * dy, t = 0;
  if (l2 > 0) { t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)); }
  var ex = a[0] + t * dx - p[0], ey = a[1] + t * dy - p[1];
  return ex * ex + ey * ey;
}

function ringArea(r) {
  var s = 0;
  for (var i = 0, n = r.length; i < n; i++) {
    var a = r[i], c = r[(i + 1) % n];
    s += a[0] * c[1] - c[0] * a[1];
  }
  return s / 2;
}

// --- Packing ---
// Record: [type u8][count u16 LE][count x (x i16 LE, y i16 LE)] in 4 m units.
var REC = { WATER: 1, HOLE: 2, HIGHWAY: 3, MAJOR: 4, RUNWAY: 5, MINOR: 6, TAXIWAY: 7 };

function packRecords(records, unit) {
  var size = 0, i, j;
  for (i = 0; i < records.length; i++) { size += 3 + records[i].pts.length * 4; }
  var buf = new Uint8Array(size), dv = new DataView(buf.buffer), o = 0;
  for (i = 0; i < records.length; i++) {
    var r = records[i];
    buf[o] = r.type; dv.setUint16(o + 1, r.pts.length, true); o += 3;
    for (j = 0; j < r.pts.length; j++) {
      dv.setInt16(o, clamp16(Math.round(r.pts[j][0] / unit)), true);
      dv.setInt16(o + 2, clamp16(Math.round(r.pts[j][1] / unit)), true);
      o += 4;
    }
  }
  return buf;
}
function clamp16(v) { return v > 32767 ? 32767 : (v < -32768 ? -32768 : v); }

module.exports = {
  UNIT_M: UNIT_M, unitFor: unitFor, REC: REC,
  makeProjection: makeProjection, tilesForBox: tilesForBox, tilePixelToLatLon: tilePixelToLatLon,
  clipPolygon: clipPolygon, clipLine: clipLine, simplify: simplify, ringArea: ringArea,
  packRecords: packRecords, clamp16: clamp16
};
