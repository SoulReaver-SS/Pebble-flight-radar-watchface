# Aircraft Map

A Pebble Time 2 watchface that shows live ADS-B traffic around you on a dark map styled after the Wingbits live map.

https://apps.repebble.com/057454964bc84d3f881d3edd

- Time band on top, nearest aircraft at the bottom (callsign, distance, bearing arrow, altitude, speed, category)
- Map centered on your phone's GPS: water, highways, major roads and runways from OpenStreetMap vector tiles (OpenFreeMap by default)
- Aircraft colored by altitude with the Wingbits "thermal" ramp, snapped to Pebble's 64 colors
- Positions dead-reckoned between refreshes, so planes keep moving until the next update
- Center on GPS, a preset city or airport (Bay Area and global metros), a ZIP/postal code, or coordinates
- Range from 1 to 100 nm; side streets and taxiways appear at 1-2 nm, planes become dots past ~40 nm
- Tap/swipe controls are written but switched off: PebbleOS does not deliver touch input to watchfaces yet
- Wrist flick forces a refresh and holds the backlight for 10 seconds

## Data

| What | Source | Key |
|---|---|---|
| Aircraft | Wingbits customer API (`/v1/flights?by=radius`) | Your own key, set in the watchface settings |
| Aircraft fallback | adsb.lol (`/v2/lat/{lat}/lon/{lon}/dist/{nm}`) | None |
| Map | OpenFreeMap (OpenMapTiles schema) | None |
| Map, optional | Protomaps hosted tiles v4 | Your own key, set in settings |
| Postal codes | Zippopotam.us | None |

Targets with a `~` address (no ICAO address, mostly airport ground vehicles) and surface vehicles are dropped. Aircraft on the ground are hidden by default.

## How it works

The phone side (`src/pkjs`) gets a GPS fix, downloads the vector tiles covering the view, decodes them (`mvt.js`), clips and simplifies water polygons and road lines to the screen area, and packs them as int16 coordinates in 4 m steps, doubled at wide ranges so everything fits (`geo.js`, `mapbuilder.js`). The map is rebuilt only after you move about 2 km and is cached on the phone. Aircraft are fetched every refresh, sorted by distance and packed 20 bytes each (`planes.js`).

The watch side (`src/c/overhead.c`) receives the map in chunks and the aircraft list, then draws everything with you at the center.

## Build

```
pebble build
pebble install --emulator emery
```

## Credits

- Map data © OpenMapTiles © OpenStreetMap contributors, served by OpenFreeMap (or Protomaps with your key)
- Aircraft data from Wingbits and adsb.lol (ODbL)
- IBM Plex Mono, SIL Open Font License (`resources/fonts/OFL-IBMPlexMono.txt`)
- Aircraft silhouettes are original drawings
