// Minimal Mapbox Vector Tile (MVT v2) decoder.
// Only what Overhead needs: layer names, feature type, "kind" style tags and geometry.

function Reader(buf) {
  this.b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  this.p = 0;
}

Reader.prototype.varint = function () {
  var b = this.b, val = 0, shift = 0, byte;
  do {
    byte = b[this.p++];
    // Avoid bitwise overflow past 2^31 by using multiplication.
    val += (byte & 0x7f) * Math.pow(2, shift);
    shift += 7;
  } while (byte & 0x80);
  return val;
};

Reader.prototype.skip = function (wire) {
  if (wire === 0) { this.varint(); }
  else if (wire === 1) { this.p += 8; }
  else if (wire === 2) { var len = this.varint(); this.p += len; }
  else if (wire === 5) { this.p += 4; }
  else { throw new Error('mvt: bad wire type ' + wire); }
};

Reader.prototype.bytes = function () {
  var len = this.varint();
  var out = this.b.subarray(this.p, this.p + len);
  this.p += len;
  return out;
};

Reader.prototype.string = function () {
  var u = this.bytes(), s = '';
  for (var i = 0; i < u.length; i++) { s += String.fromCharCode(u[i]); }
  try { return decodeURIComponent(escape(s)); } catch (e) { return s; }
};

Reader.prototype.packed = function () {
  var len = this.varint(), end = this.p + len, out = [];
  while (this.p < end) { out.push(this.varint()); }
  return out;
};

function zigzag(n) { return (n % 2) ? -(n + 1) / 2 : n / 2; }

function readValue(bytes) {
  var r = new Reader(bytes), v = null;
  while (r.p < r.b.length) {
    var tag = r.varint(), field = tag >> 3, wire = tag & 7;
    if (field === 1) { v = r.string(); }
    else if (field === 4 || field === 5) { v = r.varint(); }
    else if (field === 6) { v = zigzag(r.varint()); }
    else if (field === 7) { v = !!r.varint(); }
    else { r.skip(wire); }
  }
  return v;
}

// Decode geometry commands into rings/lines of [x, y] tile coordinates.
function decodeGeometry(cmds) {
  var parts = [], cur = null, x = 0, y = 0, i = 0;
  while (i < cmds.length) {
    var c = cmds[i++], id = c & 7, count = c >> 3;
    if (id === 1 || id === 2) {
      for (var k = 0; k < count; k++) {
        x += zigzag(cmds[i++]);
        y += zigzag(cmds[i++]);
        if (id === 1) { cur = [[x, y]]; parts.push(cur); }
        else if (cur) { cur.push([x, y]); }
      }
    } else if (id === 7) {
      if (cur && cur.length) { cur.push([cur[0][0], cur[0][1]]); }
    }
  }
  return parts;
}

function readLayer(bytes, wanted) {
  var r = new Reader(bytes), name = null, keys = [], vals = [], feats = [], extent = 4096;
  while (r.p < r.b.length) {
    var tag = r.varint(), field = tag >> 3, wire = tag & 7;
    if (field === 1) { name = r.string(); if (!wanted[name]) { return null; } }
    else if (field === 2) { feats.push(r.bytes()); }
    else if (field === 3) { keys.push(r.string()); }
    else if (field === 4) { vals.push(readValue(r.bytes())); }
    else if (field === 5) { extent = r.varint(); }
    else { r.skip(wire); }
  }
  if (!name || !wanted[name]) { return null; }
  var out = [];
  for (var f = 0; f < feats.length; f++) {
    var fr = new Reader(feats[f]), tags = [], type = 0, geom = [];
    while (fr.p < fr.b.length) {
      var t = fr.varint(), fd = t >> 3, w = t & 7;
      if (fd === 2) { tags = fr.packed(); }
      else if (fd === 3) { type = fr.varint(); }
      else if (fd === 4) { geom = fr.packed(); }
      else { fr.skip(w); }
    }
    var props = {};
    for (var j = 0; j + 1 < tags.length; j += 2) { props[keys[tags[j]]] = vals[tags[j + 1]]; }
    out.push({ type: type, props: props, parts: decodeGeometry(geom) });
  }
  return { name: name, extent: extent, features: out };
}

// Returns { layerName: {extent, features:[{type, props, parts}]} } for wanted layers only.
function decodeTile(buf, wantedNames) {
  var wanted = {};
  for (var i = 0; i < wantedNames.length; i++) { wanted[wantedNames[i]] = true; }
  var r = new Reader(buf), layers = {};
  while (r.p < r.b.length) {
    var tag = r.varint(), field = tag >> 3, wire = tag & 7;
    if (field === 3) {
      var layer = readLayer(r.bytes(), wanted);
      if (layer) { layers[layer.name] = layer; }
    } else { r.skip(wire); }
  }
  return layers;
}

module.exports = { decodeTile: decodeTile };
