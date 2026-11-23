// Flight Radar: live ADS-B traffic around you on a Wingbits-style dark map.
// Watch side: receives map geometry + aircraft from the phone and draws them.
#include <pebble.h>

// ---------- layout (Pebble Time 2: 200 x 228) ----------
#define TOP_H 40
#define BOT_H 34
#define MAX_PLANES 60
#define PLANE_BYTES 20
#define CMD_REFRESH 1
#define CMD_HELLO 2
#define CMD_ZOOM 3

// Map record types (must match pkjs/geo.js)
#define REC_WATER 1
#define REC_HOLE 2
#define REC_HIGHWAY 3
#define REC_MAJOR 4
#define REC_RUNWAY 5
#define REC_MINOR 6
#define REC_TAXIWAY 7

// Persist keys
#define P_ROADS 1
#define P_RING 2
#define P_INTERVAL 3
#define P_RADIUS 4
#define P_TOUCH_ZOOM 5

typedef struct {
  int16_t x, y;      // 4 m units from map anchor, y north
  int16_t alt;       // 25 ft units, INT16_MIN = unknown
  uint8_t hdg;       // 256 = full circle
  uint8_t flags;     // bit0 heading valid, bit1 on ground
  uint8_t cat;
  uint16_t gs;       // knots
  char cs[9];
} Plane;

static Window *s_window;
static Layer *s_canvas;
static GFont s_font_time, s_font_small, s_font_tiny;

// Map currently shown, plus one being received.
static uint8_t *s_map;
static uint32_t s_map_len;
static int32_t s_map_id = -1;
static int32_t s_mpp10 = 2405; // meters per pixel x10 (10 nm default)
static uint8_t *s_pending;
static uint32_t s_pending_total, s_pending_got;
static int32_t s_pending_id = -1, s_pending_mpp10;

static Plane s_planes[MAX_PLANES];
static int s_plane_count;
static time_t s_planes_time;
static int32_t s_user_x, s_user_y;
static int32_t s_unit = 4, s_pending_unit = 4;  // meters per coordinate step (grows at wide ranges)
static char s_src[20];
static char s_status[20];
static char s_loc_label[16];  // set when the map is centered on a fixed place

static int s_road_style = 1;  // 0 solid, 1 dithered, 2 hidden
static int s_show_ring = 1;
static int s_interval = 2;
static int s_radius_nm = 10;
static int s_touch_zoom = 1;  // 0 off, 1 swipe up = in, 2 down = in, 3 right = in, 4 left = in
static const int RANGES[] = { 1, 2, 3, 5, 7, 10, 15, 20, 30, 40, 60, 80, 100 };
static AppTimer *s_zoom_timer;
static int s_minutes;
static time_t s_last_request;
static bool s_connected = true;

static GPath *s_jet, *s_heavy, *s_light, *s_other;

// Tap-to-select: the chosen plane is tracked by callsign across refreshes.
#define SHOW_UNDERSCORE 0
// PebbleOS does not deliver touch input to watchfaces yet; tap/swipe code stays for a companion app.
#define WATCHFACE_TOUCH 0
#define SELECT_TIMEOUT_S 120
static char s_sel_cs[9];
static time_t s_sel_time;
static GPoint s_touch_start, s_touch_last;
#define LIGHT_MS 10000
static AppTimer *s_light_timer;
static void light_hold(void);
static bool s_touch_moved;

// ---------- aircraft silhouettes (our own, pointing north) ----------
static GPoint JET_PTS[] = {
  {0, -8}, {2, -6}, {2, -2}, {7, 2}, {7, 4}, {2, 2}, {2, 5}, {4, 7}, {4, 8}, {0, 7},
  {-4, 8}, {-4, 7}, {-2, 5}, {-2, 2}, {-7, 4}, {-7, 2}, {-2, -2}, {-2, -6}
};
static GPoint HEAVY_PTS[] = {
  {0, -10}, {2, -8}, {2, -3}, {9, 2}, {9, 5}, {2, 3}, {2, 6}, {5, 9}, {5, 10}, {0, 9},
  {-5, 10}, {-5, 9}, {-2, 6}, {-2, 3}, {-9, 5}, {-9, 2}, {-2, -3}, {-2, -8}
};
static GPoint LIGHT_PTS[] = {
  {0, -6}, {1, -5}, {1, -3}, {6, -3}, {6, -1}, {1, -1}, {1, 3}, {3, 4}, {3, 5}, {-3, 5},
  {-3, 4}, {-1, 3}, {-1, -1}, {-6, -1}, {-6, -3}, {-1, -3}, {-1, -5}
};
static GPoint OTHER_PTS[] = { {0, -4}, {4, 0}, {0, 4}, {-4, 0} };

static const GPathInfo JET_INFO = { ARRAY_LENGTH(JET_PTS), JET_PTS };
static const GPathInfo HEAVY_INFO = { ARRAY_LENGTH(HEAVY_PTS), HEAVY_PTS };
static const GPathInfo LIGHT_INFO = { ARRAY_LENGTH(LIGHT_PTS), LIGHT_PTS };
static const GPathInfo OTHER_INFO = { ARRAY_LENGTH(OTHER_PTS), OTHER_PTS };

// ---------- helpers ----------
static int map_cx(GRect b) { return b.size.w / 2; }
static int map_cy(GRect b) { return (TOP_H + (b.size.h - BOT_H)) / 2; }

