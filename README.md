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
| `conformance/` | Conformance scenes. `polar-probe.json` is the polar view probe (design origin record, 2026-09-30) converted to 0.1 |
| `fixtures/valid/` | Minimal scenes that must validate |
| `fixtures/invalid/` | Scenes that must fail, one reason each |
| `scripts/validate.js` | Schema validation (ajv) plus cross-reference checks |
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

- **view**: `type` is `projected` (flat map of a projected CRS; `crs`
  required), `orthographic` (flat Cartesian plane, `crs` optional) or `globe`
  (`crs` required). `crs` is `authority:code` or a PROJJSON object. `center`,
  `extent` (`[xmin, xmax, ymin, ymax]`) and `local_origin` are in view CRS
  units. `local_origin` is the float32 precision provision: renderers draw
  relative to it, and data marked `origin_subtracted` already have it
  subtracted.
- **data**: references keyed by id. Each is Arrow IPC (`arrow-ipc-stream` or
  `arrow-ipc-file`) held as exactly one of a transport `blob` key or a `url`.
  Vector tables declare their `geometry` column with a native GeoArrow
  encoding; WKB and WKT are not allowed.
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
  units and `uv` into the grid, plus an index table).

## Validate

```sh
npm ci
npm test                              # denylist check + every fixture
node scripts/validate.js my-scene.json   # validate your own scenes
```

`npm test` expects everything in `conformance/` and `fixtures/valid/` to pass
and everything in `fixtures/invalid/` to fail. CI runs it on every push and
pull request, and also checks that every file is ASCII.

Validation has two stages: the JSON Schema, then cross-reference checks the
schema cannot express (data ids resolve, layer ids are unique, geometry
encoding matches layer kind, extents are ordered).

## Open questions

What 0.1 settles and what it defers, against the open questions in the design
post.

- **Styling as data only, or browser-evaluated expressions?** Settled for
  0.1: data only. A color is a constant RGBA or a named RGBA column computed
  by the producer (in R); rasters use a named palette with a range. There are
  no accessor functions or expressions evaluated in the browser. Deferred: an
  expression form, and a registry of palette names (0.1 leaves `palette.name`
  as an open string that renderers resolve).
- **Minimum grid descriptor?** Settled for 0.1: `crs`, `extent` and `dim`
  are required; `nodata` is optional because producers such as GDAL commonly
  carry a sentinel value and Arrow nulls do not cover that. Deferred:
  overviews, tiling and COG sources by URL. These depend on gate A (the
  tiled-raster approach, plan issue 4), so 0.1 raster values arrive as an
  Arrow table only.
- **View type names.** 0.1 uses `projected`, `orthographic` and `globe`. The
  probe (0.0.1) said `orthographic` for what 0.1 calls `projected`; its
  conversion uses `projected`. The meaning of `orthographic` (a plain
  Cartesian plane) is provisional.
- **Vector CRS.** Vector coordinates must be in the view CRS in 0.1; the
  optional `geometry.crs` records this and leaves room for renderer-side
  reprojection.
- **Not in 0.1:** legends, popups and picking, per-layer opacity, and
  extension points for renderer-specific hints. The schema is closed
  (`additionalProperties: false`) so renderer props cannot leak in.

Probe changes from 0.0.1 to 0.1: `crs` moved into `view`; `extent_m` (a
width) became `extent`; data moved to a top-level `data` map with declared
GeoArrow encodings; `type` became `kind`; `raster-mesh` became `raster` with
a `mesh`; `fill`/`color`/`width_px` became `fill`/`stroke`/`stroke_width_px`.
The unconverted 0.0.1 scene is kept in `fixtures/invalid/` as a scene that
must fail.
