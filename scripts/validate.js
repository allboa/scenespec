#!/usr/bin/env node
// Validate scene spec documents against the schema for their version
// (schema/scene-<version>.schema.json) plus the cross-reference checks JSON
// Schema cannot express.
//
//   node scripts/validate.js              run the fixture suite
//   node scripts/validate.js a.json ...   validate the given scenes
"use strict";

const fs = require("fs");
const path = require("path");
const Ajv2020 = require("ajv/dist/2020");
const addFormats = require("ajv-formats");

const ROOT = path.resolve(__dirname, "..");
const VERSIONS = ["0.1", "0.2", "0.3", "0.4", "0.5", "0.6"];

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const schemaValidate = {};
for (const v of VERSIONS) {
  const file = path.join(ROOT, "schema", `scene-${v}.schema.json`);
  schemaValidate[v] = ajv.compile(JSON.parse(fs.readFileSync(file, "utf8")));
}

// Which geometry encodings each vector layer kind accepts.
const KIND_ENCODINGS = {
  polygon: ["geoarrow.polygon", "geoarrow.multipolygon"],
  path: ["geoarrow.linestring", "geoarrow.multilinestring"],
  point: ["geoarrow.point", "geoarrow.multipoint"],
};

const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Version order for checks that start at a given version ("0.10" > "0.9").
function atLeast(version, min) {
  const [a, b] = [version, min].map((v) => String(v).split(".").map(Number));
  return a[0] > b[0] || (a[0] === b[0] && a[1] >= b[1]);
}

function checkExtent(where, e, errors) {
  if (Array.isArray(e) && e.length === 4 && !(e[0] < e[1] && e[2] < e[3])) {
    errors.push(`${where}: extent must be [xmin, xmax, ymin, ymax] with xmin < xmax and ymin < ymax`);
  }
}