static uint16_t rd16(const uint8_t *p) { return (uint16_t)(p[0] | (p[1] << 8)); }

static int32_t isqrt(int32_t v) {
  if (v <= 0) { return 0; }
  int32_t r = v, last;
  do { last = r; r = (r + v / r) / 2; } while (r < last);
  return last;
}

// Round an RGB color to the nearest of Pebble's 64 colors.
static GColor snap(int r, int g, int b) {
  GColor8 c;
  c.argb = (uint8_t)((3 << 6) | (((r * 3 + 127) / 255) << 4) | (((g * 3 + 127) / 255) << 2) | ((b * 3 + 127) / 255));
  return c;
}

// Wingbits "thermal" altitude ramp, interpolated, then snapped to the Pebble palette.
static const int32_t ALT_STOPS[7] = { 0, 5000, 10000, 18000, 28000, 36000, 45000 };
static const uint8_t ALT_RGB[7][3] = {
  {0, 217, 255}, {50, 250, 160}, {200, 230, 60}, {255, 180, 35},
  {255, 113, 33}, {245, 70, 45}, {210, 40, 70}
};
static GColor alt_color(int16_t alt25) {
  if (alt25 == INT16_MIN) { return GColorLightGray; }
  int32_t ft = (int32_t)alt25 * 25;
  if (ft <= 0) { return snap(ALT_RGB[0][0], ALT_RGB[0][1], ALT_RGB[0][2]); }
  if (ft >= ALT_STOPS[6]) { return snap(ALT_RGB[6][0], ALT_RGB[6][1], ALT_RGB[6][2]); }
  int i = 0;
  while (i < 5 && ft > ALT_STOPS[i + 1]) { i++; }
  int32_t span = ALT_STOPS[i + 1] - ALT_STOPS[i], t = ft - ALT_STOPS[i];
  int c[3];
  for (int k = 0; k < 3; k++) {
    c[k] = ALT_RGB[i][k] + (int)(((int32_t)ALT_RGB[i + 1][k] - ALT_RGB[i][k]) * t / span);
  }
  return snap(c[0], c[1], c[2]);
}

// World (4 m units) to screen.
static GPoint to_screen(GRect b, int32_t x, int32_t y) {
  int32_t sx = map_cx(b) + ((x - s_user_x) * s_unit * 10) / s_mpp10;
  int32_t sy = map_cy(b) - ((y - s_user_y) * s_unit * 10) / s_mpp10;
  if (sx < -2000) { sx = -2000; } else if (sx > 2000) { sx = 2000; }
  if (sy < -2000) { sy = -2000; } else if (sy > 2000) { sy = 2000; }
  return GPoint((int16_t)sx, (int16_t)sy);
}

// Every-other-pixel line: averages to about #2A2A2A on the black land.
static void draw_dither_line(GContext *ctx, GPoint a, GPoint c, GRect bounds) {
  int dx = abs(c.x - a.x), dy = -abs(c.y - a.y);
  int sx = a.x < c.x ? 1 : -1, sy = a.y < c.y ? 1 : -1;
  int err = dx + dy, x = a.x, y = a.y, guard = 0;
  while (guard++ < 2000) {
    if (((x + y) & 1) == 0 && x >= 0 && y >= 0 && x < bounds.size.w && y < bounds.size.h) {
      graphics_draw_pixel(ctx, GPoint(x, y));
    }
    if (x == c.x && y == c.y) { break; }
    int e2 = 2 * err;
    if (e2 >= dy) { err += dy; x += sx; }
    if (e2 <= dx) { err += dx; y += sy; }
  }
}

static bool seg_visible(GPoint a, GPoint c, GRect b) {
  if (a.x < 0 && c.x < 0) { return false; }
  if (a.y < 0 && c.y < 0) { return false; }
  if (a.x >= b.size.w && c.x >= b.size.w) { return false; }
  if (a.y >= b.size.h && c.y >= b.size.h) { return false; }
  return true;
}

// ---------- drawing ----------
static void draw_map(GContext *ctx, GRect b) {
  if (!s_map || !s_map_len) { return; }
  graphics_context_set_antialiased(ctx, false);
  uint32_t o = 0;
  while (o + 3 <= s_map_len) {
    uint8_t type = s_map[o];
    uint16_t n = rd16(s_map + o + 1);
    const uint8_t *pts = s_map + o + 3;
    o += 3 + (uint32_t)n * 4;
    if (o > s_map_len || n < 2) { break; }

    if (type == REC_WATER || type == REC_HOLE) {
      if (n < 3) { continue; }
      GPoint *buf = malloc(sizeof(GPoint) * n);
      if (!buf) { continue; }
      for (uint16_t i = 0; i < n; i++) {
        buf[i] = to_screen(b, (int16_t)rd16(pts + i * 4), (int16_t)rd16(pts + i * 4 + 2));
      }
      GPath path = { .num_points = n, .points = buf, .rotation = 0, .offset = GPointZero };
      graphics_context_set_fill_color(ctx, type == REC_WATER ? GColorMidnightGreen : GColorBlack);
      gpath_draw_filled(ctx, &path);
      free(buf);
      continue;
    }

    bool runway = type == REC_RUNWAY, taxiway = type == REC_TAXIWAY;
    bool road = !runway && !taxiway;
    if (road && s_road_style == 2) { continue; }
    graphics_context_set_stroke_color(ctx, runway ? GColorLightGray : GColorDarkGray);
    graphics_context_set_stroke_width(ctx, runway ? 2 : 1);
    GPoint prev = to_screen(b, (int16_t)rd16(pts), (int16_t)rd16(pts + 2));
    for (uint16_t i = 1; i < n; i++) {
      GPoint cur = to_screen(b, (int16_t)rd16(pts + i * 4), (int16_t)rd16(pts + i * 4 + 2));
      if (seg_visible(prev, cur, b)) {
        if (road && s_road_style == 1) { draw_dither_line(ctx, prev, cur, b); }
        else { graphics_draw_line(ctx, prev, cur); }
      }
      prev = cur;
    }
  }
  graphics_context_set_stroke_width(ctx, 1);
}

