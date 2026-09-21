/* Tampa Monitor maps — boots MapLibre GL + PMTiles on content mount points.
 *
 * Mount points arrive in post/page bodies as <div class="<kind>-block" data-*>
 * (emitted by the content pipeline). This file never loads eagerly: hasMap
 * front matter puts map-loader.js on the page, which injects the MapLibre
 * stack and then this file once a mount nears the viewport — so booting runs
 * immediately on execution. Everything renders tokenless from self-hosted tiles:
 *   basemap.pmtiles  — Protomaps "white" Florida extract
 *   planning.pmtiles — source-layers: current-zoning, future-land-use
 *   parcels.pmtiles  — source-layer: parcels (FOLIO)
 *   tampa-municipal-districts.pmtiles — council residency districts 4–7
 *   precincts.pmtiles — county voting precincts (PRECINCT, plain strings)
 *   city-layers.pmtiles — city reference layers (built by toolshed
 *     boundaries/scripts/fetch-city-layers.sh); used here: community-
 *     redevelopment, impact-fee-districts. Also carries planning-districts,
 *     neighborhoods, historic-districts-national/-local, overlay-districts.
 * Ported from toolshed/maps/templates/planning.html (the live MapLibre
 * pattern at maps.tampamonitor.com); keep the two in visual lockstep.
 *
 * No address search yet: the WP maps used mapbox-gl-geocoder (Mapbox-only).
 * The data-show-geocoder attr is ignored until the Geocodio-backed control
 * lands (see docs/MAPS.md → Geocoding).
 */
