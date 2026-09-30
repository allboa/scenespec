#!/usr/bin/env node
// Validate scene spec documents against schema/scene-0.1.schema.json plus
// the cross-reference checks JSON Schema cannot express.
//
//   node scripts/validate.js              run the fixture suite
//   node scripts/validate.js a.json ...   validate the given scenes
"use strict";

const fs = require("fs");
const path = require("path");
const Ajv2020 = require("ajv/dist/2020");
const addFormats = require("ajv-formats");

const ROOT = path.resolve(__dirname, "..");
const SCHEMA = path.join(ROOT, "schema", "scene-0.1.schema.json");

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const schemaValidate = ajv.compile(JSON.parse(fs.readFileSync(SCHEMA, "utf8")));

// Which geometry encodings each vector layer kind accepts.
const KIND_ENCODINGS = {
  polygon: ["geoarrow.polygon", "geoarrow.multipolygon"],
  path: ["geoarrow.linestring", "geoarrow.multilinestring"],
  point: ["geoarrow.point", "geoarrow.multipoint"],
};

function checkExtent(where, e, errors) {
  if (Array.isArray(e) && e.length === 4 && !(e[0] < e[1] && e[2] < e[3])) {
    errors.push(`${where}: extent must be [xmin, xmax, ymin, ymax] with xmin < xmax and ymin < ymax`);
  }
}

// Checks that need the whole document: ids resolve, ids are unique,
// geometry matches layer kind, extents are ordered, origin and CRS rules.
function semanticErrors(scene) {
  const errors = [];
  const data = scene.data || {};
  const view = scene.view || {};
  for (const [id, ref] of Object.entries(data)) {
    if (ref.origin_subtracted === true && !view.local_origin) {
      errors.push(`/data/${id}: origin_subtracted is true but view.local_origin is absent`);
    }
    // 0.1: vector coordinates are in the view CRS. Compared as JSON values,
    // so "EPSG:3031" and an equivalent PROJJSON object do not match.
    if (ref.geometry && ref.geometry.crs !== undefined && view.crs !== undefined &&
        JSON.stringify(ref.geometry.crs) !== JSON.stringify(view.crs)) {
      errors.push(`/data/${id}: geometry.crs must equal view.crs in 0.1`);
    }
  }
  // Raster values and mesh tables are plain tables, not vector data.
  const needTable = (where, id) => {
    const ref = needData(where, id);
    if (ref && ref.geometry) errors.push(`${where}: data "${id}" has a geometry column; expected a plain table`);
  };
  const needData = (where, id) => {
    if (!Object.prototype.hasOwnProperty.call(data, id)) {
      errors.push(`${where}: data id "${id}" is not defined in data`);
      return null;
    }
    return data[id];
  };
  checkExtent("/view", scene.view && scene.view.extent, errors);
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
    }
  });
  return errors;
}

function validateScene(scene) {
  if (!schemaValidate(scene)) {
    return schemaValidate.errors.map(
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
