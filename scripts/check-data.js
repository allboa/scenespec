#!/usr/bin/env node
// Check explicit (vector) data against the contract in the README section
// "Explicit data". For every vector data reference (one with a `geometry`)
// whose URL is a file in this repo, read the Arrow IPC bytes with
// apache-arrow and check that:
//   - the bytes are the declared IPC format (stream or file);
//   - the geometry column has a native GeoArrow extension type, the one the
//     scene declares (never WKB or WKT, no geometry collections);
//   - the extension metadata gives a CRS that matches view.crs, and planar
//     edges;
//   - the storage is the layout the extension names: nested 32-bit Lists
//     down to coordinates, interleaved (FixedSizeList<double> named xy or
//     xyz) or separated (Struct of doubles x, y and optionally z), no M;
//   - every other column is an attribute type popups show, or a colour
//     column (FixedSizeList<uint8, 4>);
//   - the layers that draw it name colour columns of that type and popup
//     columns that exist and are attributes.
//
//   node scripts/check-data.js            run the suite
//   node scripts/check-data.js a.json     check the local data of given scenes
//
// The suite expects the data of conformance/ and fixtures/valid/ scenes to
// pass, and each scene in fixtures/data/invalid/ to be a valid scene whose
// data fails for exactly one reason. Data held as blobs, or at URLs that are
// not files in the repo, is skipped and counted.
"use strict";

const fs = require("fs");
const path = require("path");
const { tableFromIPC, Type, Precision } = require("apache-arrow");
const { validateScene } = require("./validate.js");

const ROOT = path.resolve(__dirname, "..");

// Extension name -> number of List levels above the coordinates.
const NATIVE = {
  "geoarrow.point": 0,
  "geoarrow.linestring": 1,
  "geoarrow.multipoint": 1,
  "geoarrow.polygon": 2,
  "geoarrow.multilinestring": 2,
  "geoarrow.multipolygon": 3,
};
const CRS_TYPES = ["projjson", "authority_code"];
const AUTH_CODE = /^[A-Za-z][A-Za-z0-9_]*:[A-Za-z0-9_.-]+$/;

const isDouble = (t) => t.typeId === Type.Float && t.precision === Precision.DOUBLE;

// --- CRS matching ------------------------------------------------------------

// JSON values equal regardless of object key order.
function sameValue(a, b) {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  return sameValue(ka.join("\n"), kb.join("\n")) && ka.every((k) => sameValue(a[k], b[k]));
}

// The "AUTHORITY:CODE" names of a CRS: the string itself, or a PROJJSON
// object's top-level id (or ids).
function crsCodes(c) {
  if (typeof c === "string") return AUTH_CODE.test(c) ? [c.toUpperCase()] : [];
  if (!c || typeof c !== "object") return [];
  const ids = c.ids || (c.id ? [c.id] : []);
  return ids.filter((i) => i && i.authority !== undefined && i.code !== undefined)
    .map((i) => `${i.authority}:${i.code}`.toUpperCase());
}

// Two CRSs match when they are equal as JSON values (PROJJSON's "$schema"
// aside), or when one authority code names both.
function sameCrs(a, b) {
  const bare = (c) => {
    if (!c || typeof c !== "object") return c;
    const { $schema, ...rest } = c;
    return rest;
  };
  if (sameValue(bare(a), bare(b))) return true;
  const cb = crsCodes(b);
  return crsCodes(a).some((k) => cb.includes(k));
}

const crsLabel = (c) => {
  if (c === undefined) return "no CRS";
  const codes = crsCodes(c);
  if (codes.length) return codes[0];
  return typeof c === "string" ? JSON.stringify(c.slice(0, 40)) : `PROJJSON "${c.name || "unnamed"}"`;
};

// --- types -------------------------------------------------------------------

function typeName(t) {
  if (t.typeId === Type.Dictionary) return `Dictionary<${typeName(t.dictionary)}>`;
  const base = Type[t.typeId] || String(t);
  if (t.typeId === Type.FixedSizeList) return `FixedSizeList<${typeName(t.children[0].type)}, ${t.listSize}>`;
  if (t.typeId === Type.Int) return `${t.isSigned ? "Int" : "Uint"}${t.bitWidth}`;
  if (t.typeId === Type.Float) return ["Float16", "Float32", "Float64"][t.precision];
  return base;
}

const isColour = (t) => t.typeId === Type.FixedSizeList && t.listSize === 4 &&
  t.children[0].type.typeId === Type.Int && t.children[0].type.bitWidth === 8 && !t.children[0].type.isSigned;

// Attribute types: what a popup shows as text.
function isAttribute(t) {
  switch (t.typeId) {
    case Type.Bool: case Type.Int: case Type.Utf8: case Type.LargeUtf8: case Type.Date: case Type.Timestamp:
      return true;
    case Type.Float:
      return t.precision !== Precision.HALF;
    default:
      return false;
  }
}

// --- the contract --------------------------------------------------------------