// Checks that need the whole document: ids resolve, ids are unique,
// geometry matches layer kind, extents are ordered, origin and CRS rules,
// (0.2) tile plans are consistent with their levels and sources, (0.3)
// rgb bands and jpeg encodings fit every level, (0.5) legends name a
// layer and popups do not name the geometry column, and (0.6) chunk refs lie
// on their grid and plans over chunks name stored chunks.
function semanticErrors(scene) {
  const errors = [];
  const data = scene.data || {};
  const view = scene.view || {};
  for (const [id, ref] of Object.entries(data)) {
    if (ref.origin_subtracted === true && !view.local_origin) {
      errors.push(`/data/${id}: origin_subtracted is true but view.local_origin is absent`);
    }
    // Vector coordinates are in the view CRS. Compared as JSON values,
    // so "EPSG:3031" and an equivalent PROJJSON object do not match.
    if (ref.geometry && ref.geometry.crs !== undefined && view.crs !== undefined &&
        !sameJson(ref.geometry.crs, view.crs)) {
      errors.push(`/data/${id}: geometry.crs must equal view.crs in ${scene.version}`);
    }
  }
  const needData = (where, id) => {
    if (!Object.prototype.hasOwnProperty.call(data, id)) {
      errors.push(`${where}: data id "${id}" is not defined in data`);
      return null;
    }
    return data[id];
  };
  // Raster values, mesh tables and (0.6) chunk ref tables are plain Arrow
  // tables, not vector data, not COGs and not chunks.
  const needTable = (where, id) => {
    const ref = needData(where, id);
    if (!ref) return;
    if (ref.format === "cog") errors.push(`${where}: data "${id}" is a cog; expected an Arrow table`);
    else if (ref.format === "chunks") errors.push(`${where}: data "${id}" is chunks; expected an Arrow table`);
    else if (ref.geometry) errors.push(`${where}: data "${id}" has a geometry column; expected a plain table`);
  };
  for (const [id, ref] of Object.entries(data)) {
    if (ref.format === "chunks") chunksErrors(`/data/${id}`, ref, needTable, errors);
  }
  checkExtent("/view", scene.view && scene.view.extent, errors);
  // 0.4: bounds limit a flat camera; a globe has no edge to stop at.
  if (scene.view && scene.view.bounds) {
    checkExtent("/view/bounds", scene.view.bounds, errors);
    if (scene.view.type === "globe") errors.push("/view/bounds: a globe view has no bounds");
    const bb = scene.view.bounds;
    const c = scene.view.center;
    if (Array.isArray(c) && !(c[0] >= bb[0] && c[0] <= bb[1] && c[1] >= bb[2] && c[1] <= bb[3])) {
      errors.push("/view/center: center must lie within view.bounds");
    }
    const e = scene.view.extent;
    if (Array.isArray(e) && e.length === 4 && !(e[0] < bb[1] && e[1] > bb[0] && e[2] < bb[3] && e[3] > bb[2])) {
      errors.push("/view/extent: extent must overlap view.bounds");
    }
  }
  const seen = new Set();
  (scene.layers || []).forEach((layer, i) => {
    const where = `/layers/${i}`;
    if (seen.has(layer.id)) errors.push(`${where}: duplicate layer id "${layer.id}"`);
    seen.add(layer.id);
    if (KIND_ENCODINGS[layer.kind]) {
      const ref = needData(where, layer.data);
      if (ref) {
        if (!ref.geometry) {
          errors.push(`${where}: data "${layer.data}" has no geometry column`);
        } else if (!KIND_ENCODINGS[layer.kind].includes(ref.geometry.encoding)) {
          errors.push(`${where}: ${layer.kind} layer cannot draw ${ref.geometry.encoding}`);
        }
        // 0.5: popup columns are attributes. Whether they exist in the Arrow
        // data is for producers and renderers to check; the validator does
        // not read blobs.
        if (ref.geometry && layer.popup && layer.popup.columns.includes(ref.geometry.column)) {
          errors.push(`${where}/popup: "${ref.geometry.column}" is the geometry column, not an attribute`);
        }
      }
    } else if (layer.kind === "raster") {
      needTable(where, layer.values);
      checkExtent(`${where}/grid`, layer.grid && layer.grid.extent, errors);
      if (layer.mesh) {
        needTable(`${where}/mesh`, layer.mesh.vertices);
        needTable(`${where}/mesh`, layer.mesh.indices);
      }
    } else if (layer.kind === "tiled_raster") {
      tiledRasterErrors(where, layer, scene.version, view, needData, needTable, errors);
    }
  });
  if (atLeast(scene.version, "0.5")) {
    rangeErrors(scene, errors);
    legendErrors(scene, errors);
  }
  return errors;
}

// 0.5: a range with equal ends cannot be drawn (it divides by zero).
function rangeErrors(scene, errors) {
  (scene.layers || []).forEach((layer, i) => {
    for (const key of ["palette", "rgb"]) {
      const r = layer[key] && layer[key].range;
      if (Array.isArray(r) && r[0] === r[1]) {
        errors.push(`/layers/${i}/${key}/range: ends must differ`);
      }
    }
  });
}

// 0.5: each legend keys an existing layer; ramp ends differ, stops run 0 to
// 1 in order, and a palette ramp keys a palette layer and agrees with it.
function legendErrors(scene, errors) {
  const layers = new Map((scene.layers || []).map((l) => [l.id, l]));
  (scene.legends || []).forEach((lg, i) => {
    const where = `/legends/${i}`;
    const layer = layers.get(lg.layer);
    if (!layer) errors.push(`${where}: layer id "${lg.layer}" is not a layer in this scene`);
    const ramp = lg.ramp;
    if (!ramp) return;
    // A reversed range is a reversed key, as a reversed layer palette is.
    if (ramp.range[0] === ramp.range[1]) {
      errors.push(`${where}/ramp/range: ends must differ`);
    }
    if (ramp.stops) {
      const at = ramp.stops.map((st) => st.at);
      if (at[0] !== 0 || at[at.length - 1] !== 1) {
        errors.push(`${where}/ramp/stops: the first stop must be at 0 and the last at 1`);
      }
      for (let k = 1; k < at.length; k++) {
        if (!(at[k] > at[k - 1])) {
          errors.push(`${where}/ramp/stops/${k}: at must be greater than the previous stop's`);
          break;
        }
      }
    }
    if (ramp.palette && layer) {
      if (!layer.palette) {
        errors.push(`${where}/ramp: layer "${lg.layer}" has no palette; key it with stops or classes`);
      } else if (!(ramp.palette === layer.palette.name && sameJson(ramp.range, layer.palette.range))) {
        errors.push(`${where}/ramp: palette and range must equal those of layer "${lg.layer}"`);
      }
    }
  });
}

