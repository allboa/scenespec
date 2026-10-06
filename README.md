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
| `schema/scene-0.4.schema.json` | JSON Schema for scene spec 0.4: 0.3 plus `view.bounds`, a region the camera is kept within |
| `schema/scene-0.5.schema.json` | JSON Schema for scene spec 0.5: 0.4 plus scene-level `legends` and per-layer `popup` |
| `schema/scene-0.6.schema.json` | JSON Schema for scene spec 0.6: 0.5 plus chunk references (data `format: "chunks"`) |
| `conformance/` | Conformance scenes. `polar-probe.json` is the polar view probe (design origin record, 2026-09-30) converted to 0.1. `polar-cog-tiles.json` (0.2) is a tiled COG plan from allboa/spikes `tiled-cog-polar/`. `polar-rgb-jpeg-tiles.json` (0.3) is a 3-band YCbCr JPEG COG drawn as a colour image. `polar-probe-bounds.json` (0.4) is the probe with `view.bounds`. `polar-probe-legends-popups.json` (0.5) adds legends and a land popup. `polar-cog-chunks.json` (0.6) is the tiled COG as chunk references, and `zarr-v2-chunks.json` (0.6) a small Zarr v2 array (the store is `tiny.zarr/`) as chunk references |
| `fixtures/valid/` | Minimal scenes that must validate |
| `fixtures/invalid/` | Scenes that must fail, one reason each |
| `fixtures/data/` | Explicit-data fixtures: one Arrow IPC stream per GeoArrow geometry kind (drawn by `fixtures/valid/explicit-data-0.6.json`), and in `invalid/` streams and scenes whose data breaks the contract for one reason each |
| `scripts/validate.js` | Schema validation (ajv, schema chosen by the scene's `version`) plus cross-reference checks |
| `scripts/check-terms.js` | Fails if any renderer term from a denylist appears in the schema, or (0.6) a file format name in the chunk-reference definitions |
| `scripts/check-refs.js` | Decodes the chunk refs of conformance scenes whose bytes are in the repo (0.6) |
| `scripts/check-data.js` | Reads the vector data whose bytes are in the repo (apache-arrow) and checks it against the explicit-data contract |
| `scripts/make-data.R` | Writes the Arrow fixtures in `fixtures/data/` (nanoarrow, geoarrow, wk) |

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
  encoding; WKB and WKT are not allowed (what the Arrow bytes hold is under
  "Explicit data" below). In 0.1 vector coordinates are in
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

## Explicit data: Arrow with GeoArrow geometry

This section holds for every version, 0.1 to 0.6. The scene JSON names a
vector table (`format`, `blob` or `url`, `geometry.column`,
`geometry.encoding` and an optional `geometry.crs`); this is what the Arrow
bytes behind it must hold, so that any producer (DuckDB, a Python writer,
rangefinder) can write a scene that any reader draws, without sharing code
(allboa/scenespec#11, from allboa/design decision 0011). Nothing in the
scene JSON changes, so there is no new version: the encoding is already
declared in the scene, and the coordinate layout and the CRS travel in the
Arrow schema, where a reader finds them.

- **One table per data reference**: an Arrow IPC stream
  (`arrow-ipc-stream`) or file (`arrow-ipc-file`), as declared, with zero or
  more record batches of one schema (an empty table may have none).
- **Geometry**: the column named by `geometry.column` has a native GeoArrow
  extension type: its field metadata `ARROW:extension:name` is one of
  `geoarrow.point`, `geoarrow.linestring`, `geoarrow.polygon`,
  `geoarrow.multipoint`, `geoarrow.multilinestring` and
  `geoarrow.multipolygon`, and equals `geometry.encoding`. Serialised
  geometry (`geoarrow.wkb`, `geoarrow.wkt`, `ogc.wkb` and their large and
  view forms) is never used: the producer converts it before the data
  leave. Only the named column is the layer's geometry; other columns are
  not drawn.
- **Storage**, as GeoArrow lays it out: a point is a coordinate; a
  linestring or a multipoint is a List of coordinates; a polygon (a List of
  rings) or a multilinestring is a List of Lists; a multipolygon is three
  Lists deep. Lists have 32-bit offsets (List, not LargeList). Coordinates
  are doubles, either **interleaved**, a FixedSizeList whose child field is
  named `xy` (2 values) or `xyz` (3), or **separated**, a Struct of fields
  `x`, `y` and optionally `z`. Either layout may be used in any table, and
  a reader accepts both. Rings are closed, and the first ring of a polygon
  is its outer ring and the rest are holes. A flat view draws x and y; z is
  carried and may be ignored.
- **CRS**: `ARROW:extension:metadata` is a JSON object whose `crs` is a
  PROJJSON object (what geoarrow writes) or an `authority:code` string.
  `crs_type`, if given, is `projjson` or `authority_code` (WKT and SRID
  forms are not used: a reader without PROJ could not match them), and
  `edges`, if given, is `planar`. `crs_type` fits the form of `crs`:
  `projjson` with an object, `authority_code` with a string. Coordinates are in the view CRS: the
  producer transforms them before writing and writes the view's CRS. Two
  CRSs match when they are equal as JSON values (ignoring key order and
  PROJJSON's `$schema`), or when one authority code names both (the string
  itself, or a PROJJSON object's top-level `id` or `ids`; authority codes
  compare case-insensitively), so a `view.crs` of `"EPSG:3031"` matches the
  PROJJSON for EPSG:3031. `crs` is required when the view has a CRS, and
  may be left out for a `cartesian` view without one. The scene's optional
  `geometry.crs`, when given, matches the Arrow `crs` by the same rule. A reader does not reproject; one that compares and finds a
  mismatch reports an error for the layer and does not draw it.
- **Columns a layer names**: a popup column is an attribute, and a colour
  column, named by a layer's `fill` or `stroke`, is
  `FixedSizeList<uint8, 4>`. Attribute types are those a popup shows as
  text: boolean, signed and
  unsigned integers (8 to 64 bits), float32, float64, string (Utf8 and
  LargeUtf8), date (Date32 and Date64) and timestamp (any unit, with or
  without a time zone); nulls are missing values. A dictionary column is not
  an attribute: a factor or category a popup shows is written as strings,
  and a legend that lists categories in order is written from them as data
  (0.5). Legends read no columns. Columns no layer names may have any Arrow
  type (a duration, a time of day, binary, a list) and readers ignore them,
  so a producer need not drop them.
- **Out of scope**: geometry collections (`geoarrow.geometrycollection`),
  mixed kinds in one column (`geoarrow.geometry`), M coordinates (`xym` and
  `xyzm`), boxes (`geoarrow.box`), curves and non-planar edges. A producer
  splits mixed kinds into one table per kind, explodes collections and
  drops M.
- **Unknown extension types**: when the geometry column's extension name is
  not one of the six above (WKB, an out of scope type, or one the reader
  does not know), the reader reports an error for each layer that draws the
  table and draws nothing from it; it does not guess from the storage.
  Other layers draw as usual. Any other column with an extension type the
  reader does not know is read as its storage type, as Arrow readers do.

aobcore's producers (`vector_stream()`, `vector_ipc()` and
`gdal_vector_stream()`) write interleaved xy coordinates and a PROJJSON CRS
(geoarrow resolves `"EPSG:3031"` to PROJJSON from wk's bundled table).
Separated coordinates, an `authority:code` CRS and z are allowed for other
producers.

`fixtures/data/` holds one Arrow IPC stream per geometry kind, each with
two or three features in EPSG:3031 and a few attribute columns: `point`,
`linestring` and `polygon` are interleaved (aobcore's form; `point` also
has a date and a colour column), and `multipoint`, `multilinestring` and
`multipolygon` are separated (`multipoint` gives its CRS as
`{"crs": "EPSG:3031", "crs_type": "authority_code"}`; between them they
have int64, boolean and timestamp attributes).
`fixtures/valid/explicit-data-0.6.json` draws all six, with popups (the
polygon reference also gives `geometry.crs`). `fixtures/data/invalid/`
holds valid scenes whose data break the contract for one reason each: WKB
geometry, no CRS, a CRS that is not the view's, a `crs_type` that does not
fit the `crs`, a geometry collection, M coordinates, storage that does not
match the extension, a binary column named in a popup, an encoding the
scene does not declare, a missing popup column and a colour column that is
not RGBA. `scripts/make-data.R` writes the streams with the calls aobcore
makes (nanoarrow, geoarrow and wk); `scripts/check-data.js` reads them with
apache-arrow (the version aobcore's renderer bundles) and checks the rules
above on extension names, metadata, storage types, CRS and named columns
(not coordinate values, such as closed rings). The streams are binary, so
CI's ASCII check drops exactly `fixtures/data/*.arrows` and
`fixtures/data/invalid/*.arrows` from its results; the scenes beside them
are still checked.

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
  full intensity, with no scaling. `uint8` without `range` is the same as
  `range: [0, 255]` in raw values: `scale` and `offset` are ignored. Any other `dtype` needs `rgb.range`:
  scaled values (raw * scale + offset) from `range[0]` to `range[1]` map
  linearly to zero and full intensity, clamped, for colour and alpha bands
  alike. With `uint8`, `range` is optional and stretches the image.
- **jpeg codec**: baseline JPEG tiles (TIFF compression 7) with `dtype`
  `uint8`, `planar` `interleaved`, no predictor, and `samples_per_pixel` 1
  (greyscale) or 3 (YCbCr, TIFF photometric 6, the GDAL default for RGB
  JPEG COGs). All of these are checked. Photometric is implied by the
  sample count, 3 meaning YCbCr and 1 meaning greyscale (MinIsBlack), so
  producers must not emit `jpeg` levels with any other photometric. Band
  numbers refer to the decoded image: after decoding, band 1 is red, 2
  green and 3 blue, so `bands` is usually `[1, 2, 3]`. The band order is
  not checked; another order validates and swaps channels. A JPEG COG
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

## 0.4: view bounds

0.4 is 0.3 plus one optional view field, `bounds`: an extent in view CRS
units that the camera is kept within: the camera never shows more than
`bounds` plus a margin, so panning stops at their edge and zooming out stops
when they, with the margin, fit the canvas. The margin is the renderer's
choice (it lets the edge be seen; aobcore's renderer uses a quarter of the
bounds' size on each side). `extent` is still the initial view. Every 0.3
construct is unchanged, so a 0.3 scene becomes a 0.4 scene by changing `version`.
Without `bounds` the camera is not limited, as before.

```json
"view": { "type": "projected", "crs": "EPSG:3031",
          "extent": [-3e6, 3e6, -3e6, 3e6],
          "bounds": [-1.28e7, 1.28e7, -1.28e7, 1.28e7] }
```

`bounds` limits the camera only. It is not a clip: data outside it is drawn
wherever the camera shows it, and tile plans keep their own coverage. It
follows allboa/design decision 0005, where a producer derives a default
domain from the view CRS's centre (the whole disc for Lambert azimuthal
equal area; about the equator for south polar stereographic). A globe view
has no bounds; the validator rejects them there (a scene spec choice, not
part of decision 0005). The validator also rejects an initial `center`
outside `bounds`, or an `extent` that does not overlap them, since the
camera could never show that view. `conformance/polar-probe-bounds.json` is
the polar probe as a 0.4 scene with bounds from decision 0005 (`k = 2`)
as aobcore's `crs_domain()` computes them, measuring stretch against the
centre's own scale (EPSG:3031 is 0.97 there), so 12.58e6 m rather than the
decision table's 12.8e6 m, which measured against a sphere.

## 0.5: legends and popups

0.5 is 0.4 plus a scene-level `legends` array and an optional `popup` on
vector layers. Every 0.4 construct is unchanged, so a 0.4 scene becomes a
0.5 scene by changing `version` (with one tightening, below). It serves
allboa/aobview#6 (legends) and #7 (popups).

```json
"layers": [
  { "id": "sst", "kind": "raster", "palette": { "name": "ocean", "range": [-2, 13] }, ... },
  { "id": "zones", "kind": "polygon", "data": "zones", "fill": { "column": "fill" },
    "popup": { "columns": ["zone", "area_km2"], "trigger": "select" } },
  { "id": "stations", "kind": "point", "data": "stations", "fill": { "column": "fill" },
    "popup": { "columns": ["name", "depth_m"], "trigger": "point" } }
],
"legends": [
  { "layer": "sst", "title": "SST (degrees C)",
    "ramp": { "palette": "ocean", "range": [-2, 13] },
    "na": { "label": "no data", "color": [0, 0, 0, 0] } },
  { "layer": "zones", "title": "Zone",
    "classes": [ { "label": "Protected", "color": [27, 158, 119, 160] },
                 { "label": "Open", "color": [117, 112, 179, 160] } ] },
  { "layer": "stations", "title": "Depth (m)",
    "ramp": { "range": [0, 4000],
              "stops": [ { "at": 0, "color": [255, 255, 204, 255] },
                         { "at": 1, "color": [8, 29, 88, 255] } ] } }
]
```

**Legends are data.** A legend is a key the producer writes from the same
colours it used for the layer, so the key and the drawing cannot disagree.
The renderer draws it; it does not work a legend out from the layer.

- **legend**: `layer` (required) is the id of the layer it keys; the
  validator checks it exists. `title` is optional (a renderer may fall back
  to the layer's `label`). Exactly one of `ramp` and `classes`, plus an
  optional `na` entry for missing values, shown apart. Legends are shown in
  array order, while their layer is shown; placement and styling of the key
  are the renderer's choice and are not in the spec. A layer may have more
  than one legend.
- **ramp**: a continuous key from `range[0]` to `range[1]` as written (the
  ends must differ; checked). A reversed range, `range[0]` greater than
  `range[1]`, is a reversed key, as for a reversed layer palette. Colours are given as exactly one of
  `stops` (at least two `{ "at", "color" }`, `at` a position from 0 at
  `range[0]` to 1 at `range[1]`, strictly increasing, first 0 and last 1,
  all checked; colours are interpolated linearly in RGBA between stops) or
  `palette`, a palette name as in a layer `palette`. A palette ramp is only
  for a layer that has a `palette`, and must name the same palette and the
  same range (both checked); vector layers and `rgb` rasters are keyed with
  `stops` or `classes`. Stops are positions, not values, so a ramp can key
  a colour column computed by any function the producer used; the ends are
  labelled with the range.
- **classes**: discrete entries, each a `label` and a constant RGBA
  `color`, shown in order.
- **popup** (polygon, path and point layers only): `columns` names the
  attribute columns of the layer's data (at least one, no repeats) whose
  values are shown, in order, as text labelled by column name, for one
  feature (one row) at a time. `trigger` is `select` (the default: shown
  when the viewer selects a feature, for example by a click, tap or key
  press, and kept until another selection or a dismissal) or `point` (shown
  while the viewer points at a feature without selecting it; with no way to
  point without selecting, as on touch screens, a renderer treats it as
  `select`). A popup only shows attributes; nothing is sent back to the
  producer (selections returning to R are a live transport concern, out of
  scope here). Raster popups (showing a cell value) are not in 0.5.
- **popup columns and Arrow data**: the schema cannot see the Arrow
  tables, and the validator reads only the scene JSON (blobs are transport
  keys), so it checks only that `columns` does not name the layer's
  geometry column. `scripts/check-data.js` checks the popup columns of data
  whose bytes are in the repo (see "Explicit data"). Producers must write
  every named column into the layer's data; a renderer that finds one
  missing reports an error for that layer's popup rather than showing a
  partial one.
- **one tightening**: in 0.5 a layer `palette.range` or `rgb.range` with
  equal ends is rejected (allboa/scenespec#6 point 4). Such a range divides
  by zero, so no drawable 0.4 scene is affected. 0.1 to 0.4 are unchanged.

`conformance/polar-probe-legends-popups.json` is the 0.4 bounds probe as a
0.5 scene with a palette ramp legend for the SST field, a one-class legend
for land, and a `select` popup on land showing Natural Earth's `featurecla`
and `scalerank`; a producer drawing it must carry those two columns in the
land table.

## 0.6: chunk references

0.6 is 0.5 plus one data reference format, `chunks`, which a `tiled_raster`
layer can draw. Every 0.5 construct is unchanged, so a 0.5 scene becomes a
0.6 scene by changing `version`. It serves allboa/scenespec#10, from
allboa/design decisions 0010 (item 2) and 0011: the chunk reference is the
currency shared by the R-planned and browser-resolved routes. A COG tile, a
Zarr chunk, a Kerchunk reference and an Icechunk virtual chunk are all one
thing: bytes at a URL, an offset and a length, decoded by a codec and placed
in a grid. A chunk reference carries bytes plus codec (Michael, 2026-10-06):
the byte range, plus the codec chain and the grid needed to decode the bytes
and place them, so a reader never reads the store's own metadata.

```json
"data": {
  "tiny": {
    "format": "chunks",
    "grid": { "crs": "EPSG:3031", "geotransform": [-1200000, 100000, 0, -1000000, 0, 100000],
              "dim": [24, 20], "chunk_size": [10, 10] },
    "dtype": "float32",
    "codecs": [ { "name": "bytes", "configuration": { "endian": "little" } },
                { "name": "deflate", "configuration": { "level": 6 } } ],
    "nodata": -9999,
    "refs": { "rows": [
      { "col": 0, "row": 0, "url": "tiny.zarr/0.0", "offset": 0, "length": 390 },
      { "col": 1, "row": 0, "url": "tiny.zarr/0.1", "offset": 0, "length": 353 },
      { "col": 2, "row": 0, "url": "tiny.zarr/0.2", "offset": 0, "length": 192 },
      { "col": 0, "row": 1, "url": "tiny.zarr/1.0", "offset": 0, "length": 411 },
      { "col": 1, "row": 1, "url": "tiny.zarr/1.1", "offset": 0, "length": 359 } ] }
  }
},
"layers": [
  { "id": "tiny", "kind": "tiled_raster", "source": "tiny",
    "palette": { "name": "ocean", "range": [-2, 1] },
    "plan": { "crs": "EPSG:3031", "coverage": "all_levels", "selection": { "rule": "coarsest_sufficient" },
              "mesh": { "vertices": "tiny_vertices", "indices": "tiny_indices" },
              "levels": [ { "level": 0, "pixel_size": 100000, "tiles": [
                { "col": 0, "row": 0, "footprint": [-1200000, -200000, -1000000, 0],
                  "mesh": { "first_vertex": 0, "vertex_count": 4, "first_index": 0, "index_count": 6 } }, ... ] } ] } }
]
```

**The decoding rule.** A reader decodes each ref by reading bytes
[offset, offset + length) of its URL and applying the codec chain in
reverse, the last codec first. That gives one full chunk: chunk width x
height x bands samples of `dtype`, laid out as `interleave` says, and a
value is raw * `scale` + `offset`. Nothing else about the store is needed.

- **chunks data reference**: `grid`, `dtype`, `codecs` and `refs` are
  required; `url` (the default URL for refs that give none), `bands`
  (default 1), `interleave`, `nodata`, `scale` and `offset` are optional.
  The schema is reader-neutral: its chunk-reference definitions name
  codecs, never a file or store format, and `scripts/check-terms.js`
  checks that.
- **grid**: `crs`, `geotransform`, `dim` (`[ncol, nrow]`) and `chunk_size`
  (`[width, height]` in cells) describe level 0, the full-resolution grid.
  `geotransform` is `[x0, dx, rx, y0, ry, dy]`: the corner of cell column
  c and row r is at x = x0 + c * dx + r * rx, y = y0 + c * ry + r * dy, so
  (x0, y0) is the outer corner of the first cell. `dy` is negative when row
  0 is at the top (north up, as in a COG) and positive when row 0 is at the
  bottom (as in many arrays written from netCDF, and in `tiny.zarr`); `dx`
  is positive, and the rotation terms `rx` and `ry` must be 0 in 0.6.
  `levels` lists coarser levels, each with its own `dim` and either its own
  `geotransform` or a `scale` `[sx, sy]` from level 0 (geotransform
  `[x0, dx * sx, 0, y0, 0, dy * sy]`), and optionally its own `chunk_size`.
  Chunk (col, row) of a level covers cell columns col * width to
  (col + 1) * width - 1 and cell rows row * height to (row + 1) * height - 1,
  counted from the origin corner.
  Chunks are stored at full size: an edge chunk is padded, and only its
  cells inside the level are drawn.
- **codecs**: a codec chain in the Zarr v3 shape, a list of
  `{ "name", "configuration" }` in the order the codecs were applied when
  writing. Exactly one array to bytes codec comes first: `bytes`
  (configuration `endian`, `little` by default) or `jpeg` (configuration
  `tables`, base64 JPEG tables as in 0.3's `jpeg_tables`; `jpeg` is the whole
  chain, with `dtype` `uint8`, `interleave` `pixel` and 1 or 3 bands). Bytes
  to bytes codecs follow: `predictor` (configuration `type`, `horizontal` or
  `floating_point`, directly after `bytes`; defined below), `deflate` (a
  zlib stream: RFC 1950 header, deflate data, Adler-32 check), `gzip` (RFC
  1952), `zstd` (a Zstandard frame), `lzw` (defined below) and `blosc` (a
  Blosc (v1) compressed buffer, whose header says how it was written; its
  configuration `cname`, `clevel`, `shuffle`, `typesize`, `blocksize` is
  for the record). Unknown codecs and unknown configuration keys are
  rejected. 0.2's tile `encoding` maps across directly: codec `deflate`
  with predictor `horizontal` is `[bytes, predictor horizontal, deflate]`.
  A Zarr v2 `zlib` compressor is `deflate`.
- **predictors**: both work within each chunk row, taken over one band for
  `plane` or `separate` and over all bands for `pixel`, and both use a
  stride n, which is `bands` for `pixel` interleave and 1 otherwise (this
  is TIFF's per-sample differencing with a stride of samples per pixel).
  `horizontal`: every sample from the (n+1)-th on is stored as the
  difference from the sample n positions before it, in the sample type,
  wrapping. `floating_point`: the bytes of the row's samples are split
  into planes, most significant byte first, and every byte from the
  (n+1)-th on is stored as the difference from the byte n positions before
  it; undoing it gives the samples in the `bytes` codec's endian.
- **lzw**: TIFF LZW: 8-bit symbols, codes of 9 to 12 bits packed most
  significant bit first, Clear code 256 and EndOfInformation code 257, and
  the code width growing one code early (early change).
- **dtype, bands and interleave**: `dtype` is one of 0.2's sample types.
  With more than one band, `interleave` is `pixel` (a chunk holds every
  band, the samples of one cell together), `plane` (a chunk holds every
  band, one band's full chunk after another) or `separate` (a chunk holds
  one band, and each ref names it in `band`). Within a band, cells run row
  by row from the origin corner.
- **refs**: exactly one of `rows`, inline JSON with one object per stored
  chunk, or `table`, the data id of an Arrow table carried like any other
  data (a `blob` or a `url`), so a large store does not bloat the scene. A
  ref is `level` (default 0), `col`, `row`, `band` (only and always with
  `separate`), `url` (default the reference's `url`; one of the two is
  required), `offset` (0 or more) and `length` (1 or more). The table has
  the same columns (`level`, `band` and `url` may be absent or null for
  their defaults; `offset` and `length` are 64-bit integers). The validator
  checks that a table id names a plain Arrow table but does not read it.
- **sparse chunks**: a chunk with no ref is not stored. Every cell in it is
  no data, as if filled with `nodata`, and it is not drawn. Leaving a ref
  out is the only way to say so: a ref with length 0 is rejected.
- **tiled_raster over chunks**: `source` may name a `chunks` reference.
  The plan is the same (`crs`, `coverage`, `mesh`, `selection` or
  `planned_for`), but each level gives only `level`, `pixel_size` and
  `tiles`, and each tile only `col`, `row`, `footprint` and `mesh`: the
  grid, codec chain, byte ranges, chunk size and edge windows come from the
  source. Mesh uv is in chunk space, (0, 0) at the outer corner of the
  chunk's first cell and (1, 1) at the opposite corner of the full padded
  chunk, so on a north-up grid it is the same as a COG tile's. A palette
  layer over chunks names its band in the layer's `band` (default 1); an
  `rgb` layer needs every band in one chunk (`pixel` or `plane`). A `cog`
  source plans exactly as in 0.2 to 0.5, and its plan levels must keep
  their own grid and encoding.

The conformance scene `polar-cog-chunks.json` is `polar-cog-tiles.json`
re-expressed as chunks: the same grid (levels 1 to 4 by `scale`), the
codec chain `[bytes little, deflate]`, inline refs for every one of the
139 tiles in the five levels, and the same plan of 22 tiles with their
footprints and mesh counts. The spike's COG is not committed anywhere, so
its byte ranges were read from a copy regenerated with the spike's
`make_cogs.py` recipe (written in R with gdalraster on GDAL 3.13.3), by
reading the TileOffsets and TileByteCounts of every image in the file.
Decoding two refs (level 0 col 4 row 4, and level 4) by the rule above
gave exactly GDAL's read of the same pixels. The 22 tiles also in
`polar-cog-tiles.json` have identical lengths there, at offsets exactly 120
bytes later, because the newer GDAL writes a longer header; the refs are
the regenerated file's, so the scene names it `polar_3031_gdal3.13.tif`
(19116675 bytes, sha256
`6effb60995674bfc4f9a0b3ffd41697bdd547545674086d79fb3645032ad1349`) rather
than the spike's `polar_3031.tif`. That COG is not in this repo either.

The conformance scene `zarr-v2-chunks.json` is a Zarr v2 array as chunks,
with its store in `conformance/tiny.zarr/`: 24 x 20 float32 cells of 100 km
in EPSG:3031, 10 x 10 chunks, compressor `zlib` (codec `deflate`),
`fill_value` -9999 (`nodata`), and row 0 at the bottom, so `dy` is
positive. Chunk `1.2` is all fill and is not written, so it has no ref and
no plan tile. Each ref is a whole chunk file: offset 0 and the file's
length. The store was written by hand (a `.zarray` and zlib-compressed
chunk files, no Zarr library), and GDAL's Zarr driver reads it.
`npm test` decodes every ref whose bytes are in the repo
(`scripts/check-refs.js`). The chunk files are compressed bytes, so CI's ASCII
check drops exactly the paths
`conformance/tiny.zarr/<row>.<col>` from its results; every other file,
the store's `.zarray` and `.zattrs` included, is still checked.

## Validate


```sh
npm ci
npm test                              # denylist check + every fixture + local chunk refs + local vector data
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
is only for `jpeg`). For 0.5 it also checks that each legend names an
existing layer, that ramp ranges have differing ends, that stops start at 0,
end at 1 and increase, that a palette ramp keys a layer with a palette
and matches it,
that popups do not name the geometry column, and that palette and rgb
ranges do not have equal ends. It does not read Arrow data, so it cannot
check that popup columns exist; `scripts/check-data.js` does, for data in
the repo. For 0.6 it also checks that a codec chain
starts with its array to bytes codec, that `predictor` comes directly
after `bytes` (and `floating_point` only for float samples), that `jpeg`
chains are alone, `uint8`, `pixel` and 1 or 3 bands, that grid level
numbers are unique, that each coarser level fits level 0 (dx and dy with
level 0's signs, and each edge of its extent within one of its own cells
of level 0's), that each inline ref is on its level's chunk grid, is
unique, has a URL and gives `band` exactly when bands are `separate`, that
a refs `table` is a plain Arrow table, that a plan over chunks has no
level grids or encodings, names source levels and chunks on their grid and
has a ref for every chunk it draws, and that a layer's `band` and `rgb`
bands exist in the source. `scripts/check-refs.js` then decodes the inline
refs of conformance scenes whose bytes are local files (codecs `deflate`
and `gzip`) and checks each gives a full chunk; it counts apart the refs
it skips because their bytes are not in the repo and those it skips
because it does not undo their codec chain. `scripts/check-data.js` reads
each vector table whose bytes are in the repo, for conformance scenes and
`fixtures/valid/` (which must pass) and `fixtures/data/invalid/` (valid
scenes whose data must fail for exactly one reason), and checks it against
the explicit-data contract: the IPC format, the geometry extension name
and storage, the CRS against `view.crs` and `geometry.crs`, and the
columns its layers name (popup columns are attributes, colour columns
RGBA). It also fails if a file in
`fixtures/data/` is not read by any scene.

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
  reprojection. The Arrow geometry column carries the same CRS in its
  extension metadata ("Explicit data").
- **Explicit data.** Open: LargeList offsets and string views for very
  large tables; an `arrow-ipc-file` fixture (nanoarrow writes streams only);
  null geometries, which the contract does not yet say how to draw; and
  display formats for attribute values, which wait on popup formats (0.5).
- **Colour images (0.3).** Open: a mask image for JPEG COGs (TIFF
  internal masks are separate tiles with their own byte ranges, so a tile
  would need a second range); `rgb` for plain `raster` layers; `planar`
  `separate` RGB (three byte ranges per tile); and per-band ranges for
  non-`uint8` imagery. 0.3 gives one `range` for all bands.
- **Legends and popups (0.5).** Open: tick labels or breaks inside a ramp
  (0.5 labels only the ends), display names and number formats for popup
  columns (0.5 shows column names and plain text), raster cell popups, and
  whether `trigger` needs a third value for both.
- **Chunk references (0.6).** Open: a fill value that is data rather than
  no data (a store of counts whose missing chunks mean 0 cannot be said in
  0.6, where a missing chunk is always no data); refs that carry their
  bytes inline (base64) for tiny chunks; array to array codecs, such as a
  transpose for Fortran-order arrays; sharded stores (0.6 needs each inner
  chunk as its own ref); dimensions beyond two plus bands, which wait for
  a time axis (allboa/scenespec#9); rotated geotransforms; and the Arrow
  column types of a refs table, which the validator cannot see. Per
  decision 0011 the chunk-reference schema lives here until a second
  producer exists, then moves to its own cross-language repo.
- **Not in 0.1:** legends and popups (added in 0.5), per-layer opacity, and
  extension points for renderer-specific hints. The schema is closed
  (`additionalProperties: false`) so renderer props cannot leak in.

Probe changes from 0.0.1 to 0.1: `crs` moved into `view`; `extent_m` (a
width) became `extent`; data moved to a top-level `data` map with declared
GeoArrow encodings; `type` became `kind`; `raster-mesh` became `raster` with
a `mesh`; `fill`/`color`/`width_px` became `fill`/`stroke`/`stroke_width_px`.
The unconverted 0.0.1 scene is kept in `fixtures/invalid/` as a scene that
must fail.