// Coordinates: interleaved or separated doubles, xy or xyz. Returns an error
// or null.
function coordError(f) {
  const t = f.type;
  if (t.typeId === Type.FixedSizeList) {
    const child = t.children[0];
    if (/m/.test(child.name) || t.listSize === 4) return `coordinates are ${child.name || `${t.listSize} values`}: M coordinates are out of scope`;
    if (!((child.name === "xy" && t.listSize === 2) || (child.name === "xyz" && t.listSize === 3))) {
      return `interleaved coordinates must be a FixedSizeList named xy (2 values) or xyz (3), not "${child.name}" (${t.listSize})`;
    }
    if (!isDouble(child.type)) return `coordinates must be doubles, not ${typeName(child.type)}`;
    return null;
  }
  if (t.typeId === Type.Struct) {
    const names = t.children.map((c) => c.name);
    if (names.includes("m")) return `coordinates are ${names.join("")}: M coordinates are out of scope`;
    if (!(names.join(",") === "x,y" || names.join(",") === "x,y,z")) {
      return `separated coordinates must be a Struct of x, y and optionally z, not ${names.join(", ")}`;
    }
    const bad = t.children.find((c) => !isDouble(c.type));
    if (bad) return `coordinate ${bad.name} must be double, not ${typeName(bad.type)}`;
    return null;
  }
  return `coordinates must be a FixedSizeList (interleaved) or Struct (separated), not ${typeName(t)}`;
}

function storageError(field, encoding) {
  let f = field;
  for (let k = 0; k < NATIVE[encoding]; k++) {
    if (f.type.typeId === Type.LargeList) return `${encoding} storage uses LargeList; offsets must be 32-bit (List)`;
    if (f.type.typeId !== Type.List) {
      return `${encoding} storage must be ${NATIVE[encoding]} nested List level(s) above the coordinates; found ${typeName(f.type)} at level ${k + 1}`;
    }
    f = f.type.children[0];
  }
  return coordError(f);
}

// The geometry column: its extension, metadata and storage. Stops at the
// first fault, so a fixture fails for one reason.
function geometryError(field, ref, view) {
  const meta = field.metadata;
  const ext = meta.get("ARROW:extension:name");
  const declared = ref.geometry.encoding;
  if (ext === undefined) return `geometry column "${field.name}" has no GeoArrow extension type (${typeName(field.type)} storage)`;
  if (/wk[bt]/.test(ext)) return `geometry column "${field.name}" is ${ext}: serialised geometry (WKB or WKT) is not allowed; write a native GeoArrow type`;
  if (ext === "geoarrow.geometrycollection" || ext === "geoarrow.geometry") {
    return `geometry column "${field.name}" is ${ext}: geometry collections and mixed geometry types are out of scope`;
  }
  if (!(ext in NATIVE)) return `geometry column "${field.name}" has extension ${ext}, which is not one of the six native GeoArrow types`;
  if (ext !== declared) return `geometry column "${field.name}" is ${ext} but the scene declares ${declared}`;
  let m = {};
  const text = meta.get("ARROW:extension:metadata");
  if (text !== undefined && text !== "") {
    try {
      m = JSON.parse(text);
    } catch (e) {
      return `ARROW:extension:metadata of "${field.name}" is not JSON: ${e.message}`;
    }
  }
  if (m.edges !== undefined && m.edges !== "planar") return `edges are ${m.edges}; only planar edges are drawn`;
  if (m.crs_type !== undefined && !CRS_TYPES.includes(m.crs_type)) {
    return `crs_type ${m.crs_type} is not ${CRS_TYPES.join(" or ")}`;
  }
  if (view.crs !== undefined) {
    if (m.crs === undefined || m.crs === null) return `geometry column "${field.name}" has no crs in its extension metadata (view CRS ${crsLabel(view.crs)})`;
    if (!sameCrs(m.crs, view.crs)) return `geometry CRS ${crsLabel(m.crs)} is not the view CRS ${crsLabel(view.crs)}`;
  }
  return storageError(field, ext);
}