static void draw_ring(GContext *ctx, GRect b) {
  int32_t r = (int32_t)s_radius_nm * 18520 / s_mpp10;
  GPoint c = GPoint(map_cx(b), map_cy(b));
  graphics_context_set_stroke_color(ctx, GColorDarkGray);
  for (int i = 0; s_show_ring && i < 120; i++) {
    int32_t a = TRIG_MAX_ANGLE * i / 120;
    GPoint p = GPoint(c.x + (int16_t)(sin_lookup(a) * r / TRIG_MAX_RATIO),
                      c.y - (int16_t)(cos_lookup(a) * r / TRIG_MAX_RATIO));
    graphics_draw_pixel(ctx, p);
  }
  static char label[8];
  snprintf(label, sizeof(label), "%dNM", s_radius_nm);
  int32_t a = TRIG_MAX_ANGLE / 8; // label at the 1:30 position
  GPoint lp = GPoint(c.x + (int16_t)(sin_lookup(a) * r / TRIG_MAX_RATIO) + 2,
                     c.y - (int16_t)(cos_lookup(a) * r / TRIG_MAX_RATIO) - 12);
  graphics_context_set_text_color(ctx, GColorDarkGray);
  graphics_draw_text(ctx, label, s_font_tiny, GRect(lp.x, lp.y, 40, 14),
                     GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);
}

// World position (4 m units) of a plane, dead-reckoned forward since the last update (max 3 min).
static void plane_world(const Plane *p, int32_t age, int32_t *ox, int32_t *oy) {
  int32_t x = p->x, y = p->y;
  if ((p->flags & 1) && !(p->flags & 2) && p->gs > 0) {
    if (age > 180) { age = 180; }
    int32_t dist4 = (int32_t)p->gs * 1852 / 3600 * age / s_unit; // coordinate steps
    int32_t ang = TRIG_MAX_ANGLE * p->hdg / 256;
    x += sin_lookup(ang) * dist4 / TRIG_MAX_RATIO;
    y += cos_lookup(ang) * dist4 / TRIG_MAX_RATIO;
  }
  *ox = x; *oy = y;
}

static GPoint plane_pos(GRect b, const Plane *p, int32_t age) {
  int32_t x, y;
  plane_world(p, age, &x, &y);
  return to_screen(b, x, y);
}

// Index of the plane shown in the bottom band: the tapped one if still present, else the nearest.
static int selected_index(void) {
  if (!s_sel_cs[0]) { return 0; }
  for (int i = 0; i < s_plane_count; i++) {
    if (strncmp(s_planes[i].cs, s_sel_cs, 8) == 0) { return i; }
  }
  s_sel_cs[0] = 0;
  return 0;
}

static void draw_heli(GContext *ctx, GPoint c, int32_t ang, GColor color) {
  graphics_context_set_fill_color(ctx, color);
  graphics_context_set_stroke_color(ctx, color);
  graphics_fill_circle(ctx, c, 2);
  for (int k = 0; k < 2; k++) {
    int32_t a = ang + TRIG_MAX_ANGLE / 8 + k * TRIG_MAX_ANGLE / 4;
    int16_t dx = (int16_t)(sin_lookup(a) * 6 / TRIG_MAX_RATIO), dy = (int16_t)(cos_lookup(a) * 6 / TRIG_MAX_RATIO);
    graphics_draw_line(ctx, GPoint(c.x - dx, c.y + dy), GPoint(c.x + dx, c.y - dy));
  }
  int16_t tx = (int16_t)(sin_lookup(ang) * 6 / TRIG_MAX_RATIO), ty = (int16_t)(cos_lookup(ang) * 6 / TRIG_MAX_RATIO);
  graphics_draw_line(ctx, c, GPoint(c.x - tx, c.y + ty));
}

