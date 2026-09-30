#!/usr/bin/env node
// Fail if any renderer term appears in the schema. The scene spec is
// renderer-neutral: no layer class names, accessor props, view classes or
// renderer settings from any rendering library.
//
// Matching is case-insensitive and ignores "_" and "-", so coordinate_origin
// matches coordinateOrigin. Spaces are kept, so plain English such as
// "path" or "raster" in descriptions is fine; "PathLayer" is not.
"use strict";

const fs = require("fs");
const path = require("path");

const DENYLIST = [
  // layer classes
  "SolidPolygonLayer", "PolygonLayer", "PathLayer", "ScatterplotLayer",
  "SimpleMeshLayer", "BitmapLayer", "GeoJsonLayer", "TileLayer",
  "RasterLayer", "COGLayer", "ZarrLayer", "LineLayer", "IconLayer",
  "TextLayer", "ColumnLayer", "H3HexagonLayer", "MVTLayer",
  // accessors and props
  "getFillColor", "getLineColor", "getColor", "getWidth", "getRadius",
  "getPosition", "getPath", "getPolygon", "getElevation", "widthUnits",
  "radiusUnits", "lineWidthMinPixels", "coordinateSystem",
  "coordinateOrigin", "modelMatrix", "updateTriggers", "pickable",
  "extruded", "wireframe", "binary",
  // interaction and page (0.5 popups)
  "autoHighlight", "highlightColor", "getTooltip", "tooltip", "onClick",
  "onHover", "mouseover", "mousemove", "addEventListener", "innerHTML",
  // views and camera
  "OrthographicView", "MapView", "GlobeView", "FirstPersonView",
  "OrbitView", "viewState", "initialViewState",
  // libraries
  "deck.gl", "deckgl", "luma.gl", "maplibre", "mapbox", "leaflet",
];

const norm = (s) => s.toLowerCase().replace(/[_-]/g, "");

function findTerms(text) {
  const t = norm(text);
  return DENYLIST.filter((term) => t.includes(norm(term)));
}

function main() {
  // Sanity: the check must catch a known offender.
  if (findTerms('{"coordinate_origin": 1}').length === 0) {
    console.log("FAIL denylist self-test");
    process.exit(1);
  }
  const dir = path.resolve(__dirname, "..", "schema");
  let bad = 0;
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    const hits = findTerms(fs.readFileSync(path.join(dir, f), "utf8"));
    if (hits.length) {
      bad++;
      console.log(`FAIL schema/${f}: renderer terms ${hits.join(", ")}`);
    } else {
      console.log(`ok   schema/${f}: no renderer terms (${DENYLIST.length} checked)`);
    }
  }
  process.exit(bad ? 1 : 0);
}

if (require.main === module) main();

module.exports = { DENYLIST, findTerms };