// Errors of one vector data reference read from `bytes`.
function dataErrors(bytes, id, ref, scene) {
  const where = `/data/${id}`;
  const isFile = bytes.length >= 6 && Buffer.from(bytes.subarray(0, 6)).toString("latin1") === "ARROW1";
  if (ref.format === "arrow-ipc-file" && !isFile) return [`${where}: declared arrow-ipc-file but the bytes are not an IPC file`];
  if (ref.format === "arrow-ipc-stream" && isFile) return [`${where}: declared arrow-ipc-stream but the bytes are an IPC file`];
  let table;
  try {
    table = tableFromIPC(bytes);
  } catch (e) {
    return [`${where}: not readable as Arrow IPC: ${e.message}`];
  }
  const fields = table.schema.fields;
  const geom = fields.find((f) => f.name === ref.geometry.column);
  if (!geom) return [`${where}: geometry column "${ref.geometry.column}" not found`];
  const ge = geometryError(geom, ref, scene.view || {});
  if (ge) return [`${where}: ${ge}`];
  const errors = [];
  for (const f of fields) {
    if (f === geom) continue;
    const ext = f.metadata.get("ARROW:extension:name");
    if (ext !== undefined && ext.startsWith("geoarrow.")) {
      errors.push(`${where}: column "${f.name}" is a second geometry column (${ext}); one layer's data has one`);
    } else if (!isAttribute(f.type) && !isColour(f.type)) {
      errors.push(`${where}: column "${f.name}" is ${typeName(f.type)}, not an attribute type (bool, integer, float32 or float64, string, date, timestamp) or a colour column (FixedSizeList<Uint8, 4>)`);
    }
  }
  (scene.layers || []).forEach((L, i) => {
    if (L.data !== id) return;
    for (const key of ["fill", "stroke"]) {
      const c = L[key];
      if (!c || Array.isArray(c)) continue;
      const f = fields.find((x) => x.name === c.column);
      if (!f) errors.push(`/layers/${i}/${key}: colour column "${c.column}" not found in data ${id}`);
      else if (!isColour(f.type)) errors.push(`/layers/${i}/${key}: colour column "${c.column}" is ${typeName(f.type)}, not FixedSizeList<Uint8, 4>`);
    }
    for (const name of (L.popup && L.popup.columns) || []) {
      const f = fields.find((x) => x.name === name);
      if (!f) errors.push(`/layers/${i}/popup: column "${name}" not found in data ${id}`);
      else if (!isAttribute(f.type)) errors.push(`/layers/${i}/popup: column "${name}" is ${typeName(f.type)}, not an attribute type`);
    }
  });
  return errors;
}

// Check the local vector data of one scene file.
function checkScene(file) {
  const scene = JSON.parse(fs.readFileSync(file, "utf8"));
  const res = { checked: [], skipped: 0, errors: [] };
  for (const [id, ref] of Object.entries(scene.data || {})) {
    if (!ref.geometry || !(ref.format === "arrow-ipc-stream" || ref.format === "arrow-ipc-file")) continue;
    const url = ref.url;
    const local = url === undefined || /^[a-z][a-z0-9+.-]*:/i.test(url) ? null : path.resolve(path.dirname(file), url);
    if (!local || !fs.existsSync(local)) {
      res.skipped++;
      continue;
    }
    res.checked.push(local);
    res.errors.push(...dataErrors(fs.readFileSync(local), id, ref, scene));
  }
  return res;
}

const jsonFiles = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => path.join(dir, f));

function suite() {
  let bad = 0;
  const used = new Set();
  const rel = (f) => path.relative(ROOT, f);
  for (const dir of ["conformance", path.join("fixtures", "valid")]) {
    for (const file of jsonFiles(path.join(ROOT, dir))) {
      const r = checkScene(file);
      r.checked.forEach((f) => used.add(f));
      if (r.checked.length === 0) continue;
      const skipped = r.skipped ? `, ${r.skipped} skipped (not in the repo)` : "";
      if (r.errors.length) {
        bad++;
        console.log(`FAIL ${rel(file)}`);
        r.errors.forEach((e) => console.log(`       ${e}`));
      } else {
        console.log(`ok   ${rel(file)}: ${r.checked.length} vector data files meet the contract${skipped}`);
      }
    }
  }
  const invalid = path.join(ROOT, "fixtures", "data", "invalid");
  for (const file of jsonFiles(invalid)) {
    const sceneErrors = validateScene(JSON.parse(fs.readFileSync(file, "utf8")));
    const r = checkScene(file);
    r.checked.forEach((f) => used.add(f));
    if (sceneErrors.length) {
      bad++;
      console.log(`FAIL ${rel(file)}: the scene itself must be valid (${sceneErrors[0]})`);
    } else if (r.checked.length === 0) {
      bad++;
      console.log(`FAIL ${rel(file)}: no local data to check`);
    } else if (r.errors.length !== 1) {
      bad++;
      console.log(`FAIL ${rel(file)}: expected exactly one data error, got ${r.errors.length}`);
      r.errors.forEach((e) => console.log(`       ${e}`));
    } else {
      console.log(`ok   ${rel(file)} (rejected: ${r.errors[0]})`);
    }
  }
  // Every data fixture is read by some scene.
  for (const dir of [path.join(ROOT, "fixtures", "data"), invalid]) {
    for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".arrows"))) {
      if (!used.has(path.join(dir, f))) {
        bad++;
        console.log(`FAIL ${rel(path.join(dir, f))}: no scene references it`);
      }
    }
  }
  console.log(`${used.size} Arrow data files read`);
  return bad === 0;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length === 0) process.exit(suite() ? 0 : 1);
  let bad = 0;
  for (const file of args) {
    const r = checkScene(file);
    if (r.errors.length) {
      bad++;
      console.log(`INVALID ${file}`);
      r.errors.forEach((e) => console.log(`  ${e}`));
    } else {
      console.log(`ok      ${file}: ${r.checked.length} checked, ${r.skipped} skipped`);
    }
  }
  process.exit(bad ? 1 : 0);
}

module.exports = { dataErrors, sameCrs, checkScene };
