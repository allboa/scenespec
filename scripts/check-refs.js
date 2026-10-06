#!/usr/bin/env node
// Decode the chunk refs of the conformance scenes whose bytes are in this
// repo (0.6). For each inline ref of a chunks data reference whose URL is a
// local file next to the scene, read bytes [offset, offset + length),
// undo the codec chain in reverse and check that a full chunk comes out
// (chunk width * height * bands * sample size bytes). Refs whose files are
// not in the repo, and refs whose codec chain this script does not undo
// (anything but bytes then deflate or gzip), are skipped and counted apart.
"use strict";

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const ROOT = path.resolve(__dirname, "..");
const SAMPLE_BYTES = { uint8: 1, int8: 1, uint16: 2, int16: 2, uint32: 4, int32: 4, float32: 4, float64: 8 };
const UNDO = { deflate: zlib.inflateSync, gzip: zlib.gunzipSync };

function checkScene(file) {
  const scene = JSON.parse(fs.readFileSync(file, "utf8"));
  const res = { ok: 0, notLocal: 0, codec: 0, failed: [] };
  for (const [id, ref] of Object.entries(scene.data || {})) {
    if (ref.format !== "chunks" || !ref.refs.rows) continue;
    const names = ref.codecs.map((c) => c.name);
    const levels = new Map([[0, ref.grid.chunk_size]]);
    for (const lv of ref.grid.levels || []) levels.set(lv.level, lv.chunk_size || ref.grid.chunk_size);
    ref.refs.rows.forEach((r, k) => {
      const url = r.url || ref.url;
      const local = /^[a-z][a-z0-9+.-]*:/i.test(url) ? null : path.resolve(path.dirname(file), url);
      if (!local || !fs.existsSync(local)) {
        res.notLocal++;
        return;
      }
      if (names[0] !== "bytes" || !names.slice(1).every((n) => UNDO[n])) {
        res.codec++;
        return;
      }
      const fd = fs.openSync(local, "r");
      let bytes = Buffer.alloc(r.length);
      const got = fs.readSync(fd, bytes, 0, r.length, r.offset);
      fs.closeSync(fd);
      const where = `/data/${id}/refs/rows/${k}`;
      if (got !== r.length) {
        res.failed.push(`${where}: ${url} has only ${got} bytes at offset ${r.offset}`);
        return;
      }
      try {
        for (const n of names.slice(1).reverse()) bytes = UNDO[n](bytes);
      } catch (e) {
        res.failed.push(`${where}: ${names.join(", ")} did not decode: ${e.message}`);
        return;
      }
      const [w, h] = levels.get(r.level || 0);
      const bands = (ref.interleave || "pixel") === "separate" ? 1 : ref.bands || 1;
      const want = w * h * bands * SAMPLE_BYTES[ref.dtype];
      if (bytes.length !== want) res.failed.push(`${where}: decoded ${bytes.length} bytes, expected ${want}`);
      else res.ok++;
    });
  }
  return res;
}

function main() {
  const dir = path.join(ROOT, "conformance");
  let bad = 0;
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    const r = checkScene(path.join(dir, f));
    if (r.ok + r.notLocal + r.codec + r.failed.length === 0) continue;
    if (r.failed.length) {
      bad++;
      console.log(`FAIL conformance/${f}`);
      r.failed.forEach((e) => console.log(`       ${e}`));
    } else {
      const notLocal = r.notLocal ? `, ${r.notLocal} skipped (bytes not in the repo)` : "";
      const codec = r.codec ? `, ${r.codec} skipped (codec chain not decoded by this script)` : "";
      console.log(`ok   conformance/${f}: ${r.ok} refs decoded${notLocal}${codec}`);
    }
  }
  process.exit(bad ? 1 : 0);
}

if (require.main === module) main();

module.exports = { checkScene };
