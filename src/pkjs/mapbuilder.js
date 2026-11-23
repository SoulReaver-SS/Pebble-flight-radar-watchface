// Builds the watch map (water polygons, highways, major roads, runways) from Protomaps tiles.
var geo = require('./geo');
var mvt = require('./mvt');
var net = require('./net');

// Default basemap: OpenFreeMap (OpenMapTiles schema, no key, no usage limits).
// Optional: Protomaps hosted tiles when the user supplies their own key.
var OFM_TILEJSON = 'https://tiles.openfreemap.org/planet';
var PROTOMAPS_URL = 'https://api.protomaps.com/tiles/v4/{z}/{x}/{y}.mvt?key=';
var MAX_BYTES = 16000;     // keep the map small enough for the watch heap

// Extra map around the screen so small moves don't need a rebuild: ~60 px, between 0.5 and 2.5 km.
function marginFor(mpp) { return Math.max(500, Math.min(2500, 60 * mpp)); }

// Tile zoom whose tiles span ~128 screen px at this scale (keeps detail matched to the watch).
function zoomFor(mpp, lat) {
  var tileM = 40075016 * Math.cos(lat * Math.PI / 180);
  var z = Math.round(Math.log(tileM / (mpp * 128)) / Math.LN2);
  return Math.max(4, Math.min(15, z));
}

// OpenMapTiles schema (OpenFreeMap): layers water, transportation, aeroway.
function classifyOmt(layer, props, close) {
  var c = props['class'];
  if (layer === 'aeroway') {
    if (c === 'runway') { return geo.REC.RUNWAY; }
    if (c === 'taxiway' && close) { return geo.REC.TAXIWAY; }
    return 0;
  }
  if (props.ramp) { return 0; }
  if (c === 'motorway') { return geo.REC.HIGHWAY; }
  if (c === 'trunk' || c === 'primary') { return geo.REC.MAJOR; }
  if (close && (c === 'secondary' || c === 'tertiary' || c === 'minor')) { return geo.REC.MINOR; }
  return 0;
}

// Protomaps basemap schema: layers water, roads.
function classifyRoad(props, close) {
  var kind = props.kind, detail = props.kind_detail;
  if (kind === 'highway' && detail === 'motorway') { return geo.REC.HIGHWAY; }
  if (kind === 'major_road' && (detail === 'trunk' || detail === 'primary')) { return geo.REC.MAJOR; }
  if (kind === 'aeroway' && detail === 'runway') { return geo.REC.RUNWAY; }
  if (close) {
    // Zoomed in to a couple of miles: side streets and airport taxiways become useful.
    if (kind === 'major_road' && (detail === 'secondary' || detail === 'tertiary')) { return geo.REC.MINOR; }
    if (kind === 'minor_road' && (detail === 'residential' || detail === 'unclassified' || !detail)) { return geo.REC.MINOR; }
    if (kind === 'aeroway' && detail === 'taxiway') { return geo.REC.TAXIWAY; }
  }
  return 0;
}

// Convert decoded tiles to clipped, simplified records in local meters.
function toRecords(tiles, proj, box, tol, mpp, includeMajor) {
  var water = [], lines = [], minArea = (2 * mpp) * (2 * mpp);
  tiles.forEach(function (t) {
    var z = t.z, tx = t.x, ty = t.y, layers = t.layers;
    function project(part, extent) {
      return part.map(function (p) {
        var ll = geo.tilePixelToLatLon(z, tx, ty, p[0], p[1], extent);
        return proj.toLocal(ll[0], ll[1]);
      });
    }
    if (layers.water) {
      layers.water.features.forEach(function (f) {
        if (f.type !== 3) { return; }
        f.parts.forEach(function (part) {
          if (part.length < 4 || f.props['class'] === 'swimming_pool') { return; }
          // MVT v2: exterior rings have positive area in tile (y-down) coordinates.
          var hole = geo.ringArea(part) < 0;
          var ring = geo.clipPolygon(project(part, layers.water.extent), box);
          if (ring.length < 3) { return; }
          ring.push(ring[0]);
          ring = geo.simplify(ring, tol);
          ring.pop();
          if (ring.length < 3 || Math.abs(geo.ringArea(ring)) < minArea) { return; }
          water.push({ type: hole ? geo.REC.HOLE : geo.REC.WATER, pts: ring });
        });
      });
    }
    ['roads', 'transportation', 'aeroway'].forEach(function (name) {
      var layer = layers[name];
      if (!layer) { return; }
      layer.features.forEach(function (f) {
        // Runways can arrive as polygons in OpenMapTiles: their outline still reads as a runway.
        if (f.type !== 2 && !(f.type === 3 && name === 'aeroway')) { return; }
        var type = name === 'roads' ? classifyRoad(f.props, mpp < 50) : classifyOmt(name, f.props, mpp < 50);
        if (!type || (!includeMajor && (type === geo.REC.MAJOR || type === geo.REC.MINOR))) { return; }
        f.parts.forEach(function (part) {
          geo.clipLine(project(part, layer.extent), box).forEach(function (piece) {
            var s = geo.simplify(piece, tol);
            if (s.length >= 2) { lines.push({ type: type, pts: s }); }
          });
        });
      });
    });
  });
  // Draw order on the watch: water, then roads, then runways on top.
  var rank = {};
  rank[geo.REC.MINOR] = 0; rank[geo.REC.MAJOR] = 1; rank[geo.REC.HIGHWAY] = 2; rank[geo.REC.TAXIWAY] = 3; rank[geo.REC.RUNWAY] = 4;
  lines.sort(function (a, b) { return rank[a.type] - rank[b.type]; });
  return water.concat(lines);
}

