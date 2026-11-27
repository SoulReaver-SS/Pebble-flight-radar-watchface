// Tiny XMLHttpRequest wrapper: cb(err, status, response, header) where header(name) reads a response header.
function get(url, opts, cb) {
  var xhr = new XMLHttpRequest(), done = false;
  xhr.open('GET', url, true);
  if (opts.responseType) { xhr.responseType = opts.responseType; }
  xhr.timeout = opts.timeout || 20000;
  var headers = opts.headers || {};
  for (var h in headers) { if (headers.hasOwnProperty(h)) { xhr.setRequestHeader(h, headers[h]); } }
  function header(name) {
    try { return xhr.getResponseHeader(name); } catch (e) { return null; }
  }
  function finish(err) {
    if (done) { return; }
    done = true;
    if (err) { cb(err, xhr.status || 0, null, header); return; }
    var body = xhr.response;
    if (opts.json) {
      try { body = JSON.parse(typeof xhr.response === 'string' ? xhr.response : xhr.responseText); }
      catch (e) { cb(new Error('bad json'), xhr.status, null, header); return; }
    }
    cb(null, xhr.status, body, header);
  }
  xhr.onload = function () { finish(null); };
  xhr.onerror = function () { finish(new Error('network error')); };
  xhr.ontimeout = function () { finish(new Error('timeout')); };
  xhr.send();
}

module.exports = { get: get };