// 0.6: a chunks reference. The codec chain starts with its one array to
// bytes codec; levels are unique; every inline ref lies on its level's chunk
// grid, is unique, has a URL and names a band exactly when bands are
// separate. A refs table must be a plain Arrow table (its rows are not read).
function chunksErrors(where, ref, needTable, errors) {
  const codecs = ref.codecs.map((c) => c.name);
  const bands = ref.bands || 1;
  const interleave = ref.interleave || "pixel";
  if (!ARRAY_TO_BYTES.includes(codecs[0])) {
    errors.push(`${where}/codecs: the chain must start with its array to bytes codec (${ARRAY_TO_BYTES.join(" or ")})`);
  }
  codecs.forEach((name, k) => {
    if (name === "predictor" && !(k === 1 && codecs[0] === "bytes")) {
      errors.push(`${where}/codecs/${k}: predictor must come directly after bytes`);
    }
  });
  const pred = ref.codecs.find((c) => c.name === "predictor");
  if (pred && pred.configuration.type === "floating_point" && !ref.dtype.startsWith("float")) {
    errors.push(`${where}/codecs: the floating_point predictor needs a float dtype (got ${ref.dtype})`);
  }
  if (codecs.includes("jpeg")) {
    if (codecs.length !== 1) errors.push(`${where}/codecs: jpeg is the whole chain`);
    if (ref.dtype !== "uint8") errors.push(`${where}: codec jpeg needs dtype uint8`);
    if (interleave !== "pixel") errors.push(`${where}: codec jpeg needs interleave pixel`);
    if (bands !== 1 && bands !== 3) errors.push(`${where}: codec jpeg needs 1 or 3 bands (got ${bands})`);
  }
  const levels = chunkLevels(ref);
  const seenLevels = new Set();
  (ref.grid.levels || []).forEach((lv, j) => {
    if (seenLevels.has(lv.level)) errors.push(`${where}/grid/levels/${j}: duplicate level ${lv.level}`);
    seenLevels.add(lv.level);
  });
  if (ref.refs.table !== undefined) needTable(`${where}/refs/table`, ref.refs.table);
  const seen = new Set();
  (ref.refs.rows || []).forEach((r, k) => {
    const rw = `${where}/refs/rows/${k}`;
    const level = r.level || 0;
    const lv = levels.get(level);
    if (!lv) {
      errors.push(`${rw}: level ${level} is not in the grid`);
    } else if (r.col >= lv.ncols || r.row >= lv.nrows) {
      errors.push(`${rw}: chunk ${r.col}/${r.row} is outside level ${level}'s ${lv.ncols} x ${lv.nrows} chunks`);
    }
    if (interleave === "separate") {
      if (r.band === undefined) errors.push(`${rw}: interleave separate needs band`);
      else if (r.band > bands) errors.push(`${rw}: band ${r.band} is more than bands ${bands}`);
    } else if (r.band !== undefined) {
      errors.push(`${rw}: band is only for interleave separate`);
    }
    if (r.url === undefined && ref.url === undefined) {
      errors.push(`${rw}: no url, and the reference gives no default url`);
    }
    const key = chunkKey(level, r.col, r.row, r.band);
    if (seen.has(key)) errors.push(`${rw}: duplicate chunk ${key}`);
    seen.add(key);
  });
}

const ARRAY_TO_BYTES = ["bytes", "jpeg"];

const chunkKey = (level, col, row, band) => `${level}/${col}/${row}${band === undefined ? "" : `/${band}`}`;