// Tile URL template for the chosen source; OpenFreeMap's current planet build comes from its TileJSON.
function tileTemplate(key, cb) {
  if (key) { cb(null, PROTOMAPS_URL + encodeURIComponent(key), 15, ['water', 'roads']); return; }
  var cached = null;
  try { cached = JSON.parse(localStorage.getItem('overhead-ofm')); } catch (e) { }
  if (cached && Date.now() - cached.t < 86400000) { cb(null, cached.url, cached.maxzoom, OMT_LAYERS); return; }
  net.get(OFM_TILEJSON, { json: true, timeout: 15000 }, function (err, status, body) {
    var url = body && body.tiles && body.tiles[0];
    if (err || status !== 200 || !url) {
      if (cached) { cb(null, cached.url, cached.maxzoom, OMT_LAYERS); return; }
      cb(err || new Error('tilejson HTTP ' + status));
      return;
    }
    var maxzoom = body.maxzoom || 14;
    try { localStorage.setItem('overhead-ofm', JSON.stringify({ t: Date.now(), url: url, maxzoom: maxzoom })); } catch (e) { }
    cb(null, url, maxzoom, OMT_LAYERS);
  });
}
var OMT_LAYERS = ['water', 'transportation', 'aeroway'];

// opts: { lat, lon, mpp, key }  cb(err, { bytes, lat, lon, mpp, zoom })
function buildMap(opts, cb) {
  tileTemplate(opts.key, function (err, template, maxzoom, layerNames) {
    if (err) { cb(err); return; }
    buildFrom(opts, template, maxzoom, layerNames, cb);
  });
}

function buildFrom(opts, template, maxzoom, layerNames, cb) {
  var proj = geo.makeProjection(opts.lat, opts.lon);
  var margin = marginFor(opts.mpp);
  // opts.halfW/halfH: px from the map center to the screen edges (differs between Time 2 and Round 2).
  var hw = (opts.halfW || 100) * opts.mpp + margin, hh = (opts.halfH || 120) * opts.mpp + margin;
  var box = { x0: -hw, x1: hw, y0: -hh, y1: hh };
  var sw = proj.toLatLon(-hw, -hh), ne = proj.toLatLon(hw, hh);
  var z = Math.min(maxzoom, zoomFor(opts.mpp, opts.lat));
  var list = geo.tilesForBox(z, sw[0], sw[1], ne[0], ne[1]);
  while (list.length > 12 && z > 4) {
    z--;
    list = geo.tilesForBox(z, sw[0], sw[1], ne[0], ne[1]);
  }

  var decoded = [], pending = list.length, failed = null;
  list.forEach(function (zxy) {
    var url = template.replace('{z}', zxy[0]).replace('{x}', zxy[1]).replace('{y}', zxy[2]);
    net.get(url, { responseType: 'arraybuffer', timeout: 30000 }, function (err, status, body) {
      if (err || status !== 200 || !body) {
        failed = failed || err || new Error('tile HTTP ' + status);
      } else {
        try {
          decoded.push({ z: zxy[0], x: zxy[1], y: zxy[2], layers: mvt.decodeTile(new Uint8Array(body), layerNames) });
        } catch (e) { failed = failed || e; }
      }
      if (--pending === 0) { finish(); }
    });
  });

  function finish() {
    if (!decoded.length) { cb(failed || new Error('no tiles')); return; }
    var tol = 0.7 * opts.mpp, bytes = null, includeMajor = true, unit = geo.unitFor(opts.mpp);
    for (var attempt = 0; attempt < 5; attempt++) {
      bytes = geo.packRecords(toRecords(decoded, proj, box, tol, opts.mpp, includeMajor), unit);
      if (bytes.length <= MAX_BYTES) { break; }
      if (attempt === 2) { includeMajor = false; } else { tol *= 1.6; }
    }
    if (bytes.length > MAX_BYTES) { bytes = bytes.subarray(0, 0); }
    cb(null, { bytes: bytes, lat: opts.lat, lon: opts.lon, mpp: opts.mpp, unit: unit, zoom: z, tiles: list.length, partial: !!failed });
  }
}

module.exports = { buildMap: buildMap, marginFor: marginFor };
