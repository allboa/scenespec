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
const VERSIONS = ["0.1", "0.2", "0.3", "0.4"];

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

function checkExtent(where, e, errors) {
  if (Array.isArray(e) && e.length === 4 && !(e[0] < e[1] && e[2] < e[3])) {
    errors.push(`${where}: extent must be [xmin, xmax, ymin, ymax] with xmin < xmax and ymin < ymax`);
  }
}

// Checks that need the whole document: ids resolve, ids are unique,
// geometry matches layer kind, extents are ordered, origin and CRS rules,
// (0.2) tile plans are consistent with their levels and sources, and (0.3)
// rgb bands and jpeg encodings fit every level.
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
  // Raster values and mesh tables are plain Arrow tables, not vector data
  // and not COGs.
  const needTable = (where, id) => {
    const ref = needData(where, id);
    if (!ref) return;
    if (ref.format === "cog") errors.push(`${where}: data "${id}" is a cog; expected an Arrow table`);
    else if (ref.geometry) errors.push(`${where}: data "${id}" has a geometry column; expected a plain table`);
  };
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
      }
    } else if (layer.kind === "raster") {
      needTable(where, layer.values);
      checkExtent(`${where}/grid`, layer.grid && layer.grid.extent, errors);
      if (layer.mesh) {
        needTable(`${where}/mesh`, layer.mesh.vertices);
        needTable(`${where}/mesh`, layer.mesh.indices);
      }
    } else if (layer.kind === "tiled_raster") {
      tiledRasterErrors(where, layer, view, needData, needTable, errors);
    }
  });
  return errors;
}

function tiledRasterErrors(where, layer, view, needData, needTable, errors) {
  const src = needData(`${where}/source`, layer.source);
  if (src && src.format !== "cog") {
    errors.push(`${where}/source: data "${layer.source}" is ${src.format}; expected a cog`);
  }
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
  plan.levels.forEach((lv, j) => {
    const lw = `${where}/plan/levels/${j}`;
    if (levels.has(lv.level)) errors.push(`${lw}: duplicate level ${lv.level}`);
    levels.add(lv.level);
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