static void draw_planes(GContext *ctx, GRect b) {
  int32_t age = (int32_t)(time(NULL) - s_planes_time);
  int sel = selected_index();
  graphics_context_set_antialiased(ctx, false);
  for (int i = s_plane_count - 1; i >= 0; i--) {
    const Plane *p = &s_planes[i];
    GPoint c = plane_pos(b, p, age);
    if (c.x < -12 || c.y < TOP_H - 12 || c.x > b.size.w + 12 || c.y > b.size.h - BOT_H + 12) { continue; }
    GColor color = alt_color(p->alt);
    int32_t ang = (p->flags & 1) ? TRIG_MAX_ANGLE * p->hdg / 256 : 0;
    if (s_mpp10 > 9000) {
      graphics_context_set_fill_color(ctx, color);
      graphics_context_set_stroke_color(ctx, color);
      graphics_fill_circle(ctx, c, 2);
      if (p->flags & 1) {
        graphics_draw_line(ctx, c, GPoint(c.x + (int16_t)(sin_lookup(ang) * 5 / TRIG_MAX_RATIO),
                                          c.y - (int16_t)(cos_lookup(ang) * 5 / TRIG_MAX_RATIO)));
      }
    } else if (p->cat == 7) {
      draw_heli(ctx, c, ang, color);
    } else {
      GPath *path = s_jet;
      if (p->cat == 5) { path = s_heavy; }
      else if (p->cat == 1 || p->cat == 9 || p->cat == 12) { path = s_light; }
      else if (p->cat == 10 || p->cat == 11 || p->cat == 14) { path = s_other; }
      gpath_rotate_to(path, ang);
      gpath_move_to(path, c);
      graphics_context_set_fill_color(ctx, color);
      graphics_context_set_stroke_color(ctx, color);
      gpath_draw_filled(ctx, path);
      gpath_draw_outline(ctx, path); // keeps thin wings solid after rotation
    }
    if (i == sel) {
      // Target brackets: white on the nearest aircraft, orange on one you tapped.
      graphics_context_set_stroke_color(ctx, s_sel_cs[0] ? GColorOrange : GColorWhite);
      const int r = 11, l = 3;
      for (int sx = -1; sx <= 1; sx += 2) {
        for (int sy = -1; sy <= 1; sy += 2) {
          GPoint k = GPoint(c.x + sx * r, c.y + sy * r);
          graphics_draw_line(ctx, k, GPoint(k.x - sx * l, k.y));
          graphics_draw_line(ctx, k, GPoint(k.x, k.y - sy * l));
        }
      }
    }
  }
}

static void draw_user(GContext *ctx, GRect b) {
  GPoint c = GPoint(map_cx(b), map_cy(b));
  graphics_context_set_stroke_color(ctx, GColorOrange);
  if (s_loc_label[0]) {
    graphics_context_set_antialiased(ctx, false);
    graphics_draw_line(ctx, GPoint(c.x - 7, c.y), GPoint(c.x - 3, c.y));
    graphics_draw_line(ctx, GPoint(c.x + 3, c.y), GPoint(c.x + 7, c.y));
    graphics_draw_line(ctx, GPoint(c.x, c.y - 7), GPoint(c.x, c.y - 3));
    graphics_draw_line(ctx, GPoint(c.x, c.y + 3), GPoint(c.x, c.y + 7));
    return;
  }
  graphics_context_set_antialiased(ctx, true);
  graphics_context_set_fill_color(ctx, GColorOrange);
  graphics_fill_circle(ctx, c, 3);
  graphics_draw_circle(ctx, c, 6);
}

static void draw_top(GContext *ctx, GRect b) {
  graphics_context_set_fill_color(ctx, GColorBlack);
  graphics_fill_rect(ctx, GRect(0, 0, b.size.w, TOP_H), 0, GCornerNone);
  graphics_context_set_stroke_color(ctx, GColorDarkGray);
  graphics_draw_line(ctx, GPoint(0, TOP_H - 1), GPoint(b.size.w, TOP_H - 1));

  time_t now = time(NULL);
  struct tm *t = localtime(&now);
  static char tbuf[8];
  strftime(tbuf, sizeof(tbuf), clock_is_24h_style() ? "%H:%M" : "%I:%M", t);
  char *tstr = (!clock_is_24h_style() && tbuf[0] == '0') ? tbuf + 1 : tbuf;

  // Drawn as one string so the "_" sits flush against the digits (mono font), then the "_" alone
  // is redrawn in orange at the same origin, like the active tab in the Wingbits menu.
  static char tline[10];
  snprintf(tline, sizeof(tline), "%s%s", SHOW_UNDERSCORE ? "_" : "", tstr);
  graphics_context_set_text_color(ctx, GColorWhite);
  graphics_draw_text(ctx, tline, s_font_time, GRect(4, -1, 120, 36), GTextOverflowModeFill, GTextAlignmentLeft, NULL);
  if (SHOW_UNDERSCORE) {
    graphics_context_set_text_color(ctx, GColorOrange);
    graphics_draw_text(ctx, "_", s_font_time, GRect(4, -1, 120, 36), GTextOverflowModeFill, GTextAlignmentLeft, NULL);
  }

  static char date[12];
  strftime(date, sizeof(date), "%a %d", t);
  for (char *q = date; *q; q++) { if (*q >= 'a' && *q <= 'z') { *q -= 32; } }
  graphics_context_set_text_color(ctx, GColorLightGray);
  graphics_draw_text(ctx, date, s_font_tiny, GRect(b.size.w - 74, 3, 70, 14),
                     GTextOverflowModeTrailingEllipsis, GTextAlignmentRight, NULL);

  static char info[32];
  const char *line = info;
  if (!s_connected) { line = "NO PHONE"; graphics_context_set_text_color(ctx, GColorOrange); }
  else if (s_status[0]) { line = s_status; graphics_context_set_text_color(ctx, GColorOrange); }
  else if (s_src[0]) {
    snprintf(info, sizeof(info), "%s %d", s_loc_label[0] ? s_loc_label : s_src, s_plane_count);
    graphics_context_set_text_color(ctx, GColorDarkGray);
  } else { line = "SYNCING"; graphics_context_set_text_color(ctx, GColorDarkGray); }
  graphics_draw_text(ctx, line, s_font_tiny, GRect(b.size.w - 94, 19, 90, 14),
                     GTextOverflowModeTrailingEllipsis, GTextAlignmentRight, NULL);
}