// Level number -> its dim, chunk size and chunk counts, level 0 included.
function chunkLevels(ref) {
  const g = ref.grid;
  const out = new Map();
  const add = (level, dim, size) => {
    out.set(level, { dim, size, ncols: Math.ceil(dim[0] / size[0]), nrows: Math.ceil(dim[1] / size[1]) });
  };
  add(0, g.dim, g.chunk_size);
  for (const lv of g.levels || []) add(lv.level, lv.dim, lv.chunk_size || g.chunk_size);
  return out;
}

function tiledRasterErrors(where, layer, version, view, needData, needTable, errors) {
  const src = needData(`${where}/source`, layer.source);
  const chunked = !!src && src.format === "chunks";
  if (src && src.format !== "cog" && !chunked) {
    const want = atLeast(version, "0.6") ? "a cog or chunks" : "a cog";
    errors.push(`${where}/source: data "${layer.source}" is ${src.format}; expected ${want}`);
  }
  if (layer.band !== undefined) {
    if (layer.rgb) errors.push(`${where}/band: not used with rgb; give the bands in rgb.bands`);
    else if (src && !chunked) errors.push(`${where}/band: only for a chunks source; a cog gives its band in each level's encoding`);
  }
  if (chunked) chunkSourceErrors(where, layer, src, errors);
  const plan = layer.plan;
  if (view.crs === undefined) {
    errors.push(`${where}/plan: a tiled raster needs view.crs`);
  } else if (!sameJson(plan.crs, view.crs)) {
    errors.push(`${where}/plan: crs must equal view.crs`);
  }
  needTable(`${where}/plan/mesh`, plan.mesh.vertices);
  needTable(`${where}/plan/mesh`, plan.mesh.indices);
  if (plan.planned_for) checkExtent(`${where}/plan/planned_for`, plan.planned_for.extent, errors);
  const levels = new Set();
  const vertexRuns = [];
  const indexRuns = [];
  const chunkInfo = chunked ? chunkLevels(src) : null;
  const separate = chunked && (src.interleave || "pixel") === "separate";
  const stored = chunked && src.refs.rows
    ? new Set(src.refs.rows.map((r) => chunkKey(r.level || 0, r.col, r.row, separate ? r.band : undefined)))
    : null;
  const drawnBand = separate ? layer.band || 1 : undefined;
  plan.levels.forEach((lv, j) => {
    const lw = `${where}/plan/levels/${j}`;
    if (levels.has(lv.level)) errors.push(`${lw}: duplicate level ${lv.level}`);
    levels.add(lv.level);
    // 0.6: a level over chunks has no grid or encoding of its own.
    if (chunked && lv.grid) {
      errors.push(`${lw}: a plan over a chunks source takes grid, encoding and byte ranges from the source; give level, pixel_size and tiles`);
      return;
    }
    if (!lv.grid) {
      if (!chunked) {
        errors.push(`${lw}: a plan over a cog gives each level's grid, encoding and tile byte ranges`);
        return;
      }
      const info = chunkInfo.get(lv.level);
      if (!info) errors.push(`${lw}: level ${lv.level} is not in the source grid`);
      const chunks = new Set();
      lv.tiles.forEach((t, k) => {
        const tw = `${lw}/tiles/${k}`;
        const key = chunkKey(lv.level, t.col, t.row, drawnBand);
        if (chunks.has(key)) errors.push(`${tw}: duplicate chunk ${t.col}/${t.row}`);
        chunks.add(key);
        if (info && (t.col >= info.ncols || t.row >= info.nrows)) {
          errors.push(`${tw}: chunk ${t.col}/${t.row} is outside level ${lv.level}'s ${info.ncols} x ${info.nrows} chunks`);
        } else if (info && stored && !stored.has(key)) {
          errors.push(`${tw}: chunk ${key} has no ref; a chunk that is not stored is no data and is left out of the plan`);
        }
        checkExtent(`${tw}/footprint`, t.footprint, errors);
        vertexRuns.push({ where: tw, start: t.mesh.first_vertex, count: t.mesh.vertex_count });
        indexRuns.push({ where: tw, start: t.mesh.first_index, count: t.mesh.index_count });
      });
      return;
    }
    checkExtent(`${lw}/grid`, lv.grid.extent, errors);
    const enc = lv.encoding;
    const spp = enc.samples_per_pixel || 1;
    if (layer.rgb) {
      rgbErrors(`${lw}/encoding`, layer.rgb, enc, spp, errors);
    } else if ((enc.band || 1) > spp) {
      errors.push(`${lw}/encoding: band ${enc.band} is more than samples_per_pixel ${spp}`);
    }
    if (enc.codec === "jpeg") {
      jpegErrors(`${lw}/encoding`, enc, spp, errors);
    } else if (enc.jpeg_tables !== undefined) {
      errors.push(`${lw}/encoding: jpeg_tables is only for codec jpeg`);
    }
    const [ncol, nrow] = lv.grid.dim;
    const tiles = new Set();
    lv.tiles.forEach((t, k) => {
      const tw = `${lw}/tiles/${k}`;
      const key = `${t.col}/${t.row}`;
      if (tiles.has(key)) errors.push(`${tw}: duplicate tile ${key}`);
      tiles.add(key);
      const [w, h] = t.size;
      const win = t.window || { x: 0, y: 0, width: w, height: h };
      if (win.x + win.width > w || win.y + win.height > h) {
        errors.push(`${tw}: window is outside the ${w} x ${h} tile`);
      }
      // The valid pixels must lie on the level's grid; an edge tile needs a
      // window that stops at the grid edge.
      if (t.col * w + win.x + win.width > ncol || t.row * h + win.y + win.height > nrow) {
        errors.push(`${tw}: valid pixels run past the ${ncol} x ${nrow} grid; an edge tile needs a window`);
      }
      checkExtent(`${tw}/footprint`, t.footprint, errors);
      vertexRuns.push({ where: tw, start: t.mesh.first_vertex, count: t.mesh.vertex_count });
      indexRuns.push({ where: tw, start: t.mesh.first_index, count: t.mesh.index_count });
    });
  });
  // Each tile owns its rows: runs in the shared mesh tables must not overlap.
  const checkRuns = (runs, what) => {
    runs.sort((a, b) => a.start - b.start);
    for (let k = 1; k < runs.length; k++) {
      const prev = runs[k - 1];
      if (runs[k].start < prev.start + prev.count) {
        errors.push(`${runs[k].where}/mesh: ${what} rows overlap those of ${prev.where}`);
      }
    }
  };
  checkRuns(vertexRuns, "vertex");
  checkRuns(indexRuns, "index");
}

