/* Tampa Monitor map loader — defers the MapLibre stack until it's needed.
 *
 * hasMap pages used to ship maplibre-gl + pmtiles + basemaps + maps.js up
 * front: ~300 KB of JS parsed before the reader ever reached the map, and the
 * single biggest perf cost on agenda posts (TBT ~3 s on throttled mobile).
 * This ~1 KB loader watches the map mounts instead and injects the stack when
 * the first one comes within a viewport of scrolling into view — maps.js
 * boots on execution, so the map is up by the time the reader arrives. Pages
 * whose map sits at the top (the land-use map page) intersect immediately and
 * load exactly as before.
 *
 * The CDN pins live HERE now (formerly base.njk's <head>); versions keep
 * tracking toolshed's planning.html.
 */
(() => {
  "use strict";

  // Mounts that boot a real map (mirrors BOOTS in maps.js).
  const mounts = document.querySelectorAll(
    ".land-use-map-block, .mapbox-block, .council-districts-block, " +
    ".tampa-cra-block, .impact-fee-districts-block, " +
    ".redistricting-precincts-block, .updated-city-precincts-block, " +
    ".tampa-zipcodes-block, .annexation-history-block, .drew-park-cra-block, " +
    ".tampa-neighborhoods-block, .neighborhood-quiz-block, " +
    ".stormwater-workorders-block, .south-howard-block",
  );
  if (!mounts.length) return;

  const CSS = "https://unpkg.com/maplibre-gl@5.24.0/dist/maplibre-gl.css";
  const STACK = [
    "https://unpkg.com/maplibre-gl@5.24.0/dist/maplibre-gl.js",
    "https://unpkg.com/pmtiles@4.4.1/dist/pmtiles.js",
    "https://unpkg.com/@protomaps/basemaps@5/dist/basemaps.js",
  ];

  const script = (src) =>
    new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.crossOrigin = "anonymous";
      s.onload = resolve;
      s.onerror = () => reject(new Error(`map loader: failed to load ${src}`));
      document.head.appendChild(s);
    });

  let started = false;
  const start = () => {
    if (started) return;
    started = true;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = CSS;
    document.head.appendChild(link);
    // The three libraries are independent of each other; maps.js needs all of
    // them as globals and boots its mounts as soon as it executes.
    Promise.all(STACK.map(script))
      .then(() => script("/assets/js/maps.js"))
      .catch((err) => console.error(err));
  };

  if (!("IntersectionObserver" in window)) {
    start();
    return;
  }
  const io = new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        io.disconnect();
        start();
      }
    },
    // Fire one full viewport ahead of arrival so the map is booted by the
    // time the reader scrolls to it.
    { rootMargin: "100% 0px" },
  );
  mounts.forEach((el) => io.observe(el));
})();