static void format_alt(char *out, size_t n, int16_t alt25) {
  if (alt25 == INT16_MIN) { snprintf(out, n, "ALT ?"); return; }
  int32_t ft = (int32_t)alt25 * 25;
  if (ft >= 18000) { snprintf(out, n, "FL%03d", (int)((ft + 50) / 100)); }
  else if (ft >= 1000) { snprintf(out, n, "%d,%03dFT", (int)(ft / 1000), (int)(ft % 1000)); }
  else { snprintf(out, n, "%dFT", (int)(ft < 0 ? 0 : ft)); }
}

static const char *cat_name(uint8_t cat) {
  switch (cat) {
    case 1: return "LIGHT";
    case 2: return "SMALL";
    case 3: return "LARGE";
    case 4: return "B757";
    case 5: return "HEAVY";
    case 6: return "FAST";
    case 7: return "HELI";
    case 9: return "GLIDER";
    case 10: return "BALLOON";
    case 12: return "ULTRALT";
    case 14: return "UAV";
    default: return "";
  }
}

static void draw_bottom(GContext *ctx, GRect b) {
  int y0 = b.size.h - BOT_H;
  graphics_context_set_fill_color(ctx, GColorBlack);
  graphics_fill_rect(ctx, GRect(0, y0, b.size.w, BOT_H), 0, GCornerNone);
  graphics_context_set_stroke_color(ctx, GColorDarkGray);
  graphics_draw_line(ctx, GPoint(0, y0), GPoint(b.size.w, y0));

  if (!s_plane_count) {
    graphics_context_set_text_color(ctx, GColorDarkGray);
    graphics_draw_text(ctx, s_src[0] ? "_NO TRAFFIC" : "_WAITING", s_font_small, GRect(6, y0 + 7, 188, 18),
                       GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);
    return;
  }
  const Plane *p = &s_planes[selected_index()];
  int32_t age = (int32_t)(time(NULL) - s_planes_time);
  // Direction and distance from world coordinates (precise even when the plane is a few px away).
  int32_t wx, wy;
  plane_world(p, age, &wx, &wy);
  int32_t dxp = wx - s_user_x, dyp = wy - s_user_y, unit = s_unit;  // y north
  while (abs(dxp) > 4000 || abs(dyp) > 4000) { dxp /= 2; dyp /= 2; unit *= 2; }
  int32_t dist_m = isqrt(dxp * dxp + dyp * dyp) * unit;

  // Line 1: _CALLSIGN ............ 3.2NM [arrow]
  static char csline[12];
  snprintf(csline, sizeof(csline), "%s%s", SHOW_UNDERSCORE ? "_" : "", p->cs);
  graphics_context_set_text_color(ctx, GColorWhite);
  graphics_draw_text(ctx, csline, s_font_small, GRect(6, y0 + 1, 110, 18),
                     GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);
  if (SHOW_UNDERSCORE) {
    graphics_context_set_text_color(ctx, GColorOrange);
    graphics_draw_text(ctx, "_", s_font_small, GRect(6, y0 + 1, 110, 18), GTextOverflowModeFill, GTextAlignmentLeft, NULL);
  }

  static char dist[12];
  int32_t tenths = dist_m * 10 / 1852;
  snprintf(dist, sizeof(dist), "%d.%dNM", (int)(tenths / 10), (int)(tenths % 10));
  graphics_context_set_text_color(ctx, GColorLightGray);
  graphics_draw_text(ctx, dist, s_font_small, GRect(96, y0 + 1, 80, 18),
                     GTextOverflowModeTrailingEllipsis, GTextAlignmentRight, NULL);

  // Bearing arrow toward the nearest aircraft, in its altitude color.
  GColor color = alt_color(p->alt);
  // Arrow built from the unit vector toward the plane (screen y points down).
  GPoint ac = GPoint(b.size.w - 11, y0 + 10);
  int32_t len = isqrt(dxp * dxp + dyp * dyp);
  int32_t ux = len ? dxp * 64 / len : 0, uy = len ? -dyp * 64 / len : -64;  // 64 = 1.0
  // Shaft plus two head strokes: reads as a direction even at this size.
  GPoint tip = GPoint(ac.x + ux * 7 / 64, ac.y + uy * 7 / 64);
  GPoint tail = GPoint(ac.x - ux * 6 / 64, ac.y - uy * 6 / 64);
  GPoint hl = GPoint(tip.x + (-ux * 5 - uy * 4) / 64, tip.y + (-uy * 5 + ux * 4) / 64);
  GPoint hr = GPoint(tip.x + (-ux * 5 + uy * 4) / 64, tip.y + (-uy * 5 - ux * 4) / 64);
  graphics_context_set_antialiased(ctx, false);
  graphics_context_set_stroke_color(ctx, color);
  graphics_context_set_stroke_width(ctx, 2);
  graphics_draw_line(ctx, tail, tip);
  graphics_context_set_stroke_width(ctx, 1);
  graphics_draw_line(ctx, tip, hl);
  graphics_draw_line(ctx, tip, hr);

  // Line 2: altitude (in its ramp color), speed, category
  static char alt[16], spd[16];
  format_alt(alt, sizeof(alt), p->alt);
  snprintf(spd, sizeof(spd), "%dKT", (int)p->gs);
  graphics_context_set_text_color(ctx, color);
  graphics_draw_text(ctx, alt, s_font_small, GRect(6 + (SHOW_UNDERSCORE ? 9 : 0), y0 + 16, 90, 18), GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);
  graphics_context_set_text_color(ctx, GColorLightGray);
  graphics_draw_text(ctx, spd, s_font_small, GRect(96, y0 + 16, 50, 18), GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);
  graphics_context_set_text_color(ctx, GColorDarkGray);
  graphics_draw_text(ctx, cat_name(p->cat), s_font_tiny, GRect(140, y0 + 18, 56, 14), GTextOverflowModeTrailingEllipsis, GTextAlignmentRight, NULL);
}