// 0.6: the bands a tiled raster draws must exist in its chunks source; rgb
// needs every band in one chunk (not separate), and non-uint8 rgb a range.
function chunkSourceErrors(where, layer, src, errors) {
  const bands = src.bands || 1;
  if (layer.rgb) {
    const named = layer.rgb.bands.map((b) => ["rgb.bands", b]);
    if (layer.rgb.alpha !== undefined) named.push(["rgb.alpha", layer.rgb.alpha]);
    for (const [what, b] of named) {
      if (b > bands) errors.push(`${where}/rgb: ${what} ${b} is more than the source's bands ${bands}`);
    }
    if (layer.rgb.alpha !== undefined && layer.rgb.bands.includes(layer.rgb.alpha)) {
      errors.push(`${where}/rgb: rgb.alpha ${layer.rgb.alpha} is also a colour band`);
    }
    if ((src.interleave || "pixel") === "separate") {
      errors.push(`${where}/rgb: rgb needs every band in one chunk (interleave pixel or plane), not separate`);
    }
    if (src.dtype !== "uint8" && !layer.rgb.range) {
      errors.push(`${where}/rgb: rgb on ${src.dtype} samples needs rgb.range to scale them`);
    }
  } else if ((layer.band || 1) > bands) {
    errors.push(`${where}/band: band ${layer.band} is more than the source's bands ${bands}`);
  }
}