(() => {
  "use strict";
  if (!window.maplibregl || !window.pmtiles) return;

  const TILES = "https://tiles.tampamonitor.com";
  const GLYPHS = "https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf";
  const SPRITE = "https://protomaps.github.io/basemaps-assets/sprites/v4/white";

  const protocol = new pmtiles.Protocol();
  maplibregl.addProtocol("pmtiles", protocol.tile);

  // ── palette expressions + legends (verbatim from toolshed planning.html) ──

  const FLU_FILL_COLOR = [
    "match", ["get", "UNIQ_VAL"],
    "TAMPA_CBD", "hsl(0, 100%, 24%)",
    "TAMPA_CC-35", "hsl(0, 100%, 50%)",
    "TAMPA_CMU-35", "hsl(314, 59%, 82%)",
    "TAMPA_ESA", "hsl(145, 100%, 85%)",
    "TAMPA_GMU-24", "hsl(275, 100%, 92%)",
    "TAMPA_HI", "hsl(0, 0%, 31%)",
    "TAMPA_LI", "hsl(0, 0%, 61%)",
    "TAMPA_MACDILL AFB", "hsl(207, 74%, 65%)",
    "TAMPA_M-AP", "hsl(0, 0%, 82%)",
    "TAMPA_NMU-16", "hsl(36, 36%, 73%)",
    "TAMPA_NMU-24", "hsl(25, 50%, 61%)",
    "TAMPA_NMU-35", "hsl(0, 67%, 72%)",
    "TAMPA_P/QP", "hsl(207, 74%, 65%)",
    "TAMPA_R/OS", "hsl(97, 42%, 73%)",
    "TAMPA_R/W", "hsl(235, 17%, 74%)",
    "TAMPA_R-10", "hsl(27, 100%, 74%)",
    "TAMPA_R-20", "hsl(28, 37%, 44%)",
    "TAMPA_R-3", "hsl(60, 100%, 50%)",
    "TAMPA_R-35", "hsl(34, 100%, 28%)",
    "TAMPA_R-50", "hsl(18, 100%, 25%)",
    "TAMPA_R-6", "hsl(55, 100%, 50%)",
    "TAMPA_R-83", "hsl(24, 93%, 16%)",
    "TAMPA_RE-10", "hsl(85, 100%, 79%)",
    "TAMPA_RMU-100", "hsl(333, 48%, 49%)",
    "TAMPA_SMU-3", "hsl(314, 100%, 50%)",
    "TAMPA_SMU-6", "hsl(330, 100%, 87%)",
    "TAMPA_TA", "hsl(0, 0%, 100%)",
    "TAMPA_TU-24", "hsl(0, 51%, 60%)",
    "TAMPA_UMU-60", "hsl(279, 100%, 87%)",
    "#000000",
  ];

  const ZONING_FILL_COLOR = [
    "case",
    ["all",
      ["==", ["slice", ["get", "ZONECLASS"], 0, 3], "PD-"],
      ["!=", ["get", "ZONECLASS"], "PD-A"],
    ],
    "#14B8A6",
    ["==", ["get", "ZONECLASS"], "PD"],
    "#14B8A6",
    [
      "match", ["get", "ZONECLASS"],
      ["A"], "#006d2c",
      ["CN"], "#ffeda0",
      ["CI"], "#f03b20",
      ["CG"], "#feb24c",
      ["IG"], "#bdbdbd",
      ["IH"], "#636363",
      ["M-AP-1"], "#f1eef6",
      ["M-AP-2"], "#bdc9e1",
      ["M-AP-3"], "#74a9cf",
      ["M-AP-4"], "#2b8cbe",
      ["UC"], "#045a8d",
      ["RO"], "#f0f9e8",
      ["RO-1"], "#bae4bc",
      ["OP"], "#7bccc4",
      ["OP-1"], "#2b8cbe",
      ["RM-12"], "#ede5cf",
      ["RM-24"], "#d39c83",
      ["RM-16"], "#e0c2a2",
      ["RM-24/18", "RM-18"], "hsl(5, 40%, 60%)",
      ["RM-35"], "#a65461",
      ["RM-50"], "hsl(337, 40%, 36%)",
      ["RM-75"], "#541f3f",
      ["RS-50"], "#ecda9a",
      ["RS-60"], "#efc47e",
      ["RS-75"], "#f3ad6a",
      ["RS-100"], "#f7945d",
      ["RS-150"], "#f97b57",
      ["YC-1"], "#fde0c5",
      ["YC-2"], "#facba6",
      ["YC-3"], "#f8b58b",
      ["YC-4"], "#f59e72",
      ["YC-5"], "#f2855d",
      ["YC-6"], "#ef6a4c",
      ["YC-7"], "#eb4a40",
      ["YC-8"], "hsl(4, 74%, 53%)",
      ["YC-9"], "#8e3029",
      ["CD-1"], "#ffffd4",
      ["CD-3"], "#fe9929",
      ["CBD-1"], "#d95f0e",
      ["CBD-2"], "#993404",
      ["PD-A"], "#ffdd9a",
      ["CU"], "#ffc285",
      ["CD-2"], "#fed98e",
      ["SH-RS"], "#fbe6c5",
      ["SH-RS-A"], "#f5ba98",
      ["SH-RM"], "#ee8a82",
      ["SH-RO"], "#dc7176",
      ["SH-CN"], "#c8586c",
      ["SH-CG"], "#b84b61",
      ["SH-CI"], "#9c3f5d",
      ["SH-PD"], "#8a3554",
      ["NMU-35"], "#f07c72",
      "hsl(220, 3%, 99%)",
    ],
  ];

  const ZONING_LEGEND = [
    ["A — Agricultural", "#006d2c"], ["RS-50", "#ecda9a"], ["RS-60", "#efc47e"],
    ["RS-75", "#f3ad6a"], ["RS-100", "#f7945d"], ["RS-150", "#f97b57"],
    ["RM-12", "#ede5cf"], ["RM-16", "#e0c2a2"], ["RM-18/24", "hsl(5, 40%, 60%)"],
    ["RM-24", "#d39c83"], ["RM-35", "#a65461"], ["RM-50", "hsl(337, 40%, 36%)"],
    ["RM-75", "#541f3f"], ["RO", "#f0f9e8"], ["RO-1", "#bae4bc"],
    ["OP", "#7bccc4"], ["OP-1", "#2b8cbe"], ["CN", "#ffeda0"],
    ["CG", "#feb24c"], ["CI", "#f03b20"], ["CU", "#ffc285"],
    ["CD-1", "#ffffd4"], ["CD-2", "#fed98e"], ["CD-3", "#fe9929"],
    ["CBD-1", "#d95f0e"], ["CBD-2", "#993404"], ["IG", "#bdbdbd"],
    ["IH", "#636363"], ["PD / PD-*", "#14B8A6"], ["PD-A", "#ffdd9a"],
    ["NMU-35", "#f07c72"], ["UC", "#045a8d"], ["M-AP-1", "#f1eef6"],
    ["M-AP-2", "#bdc9e1"], ["M-AP-3", "#74a9cf"], ["M-AP-4", "#2b8cbe"],
    ["SH-RS", "#fbe6c5"], ["SH-RS-A", "#f5ba98"], ["SH-RM", "#ee8a82"],
    ["SH-RO", "#dc7176"], ["SH-CN", "#c8586c"], ["SH-CG", "#b84b61"],
    ["SH-CI", "#9c3f5d"], ["SH-PD", "#8a3554"], ["YC-1", "#fde0c5"],
    ["YC-2", "#facba6"], ["YC-3", "#f8b58b"], ["YC-4", "#f59e72"],
    ["YC-5", "#f2855d"], ["YC-6", "#ef6a4c"], ["YC-7", "#eb4a40"],
    ["YC-8", "hsl(4, 74%, 53%)"], ["YC-9", "#8e3029"],
  ];

  const FLU_LEGEND = [
    ["CBD", "hsl(0, 100%, 24%)"], ["CC-35", "hsl(0, 100%, 50%)"],
    ["CMU-35", "hsl(314, 59%, 82%)"], ["ESA", "hsl(145, 100%, 85%)"],
    ["GMU-24", "hsl(275, 100%, 92%)"], ["HI", "hsl(0, 0%, 31%)"],
    ["LI", "hsl(0, 0%, 61%)"], ["MacDill AFB", "hsl(207, 74%, 65%)"],
    ["M-AP", "hsl(0, 0%, 82%)"], ["NMU-16", "hsl(36, 36%, 73%)"],
    ["NMU-24", "hsl(25, 50%, 61%)"], ["NMU-35", "hsl(0, 67%, 72%)"],
    ["P/QP", "hsl(207, 74%, 65%)"], ["R/OS", "hsl(97, 42%, 73%)"],
    ["R/W", "hsl(235, 17%, 74%)"], ["R-3", "hsl(60, 100%, 50%)"],
    ["R-6", "hsl(55, 100%, 50%)"], ["R-10", "hsl(27, 100%, 74%)"],
    ["R-20", "hsl(28, 37%, 44%)"], ["R-35", "hsl(34, 100%, 28%)"],
    ["R-50", "hsl(18, 100%, 25%)"], ["R-83", "hsl(24, 93%, 16%)"],
    ["RE-10", "hsl(85, 100%, 79%)"], ["RMU-100", "hsl(333, 48%, 49%)"],
    ["SMU-3", "hsl(314, 100%, 50%)"], ["SMU-6", "hsl(330, 100%, 87%)"],
    ["TA", "hsl(0, 0%, 100%)"], ["TU-24", "hsl(0, 51%, 60%)"],
    ["UMU-60", "hsl(279, 100%, 87%)"],
  ];

  // ── shared helpers ──────────────────────────────────────────────────

  const attrJson = (el, name, fallback) => {
    const v = el.dataset[name];
    if (!v) return fallback;
    try { return JSON.parse(v); } catch { return fallback; }
  };
  const attrNum = (el, name, fallback) =>
    el.dataset[name] !== undefined ? parseFloat(el.dataset[name]) : fallback;

  function baseStyle() {
    // @protomaps/basemaps supplies the full layer stack for the flavor;
    // fall back to a bare background if the CDN script failed.
    let layers = window.basemaps
      ? basemaps.layers("protomaps", basemaps.namedFlavor("white"))
      : [{ id: "bg", type: "background", paint: { "background-color": "#f6f6f4" } }];
    // The white flavor's road casings are pure #fff — invisible on the bare
    // basemap, but once zoning/FLU colors sit under the roads they flank every
    // street with fat white strokes (line-gap-width draws them outside the road
    // fill), roughly doubling apparent road width. Drop them; the near-white
    // road fills alone read as thin lines over the data, like the Mapbox style.
    layers = layers.filter((l) => !/^roads_.*casing/.test(l.id));
    return {
      version: 8,
      glyphs: GLYPHS,
      sprite: SPRITE,
      sources: {
        protomaps: {
          type: "vector",
          url: `pmtiles://${TILES}/basemap.pmtiles`,
          attribution: '<a href="https://protomaps.com">Protomaps</a> · <a href="https://openstreetmap.org">OSM</a>',
        },
      },
      layers,
    };
  }

  function makeMap(el, { pitchable = false } = {}) {
    const map = new maplibregl.Map({
      container: el,
      style: baseStyle(),
      center: attrJson(el, "center", [-82.46, 27.96]),
      zoom: attrNum(el, "zoom", 11),
      pitch: pitchable ? attrNum(el, "pitch", 0) : 0,
      bearing: pitchable ? attrNum(el, "bearing", 0) : 0,
    });
    map.addControl(new maplibregl.FullscreenControl(), "top-right");
    map.addControl(new maplibregl.NavigationControl(), "top-right");
    return map;
  }

  // Insertion anchors in the Protomaps basemap so data layers sit UNDER the
  // road network / labels instead of shading over them (the drew-park-cra
  // pattern): fills go before roads_runway (bottom of the roads stack),
  // overlays like parcel highlights before roads_labels_major. Fallback
  // scans by prefix/type in case the basemap layer ids shift between
  // @protomaps/basemaps versions.
  function beforeRoads(map) {
    if (map.getLayer("roads_runway")) return "roads_runway";
    return map.getStyle().layers.find((l) => l.id.startsWith("roads"))?.id;
  }
  function beforeLabels(map) {
    if (map.getLayer("roads_labels_major")) return "roads_labels_major";
    return map.getStyle().layers.find((l) => l.type === "symbol")?.id;
  }

  function addPlanningSource(map) {
    map.addSource("planning", { type: "vector", url: `pmtiles://${TILES}/planning.pmtiles` });
  }

  function addFluLayer(map, { visible = true, beforeId } = {}) {
    map.addLayer({
      id: "flu-fill", type: "fill", source: "planning", "source-layer": "future-land-use",
      layout: { visibility: visible ? "visible" : "none" },
      paint: { "fill-color": FLU_FILL_COLOR, "fill-opacity": 0.6 },
    }, beforeId);
  }

  function addZoningLayer(map, { visible = true, beforeId } = {}) {
    map.addLayer({
      id: "zoning-fill", type: "fill", source: "planning", "source-layer": "current-zoning",
      layout: { visibility: visible ? "visible" : "none" },
      paint: { "fill-color": ZONING_FILL_COLOR, "fill-opacity": 0.7 },
    }, beforeId);
  }

  function add3dBuildings(map) {
    if (map.getLayer("buildings")) map.removeLayer("buildings");
    map.addLayer({
      id: "buildings-3d", type: "fill-extrusion", source: "protomaps", "source-layer": "buildings",
      filter: ["in", "kind", "building", "building_part"],
      paint: {
        "fill-extrusion-color": "#ddd",
        "fill-extrusion-height": ["interpolate", ["linear"], ["zoom"], 14, 0, 15, ["coalesce", ["get", "height"], 8]],
        "fill-extrusion-base": ["coalesce", ["get", "min_height"], 0],
        "fill-extrusion-opacity": 0.7,
      },
    });
  }

  // parcels: invisible fill for hit-testing + green outline for highlights
  // (inserted above roads, below labels — the WP map's road-label anchor)
  function addParcelsLayers(map, beforeId) {
    map.addSource("parcels", { type: "vector", url: `pmtiles://${TILES}/parcels.pmtiles` });
    map.addLayer({
      id: "parcels-fill", type: "fill", source: "parcels", "source-layer": "parcels",
      minzoom: 12, paint: { "fill-opacity": 0 },
    }, beforeId);
    map.addLayer({
      id: "parcels-highlight", type: "line", source: "parcels", "source-layer": "parcels",
      filter: ["in", ["get", "FOLIO"], ["literal", []]],
      paint: { "line-color": "#00FF00", "line-width": 4 },
    }, beforeId);
  }
  const highlightFolios = (map, folios) =>
    map.setFilter("parcels-highlight", ["in", ["get", "FOLIO"], ["literal", folios]]);

  // bounding box of a GeoJSON Polygon/MultiPolygon (queryRenderedFeatures
  // geometry — already reprojected to lng/lat), by recursing to the numeric
  // coordinate pairs regardless of nesting depth.
  function bboxOf(geometry) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const walk = (c) => {
      if (typeof c[0] === "number") {
        const [x, y] = c;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      } else {
        c.forEach(walk);
      }
    };
    walk(geometry.coordinates);
    return [minX, minY, maxX, maxY];
  }

  // Screen-pixel radii to progressively widen a parcel lookup around a
  // point, in a fixed search order (nearer radii win). An exact-pixel query
  // (radius 0) very often misses outright: the permit feed's coordinate is a
  // geocoded ADDRESS point (Accela), which routinely lands on the street/ROW
  // rather than strictly inside its own parcel's polygon — confirmed live
  // against the 7/23 CRA/evening agenda's 10 permit markers, most of which
  // needed a widened box to resolve at all. Capped at 50px (roughly a parcel
  // width at z16) so a miss doesn't silently grab an unrelated neighbor.
  const FOLIO_SEARCH_RADII = [0, 8, 16, 24, 32, 40, 50];

  // Parcel nearest a point — parcels-fill only renders from z12, so this
  // returns null while zoomed out. Widens the search per FOLIO_SEARCH_RADII
  // (see above) until it finds a candidate; among several hits at the
  // winning radius, picks whichever polygon's bounding-box center is
  // nearest the point (cheap approximation — parcels are small enough that
  // squared-degree distance orders correctly at Tampa's latitude).
  function folioAt(map, lngLat) {
    const ll = maplibregl.LngLat.convert(lngLat);
    const pt = map.project(ll);
    for (const r of FOLIO_SEARCH_RADII) {
      const hits = r === 0
        ? map.queryRenderedFeatures(pt, { layers: ["parcels-fill"] })
        : map.queryRenderedFeatures(
            [[pt.x - r, pt.y - r], [pt.x + r, pt.y + r]],
            { layers: ["parcels-fill"] },
          );
      if (!hits.length) continue;
      if (hits.length === 1) return hits[0].properties.FOLIO;
      let best = hits[0], bestD = Infinity;
      for (const f of hits) {
        const [minX, minY, maxX, maxY] = bboxOf(f.geometry);
        const d = ((minX + maxX) / 2 - ll.lng) ** 2 + ((minY + maxY) / 2 - ll.lat) ** 2;
        if (d < bestD) { bestD = d; best = f; }
      }
      return best.properties.FOLIO;
    }
    return null;
  }

  /** Collapsible overlay panel (details/summary) at a data-* position. */
  function panel(el, { title, position = "bottom-left", open }) {
    const details = document.createElement("details");
    details.className = `map-panel map-panel--${position}`;
    details.open = open ?? el.clientWidth > 640;
    const summary = document.createElement("summary");
    summary.textContent = title;
    const body = document.createElement("div");
    body.className = "map-panel__body";
    details.append(summary, body);
    el.appendChild(details);
    return body;
  }

  function legendRows(body, sections) {
    body.textContent = "";
    for (const [label, entries] of sections) {
      const h = document.createElement("div");
      h.className = "map-legend__row";
      h.innerHTML = `<strong>${label}</strong>`;
      body.appendChild(h);
      for (const [name, color] of entries) {
        const row = document.createElement("div");
        row.className = "map-legend__row";
        const swatch = document.createElement("div");
        swatch.className = "map-legend__swatch";
        swatch.style.background = color;
        const span = document.createElement("span");
        span.textContent = name;
        row.append(swatch, span);
        body.appendChild(row);
      }
    }
  }

  function planningPopup(map, layers) {
    map.on("click", (e) => {
      // outline the clicked parcel — or clear it when clicking empty ground
      if (map.getLayer("parcels-fill")) {
        const folio = folioAt(map, e.lngLat);
        highlightFolios(map, folio ? [folio] : []);
      }
      const features = map.queryRenderedFeatures(e.point, { layers });
      if (!features.length) return;
      let html = '<p class="map-popup__title">Zoning information</p>';
      const zoning = features.find((f) => f.layer.id === "zoning-fill");
      if (zoning) {
        html += `<div class="map-popup__row"><span class="map-popup__label">Current zoning</span><span>${zoning.properties.ZONECLASS || "N/A"}</span></div>`;
      }
      const flu = features.find((f) => f.layer.id === "flu-fill");
      if (flu) {
        const label = (flu.properties.UNIQ_VAL || "N/A").replace(/^TAMPA_/, "");
        html += `<div class="map-popup__row"><span class="map-popup__label">Future land use</span><span>${label}</span></div>`;
      }
      new maplibregl.Popup({ maxWidth: "300px" }).setLngLat(e.lngLat).setHTML(html).addTo(map);
    });
    for (const id of layers) {
      map.on("mouseenter", id, () => { map.getCanvas().style.cursor = "pointer"; });
      map.on("mouseleave", id, () => { map.getCanvas().style.cursor = ""; });
    }
  }

  // ── boot: land-use map (/tampa-land-use-map/) ───────────────────────

  function bootPlanning(el) {
    const map = makeMap(el, { pitchable: true });

    map.on("load", () => {
      const roads = beforeRoads(map);
      addPlanningSource(map);
      // FLU under zoning, both under the road network + labels
      addFluLayer(map, { beforeId: roads });
      addZoningLayer(map, { beforeId: roads });
      // parcels give click-to-outline on the land-use map too, matching WP
      addParcelsLayers(map, beforeLabels(map));
      // extrusions append at the TOP of the stack (planning.html order) —
      // anything drawn after them paints over the towers, which is exactly
      // how they vanished under the zoning fills when inserted low
      add3dBuildings(map);
      planningPopup(map, ["zoning-fill", "flu-fill"]);

      let renderLegend = () => {};

      // layer toggles
      const controls = panel(el, { title: "Layers", position: "top-left", open: true });
      const toggles = [
        ["Current Zoning", "zoning-fill", true],
        ["Future Land Use", "flu-fill", true],
        ["3D Buildings", "buildings-3d", true],
      ];
      for (const [label, layerId, checked] of toggles) {
        const lab = document.createElement("label");
        const input = document.createElement("input");
        input.type = "checkbox";
        input.checked = checked;
        input.addEventListener("change", () => {
          map.setLayoutProperty(layerId, "visibility", input.checked ? "visible" : "none");
          renderLegend();
        });
        lab.append(input, document.createTextNode(label));
        controls.appendChild(lab);
      }

      // legend
      if (el.dataset.showLegend === "true") {
        const legendBody = panel(el, {
          title: "Legend",
          position: el.dataset.legendPosition || "bottom-left",
        });
        renderLegend = () => {
          const sections = [];
          if (map.getLayoutProperty("zoning-fill", "visibility") !== "none") sections.push(["Zoning", ZONING_LEGEND]);
          if (map.getLayoutProperty("flu-fill", "visibility") !== "none") sections.push(["Future Land Use", FLU_LEGEND]);
          legendRows(legendBody, sections);
        };
        renderLegend();
      }
    });
  }

  // ── boot: agenda / current-dev map (mapbox-block) ───────────────────
  //
  // Weekly-agenda mounts carry:
  //   data-records "RECORDID:agendaItem, …"  — agendaItem is the item's number
  //     in the post's own ordered list, display text only; RECORDID matches the
  //     Datasette feed's RECORDID exactly.
  //   data-folios  "RECORDID:lat,lng:folio,folio|RECORDID:lat,lng|…" — explicit
  //     coords (+ optional parcel folios) for items not in the feed (SU/VAC/
  //     TA-CPA). Folio values match parcels.pmtiles FOLIO with dots stripped.
  //   data-geojson-endpoint — DEAD attribute from a pre-Datasette version of
  //     the WP block; deliberately ignored.
  // Points feed: Michael's Datasette (dev-coord). Fetched directly — requires
  // CORS enabled on that instance; degrades gracefully (zoning, parcels and
  // folio markers still render) when the fetch fails.

  const DEV_FEED = "https://dev-coord.tampamonitor.com/locations/current.json?_shape=objects&_size=max";

  function parseRecords(raw) {
    if (!raw) return [];
    return raw.split(",").map((s) => s.trim()).filter(Boolean).map((entry) => {
      const parts = entry.split(":");
      return { recordId: parts[0].trim(), agendaItem: parts.slice(1).join(":").trim() };
    });
  }

  const COORDS_RE = /^(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)$/;

  function parseFolios(raw) {
    if (!raw) return [];
    const out = [];
    for (const entry of raw.split("|").map((s) => s.trim()).filter(Boolean)) {
      const parts = entry.split(":").map((s) => s.trim());
      const recordId = parts[0];
      let coords = null;
      let folios = [];
      if (parts.length >= 3) {
        const m = parts[1].match(COORDS_RE);
        if (m) coords = [parseFloat(m[2]), parseFloat(m[1])]; // lng, lat
        folios = parts[2].split(",").map((f) => f.trim().replace(".", "")).filter(Boolean);
      } else if (parts.length === 2) {
        const m = parts[1].match(COORDS_RE);
        if (m) coords = [parseFloat(m[2]), parseFloat(m[1])];
        else folios = parts[1].split(",").map((f) => f.trim().replace(".", "")).filter(Boolean);
      }
      if (coords) out.push({ recordId, coords, folios });
    }
    return out;
  }

  function recordType(id) {
    if (/^REZ/.test(id)) return "Rezoning";
    if (/^SU/.test(id)) return "Special Use";
    if (/^VAC/.test(id)) return "Vacating";
    if (/^AB/.test(id)) return "Alcoholic Beverage";
    if (/^TA|^CPA/.test(id)) return "Plan Amendment";
    if (/^DE/.test(id)) return "Design Exception";
    return "Council item";
  }

  // Resolve a display item number to its on-page anchor href so the popup can
  // deep-link into the agenda. The agenda body renders each item as
  //   <article class="agenda-item" id="item-<internalId>">
  //     <h3 …><a class="agenda-item__anchor" href="#item-<internalId>">N</a> …
  // where N is the display number data-records also carries (RECORDID:N). The
  // internal id isn't in the map data, so match on the anchor's visible number
  // and reuse its own href. Scoped to `root` (the mount's post <article>) so a
  // page with two agendas can't cross-link. Returns null when no item matches
  // (unknown number, or the map embedded outside an agenda) → plain text.
  function agendaItemHref(root, displayNumber) {
    const want = String(displayNumber).trim();
    for (const a of root.querySelectorAll(".agenda-item__anchor")) {
      if (a.textContent.trim() === want) return a.getAttribute("href");
    }
    return null;
  }

  function zoningInfoHtml(map, point) {
    const feats = map.queryRenderedFeatures(point, { layers: ["zoning-fill", "flu-fill"] });
    let html = "";
    const zoning = feats.find((f) => f.layer.id === "zoning-fill");
    if (zoning) html += `<div class="map-popup__row"><span class="map-popup__label">Zoning</span><span>${zoning.properties.ZONECLASS || "N/A"}</span></div>`;
    const flu = feats.find((f) => f.layer.id === "flu-fill");
    if (flu) html += `<div class="map-popup__row"><span class="map-popup__label">Future land use</span><span>${(flu.properties.UNIQ_VAL || "N/A").replace(/^TAMPA_/, "")}</span></div>`;
    return html;
  }

  function bootAgenda(el) {
    const records = parseRecords(el.dataset.records);
    const folios = parseFolios(el.dataset.folios);
    const folioIds = new Set(folios.map((f) => f.recordId));
    const agendaItemFor = (id) => records.find((r) => r.recordId === id)?.agendaItem || "";
    // the mount's post <article>, scope for resolving agenda-item deep links
    const root = el.closest("article.post") || document;
    const map = makeMap(el);

    map.on("load", async () => {
      const roads = beforeRoads(map);
      const labels = beforeLabels(map);
      addPlanningSource(map);
      addFluLayer(map, { beforeId: roads });
      addZoningLayer(map, { beforeId: roads });

      addParcelsLayers(map, labels);

      // purple markers: items with explicit coords from data-folios
      map.addSource("folio-markers", {
        type: "geojson",
        data: {
          type: "FeatureCollection",
          features: folios.map((f) => ({
            type: "Feature",
            geometry: { type: "Point", coordinates: f.coords },
            properties: {
              RECORDID: f.recordId,
              RECORDALIAS: recordType(f.recordId),
              FOLIOS: f.folios.join(","),
            },
          })),
        },
      });
      map.addLayer({
        id: "folio-markers-layer", type: "circle", source: "folio-markers",
        paint: { "circle-radius": 10, "circle-color": "#9333EA", "circle-stroke-width": 2, "circle-stroke-color": "#fff" },
      });

      // blue markers: current-dev permit points from the Datasette feed
      try {
        const res = await fetch(DEV_FEED);
        const data = await res.json();
        const features = (data.rows || [])
          .filter((row) => records.some((r) => r.recordId === row.RECORDID) && !folioIds.has(row.RECORDID))
          .map((row) => {
            let geometry = null;
            try { geometry = JSON.parse(row.geometry); } catch { /* skip */ }
            return geometry && {
              type: "Feature",
              geometry,
              properties: { RECORDID: row.RECORDID, RECORDALIAS: row.Type, ADDRESS: row.ADDRESS || "", URL: row.URL || "" },
            };
          })
          .filter(Boolean);
        map.addSource("geojson-data", { type: "geojson", data: { type: "FeatureCollection", features } });
        map.addLayer({
          id: "geojson-layer", type: "circle", source: "geojson-data",
          paint: { "circle-radius": 10, "circle-color": "#007cbf", "circle-stroke-width": 2, "circle-stroke-color": "#fff" },
        });
      } catch {
        // feed unreachable (offline / CORS not yet enabled) — zoning, parcels
        // and folio markers still render
      }

      // interactions
      map.on("click", (e) => {
        const hits = map.queryRenderedFeatures(e.point, {
          layers: ["folio-markers-layer", "geojson-layer", "parcels-fill"].filter((l) => map.getLayer(l)),
        });
        if (!hits.length) return;
        const marker = hits.find((f) => f.layer.id !== "parcels-fill");

        if (marker) {
          const p = marker.properties;
          let html = `<p class="map-popup__title">${p.RECORDID}</p>`;
          html += `<div class="map-popup__row"><span class="map-popup__label">Type</span><span>${p.RECORDALIAS || ""}</span></div>`;
          if (p.ADDRESS) html += `<div class="map-popup__row"><span class="map-popup__label">Address</span><span>${p.ADDRESS}</span></div>`;
          const item = agendaItemFor(p.RECORDID);
          if (item) {
            const href = agendaItemHref(root, item);
            const itemHtml = href ? `<a href="${href}">${item}</a>` : item;
            html += `<div class="map-popup__row"><span class="map-popup__label">Agenda item</span><span>${itemHtml}</span></div>`;
          }
          html += zoningInfoHtml(map, e.point);
          if (p.URL) html += `<p><a href="${p.URL}" target="_blank" rel="noopener">Accela record →</a></p>`;
          new maplibregl.Popup({ maxWidth: "320px" }).setLngLat(e.lngLat).setHTML(html).addTo(map);

          // highlight the record's parcels; fly closer if zoomed out.
          // Folio markers carry their parcel list; the Datasette permit dots
          // don't, so fall back to the parcel under the dot (WP behavior) —
          // a dot alone doesn't show the extent of the property.
          const coords = marker.geometry.coordinates;
          let parcelIds = (p.FOLIOS || "").split(",").filter(Boolean);
          if (!parcelIds.length) {
            const folio = folioAt(map, coords);
            if (folio) parcelIds = [folio];
          }
          highlightFolios(map, parcelIds);
          if (map.getZoom() < 16) {
            map.flyTo({ center: coords, zoom: 16, speed: 1.1 });
            // parcels only render from z12 — if the lookup missed because we
            // were zoomed out, retry once the flight lands and tiles load
            if (!parcelIds.length) {
              map.once("idle", () => {
                const folio = folioAt(map, coords);
                if (folio) highlightFolios(map, [folio]);
              });
            }
          }
          return;
        }

        // bare parcel click: outline it + zoning info
        const parcel = hits.find((f) => f.layer.id === "parcels-fill");
        if (parcel) {
          map.setFilter("parcels-highlight", ["in", ["get", "FOLIO"], ["literal", [parcel.properties.FOLIO]]]);
          const info = zoningInfoHtml(map, e.point);
          if (info) {
            new maplibregl.Popup({ maxWidth: "300px" }).setLngLat(e.lngLat)
              .setHTML(`<p class="map-popup__title">Parcel</p>${info}`).addTo(map);
          }
        }
      });

      for (const id of ["folio-markers-layer", "geojson-layer"]) {
        map.on("mouseenter", id, () => { map.getCanvas().style.cursor = "pointer"; });
        map.on("mouseleave", id, () => { map.getCanvas().style.cursor = ""; });
      }

      // legend: zoning + FLU swatches (matches the WP LegendControl scope)
      if (el.dataset.showLegend === "true") {
        const legendBody = panel(el, {
          title: "Legend",
          position: el.dataset.legendPosition || "bottom-left",
          open: false,
        });
        legendRows(legendBody, [["Zoning", ZONING_LEGEND], ["Future Land Use", FLU_LEGEND]]);
      }
    });
  }

  // ── named boundary maps (WP monitor-blocks ports, 2026-07-16) ────────
  //
  // Faithful ports of the five named WP map blocks: same palettes, popups
  // and legends, re-pointed from Mapbox tilesets to self-hosted PMTiles.
  // Mounts carry only data-center / data-zoom (makeMap reads both).

  // Tampa's councilmembers for districts 1–3 are elected citywide, so the
  // districts file carries only the four residency districts 4–7.
  const DISTRICT_COLORS = { 4: "#e41a1c", 5: "#377eb8", 6: "#4daf4a", 7: "#984ea3" };
  const DISTRICT_LEGEND = Object.entries(DISTRICT_COLORS).map(([d, c]) => [`District ${d}`, c]);

  const CRA_COLORS = {
    "Central Park": "#E74C3C",
    "Channel District": "#2ECC71",
    "Downtown Non Core": "#3498DB",
    "Downtown Core": "#2980B9",
    "Drew Park": "#F39C12",
    "East Tampa": "#9B59B6",
    "Tampa Heights Riverfront": "#1ABC9C",
    "Ybor City 1": "#E67E22",
    "Ybor City 2": "#D35400",
    "West Tampa": "#34495E",
  };

  // The 2026 city dataset carries six districts; the WP-era tileset's other
  // four (East Tampa, Drew Park, West Tampa, Ybor City) are gone from the
  // source. Colors kept from the WP block for the survivors.
  const IMPACT_FEE_COLORS = {
    "Central Business District 25.1A": "#8E44AD",
    "Central East District 25.1B": "#E74C3C",
    "Interbay District 25.1C": "#F39C12",
    "North Central District 25.1D": "#34495E",
    "University North District 25.1E": "#F1C40F",
    "Westshore District 25.1F": "#1ABC9C",
  };
  const IMPACT_FEE_SUFFIX = /\s+25\.\d+[A-Z]$/;

  // Which precinct went to which district in the March 2026 redistricting.
  const REDISTRICTING_PRECINCTS = {
    141: "6", 151: "6", 169: "5", 207: "5",
    249: "7", 250: "7", 320: "6", 342: "7", 345: "7",
  };

  // Per-precinct stats from the March 2026 redistricting coverage — frozen
  // analysis numbers (SOE registration + census estimates), formerly
  // duplicated inline in the WP block code. Keys match precincts.pmtiles
  // PRECINCT values.
  const PRECINCT_STATS = {
    141: { district: 6, voters: "1,303", demPct: "33.8%", repPct: "37.6%", lean: "Competitive", turnout: "18.3%", income: "$97,087", white: "78.9%", black: "1.8%", hispanic: "20.6%" },
    151: { district: 6, voters: "1,368", demPct: "30.1%", repPct: "39.3%", lean: "Lean R", turnout: "10.3%", income: "$120,499", white: "80.1%", black: "6.5%", hispanic: "10.3%" },
    169: { district: 5, voters: "2,395", demPct: "45.1%", repPct: "26.3%", lean: "Lean D", turnout: "10.2%", income: "$48,251", white: "64.7%", black: "26.0%", hispanic: "17.2%" },
    207: { district: 5, voters: "1,656", demPct: "58.1%", repPct: "15.9%", lean: "Strong D", turnout: "8.4%", income: "$23,392", white: "31.5%", black: "52.5%", hispanic: "36.2%" },
    249: { district: 7, voters: "2,333", demPct: "33.3%", repPct: "37.5%", lean: "Competitive", turnout: "12.9%", income: "$77,666", white: "77.2%", black: "0.9%", hispanic: "43.1%" },
    250: { district: 7, voters: "227", demPct: "31.3%", repPct: "41.0%", lean: "Lean R", turnout: "8.5%", income: "$96,373", white: "78.4%", black: "8.4%", hispanic: "12.6%" },
    320: { district: 6, voters: "685", demPct: "51.8%", repPct: "17.4%", lean: "Strong D", turnout: "13.8%", income: "$85,391", white: "56.0%", black: "34.0%", hispanic: "23.4%" },
    342: { district: 7, voters: "2,285", demPct: "50.9%", repPct: "17.5%", lean: "Strong D", turnout: "8.0%", income: "$31,459", white: "37.8%", black: "33.8%", hispanic: "39.4%" },
    345: { district: 7, voters: "2,061", demPct: "48.0%", repPct: "20.3%", lean: "Strong D", turnout: "5.6%", income: "$40,556", white: "31.0%", black: "41.7%", hispanic: "47.8%" },
  };

  // match-expression over a string property; keys coerced via to-string so
  // numeric tile values still hit
  function matchColor(prop, colors, fallback) {
    const expr = ["match", ["to-string", ["get", prop]]];
    for (const [k, v] of Object.entries(colors)) expr.push(k, v);
    expr.push(fallback);
    return expr;
  }

  const popupRow = (label, value) =>
    `<div class="map-popup__row"><span class="map-popup__label">${label}</span><span>${value}</span></div>`;

  // fill + outline pair in the WP block style (0.4 fill, matching border)
  function addBoundaryLayers(map, { id, source, sourceLayer, colors, beforeId, filter,
    fillOpacity = 0.4, lineWidth = 2, lineOpacity = 0.8, prop }) {
    const base = {
      source, "source-layer": sourceLayer, ...(filter ? { filter } : {}),
    };
    map.addLayer({
      id: `${id}-fill`, type: "fill", ...base,
      paint: { "fill-color": matchColor(prop, colors, "#cccccc"), "fill-opacity": fillOpacity },
    }, beforeId);
    map.addLayer({
      id: `${id}-line`, type: "line", ...base,
      paint: {
        "line-color": matchColor(prop, colors, "#999999"),
        "line-width": lineWidth, "line-opacity": lineOpacity,
      },
    }, beforeId);
  }

  function addDistrictLayers(map, beforeId) {
    map.addSource("districts", { type: "vector", url: `pmtiles://${TILES}/tampa-municipal-districts.pmtiles` });
    addBoundaryLayers(map, {
      id: "districts", source: "districts", sourceLayer: "tampa-municipal-districts",
      prop: "DISTRICTID", colors: DISTRICT_COLORS, beforeId,
    });
  }

  const districtPopupHtml = (p) =>
    `<p class="map-popup__title">City Council District ${p.DISTRICTID}</p>` +
    popupRow("District", p.DISTRICTID);

  // click popup + pointer cursor on one fill layer
  function fillPopup(map, layerId, htmlFor) {
    map.on("click", (e) => {
      const f = map.queryRenderedFeatures(e.point, { layers: [layerId] })[0];
      if (!f) return;
      new maplibregl.Popup({ maxWidth: "300px" }).setLngLat(e.lngLat).setHTML(htmlFor(f.properties)).addTo(map);
    });
    map.on("mouseenter", layerId, () => { map.getCanvas().style.cursor = "pointer"; });
    map.on("mouseleave", layerId, () => { map.getCanvas().style.cursor = ""; });
  }

  function bootDistricts(el) {
    const map = makeMap(el);
    map.on("load", () => {
      addDistrictLayers(map, beforeRoads(map));
      fillPopup(map, "districts-fill", districtPopupHtml);
      legendRows(panel(el, { title: "Legend" }), [["City Council Districts", DISTRICT_LEGEND]]);
    });
  }

  function bootCra(el) {
    const map = makeMap(el);
    map.on("load", () => {
      map.addSource("city-layers", { type: "vector", url: `pmtiles://${TILES}/city-layers.pmtiles` });
      addBoundaryLayers(map, {
        id: "cra", source: "city-layers", sourceLayer: "community-redevelopment",
        prop: "CRA_Name", colors: CRA_COLORS, beforeId: beforeRoads(map),
      });
      fillPopup(map, "cra-fill", (p) =>
        `<p class="map-popup__title">${p.CRA_Name} CRA</p>` +
        popupRow("Community Redevelopment Area", p.CRA_Name));
      legendRows(panel(el, { title: "Legend" }),
        [["Community Redevelopment Areas", Object.entries(CRA_COLORS)]]);
    });
  }

  function bootImpactFee(el) {
    const map = makeMap(el);
    map.on("load", () => {
      map.addSource("city-layers", { type: "vector", url: `pmtiles://${TILES}/city-layers.pmtiles` });
      addBoundaryLayers(map, {
        id: "impact-fee", source: "city-layers", sourceLayer: "impact-fee-districts",
        prop: "NAME", colors: IMPACT_FEE_COLORS, beforeId: beforeRoads(map), lineOpacity: 1,
      });
      fillPopup(map, "impact-fee-fill", (p) => {
        let html = `<p class="map-popup__title">${(p.NAME || "Unknown").replace(IMPACT_FEE_SUFFIX, "")}</p>` +
          popupRow("Type", "Transportation Impact Fee District");
        if (p.CODE) html += popupRow("District code", p.CODE);
        return html;
      });
      legendRows(panel(el, { title: "Legend" }), [[
        "Transportation Impact Fee Districts",
        Object.entries(IMPACT_FEE_COLORS).map(([n, c]) => [n.replace(IMPACT_FEE_SUFFIX, ""), c]),
      ]]);
    });
  }

  const LEAN_BADGES = { "Strong D": "dem", "Lean D": "dem", "Strong R": "rep", "Lean R": "rep", "Competitive": "comp" };

  // district comes from the booting map's own assignments, not the stats
  // table — the "updated" map shows 345's NEW district (5), while the stats
  // row carries its pre-move district (7)
  function precinctPopupHtml(id, s, districtLabel, district) {
    const badge = `<span class="map-popup__badge map-popup__badge--${LEAN_BADGES[s.lean] || "comp"}">${s.lean}</span>`;
    return `<p class="map-popup__title">Precinct ${id}</p>` +
      popupRow(districtLabel, district) +
      popupRow("Registered voters", s.voters) +
      popupRow("Partisan lean", badge) +
      popupRow("Dem / Rep", `${s.demPct} / ${s.repPct}`) +
      popupRow("2023 turnout", s.turnout) +
      '<p class="map-popup__section">Demographics (est.)</p>' +
      popupRow("Median income", s.income) +
      popupRow("White", s.white) +
      popupRow("Black", s.black) +
      popupRow("Hispanic", s.hispanic);
  }

  // Both precinct maps: council districts as background context, the affected
  // precincts colored by their district assignment, precinct-number labels,
  // click → stats popup (precinct wins over district).
  function bootPrecincts(el, { assignments, districtLabel, legendSection }) {
    const ids = Object.keys(assignments);
    const colors = Object.fromEntries(ids.map((id) => [id, DISTRICT_COLORS[assignments[id]]]));
    const map = makeMap(el);
    map.on("load", () => {
      const roads = beforeRoads(map);
      addDistrictLayers(map, roads);
      map.addSource("precincts", { type: "vector", url: `pmtiles://${TILES}/precincts.pmtiles` });
      const filter = ["in", ["to-string", ["get", "PRECINCT"]], ["literal", ids]];
      addBoundaryLayers(map, {
        id: "precincts", source: "precincts", sourceLayer: "precincts",
        prop: "PRECINCT", colors, beforeId: roads, filter,
        fillOpacity: 0.55, lineWidth: 2.5, lineOpacity: 0.9,
      });
      map.addLayer({
        id: "precincts-labels", type: "symbol", source: "precincts", "source-layer": "precincts",
        filter,
        layout: {
          "text-field": ["to-string", ["get", "PRECINCT"]],
          "text-font": ["Noto Sans Medium"], "text-size": 13, "text-allow-overlap": true,
        },
        paint: { "text-color": "#1a1a2e", "text-halo-color": "#ffffff", "text-halo-width": 1.5 },
      });

      map.on("click", (e) => {
        const precinct = map.queryRenderedFeatures(e.point, { layers: ["precincts-fill"] })[0];
        if (precinct) {
          const id = String(precinct.properties.PRECINCT);
          const stats = PRECINCT_STATS[id];
          if (!stats) return;
          new maplibregl.Popup({ maxWidth: "300px" }).setLngLat(e.lngLat)
            .setHTML(precinctPopupHtml(id, stats, districtLabel, assignments[id])).addTo(map);
          return;
        }
        const district = map.queryRenderedFeatures(e.point, { layers: ["districts-fill"] })[0];
        if (district) {
          new maplibregl.Popup({ maxWidth: "300px" }).setLngLat(e.lngLat)
            .setHTML(districtPopupHtml(district.properties)).addTo(map);
        }
      });
      for (const id of ["precincts-fill", "districts-fill"]) {
        map.on("mouseenter", id, () => { map.getCanvas().style.cursor = "pointer"; });
        map.on("mouseleave", id, () => { map.getCanvas().style.cursor = ""; });
      }

      const body = panel(el, { title: "Legend" });
      legendRows(body, [["Council districts", DISTRICT_LEGEND], legendSection]);
      const hint = document.createElement("p");
      hint.className = "map-legend__hint";
      hint.textContent = "Click a precinct for details";
      body.appendChild(hint);
    });
  }

  // ── toolshed maps (ported from ~/tampa-monitor/toolshed/maps/*.html, 2026-07-16) ──
  //
  // Destination maps under /toolshed/maps/ (drew-park also embeds in CRA
  // posts). Zipcodes + annexation fetch site-hosted copies of the toolshed
  // GeoJSON (source of truth: toolshed/boundaries/geojson — recopy on
  // refresh); drew-park reads the CRA boundary from city-layers.pmtiles.

  const DATA = "/assets/data/maps";

  const ZIP_CLASSES = {
    inside: { color: "#86b6ef", label: "Entirely in (≥97%)" },
    mostly_in: { color: "#3987e5", label: "Mostly in (50–97%)" },
    mostly_out: { color: "#1c5cab", label: "Mostly out (3–50%)" },
    outside: { color: "#0d366b", label: "Entirely out (<3%)" },
  };
  const STRIPE_COLOR = "#eda100";

  // 45° stripes on a transparent tile, for the "USPS also accepts an
  // incorporated city's name" overlay
  function stripedPattern(color) {
    const size = 16;
    const c = document.createElement("canvas");
    c.width = c.height = size;
    const ctx = c.getContext("2d");
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    for (const off of [-size, 0, size]) {
      ctx.beginPath();
      ctx.moveTo(off, size);
      ctx.lineTo(off + size, 0);
      ctx.stroke();
    }
    return ctx.getImageData(0, 0, size, size);
  }

  function bootZipcodes(el) {
    const map = makeMap(el);
    map.on("load", async () => {
      // text-free map: drop all basemap labels
      for (const layer of map.getStyle().layers) {
        if (layer.type === "symbol") map.setLayoutProperty(layer.id, "visibility", "none");
      }

      const geojson = await (await fetch(`${DATA}/tampa-zipcodes.geojson`)).json();

      // per-class counts for the legend + bounds to frame the view
      const counts = {};
      const bounds = new maplibregl.LngLatBounds();
      for (const f of geojson.features) {
        const p = f.properties;
        if (p.city_limits || p.label) continue;
        counts[p.cls] = (counts[p.cls] || 0) + 1;
        const rings = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
        for (const ring of rings) for (const pt of ring[0]) bounds.extend(pt);
      }
      map.fitBounds(bounds, { padding: 40, animate: false });

      map.addSource("zips", { type: "geojson", data: geojson, attribution: "Tampa GIS" });

      map.addLayer({
        id: "zips-fill", type: "fill", source: "zips",
        filter: ["all", ["==", ["geometry-type"], "Polygon"], ["!", ["has", "city_limits"]]],
        paint: {
          "fill-color": [
            "match", ["get", "cls"],
            ...Object.entries(ZIP_CLASSES).flatMap(([k, v]) => [k, v.color]),
            "#cccccc",
          ],
          "fill-opacity": 0.7,
        },
      });
      // striped overlay where USPS also accepts an incorporated city's name
      map.addImage("muni-stripes", stripedPattern(STRIPE_COLOR), { pixelRatio: 2 });
      map.addLayer({
        id: "zips-altmuni", type: "fill", source: "zips",
        filter: ["all", ["==", ["geometry-type"], "Polygon"], ["has", "alt_muni"]],
        paint: { "fill-pattern": "muni-stripes" },
      });
      // white gap between adjacent ZIP fills
      map.addLayer({
        id: "zips-outline", type: "line", source: "zips",
        filter: ["all", ["==", ["geometry-type"], "Polygon"], ["!", ["has", "city_limits"]]],
        paint: { "line-color": "#ffffff", "line-width": 1.25 },
      });
      map.addLayer({
        id: "city-line", type: "line", source: "zips",
        filter: ["has", "city_limits"],
        paint: { "line-color": "#0b0b0b", "line-width": 2.5 },
      });

      const enabled = new Set(Object.keys(ZIP_CLASSES));
      const applyFilter = () => {
        const inEnabled = ["in", ["get", "cls"], ["literal", [...enabled]]];
        map.setFilter("zips-fill", ["all", ["==", ["geometry-type"], "Polygon"], inEnabled]);
        map.setFilter("zips-outline", ["all", ["==", ["geometry-type"], "Polygon"], inEnabled]);
        map.setFilter("zips-altmuni", ["all", ["==", ["geometry-type"], "Polygon"], ["has", "alt_muni"], inEnabled]);
      };
      applyFilter();

      // legend: class toggles with counts, plus non-interactive key rows
      const body = panel(el, { title: "Share of ZIP land in city", position: "bottom-right" });
      for (const [cls, { color, label }] of Object.entries(ZIP_CLASSES)) {
        const row = document.createElement("label");
        row.className = "map-legend__row";
        const input = document.createElement("input");
        input.type = "checkbox";
        input.checked = true;
        input.addEventListener("change", () => {
          if (input.checked) enabled.add(cls); else enabled.delete(cls);
          applyFilter();
        });
        const swatch = document.createElement("span");
        swatch.className = "map-legend__swatch";
        swatch.style.background = color;
        const name = document.createElement("span");
        name.textContent = label;
        const count = document.createElement("span");
        count.className = "map-legend__note";
        count.textContent = counts[cls] || 0;
        row.append(input, swatch, name, count);
        body.appendChild(row);
      }
      const cityRow = document.createElement("div");
      cityRow.className = "map-legend__row";
      cityRow.innerHTML = '<span class="map-legend__line"></span><span>City of Tampa limits</span>';
      body.appendChild(cityRow);
      const ttRow = document.createElement("div");
      ttRow.className = "map-legend__row";
      ttRow.innerHTML = `<span class="map-legend__swatch" style="background:repeating-linear-gradient(45deg,${STRIPE_COLOR} 0 3px,transparent 3px 6px)"></span><span>Temple Terrace also accepted</span>`;
      body.appendChild(ttRow);
      const note = document.createElement("p");
      note.className = "map-legend__hint";
      note.textContent = "A Tampa mailing address comes from USPS, not city hall — six of these ZIPs are entirely outside city limits. ZIP boundaries: Tampa GIS, clipped to the shoreline.";
      body.appendChild(note);

      fillPopup(map, "zips-fill", (p) => {
        let meta = "USPS default city: Tampa";
        if (p.acceptable && p.acceptable !== "null") meta += ` · also accepts “${p.acceptable}”`;
        return `<p class="map-popup__title">ZIP ${p.zip}</p>` +
          `<p>${p.pct_in}% of its land is inside city limits</p>` +
          `<p class="map-popup__meta">${meta}</p>`;
      });
    });
  }

  // Era-based classification — 1953 is the visual hero
  const ANNEXATION_ERAS = [
    { id: "founding", label: "Founding era", note: "1855–1911",
      years: ["1855", "1887", "1907", "1911"],
      color: "#c9b89a", opacity: 0.45, outlineWidth: 1 },
    { id: "y1923", label: "1923 expansion", note: null, years: ["1923"],
      color: "#d4a96a", opacity: 0.55, outlineWidth: 1.5 },
    { id: "y1925", label: "1925 expansion", note: null, years: ["1925"],
      color: "#e8a838", opacity: 0.6, outlineWidth: 1.5 },
    { id: "y1953", label: "1953 — Great Annexation", note: "Largest single expansion",
      years: ["1952", "1953"],
      color: "#c1121f", opacity: 0.72, outlineWidth: 3 },
    { id: "y1961", label: "1961 expansion", note: null, years: ["1961"],
      color: "#2a9d8f", opacity: 0.6, outlineWidth: 1.5 },
    { id: "northern", label: "Northern expansion", note: "1981–2013",
      years: ["1981", "1983", "1984", "1985", "1987", "1988",
        "1994", "1997", "1998", "2000", "2001", "2002", "2007", "2013"],
      color: "#6b8fa8", opacity: 0.45, outlineWidth: 1 },
  ];

  // ANNX_YR → the year's era value (color / opacity / outlineWidth)
  function annexationByYear(key, fallback) {
    const expr = ["match", ["get", "ANNX_YR"]];
    for (const era of ANNEXATION_ERAS) for (const yr of era.years) expr.push(yr, era[key]);
    expr.push(fallback);
    return expr;
  }

  function bootAnnexation(el) {
    const map = makeMap(el);
    map.on("load", async () => {
      // roadless basemap: annexation eras read better without the street grid
      // (toolshed filters road/tunnel/transit out of the style; hiding is equal)
      for (const layer of map.getStyle().layers) {
        if (/road|tunnel|transit/.test(layer.id)) map.setLayoutProperty(layer.id, "visibility", "none");
      }
      // fills go UNDER the basemap water fill so Tampa Bay masks any polygon
      // overlap into the bay
      const beforeFill = map.getLayer("water") ? "water" : beforeLabels(map);

      const [annexRes, boundaryRes] = await Promise.all([
        fetch(`${DATA}/tampa-annexation-history.geojson`),
        fetch(`${DATA}/tampa-boundary.geojson`),
      ]);
      const geojson = await annexRes.json();
      const boundaryGeojson = await boundaryRes.json();

      // sort descending by year: oldest renders last = visually on top
      geojson.features.sort((a, b) =>
        parseInt(b.properties.ANNX_YR, 10) - parseInt(a.properties.ANNX_YR, 10));

      map.addSource("annexations", { type: "geojson", data: geojson, generateId: true, attribution: "City of Tampa GIS" });
      map.addLayer({
        id: "annexations-fill", type: "fill", source: "annexations",
        paint: {
          "fill-color": annexationByYear("color", "#cccccc"),
          "fill-opacity": annexationByYear("opacity", 0.4),
        },
      }, beforeFill);
      map.addLayer({
        id: "annexations-outline", type: "line", source: "annexations",
        paint: {
          "line-color": annexationByYear("color", "#cccccc"),
          "line-width": annexationByYear("outlineWidth", 1),
          "line-opacity": 0.9,
        },
      }, beforeFill);
      // hover highlight — above water so it shows over the fills
      map.addLayer({
        id: "annexations-hover", type: "fill", source: "annexations",
        paint: {
          "fill-color": "#000",
          "fill-opacity": ["case", ["boolean", ["feature-state", "hover"], false], 0.12, 0],
        },
      });

      // current city limit, dashed
      map.addSource("tampa-boundary", { type: "geojson", data: boundaryGeojson });
      map.addLayer({
        id: "tampa-boundary-line", type: "line", source: "tampa-boundary",
        paint: { "line-color": "#1a1a1a", "line-width": 1.2, "line-dasharray": [5, 3] },
      }, beforeFill);

      // legend
      const body = panel(el, { title: "Annexation era" });
      for (const era of ANNEXATION_ERAS) {
        const row = document.createElement("div");
        row.className = "map-legend__row";
        const swatch = document.createElement("span");
        swatch.className = "map-legend__swatch";
        swatch.style.background = era.color;
        const name = document.createElement("span");
        name.textContent = era.label;
        row.append(swatch, name);
        if (era.note) {
          const note = document.createElement("span");
          note.className = "map-legend__note";
          note.textContent = era.note;
          row.append(note);
        }
        body.appendChild(row);
      }
      const boundaryRow = document.createElement("div");
      boundaryRow.className = "map-legend__row";
      boundaryRow.innerHTML = '<span class="map-legend__line map-legend__line--dashed"></span><span>Current city limit</span>';
      body.appendChild(boundaryRow);

      // fit to the land mass — hardcoded to keep the bay from pulling the view east
      map.fitBounds([[-82.66, 27.82], [-82.32, 28.18]], { padding: 40, maxZoom: 13 });

      // hover feature-state
      let hoveredId = null;
      map.on("mousemove", "annexations-fill", (e) => {
        if (!e.features.length) return;
        map.getCanvas().style.cursor = "pointer";
        const id = e.features[0].id;
        if (hoveredId !== null && hoveredId !== id) {
          map.setFeatureState({ source: "annexations", id: hoveredId }, { hover: false });
        }
        hoveredId = id;
        map.setFeatureState({ source: "annexations", id: hoveredId }, { hover: true });
      });
      map.on("mouseleave", "annexations-fill", () => {
        map.getCanvas().style.cursor = "";
        if (hoveredId !== null) {
          map.setFeatureState({ source: "annexations", id: hoveredId }, { hover: false });
          hoveredId = null;
        }
      });

      map.on("click", "annexations-fill", (e) => {
        const p = e.features[0].properties;
        const yr = p.ANNX_YR || "—";
        const era = ANNEXATION_ERAS.find((x) => x.years.includes(yr));
        const dateStr = p.DATE
          ? new Date(p.DATE).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" })
          : "—";
        new maplibregl.Popup({ maxWidth: "320px" }).setLngLat(e.lngLat).setHTML(
          `<p class="map-popup__title">Annexed ${yr}</p>` +
          popupRow("Era", era ? era.label : yr) +
          popupRow("Document", p.DOCUMENT || "—") +
          popupRow("Date", dateStr),
        ).addTo(map);
      });
    });
  }

  // HCPA parcel details for the three highlighted stadium-proposal parcels
  // (fetched 2026-05-07; refresh via toolshed hcpa/fetch_drew_park_parcels.py)
  const DREW_PARK_PARCELS = {
    "1090541000": { address: "4002 N DALE MABRY HWY, TAMPA", owner: "Hillsborough Community College (BD of Trustees)", acreage: 76.96 },
    "1090540010": { address: "4014 W DR MARTIN LUTHER KING JR BLVD, TAMPA", owner: "Board of Trustees of HCC", acreage: 23.88 },
    "1090540000": { address: "4100 W DR MARTIN LUTHER KING JR BLVD", owner: "TIITF/HRS-Health Services", acreage: 20.87 },
  };
  // Drew Park CRA extent, precomputed from the community-redevelopment layer
  // (vector tiles can't give whole-feature bounds client-side)
  const DREW_PARK_BOUNDS = [[-82.5237, 27.974], [-82.5053, 27.9962]];

  function bootDrewPark(el) {
    const map = makeMap(el, { pitchable: true });
    map.on("load", () => {
      // keep neighborhoods + streets, drop the city-level "TAMPA" label
      if (map.getLayer("places_locality")) map.setLayoutProperty("places_locality", "visibility", "none");

      const labels = beforeLabels(map);
      map.addSource("city-layers", { type: "vector", url: `pmtiles://${TILES}/city-layers.pmtiles` });
      const drewPark = ["==", ["get", "CRA_Name"], "Drew Park"];
      map.addLayer({
        id: "cra-fill", type: "fill", source: "city-layers", "source-layer": "community-redevelopment",
        filter: drewPark, paint: { "fill-color": "#eab308", "fill-opacity": 0.25 },
      }, beforeRoads(map));
      map.addLayer({
        id: "cra-outline", type: "line", source: "city-layers", "source-layer": "community-redevelopment",
        filter: drewPark, paint: { "line-color": "#ca8a04", "line-width": 2.5, "line-opacity": 0.7 },
      }, labels);

      map.fitBounds(DREW_PARK_BOUNDS, { padding: 40, maxZoom: 15 });

      map.addSource("parcels", { type: "vector", url: `pmtiles://${TILES}/parcels.pmtiles` });
      map.addLayer({
        id: "parcels-highlighted", type: "fill", source: "parcels", "source-layer": "parcels",
        filter: ["in", ["get", "FOLIO"], ["literal", Object.keys(DREW_PARK_PARCELS)]],
        paint: { "fill-color": "#2563eb", "fill-opacity": 0.65 },
      }, labels);

      // flat-height extrusions (toolshed look — no zoom ramp, so buildings
      // show at the ~z14 fitBounds view, unlike add3dBuildings' 14→15 ramp)
      map.addLayer({
        id: "buildings-3d", type: "fill-extrusion", source: "protomaps", "source-layer": "buildings",
        filter: ["in", ["get", "kind"], ["literal", ["building", "building_part"]]],
        paint: {
          "fill-extrusion-color": "#d1d5db",
          "fill-extrusion-height": ["coalesce", ["get", "height"], 5],
          "fill-extrusion-base": ["coalesce", ["get", "min_height"], 0],
          "fill-extrusion-opacity": 0.7,
        },
      }, labels);

      fillPopup(map, "parcels-highlighted", (p) => {
        const d = DREW_PARK_PARCELS[p.FOLIO] || {};
        return `<p class="map-popup__title">${p.FOLIO}</p>` +
          popupRow("Address", d.address || "—") +
          popupRow("Owner", d.owner || "—") +
          popupRow("Acreage", d.acreage ? `${d.acreage.toFixed(2)} ac` : "—");
      });

      legendRows(panel(el, { title: "Legend" }), [["Drew Park", [
        ["CRA boundary", "#eab308"],
        ["Stadium-proposal parcels (click for details)", "#2563eb"],
      ]]]);
    });
  }

  // ── boot: Tampa Neighborhoods reference map (/toolshed/maps/tampa-neighborhoods/) ──
  //
  // All 160 features, click a boundary for its name. Site-hosted GeoJSON
  // (assets/data/maps/tampa-neighborhoods.geojson, trimmed from toolshed/
  // boundaries/geojson/neighborhoods.geojson) rather than city-layers.pmtiles'
  // neighborhoods layer — that tileset's tippecanoe pass (maxzoom 13,
  // density-based simplification, no --generate-ids) was dropping/distorting
  // small polygons at low zoom. Same fix as bootZipcodes/bootAnnexation below
  // use for the same reason. Inserted before labels (not before roads) and at
  // full line opacity so the boundary reads as a crisp line, not a tinted
  // wash that roads can draw over.
  function bootTampaNeighborhoods(el) {
    const map = makeMap(el);
    map.on("load", async () => {
      const geojson = await (await fetch(`${DATA}/tampa-neighborhoods.geojson`)).json();
      map.addSource("neighborhoods", { type: "geojson", data: geojson, attribution: "City of Tampa GIS" });
      const labels = beforeLabels(map);
      map.addLayer({
        id: "neighborhoods-fill", type: "fill", source: "neighborhoods",
        paint: { "fill-color": "#1D636B", "fill-opacity": 0.12 },
      }, labels);
      map.addLayer({
        id: "neighborhoods-line", type: "line", source: "neighborhoods",
        paint: { "line-color": "#0f4a52", "line-width": 2, "line-opacity": 1 },
      }, labels);

      fillPopup(map, "neighborhoods-fill", (p) =>
        `<p class="map-popup__title">${p.AssocLabel || "Unnamed area"}</p>` +
        (p.Type ? popupRow("Type", p.Type) : ""));
    });
  }

  // ── boot: "Do You Know Your Neighborhoods" quiz (/toolshed/maps/know-your-neighborhoods/) ──
  //
  // Read-only boundaries + numbers, filtered down to whichever names are in
  // window.tmNeighborhoodQuiz.mapping (set by assets/js/neighborhood-quiz.js,
  // which loads eagerly and always runs before this — MapLibre is a lazy
  // multi-script fetch) — the random-35 pool normally, or all ~131 eligible
  // names in expert mode (?expert=1), so bounds are computed from whichever
  // features actually loaded rather than a hardcoded bbox. Same source and
  // styling as bootTampaNeighborhoods above (assets/data/maps/
  // tampa-neighborhoods.geojson) rather than a separate extract, so both
  // maps behave identically.
  //
  // Clicking a shape jumps focus to its answer-table input instead of
  // showing a popup (that would give the name away) — the map and table
  // share the same number→name mapping, so a click just needs to look its
  // own name up in that array to find which row to focus.
  function bootNeighborhoodQuiz(el) {
    const quiz = window.tmNeighborhoodQuiz;
    if (!quiz) return;
    const map = makeMap(el);
    map.on("load", async () => {
      const geojson = await (await fetch(`${DATA}/tampa-neighborhoods.geojson`)).json();
      // promoteId lets setFeatureState below target a feature by its
      // AssocLabel directly — safe because quiz.mapping's names are
      // guaranteed unique (see neighborhood-quiz.js's NAMES comments).
      map.addSource("neighborhood-quiz", {
        type: "geojson", data: geojson, promoteId: "AssocLabel", attribution: "City of Tampa GIS",
      });
      const filter = ["in", ["get", "AssocLabel"], ["literal", quiz.mapping]];

      const bounds = new maplibregl.LngLatBounds();
      for (const f of geojson.features) {
        if (!quiz.mapping.includes(f.properties.AssocLabel)) continue;
        const rings = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
        for (const ring of rings) for (const pt of ring[0]) bounds.extend(pt);
      }
      const labels = beforeLabels(map);
      const filledCase = (whenFilled, whenBlank) =>
        ["case", ["boolean", ["feature-state", "filled"], false], whenFilled, whenBlank];
      map.addLayer({
        id: "quiz-fill", type: "fill", source: "neighborhood-quiz",
        filter, paint: {
          "fill-color": filledCase("#E6B45E", "#1D636B"),
          "fill-opacity": filledCase(0.4, 0.12),
        },
      }, labels);
      map.addLayer({
        id: "quiz-line", type: "line", source: "neighborhood-quiz",
        filter, paint: { "line-color": "#0f4a52", "line-width": 2, "line-opacity": 1 },
      }, labels);

      const numberExpr = ["match", ["get", "AssocLabel"]];
      quiz.mapping.forEach((name, i) => numberExpr.push(name, String(i + 1)));
      numberExpr.push("");
      map.addLayer({
        id: "quiz-numbers", type: "symbol", source: "neighborhood-quiz",
        filter,
        layout: {
          "text-field": numberExpr,
          "text-font": ["Noto Sans Bold"], "text-size": 16,
        },
        paint: { "text-color": "#1a1a2e", "text-halo-color": "#ffffff", "text-halo-width": 1.5 },
      });

      map.on("click", "quiz-fill", (e) => {
        const name = e.features[0].properties.AssocLabel;
        const num = quiz.mapping.indexOf(name) + 1;
        const input = num > 0 && document.getElementById(`nq-guess-${num}`);
        if (!input) return;
        input.scrollIntoView({ behavior: "smooth", block: "center" });
        input.focus();
      });
      map.on("mouseenter", "quiz-fill", () => { map.getCanvas().style.cursor = "pointer"; });
      map.on("mouseleave", "quiz-fill", () => { map.getCanvas().style.cursor = ""; });

      // neighborhood-quiz.js loads eagerly and may already have guesses
      // typed by the time this (lazy-loaded) map boots — apply those first,
      // then listen for the rest as they're typed.
      quiz.filled.forEach((name) => map.setFeatureState({ source: "neighborhood-quiz", id: name }, { filled: true }));
      window.addEventListener("tm-neighborhood-quiz-filled", (e) => {
        map.setFeatureState({ source: "neighborhood-quiz", id: e.detail.name }, { filled: e.detail.filled });
      });

      map.fitBounds(bounds, { padding: 40, maxZoom: 14, animate: false });
    });
  }

  // ── stormwater work orders (/toolshed/maps/stormwater-work-orders/) ──
  //
  // stormwater-workorders.js loads eagerly and owns the date inputs + the
  // table; this boot reads its current range from window.tmStormwaterWos
  // once the map boots (always later — MapLibre is a lazy multi-script
  // fetch) and follows "tm-stormwater-workorders-range" events after.

  const WO_CATEGORY = {
    CM: "Corrective maintenance",
    PM: "Preventive maintenance",
    EM: "Emergency maintenance",
    CIP: "Capital improvement",
    GM: "General maintenance",
  };

  // Top 6 work types by count get a color; the six rare types (~9% of dots)
  // fold to gray "Other" — the popup still names the exact type. Palette is
  // the largest all-pairs CVD-safe subset of the dataviz reference hues on a
  // light basemap (worst pair ΔE 8.3 protan / 15.1 normal — validated, don't
  // eyeball substitutions). Yellow/magenta/green sit under 3:1 contrast on
  // the basemap: relief is the white stroke, popups, and the table view.
  const WO_TYPE_COLORS = [
    ["Inlet Maintenance", "#2a78d6"],
    ["Stormwater Gravity Main Maintenance", "#d95926"],
    ["Ditch Grading", "#199e70"],
    ["General Ditch Maintenance", "#eda100"],
    ["General Work", "#e87ba4"],
    ["Stormwater Manhole Maintenance", "#4a3aa7"],
  ];
  const WO_OTHER_COLOR = "#898781";

  function bootStormwaterWorkorders(el) {
    const map = makeMap(el);
    map.on("load", async () => {
      const geojson = await (await fetch(`${DATA}/stormwater-work-orders.geojson`)).json();

      const bounds = new maplibregl.LngLatBounds();
      for (const f of geojson.features) bounds.extend(f.geometry.coordinates);
      map.fitBounds(bounds, { padding: 40, animate: false });

      map.addSource("stormwater-wos", {
        type: "geojson", data: geojson, attribution: "City of Tampa Cityworks",
      });
      map.addLayer({
        id: "wos-points", type: "circle", source: "stormwater-wos",
        paint: {
          "circle-color": [
            "match", ["get", "Description"],
            ...WO_TYPE_COLORS.flatMap(([type, color]) => [type, color]),
            WO_OTHER_COLOR,
          ],
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 3, 13, 5, 16, 9],
          "circle-opacity": 0.8,
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 1,
        },
      });

      // legend: one row per colored type + Other, counts live-updating with
      // the completion-date filter
      const named = new Set(WO_TYPE_COLORS.map(([type]) => type));
      const body = panel(el, { title: "Work type", position: "bottom-left" });
      const addRow = (label, color) => {
        const row = document.createElement("div");
        row.className = "map-legend__row";
        const swatch = document.createElement("span");
        swatch.className = "map-legend__swatch";
        swatch.style.background = color;
        const name = document.createElement("span");
        name.textContent = label;
        const count = document.createElement("span");
        count.className = "map-legend__note";
        row.append(swatch, name, count);
        body.appendChild(row);
        return count;
      };
      const countEls = new Map(WO_TYPE_COLORS.map(([type, color]) => [type, addRow(type, color)]));
      const otherCountEl = addRow("All other types", WO_OTHER_COLOR);
      const shapeKey = document.createElement("p");
      shapeKey.className = "map-legend__hint";
      shapeKey.textContent = "Solid dots are completed; hollow dots are open.";
      shapeKey.hidden = true;
      body.appendChild(shapeKey);
      const hint = document.createElement("p");
      hint.className = "map-legend__hint";
      hint.textContent = "Counts follow the filters. Click a dot for details.";
      body.appendChild(hint);

      // legend counts reflect what's actually visible: completed-in-range
      // plus open (when toggled), both narrowed by the type filter
      const updateLegend = (state) => {
        const counts = new Map();
        let other = 0;
        const tally = (p) => {
          if (state.type && p.Description !== state.type) return;
          if (named.has(p.Description)) counts.set(p.Description, (counts.get(p.Description) || 0) + 1);
          else other++;
        };
        for (const f of geojson.features) {
          const p = f.properties;
          if (p.ActualFinishDate < state.from || p.ActualFinishDate > state.to) continue;
          tally(p);
        }
        if (state.open) for (const f of openFeatures) tally(f.properties);
        for (const [type, countEl] of countEls) countEl.textContent = (counts.get(type) || 0).toLocaleString();
        otherCountEl.textContent = other.toLocaleString();
      };

      // open layer: nothing fetched or added until the toggle first turns on.
      // Hollow rings above the solid completed dots, same type hues.
      let openFeatures = [];
      let openReady = null;
      const ensureOpenLayer = () => {
        openReady ??= (async () => {
          const open = await (await fetch(`${DATA}/stormwater-open-work-orders.geojson`)).json();
          openFeatures = open.features;
          map.addSource("stormwater-wos-open", {
            type: "geojson", data: open, attribution: "City of Tampa Cityworks",
          });
          map.addLayer({
            id: "wos-open-points", type: "circle", source: "stormwater-wos-open",
            paint: {
              "circle-opacity": 0,
              "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 4, 13, 6, 16, 10],
              "circle-stroke-width": 2,
              "circle-stroke-color": [
                "match", ["get", "Description"],
                ...WO_TYPE_COLORS.flatMap(([type, color]) => [type, color]),
                WO_OTHER_COLOR,
              ],
            },
          });
          map.on("click", "wos-open-points", (e) => openPopup(e));
          map.on("mouseenter", "wos-open-points", () => { map.getCanvas().style.cursor = "pointer"; });
          map.on("mouseleave", "wos-open-points", () => { map.getCanvas().style.cursor = ""; });
        })();
        return openReady;
      };

      let lastState = null;
      const applyFilters = (state) => {
        if (!state || !state.from || !state.to) return;
        lastState = state;
        map.setFilter("wos-points", ["all",
          [">=", ["get", "ActualFinishDate"], state.from],
          ["<=", ["get", "ActualFinishDate"], state.to],
          ...(state.type ? [["==", ["get", "Description"], state.type]] : []),
        ]);
        if (state.open) {
          ensureOpenLayer().then(() => {
            if (!lastState.open) return; // toggled back off while fetching
            map.setFilter("wos-open-points",
              lastState.type ? ["==", ["get", "Description"], lastState.type] : null);
            map.setLayoutProperty("wos-open-points", "visibility", "visible");
            updateLegend(lastState); // recount once open data is in
          }).catch(() => {});
        } else if (map.getLayer("wos-open-points")) {
          map.setLayoutProperty("wos-open-points", "visibility", "none");
        }
        shapeKey.hidden = !state.open;
        updateLegend(state);
      };
      const boot = window.tmStormwaterWos;
      applyFilters(boot
        ? { from: boot.range.from, to: boot.range.to, type: boot.type, open: boot.open }
        : { from: "0000-00-00", to: "9999-99-99", type: null, open: false });
      window.addEventListener("tm-stormwater-workorders-range", (e) => applyFilters(e.detail));

      // ISO "YYYY-MM-DD" → "Aug 7, 2026" by hand — Date("YYYY-MM-DD") parses
      // as UTC midnight and displays a day early in Eastern time.
      const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
        "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      const fmtDate = (iso) => {
        if (!iso) return "—";
        const [y, m, d] = iso.split("-");
        return `${MONTHS[m - 1]} ${+d}, ${y}`;
      };
      const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

      const row = (label, value) =>
        `<div class="map-popup__row"><span class="map-popup__label">${label}</span><span>${esc(value)}</span></div>`;
      map.on("click", "wos-points", (e) => {
        const p = e.features[0].properties;
        const html =
          `<p class="map-popup__title">${esc(p.Description)}</p>` +
          row("Category", WO_CATEGORY[p.WoCategory] || p.WoCategory || "—") +
          row("Completed", fmtDate(p.ActualFinishDate)) +
          row("Work order", p.WORKORDERID);
        new maplibregl.Popup({ maxWidth: "300px" }).setLngLat(e.lngLat).setHTML(html).addTo(map);
      });
      const openPopup = (e) => {
        const p = e.features[0].properties;
        const html =
          `<p class="map-popup__title">${esc(p.Description)}</p>` +
          row("Category", WO_CATEGORY[p.WoCategory] || p.WoCategory || "—") +
          row("Open since", fmtDate(p.InitiateDate)) +
          row("Status", p.Status === "IN PROGRESS" ? "In progress" : "Open") +
          row("Work order", p.WORKORDERID);
        new maplibregl.Popup({ maxWidth: "300px" }).setLngLat(e.lngLat).setHTML(html).addTo(map);
      };
      map.on("mouseenter", "wos-points", () => { map.getCanvas().style.cursor = "pointer"; });
      map.on("mouseleave", "wos-points", () => { map.getCanvas().style.cursor = ""; });
    });
  }

  // ── boot: South Howard Flood Relief route (/toolshed/maps/south-howard-flood-relief/) ──
  // Phase 1 route hand-digitized in toolshed stormwater/south-howard/ from the
  // city's project location map (the city publishes no route polyline — its
  // GIS corridor polygon traces an older study's alignment, not shown here).
  // Basins are city GIS (OpenData/UtilityStorm); the pre-1953 city limit is a
  // union of pre-1953 tampa-annexation-history events — its western edge runs
  // along S Howard Ave, which is the point of showing it.
  function bootSouthHoward(el) {
    const map = makeMap(el);
    map.on("load", async () => {
      const [route, basins, oldCity] = await Promise.all([
        `${DATA}/south-howard-route.geojson`,
        `${DATA}/south-howard-basins.geojson`,
        `${DATA}/tampa-pre1953-limit.geojson`,
      ].map((u) => fetch(u).then((r) => r.json())));

      const roads = beforeRoads(map);
      const labels = beforeLabels(map);

      const basinColor = ["match", ["get", "NAME"], "Palma Ceia", "#6b5b95", "#1D636B"];
      map.addSource("sh-basins", { type: "geojson", data: basins, attribution: "City of Tampa GIS" });
      map.addLayer({
        id: "sh-basins-fill", type: "fill", source: "sh-basins",
        paint: { "fill-color": basinColor, "fill-opacity": 0.15 },
      }, roads);

      map.addSource("sh-oldcity", { type: "geojson", data: oldCity });
      map.addLayer({
        id: "sh-oldcity-line", type: "line", source: "sh-oldcity",
        paint: { "line-color": "#314A59", "line-width": 2.5, "line-dasharray": [1.5, 1.5] },
      }, labels);

      map.addSource("sh-route", { type: "geojson", data: route });
      map.addLayer({
        id: "sh-route-secondary", type: "line", source: "sh-route",
        filter: ["==", ["get", "kind"], "secondary"],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#a03123", "line-width": 4 },
      }, labels);
      map.addLayer({
        id: "sh-route-main", type: "line", source: "sh-route",
        filter: ["==", ["get", "kind"], "main"],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#e8720c", "line-width": 5 },
      }, labels);

      // one click handler so overlapping layers yield one popup, route first
      const CLICKABLE = ["sh-route-main", "sh-route-secondary", "sh-oldcity-line", "sh-basins-fill"];
      map.on("click", (e) => {
        const f = map.queryRenderedFeatures(e.point, { layers: CLICKABLE })[0];
        if (!f) return;
        const p = f.properties;
        let html;
        if (f.layer.id === "sh-basins-fill") {
          html = `<p class="map-popup__title">${p.NAME || "Unnamed"} basin</p>` +
            popupRow("Acres", (+p.LANDAREA).toFixed(1)) +
            popupRow("Service level", p.SERVICELEVEL) +
            popupRow("Drains to", p.WATERS === "HB" ? "Hillsborough Bay" : p.WATERS);
        } else if (f.layer.id === "sh-oldcity-line") {
          html = '<p class="map-popup__title">City limits before 1953</p>' +
            popupRow("Boundary", "Tampa’s western edge ran along S Howard Ave until the 1953 “Great Annexation” (House Bill 734)");
        } else {
          html = `<p class="map-popup__title">${p.name}</p>` + popupRow("Detail", p.detail);
        }
        new maplibregl.Popup({ maxWidth: "320px" }).setLngLat(e.lngLat).setHTML(html).addTo(map);
      });
      for (const id of CLICKABLE) {
        map.on("mouseenter", id, () => { map.getCanvas().style.cursor = "pointer"; });
        map.on("mouseleave", id, () => { map.getCanvas().style.cursor = ""; });
      }

      const body = panel(el, { title: "Legend" });
      legendRows(body, [["South Howard Flood Relief (Phase 1)", [
        ["10′×10′ box culvert (2–6′×8′ at outfall)", "#e8720c"],
        ["Secondary storm sewers", "#a03123"],
        ["Palma Ceia basin", "#6b5b95"],
        ["Adjacent outfall basins", "#1D636B"],
      ]]]);
      const boundaryRow = document.createElement("div");
      boundaryRow.className = "map-legend__row";
      boundaryRow.innerHTML = '<span class="map-legend__line map-legend__line--dashed"></span><span>City limit before the 1953 annexation</span>';
      body.appendChild(boundaryRow);
    });
  }

  // ── registry + init ─────────────────────────────────────────────────

  const BOOTS = {
    "land-use-map-block": bootPlanning,
    "mapbox-block": bootAgenda,
    "council-districts-block": bootDistricts,
    "tampa-cra-block": bootCra,
    "impact-fee-districts-block": bootImpactFee,
    "redistricting-precincts-block": (el) => bootPrecincts(el, {
      assignments: REDISTRICTING_PRECINCTS,
      districtLabel: "District",
      legendSection: ["Affected precincts", [[Object.keys(REDISTRICTING_PRECINCTS).join(", "), "rgba(0,0,0,0.15)"]]],
    }),
    "updated-city-precincts-block": (el) => bootPrecincts(el, {
      assignments: { 345: "5" },
      districtLabel: "Moved to district",
      legendSection: ["Precinct 345 → District 5", [["345 (moved to D5)", DISTRICT_COLORS[5]]]],
    }),
    "tampa-zipcodes-block": bootZipcodes,
    "annexation-history-block": bootAnnexation,
    "drew-park-cra-block": bootDrewPark,
    "tampa-neighborhoods-block": bootTampaNeighborhoods,
    "neighborhood-quiz-block": bootNeighborhoodQuiz,
    "stormwater-workorders-block": bootStormwaterWorkorders,
    "south-howard-block": bootSouthHoward,
  };

  for (const [cls, boot] of Object.entries(BOOTS)) {
    document.querySelectorAll(`.${cls}`).forEach((el) => {
      try {
        boot(el);
        // Static-image fallback authored inside the mount (shows in email +
        // no-JS + pre-boot). Removed only after a successful boot, so a boot
        // failure leaves the reader the picture instead of a blank box.
        el.querySelectorAll(".map-fallback, picture:has(> .map-fallback)")
          .forEach((n) => n.remove());
      } catch (err) { console.error(`map boot failed (${cls})`, err); }
    });
  }
})();