static void canvas_update(Layer *layer, GContext *ctx) {
  GRect b = layer_get_bounds(layer);
  graphics_context_set_fill_color(ctx, GColorBlack);
  graphics_fill_rect(ctx, b, 0, GCornerNone);
  draw_map(ctx, b);
  draw_ring(ctx, b);
  draw_planes(ctx, b);
  draw_user(ctx, b);
  draw_top(ctx, b);
  draw_bottom(ctx, b);
}

// ---------- phone comms ----------
static void request(int cmd) {
  DictionaryIterator *it;
  if (app_message_outbox_begin(&it) != APP_MSG_OK) { return; }
  dict_write_int32(it, MESSAGE_KEY_CMD, cmd);
  app_message_outbox_send();
  s_last_request = time(NULL);
}

static void swap_in_pending(void) {
  free(s_map);
  s_map = s_pending;
  s_map_len = s_pending_total;
  s_map_id = s_pending_id;
  s_unit = s_pending_unit;
  s_pending = NULL;
  s_pending_total = s_pending_got = 0;
  APP_LOG(APP_LOG_LEVEL_INFO, "map %d bytes, mpp10 %d, heap free %d", (int)s_map_len, (int)s_mpp10, (int)heap_bytes_free());
}

static void inbox(DictionaryIterator *it, void *ctx) {
  Tuple *t;
  if ((t = dict_find(it, MESSAGE_KEY_ROAD_STYLE))) { s_road_style = t->value->int32; persist_write_int(P_ROADS, s_road_style); }
  if ((t = dict_find(it, MESSAGE_KEY_SHOW_RING))) { s_show_ring = t->value->int32; persist_write_int(P_RING, s_show_ring); }
  if ((t = dict_find(it, MESSAGE_KEY_INTERVAL_MIN))) { s_interval = t->value->int32 > 0 ? t->value->int32 : 2; persist_write_int(P_INTERVAL, s_interval); }
  if ((t = dict_find(it, MESSAGE_KEY_RADIUS_NM)) && t->value->int32 > 0 && !s_zoom_timer) {
    s_radius_nm = t->value->int32;
    s_mpp10 = s_radius_nm * 18520 / 77;
    persist_write_int(P_RADIUS, s_radius_nm);
  }
  if ((t = dict_find(it, MESSAGE_KEY_TOUCH_ZOOM))) { s_touch_zoom = t->value->int32; persist_write_int(P_TOUCH_ZOOM, s_touch_zoom); }
  if ((t = dict_find(it, MESSAGE_KEY_STATUS))) { strncpy(s_status, t->value->cstring, sizeof(s_status) - 1); }

  Tuple *id = dict_find(it, MESSAGE_KEY_MAP_ID);
  Tuple *total = dict_find(it, MESSAGE_KEY_MAP_TOTAL);
  Tuple *chunk = dict_find(it, MESSAGE_KEY_MAP_CHUNK);
  Tuple *planes = dict_find(it, MESSAGE_KEY_PLANES);

  if (id && total) {
    free(s_pending);
    s_pending = NULL;
    s_pending_id = id->value->int32;
    s_pending_total = (uint32_t)total->value->int32;
    s_pending_got = 0;
    Tuple *mpp = dict_find(it, MESSAGE_KEY_MPP10);
    s_pending_mpp10 = mpp ? mpp->value->int32 : s_mpp10;
    Tuple *un = dict_find(it, MESSAGE_KEY_UNIT);
    s_pending_unit = (un && un->value->int32 > 0) ? un->value->int32 : 4;
    if (s_pending_total == 0) {
      swap_in_pending();
    } else {
      s_pending = malloc(s_pending_total);
      if (!s_pending) { strncpy(s_status, "LOW MEMORY", sizeof(s_status) - 1); s_pending_id = -1; }
    }
  }
  if (id && chunk && s_pending && id->value->int32 == s_pending_id) {
    Tuple *off = dict_find(it, MESSAGE_KEY_MAP_OFFSET);
    uint32_t o = off ? (uint32_t)off->value->int32 : 0;
    if (o + chunk->length <= s_pending_total) {
      memcpy(s_pending + o, chunk->value->data, chunk->length);
      s_pending_got += chunk->length;
      if (s_pending_got >= s_pending_total) { swap_in_pending(); }
    }
  }
  if (planes) {
    Tuple *cnt = dict_find(it, MESSAGE_KEY_PLANE_COUNT);
    Tuple *ux = dict_find(it, MESSAGE_KEY_USER_X), *uy = dict_find(it, MESSAGE_KEY_USER_Y);
    Tuple *src = dict_find(it, MESSAGE_KEY_SRC);
    int n = cnt ? cnt->value->int32 : 0;
    if (n > MAX_PLANES) { n = MAX_PLANES; }
    if ((int)planes->length < n * PLANE_BYTES) { n = planes->length / PLANE_BYTES; }
    const uint8_t *d = planes->value->data;
    for (int i = 0; i < n; i++) {
      const uint8_t *q = d + i * PLANE_BYTES;
      Plane *p = &s_planes[i];
      p->x = (int16_t)rd16(q);
      p->y = (int16_t)rd16(q + 2);
      p->alt = (int16_t)rd16(q + 4);
      p->hdg = q[6];
      p->flags = q[7];
      p->cat = q[8];
      p->gs = rd16(q + 10);
      memcpy(p->cs, q + 12, 8);
      p->cs[8] = 0;
    }
    s_plane_count = n;
    s_planes_time = time(NULL);
    Tuple *un2 = dict_find(it, MESSAGE_KEY_UNIT);
    if (un2 && un2->value->int32 > 0) { s_unit = un2->value->int32; }
    if (ux) { s_user_x = ux->value->int32; }
    if (uy) { s_user_y = uy->value->int32; }
    if (src) { strncpy(s_src, src->value->cstring, sizeof(s_src) - 1); }
    Tuple *loc = dict_find(it, MESSAGE_KEY_LOC_LABEL);
    if (loc) { strncpy(s_loc_label, loc->value->cstring, sizeof(s_loc_label) - 1); }
  }
  layer_mark_dirty(s_canvas);
}

