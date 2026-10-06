#!/usr/bin/env node
// Fail if any renderer term appears in the schema. The scene spec is
// renderer-neutral: no layer class names, accessor props, view classes or
// renderer settings from any rendering library.
//
// From 0.6 the chunk-reference definitions ($defs named chunk* and codec*)
// are also reader-neutral: they name codecs, never a file or store format.
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

// File and store formats the chunk-reference definitions must not name.
const FORMAT_NAMES = ["zarr", "kerchunk", "icechunk", "hdf5", "hdf4", "netcdf", "tiff", "geotiff", "grib", "parquet", "virtualizarr"];

const norm = (s) => s.toLowerCase().replace(/[_-]/g, "");

function findTerms(text) {
  const t = norm(text);
  return DENYLIST.filter((term) => t.includes(norm(term)));
}

// The chunk-reference definitions of a schema, as text ("" before 0.6).
function chunkDefsText(schema) {
  const defs = schema.$defs || {};
  return Object.keys(defs).filter((k) => /^(chunk|codec)/.test(k)).map((k) => JSON.stringify(defs[k])).join("\n");
}

const findFormats = (text) => FORMAT_NAMES.filter((name) => text.toLowerCase().includes(name));

function main() {
  // Sanity: the checks must catch known offenders.
  if (findTerms('{"coordinate_origin": 1}').length === 0 || findFormats("a Zarr chunk").length === 0) {
    console.log("FAIL denylist self-test");
    process.exit(1);
  }
  const dir = path.resolve(__dirname, "..", "schema");
  let bad = 0;
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    const text = fs.readFileSync(path.join(dir, f), "utf8");
    const hits = findTerms(text);
    const chunkText = chunkDefsText(JSON.parse(text));
    const formats = findFormats(chunkText);
    if (hits.length) {
      bad++;
      console.log(`FAIL schema/${f}: renderer terms ${hits.join(", ")}`);
    } else if (formats.length) {
      bad++;
      console.log(`FAIL schema/${f}: chunk references name file formats ${formats.join(", ")}`);
    } else {
      const also = chunkText ? `; chunk references name no file formats (${FORMAT_NAMES.length} checked)` : "";
      console.log(`ok   schema/${f}: no renderer terms (${DENYLIST.length} checked)${also}`);
    }
  }
  process.exit(bad ? 1 : 0);
}

if (require.main === module) main();

module.exports = { DENYLIST, FORMAT_NAMES, findTerms, findFormats };
