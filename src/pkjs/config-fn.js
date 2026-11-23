// Runs inside the settings page: show only the location field that matches the chosen mode.
module.exports = function (minified) {
  var clayConfig = this;
  clayConfig.on(clayConfig.EVENTS.AFTER_BUILD, function () {
    var mode = clayConfig.getItemByMessageKey('CFG_LOC_MODE');
    var fields = {
      preset: clayConfig.getItemByMessageKey('CFG_PRESET'),
      zip: clayConfig.getItemByMessageKey('CFG_ZIP'),
      coords: clayConfig.getItemByMessageKey('CFG_COORDS')
    };
    function update() {
      var m = mode.get();
      for (var k in fields) {
        if (fields.hasOwnProperty(k) && fields[k]) {
          if (k === m) { fields[k].show(); } else { fields[k].hide(); }
        }
      }
    }
    mode.on('change', update);
    update();

    // Show the overnight hours and the low pass altitude only when their toggle is on.
    function follow(toggleKey, keysToShow) {
      var t = clayConfig.getItemByMessageKey(toggleKey);
      if (!t) { return; }
      function sync() {
        keysToShow.forEach(function (k) {
          var it = clayConfig.getItemByMessageKey(k);
          if (it) { if (t.get()) { it.show(); } else { it.hide(); } }
        });
      }
      t.on('change', sync);
      sync();
    }
    follow('CFG_NIGHT', ['CFG_NIGHT_FROM', 'CFG_NIGHT_TO']);
    follow('CFG_ALERT_LOW', ['CFG_ALERT_LOW_FT']);

    // Waiting on PebbleOS: touch input isn't delivered to watchfaces yet.
    var zoom = clayConfig.getItemByMessageKey('CFG_TOUCH_ZOOM');
    if (zoom) { zoom.disable(); }
  });
};