static void hello_timer(void *data) { request(CMD_HELLO); }

// ---------- touch ----------
static void select_plane(int i) {
  if (i <= 0) { s_sel_cs[0] = 0; return; }  // index 0 is the nearest: back to automatic
  strncpy(s_sel_cs, s_planes[i].cs, 8);
  s_sel_cs[8] = 0;
  s_sel_time = time(NULL);
}

static void handle_tap(GPoint pt) {
  if (!s_plane_count) { return; }
  GRect b = layer_get_bounds(s_canvas);
  if (pt.y >= b.size.h - BOT_H) {
    // Tapping the readout steps through aircraft from nearest outward.
    select_plane((selected_index() + 1) % s_plane_count);
  } else if (pt.y >= TOP_H) {
    int32_t age = (int32_t)(time(NULL) - s_planes_time);
    int best = -1;
    int32_t best_d = 22 * 22;  // finger-sized hit radius in px
    for (int i = 0; i < s_plane_count; i++) {
      GPoint c = plane_pos(b, &s_planes[i], age);
      int32_t dx = c.x - pt.x, dy = c.y - pt.y, d = dx * dx + dy * dy;
      if (d < best_d) { best_d = d; best = i; }
    }
    if (best >= 0) {
      if (best == 0) { s_sel_cs[0] = 0; } else { select_plane(best); }
    } else {
      s_sel_cs[0] = 0;  // empty map: back to the nearest
    }
  }
  layer_mark_dirty(s_canvas);
}

static void zoom_send(void *data) {
  s_zoom_timer = NULL;
  DictionaryIterator *it;
  if (app_message_outbox_begin(&it) != APP_MSG_OK) { return; }
  dict_write_int32(it, MESSAGE_KEY_CMD, CMD_ZOOM);
  dict_write_int32(it, MESSAGE_KEY_RADIUS_NM, s_radius_nm);
  app_message_outbox_send();
  s_last_request = time(NULL);
}

// One range step per swipe; the view rescales now, the phone rebuilds the map shortly after.
static void zoom_step(int dir) {
  int n = (int)ARRAY_LENGTH(RANGES), idx = 0;
  for (int i = 0; i < n; i++) { if (RANGES[i] <= s_radius_nm) { idx = i; } }
  idx += dir;
  if (idx < 0 || idx >= n) { return; }
  s_radius_nm = RANGES[idx];
  s_mpp10 = s_radius_nm * 18520 / 77;
  persist_write_int(P_RADIUS, s_radius_nm);
  layer_mark_dirty(s_canvas);
  if (s_zoom_timer) { app_timer_reschedule(s_zoom_timer, 1200); }
  else { s_zoom_timer = app_timer_register(1200, zoom_send, NULL); }
}

