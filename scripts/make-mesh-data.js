#!/usr/bin/env node
// Write the 0.7 mesh fixtures: a small triangle mesh in EPSG:3031 as three
// plain Arrow IPC streams (fixtures/data/mesh-vertices.arrows,
// mesh-indices.arrows, mesh-faces.arrows), and tables that break the mesh
// contract for one reason each (fixtures/data/invalid/mesh-*.arrows). The
// scenes that reference them are written by hand; scripts/check-data.js
// checks both.
//
//   node scripts/make-mesh-data.js        (from the repository root)
//
// The tables are the drawable form of the hypertidy/meshcore mesh spec:
// vertices with position (FixedSizeList<float32, 3>) and a per-vertex value,
// indices with one uint32 column of three rows per triangle, and faces with
// one row per triangle. The mesh is a 4 x 4 lattice of vertices over a 3000
// km square about the pole, each cell cut into two counter-clockwise
// triangles, with a dome of height (metres) as z.
"use strict";

const fs = require("fs");
const path = require("path");
const {
  tableToIPC, tableFromArrays, makeData, makeVector, Table,
  Field, FixedSizeList, Float32, Uint32, Int32,
} = require("apache-arrow");

const ROOT = path.resolve(__dirname, "..");
const out = path.join(ROOT, "fixtures", "data");
const bad = path.join(out, "invalid");
fs.mkdirSync(bad, { recursive: true });

const N = 4;
const HALF = 1500000;
const DOME = 3000;

// FixedSizeList<float32, 3> named position, one [x, y, z] per row.
function positions(xyz) {
  const child = makeData({ type: new Float32(), length: xyz.length, data: Float32Array.from(xyz) });
  const type = new FixedSizeList(3, new Field("xyz", new Float32(), false));
  return makeVector(makeData({ type, length: xyz.length / 3, nullCount: 0, child }));
}

function lattice() {
  const xyz = [];
  const height = [];
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const x = -HALF + (2 * HALF * i) / (N - 1);
      const y = HALF - (2 * HALF * j) / (N - 1);
      const r2 = (x * x + y * y) / (2 * HALF * HALF);
      const z = Math.round(DOME * (1 - r2));
      xyz.push(x, y, z);
      height.push(z);
    }
  }
  const index = [];
  for (let j = 0; j < N - 1; j++) {
    for (let i = 0; i < N - 1; i++) {
      const a = j * N + i;
      const b = a + 1;
      const c = a + N;
      const d = c + 1;
      // Rows run down (y decreases), so c, b, a and c, d, b are
      // counter-clockwise seen from above.
      index.push(c, b, a, c, d, b);
    }
  }
  return { xyz, height, index };
}

const write = (file, table) => {
  fs.writeFileSync(file, tableToIPC(table, "stream"));
  console.log(`wrote ${path.relative(ROOT, file)} (${table.numRows} rows)`);
};

const m = lattice();
const ntri = m.index.length / 3;
const vertices = new Table({ position: positions(m.xyz), height: makeVector(Float32Array.from(m.height)) });
const indices = tableFromArrays({ index: Uint32Array.from(m.index) });
const count = Int32Array.from({ length: ntri }, (_, k) => (k * 7) % 11);
const cell = Int32Array.from({ length: ntri }, (_, k) => Math.floor(k / 2));
const faces = tableFromArrays({ count, cell });

write(path.join(out, "mesh-vertices.arrows"), vertices);
write(path.join(out, "mesh-indices.arrows"), indices);
write(path.join(out, "mesh-faces.arrows"), faces);

// One fault each.
const outOfRange = m.index.slice();
outOfRange[outOfRange.length - 1] = N * N;
write(path.join(bad, "mesh-index-out-of-range.arrows"), tableFromArrays({ index: Uint32Array.from(outOfRange) }));
write(path.join(bad, "mesh-index-not-triangles.arrows"), tableFromArrays({ index: Uint32Array.from(m.index.slice(0, -1)) }));
write(path.join(bad, "mesh-faces-short.arrows"), tableFromArrays({ count: count.slice(0, -1), cell: cell.slice(0, -1) }));
