# scenespec

The allonboard scene spec: a small, renderer-neutral JSON document that
describes a map scene. It names a view in its own CRS (polar first), the data
the scene draws (Arrow IPC with native GeoArrow geometry, or raster values on
a grid), and layers that draw that data with styling given as data. A renderer
implements the spec; nothing in the schema names a renderer, its layer
classes, props or view classes.

Agents and humans working here follow the org brief:
[allboa/design AGENTS.md](https://github.com/allboa/design/blob/main/AGENTS.md).

## Contents

| Path | What |
| --- | --- |
| `schema/scene-0.1.schema.json` | JSON Schema (draft 2020-12) for scene spec 0.1 |
| `schema/scene-0.2.schema.json` | JSON Schema for scene spec 0.2: 0.1 plus tiled COG rasters |
| `schema/scene-0.3.schema.json` | JSON Schema for scene spec 0.3: 0.2 plus colour images (RGB and RGBA) and JPEG tiles |
| `conformance/` | Conformance scenes. `polar-probe.json` is the polar view probe (design origin record, 2026-09-30) converted to 0.1. `polar-cog-tiles.json` (0.2) is a tiled COG plan from allboa/spikes `tiled-cog-polar/`. `polar-rgb-jpeg-tiles.json` (0.3) is a 3-band YCbCr JPEG COG drawn as a colour image |
| `fixtures/valid/` | Minimal scenes that must validate |
| `fixtures/invalid/` | Scenes that must fail, one reason each |
| `scripts/validate.js` | Schema validation (ajv, schema chosen by the scene's `version`) plus cross-reference checks |
| `scripts/check-terms.js` | Fails if any renderer term from a denylist appears in the schema |

## A scene in brief

```json
{
  "version": "0.1",
  "view": { "type": "projected", "crs": "EPSG:3031", "center": [0, 0] },
  "data": {
    "coast": {
      "format": "arrow-ipc-stream",
      "blob": "coast",
      "geometry": { "column": "geometry", "encoding": "geoarrow.linestring" }
    }
  },
  "layers": [
    { "id": "coast", "kind": "path", "data": "coast",
      "stroke": [60, 66, 72, 255], "stroke_width_px": 1 }
  ]
}
```

- **view**: `type` is `projected` (flat map of view CRS coordinates; `crs`
  required; usually a projected CRS, but a geographic CRS is allowed and is
  drawn flat as lon/lat, plate carree), `cartesian` (flat Cartesian plane,
  `crs` optional) or `globe` (`crs` required). `crs` is `authority:code` or a PROJJSON object. `center`,
  `extent` (`[xmin, xmax, ymin, ymax]`) and `local_origin` are in view CRS
  units. `local_origin` is the float32 precision provision: renderers draw
  relative to it, and data marked `origin_subtracted` already have it
  subtracted.
- **data**: references keyed by id. Each is Arrow IPC (`arrow-ipc-stream` or
  `arrow-ipc-file`) held as exactly one of a transport `blob` key or a `url`.
  Vector tables declare their `geometry` column with a native GeoArrow
  encoding; WKB and WKT are not allowed. In 0.1 vector coordinates are in
  the view CRS: if `geometry.crs` is given it must equal `view.crs` exactly
  (compared as JSON values). `origin_subtracted: true` requires
  `view.local_origin`.
- **layers**: drawn in order, first at the bottom. `kind` is `polygon`,
  `path`, `point` or `raster`. Vector layers name a `data` id; the validator
  checks the geometry encoding fits the kind.
- **styling**: a color is a constant `[r, g, b, a]` (0 to 255) or
  `{ "column": "name" }` naming a per-row RGBA column
  (`FixedSizeList<uint8, 4>`). Rasters use a `palette` with `name` and
  `range`.
- **raster**: a `grid` descriptor (`crs`, `extent`, `dim` as `[ncol, nrow]`,
  optional `nodata`), a `values` data id (row-major, row 0 at ymax), and
  optionally a pre-projected `mesh` (vertex table with `position` in view CRS
  units and `uv` into the grid, plus an index table). `values` and mesh
  tables are plain tables and must not declare a geometry column. `nodata`
  is a number, or the string `"NaN"` to say NaN cells mean no data (JSON has
  no NaN literal); Arrow nulls always mean no data.

## 0.2: tiled COG rasters

0.2 is 0.1 plus one data reference format and one layer kind. Every 0.1
construct is unchanged; a 0.1 scene becomes a 0.2 scene by changing
`version`. It follows gate A (allboa/design decision 0003, accepted
2026-09-30): the producer (R) plans the tiles, and the renderer only fetches
bytes, decodes and draws.

```json
{
  "data": {
    "sst": { "format": "cog", "url": "polar_3031.tif" },
    "sst_v": { "format": "arrow-ipc-stream", "blob": "sst_v" },
    "sst_i": { "format": "arrow-ipc-stream", "blob": "sst_i" }
  },
  "layers": [
    { "id": "sst", "kind": "tiled_raster", "source": "sst",
      "palette": { "name": "ocean", "range": [-2, 13] },
      "plan": {
        "crs": "EPSG:3031",
        "coverage": "all_levels",
        "selection": { "rule": "coarsest_sufficient" },
        "mesh": { "vertices": "sst_v", "indices": "sst_i" },
        "levels": [
          { "level": 4,
            "grid": { "crs": "EPSG:3031", "extent": [-6400000, 6400000, -6400000, 6400000],
                      "dim": [160, 160], "nodata": -9999 },
            "pixel_size": 80000,
            "encoding": { "codec": "deflate", "dtype": "float32" },
            "tiles": [
              { "col": 0, "row": 0, "byte_offset": 2480, "byte_length": 62061,
                "size": [256, 256], "window": { "x": 0, "y": 0, "width": 160, "height": 160 },
                "footprint": [-6400000, 6400000, -6400000, 6400000],
                "mesh": { "first_vertex": 0, "vertex_count": 4, "first_index": 0, "index_count": 6 } }
            ] }
        ] } }
  ]
}
```

- **cog data reference**: `{ "format": "cog", "url": ... }`, a Cloud
  Optimized GeoTIFF read with HTTP range requests. The URL is required (a
  blob is not allowed). The renderer never parses the TIFF header: the plan
  carries every byte range and encoding it needs.
- **tiled_raster layer**: `source` names a `cog`, `palette` colors values,
  and `plan` says which tiles to draw.
- **plan**: `crs` is the CRS of meshes and footprints and must equal
  `view.crs`. `coverage` is `view` (made for one view, recorded in
  `planned_for` as an extent and view units per device pixel; exactly one
  level; draw every tile) or `all_levels` (every level up front, with a
  `selection` rule). `mesh` names one Arrow vertex table and one Arrow index
  table shared by all tiles, with the same column conventions as a 0.1 mesh
  (`position`, `uv`, `index`). Meshes travel as Arrow data, never as JSON
  arrays, and the validator checks both are plain Arrow tables. Tiles'
  row runs must not overlap (checked). A producer may write the tables as
  one record batch per tile, so a renderer can consume the streams
  incrementally and draw tiles as they arrive; row numbers count across
  batches, so the runs stay valid.
- **level**: `level` (0 is full resolution, k the k-th overview), `grid`
  (this level's extent, dim and nodata in the source CRS, as a 0.1 grid
  descriptor), `pixel_size` (one source pixel in view CRS units, as the
  producer measured it), `encoding` and `tiles`.
- **encoding** (per level, because a TIFF stores it per image): `codec`
  (`deflate` is a zlib stream; JPEG is left out because JPEG COGs keep
  shared tables in the TIFF header, which the renderer does not read; 0.3
  adds it with the tables carried in the plan), `predictor` (`none`, `horizontal`,
  `floating_point`), `dtype`, `byte_order`, `samples_per_pixel`, `planar`,
  `band` (1-based), and `scale` and `offset`: value = raw * scale + offset.
  `grid.nodata` is compared with the raw value; the palette range is in
  scaled values.
- **tile**: `col` and `row` in the level, `byte_offset` and `byte_length`
  in the COG, `size` (tile width and height with padding), `window` (valid
  pixels of an edge tile; absent means the whole tile), `footprint` (bounding
  box of the projected mesh, view CRS units, for culling) and `mesh` (the
  tile's rows in the vertex and index tables; indices count from
  `first_vertex`). UVs are in tile space: (0, 0) is the top-left corner of the
  tile and (1, 1) the bottom-right corner of the full padded tile, so an edge
  tile's mesh stops at u = window width / tile width. Sparse tiles with no
  bytes are left out.
- **selection rules** for `all_levels`, with the screen pixel size being one
  device pixel in view CRS units: `nearest_pixel_size` picks the level whose
  `pixel_size` is closest (ties to the finer level); `coarsest_sufficient`
  picks the coarsest level whose `pixel_size` is no larger, or the finest
  level when none is (the spike planner's rule). The renderer then draws that
  level's tiles whose `footprint` meets the viewport.

**Re-planning is a transport concern.** A `view` plan is valid for the view
it was made for. When the view changes, a live session (R over httpuv or a
websocket) sends a new scene or a new plan for the layer, one round trip per
settled view change. How the renderer asks and how the reply is delivered is
the transport's business, not the schema's; the schema only describes a plan.
A self-contained page with no live session ships an `all_levels` plan
instead.

The conformance scene `polar-cog-tiles.json` is the spike's EPSG:3031 COG
(2560 x 2560, 5 km, 256 x 256 DEFLATE tiles, five levels) planned by
`tiled-cog-polar/planner.py` with real byte ranges, trimmed to 22 tiles:
levels 4, 3 and 2 in full and the four tiles at the pole in levels 1 and 0.
`fixtures/valid/tiled-lonlat-view-plan.json` is a `view` plan for the lon/lat
COG (level 3, two edge tiles with curved meshes). Neither ships its Arrow
mesh tables; the counts in each tile are the planner's.

## 0.3: colour images and JPEG tiles

0.3 is 0.2 plus a second way to color a `tiled_raster` layer and one codec.
Every 0.2 construct is unchanged; a 0.2 scene becomes a 0.3 scene by
changing `version`. It serves allboa/aobcore#13: an RGB(A) COG, such as a
rendered chart or aerial imagery, is drawn as a colour image instead of one
band through a palette.

```json
{ "id": "chart", "kind": "tiled_raster", "source": "chart_cog",
  "rgb": { "bands": [1, 2, 3], "alpha": 4 },
  "plan": { "levels": [ { "encoding": { "codec": "deflate", "dtype": "uint8",
                                       "samples_per_pixel": 4 }, ... } ], ... } }
```

- **rgb**: a `tiled_raster` layer gives exactly one of `palette` (one band,
  as in 0.2) and `rgb`. Giving both, or neither, is an error. `bands` names
  the 1-based bands for red, green and blue (a band may repeat, so
  `[1, 1, 1]` draws one band as grey); `alpha` optionally names the band for
  opacity and must not be one of `bands`. The validator checks that every
  level holds the named bands (each is at most `samples_per_pixel`), that
  the level's samples are `interleaved`, and that `encoding.band` is absent
  (it chooses the palette band and has no meaning here).
- **transparency**: a pixel is transparent when its alpha sample is 0, or
  when all three colour bands equal `grid.nodata` (compared raw, before
  scaling). Other alpha values are straight (not premultiplied) opacity.
- **sample types**: `uint8` is the v1 case: 0 is zero intensity and 255 is
  full intensity, with no scaling. Any other `dtype` needs `rgb.range`:
  scaled values (raw * scale + offset) from `range[0]` to `range[1]` map
  linearly to zero and full intensity, clamped, for colour and alpha bands
  alike. With `uint8`, `range` is optional and stretches the image.
- **jpeg codec**: baseline JPEG tiles (TIFF compression 7) with `dtype`
  `uint8`, `planar` `interleaved`, no predictor, and `samples_per_pixel` 1
  (greyscale) or 3 (YCbCr, TIFF photometric 6, the GDAL default for RGB
  JPEG COGs; the JPEG decoder converts to red, green and blue, so `bands`
  are `[1, 2, 3]` in that order). All of these are checked. A JPEG COG
  keeps shared JPEG tables (quantization, Huffman or both) once per image
  in the TIFF JPEGTables tag, not in each tile, so the producer copies those bytes into
  the level's `encoding.jpeg_tables`, base64 encoded. A renderer makes a
  standalone JPEG for a tile by joining the tables without their final EOI
  marker (the last 2 bytes) to the tile bytes without their leading SOI
  marker (the first 2 bytes). Without `jpeg_tables`, each tile must be a
  complete JPEG stream. JPEG is lossy, so `grid.nodata` should not be relied
  on; JPEG COGs usually mark no data with a separate mask image, which 0.3
  does not carry (see open questions).
- **plain raster layers** are unchanged: a `raster` layer takes a
  `palette` only. Its values table has one value column, so bands have
  nothing to point at; a colour form for it waits for a producer that needs
  one.

The conformance scene `polar-rgb-jpeg-tiles.json` is a synthetic colour
wheel around the pole (hue by angle, white rings every 1000 km) written by
GDAL 3.10.3's COG driver as a 1024 x 1024, 12.5 km, EPSG:3031 COG with
3-band YCbCr JPEG (quality 85) in 256 x 256 tiles and two overviews. Its 21
tiles (levels 2, 1 and 0 in full) carry the real byte ranges and the real
142-byte JPEGTables of each level (quantization tables only; GDAL writes
optimized Huffman tables into each tile). Decoding each level 0 tile as described
above matched GDAL's own read to a mean absolute difference below 1 (of 255)
per sample; the larger differences sit at the sharp ring edges, where
decoders upsample chroma differently. The COG itself is not in this repo
(CI keeps every file ASCII); its Arrow mesh tables are not shipped either.

## Validate

```sh
npm ci
npm test                              # denylist check + every fixture
node scripts/validate.js my-scene.json   # validate your own scenes
```

`npm test` expects everything in `conformance/` and `fixtures/valid/` to pass
and everything in `fixtures/invalid/` to fail. CI runs it on every push and
pull request, and also checks that every file is ASCII.

Validation has two stages: the JSON Schema for the scene's `version`
(`schema/scene-<version>.schema.json`; an unknown version fails), then
cross-reference checks the schema cannot express (data ids resolve, layer ids
are unique, geometry encoding matches layer kind, extents are ordered,
`origin_subtracted` has a `view.local_origin`, `geometry.crs` equals
`view.crs`, raster value and mesh tables are plain Arrow tables). For 0.2
tiled rasters it also checks that `source` is a `cog`, `plan.crs` equals
`view.crs`, level numbers and tile positions are unique, `band` is within
`samples_per_pixel`, tile mesh row runs do not overlap, windows fit their
tile, and each tile's valid pixels lie on its level's grid (so an edge tile needs a `window`).
For 0.3 it also checks that `rgb` bands and `alpha` exist in every level
and are interleaved, that `rgb` layers give no `encoding.band`, that
non-`uint8` samples come with `rgb.range`, and that `jpeg` levels are
`uint8`, interleaved, unpredicted and have 1 or 3 samples (`jpeg_tables`
is only for `jpeg`).

## Open questions

What 0.1 settles and what it defers, against the open questions in the design
post.

- **Styling as data only, or browser-evaluated expressions?** Settled for
  0.1: data only. A color is a constant RGBA or a named RGBA column computed
  by the producer (in R); rasters use a named palette with a range. There are
  no accessor functions or expressions evaluated in the browser. Deferred: an
  expression form, and a registry of palette names. 0.1 leaves
  `palette.name` as an open string; a renderer that does not know a palette
  name reports an error for that layer rather than silently substituting
  another palette.
- **Minimum grid descriptor?** Settled for 0.1: `crs`, `extent` and `dim`
  are required; `nodata` is optional (a number or `"NaN"`) because producers
  such as GDAL commonly carry a sentinel value and Arrow nulls do not cover
  that. Overviews, tiling and COG sources by URL waited for gate A; 0.2
  adds them as the `cog` data reference and the `tiled_raster` layer.
- **View type names.** 0.1 uses `projected`, `cartesian` and `globe`. The
  probe (0.0.1) said `orthographic` for what 0.1 calls `projected`; its
  conversion uses `projected`. 0.1 avoids `orthographic` because it names
  both a map projection and a renderer view class.
- **Vector CRS.** Vector coordinates must be in the view CRS in 0.1; the
  optional `geometry.crs` records this and leaves room for renderer-side
  reprojection.
- **Colour images (0.3).** Open: a mask image for JPEG COGs (TIFF
  internal masks are separate tiles with their own byte ranges, so a tile
  would need a second range); `rgb` for plain `raster` layers; `planar`
  `separate` RGB (three byte ranges per tile); and per-band ranges for
  non-`uint8` imagery. 0.3 gives one `range` for all bands.
- **Not in 0.1:** legends, popups and picking, per-layer opacity, and
  extension points for renderer-specific hints. The schema is closed
  (`additionalProperties: false`) so renderer props cannot leak in.

Probe changes from 0.0.1 to 0.1: `crs` moved into `view`; `extent_m` (a
width) became `extent`; data moved to a top-level `data` map with declared
GeoArrow encodings; `type` became `kind`; `raster-mesh` became `raster` with
a `mesh`; `fill`/`color`/`width_px` became `fill`/`stroke`/`stroke_width_px`.
The unconverted 0.0.1 scene is kept in `fixtures/invalid/` as a scene that
must fail.