// 0.3: a layer drawn as a colour image names its bands itself, and every
// level must hold them, interleaved.
function rgbErrors(where, rgb, enc, spp, errors) {
  if (enc.band !== undefined) {
    errors.push(`${where}: band is not used with rgb; give the bands in rgb.bands`);
  }
  const named = rgb.bands.map((b) => ["rgb.bands", b]);
  if (rgb.alpha !== undefined) named.push(["rgb.alpha", rgb.alpha]);
  for (const [what, b] of named) {
    if (b > spp) errors.push(`${where}: ${what} ${b} is more than samples_per_pixel ${spp}`);
  }
  if (rgb.alpha !== undefined && rgb.bands.includes(rgb.alpha)) {
    errors.push(`${where}: rgb.alpha ${rgb.alpha} is also a colour band`);
  }
  if ((enc.planar || "interleaved") !== "interleaved") {
    errors.push(`${where}: rgb needs planar interleaved (a tile record points at one band's bytes when separate)`);
  }
  if (enc.dtype !== "uint8" && !rgb.range) {
    errors.push(`${where}: rgb on ${enc.dtype} samples needs rgb.range to scale them`);
  }
}

// 0.3: JPEG tiles are 8-bit, pixel-interleaved greyscale or YCbCr.
function jpegErrors(where, enc, spp, errors) {
  if (enc.dtype !== "uint8") errors.push(`${where}: codec jpeg needs dtype uint8`);
  if ((enc.predictor || "none") !== "none") errors.push(`${where}: codec jpeg takes no predictor`);
  if ((enc.planar || "interleaved") !== "interleaved") errors.push(`${where}: codec jpeg needs planar interleaved`);
  if (spp !== 1 && spp !== 3) errors.push(`${where}: codec jpeg needs samples_per_pixel 1 or 3 (got ${spp})`);
}

function validateScene(scene) {
  const version = scene && scene.version;
  const validate = schemaValidate[version];
  if (!validate) {
    return [`/version must be one of ${VERSIONS.join(", ")} (got ${JSON.stringify(version)})`];
  }
  if (!validate(scene)) {
    return validate.errors.map(
      (e) => `${e.instancePath || "/"} ${e.message}${e.params && e.params.additionalProperty ? ` (${e.params.additionalProperty})` : ""}`
    );
  }
  return semanticErrors(scene);
}

function validateFile(file) {
  return validateScene(JSON.parse(fs.readFileSync(file, "utf8")));
}

function jsonFiles(dir) {
  return fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => path.join(dir, f));
}

function suite() {
  const groups = [
    { dir: path.join(ROOT, "conformance"), expect: true },
    { dir: path.join(ROOT, "fixtures", "valid"), expect: true },
    { dir: path.join(ROOT, "fixtures", "invalid"), expect: false },
  ];
  let failed = 0;
  let total = 0;
  for (const { dir, expect } of groups) {
    const files = jsonFiles(dir);
    if (files.length === 0) {
      console.log(`FAIL ${path.relative(ROOT, dir)}: no fixtures`);
      failed++;
    }
    for (const file of files) {
      total++;
      const errors = validateFile(file);
      const ok = errors.length === 0;
      const rel = path.relative(ROOT, file);
      if (ok === expect) {
        console.log(`ok   ${rel}${expect ? "" : ` (rejected: ${errors[0]})`}`);
      } else {
        failed++;
        console.log(`FAIL ${rel}: expected ${expect ? "valid" : "invalid"}`);
        errors.forEach((e) => console.log(`       ${e}`));
      }
    }
  }
  console.log(`${total - failed}/${total} fixtures as expected`);
  return failed === 0;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    process.exit(suite() ? 0 : 1);
  }
  let bad = 0;
  for (const file of args) {
    const errors = validateFile(file);
    if (errors.length) {
      bad++;
      console.log(`INVALID ${file}`);
      errors.forEach((e) => console.log(`  ${e}`));
    } else {
      console.log(`valid   ${file}`);
    }
  }
  process.exit(bad ? 1 : 0);
}

module.exports = { validateScene, semanticErrors };