static void touch_handler(const TouchEvent *e, void *context) {
  if (e->type == TouchEvent_Touchdown) {
    light_hold();
    s_touch_start = GPoint(e->x, e->y);
    s_touch_last = s_touch_start;
    s_touch_moved = false;
  } else if (e->type == TouchEvent_PositionUpdate) {
    s_touch_last = GPoint(e->x, e->y);
    if (abs(e->x - s_touch_start.x) > 8 || abs(e->y - s_touch_start.y) > 8) { s_touch_moved = true; }
  } else if (e->type == TouchEvent_Liftoff) {
    if (!s_touch_moved) { handle_tap(s_touch_start); return; }
    int dx = s_touch_last.x - s_touch_start.x, dy = s_touch_last.y - s_touch_start.y;
    GRect b = layer_get_bounds(s_canvas);
    bool on_map = s_touch_start.y >= TOP_H && s_touch_start.y < b.size.h - BOT_H;
    if (!on_map || !s_touch_zoom) { return; }
    bool vertical = abs(dy) >= 25 && abs(dy) > 2 * abs(dx);
    bool horizontal = abs(dx) >= 25 && abs(dx) > 2 * abs(dy);
    if ((s_touch_zoom == 1 || s_touch_zoom == 2) && vertical) {
      bool in = (dy < 0) == (s_touch_zoom == 1);
      zoom_step(in ? -1 : 1);
    } else if ((s_touch_zoom == 3 || s_touch_zoom == 4) && horizontal) {
      bool in = (dx > 0) == (s_touch_zoom == 3);
      zoom_step(in ? -1 : 1);
    }
  }
}

// ---------- events ----------
static void tick(struct tm *t, TimeUnits changed) {
  if (s_sel_cs[0] && time(NULL) - s_sel_time > SELECT_TIMEOUT_S) { s_sel_cs[0] = 0; }
  if (++s_minutes >= s_interval) { s_minutes = 0; request(CMD_REFRESH); }
  layer_mark_dirty(s_canvas);
}

static void light_off(void *data) { s_light_timer = NULL; light_enable(false); }

// The system backlight timeout is short; hold the light for LIGHT_MS so the map is readable.
static void light_hold(void) {
  light_enable(true);
  if (s_light_timer) { app_timer_reschedule(s_light_timer, LIGHT_MS); }
  else { s_light_timer = app_timer_register(LIGHT_MS, light_off, NULL); }
}

static void tap(AccelAxisType axis, int32_t dir) {
  light_hold();
  if (time(NULL) - s_last_request > 20) { request(CMD_REFRESH); }
}

static void bt(bool connected) {
  s_connected = connected;
  layer_mark_dirty(s_canvas);
}

static void window_load(Window *w) {
  Layer *root = window_get_root_layer(w);
  s_canvas = layer_create(layer_get_bounds(root));
  layer_set_update_proc(s_canvas, canvas_update);
  layer_add_child(root, s_canvas);
}

static void window_unload(Window *w) { layer_destroy(s_canvas); }

static void init(void) {
  if (persist_exists(P_ROADS)) { s_road_style = persist_read_int(P_ROADS); }
  if (persist_exists(P_RING)) { s_show_ring = persist_read_int(P_RING); }
  if (persist_exists(P_INTERVAL)) { s_interval = persist_read_int(P_INTERVAL); }
  if (persist_exists(P_RADIUS)) { s_radius_nm = persist_read_int(P_RADIUS); }
  if (persist_exists(P_TOUCH_ZOOM)) { s_touch_zoom = persist_read_int(P_TOUCH_ZOOM); }
  if (s_interval <= 0) { s_interval = 2; }
  if (s_radius_nm <= 0) { s_radius_nm = 10; }
  s_mpp10 = s_radius_nm * 18520 / 77;

  s_font_time = fonts_load_custom_font(resource_get_handle(RESOURCE_ID_FONT_TIME_30));
  s_font_small = fonts_load_custom_font(resource_get_handle(RESOURCE_ID_FONT_SMALL_14));
  s_font_tiny = fonts_load_custom_font(resource_get_handle(RESOURCE_ID_FONT_TINY_11));
  s_jet = gpath_create(&JET_INFO);
  s_heavy = gpath_create(&HEAVY_INFO);
  s_light = gpath_create(&LIGHT_INFO);
  s_other = gpath_create(&OTHER_INFO);

  s_window = window_create();
  window_set_background_color(s_window, GColorBlack);
  window_set_window_handlers(s_window, (WindowHandlers) { .load = window_load, .unload = window_unload });
  window_stack_push(s_window, true);

  app_message_register_inbox_received(inbox);
  app_message_open(2048, 64);
  tick_timer_service_subscribe(MINUTE_UNIT, tick);
  accel_tap_service_subscribe(tap);
  if (WATCHFACE_TOUCH) { touch_service_subscribe(touch_handler, NULL); }
  connection_service_subscribe((ConnectionHandlers) { .pebble_app_connection_handler = bt });
  s_connected = connection_service_peek_pebble_app_connection();
  app_timer_register(3000, hello_timer, NULL);
}

static void deinit(void) {
  tick_timer_service_unsubscribe();
  accel_tap_service_unsubscribe();
  if (WATCHFACE_TOUCH) { touch_service_unsubscribe(); }
  if (s_light_timer) { app_timer_cancel(s_light_timer); }
  light_enable(false);
  connection_service_unsubscribe();
  window_destroy(s_window);
  gpath_destroy(s_jet); gpath_destroy(s_heavy); gpath_destroy(s_light); gpath_destroy(s_other);
  fonts_unload_custom_font(s_font_time);
  fonts_unload_custom_font(s_font_small);
  fonts_unload_custom_font(s_font_tiny);
  free(s_map);
  free(s_pending);
}

int main(void) {
  init();
  app_event_loop();
  deinit();
}
