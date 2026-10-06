# Write the explicit-data fixtures: small Arrow IPC streams with native
# GeoArrow geometry (fixtures/data/*.arrows) and streams that break the
# contract for one reason each (fixtures/data/invalid/*.arrows). The scenes
# that reference them are written by hand; scripts/check-data.js checks both.
#
#   Rscript scripts/make-data.R        (from the repository root)
#
# Needs the R packages nanoarrow, geoarrow and wk, and nothing else. The calls
# are the ones allboa/aobcore's producers make: wk geometry is converted with
# geoarrow::infer_geoarrow_schema() and geoarrow::as_geoarrow_vctr() (aobcore
# as_native_vctr()), a data frame becomes a stream with
# nanoarrow::as_nanoarrow_array_stream() (aobcore native_stream()), a colour
# column is a FixedSizeList<uint8, 4> built as aobcore rgba_array() builds it,
# extension metadata is replaced as aobcore with_field_crs() replaces it, and
# bytes are written with nanoarrow::write_nanoarrow() (aobcore ipc_bytes()).
# aobcore writes interleaved coordinates only; the separated fixtures use
# geoarrow's coord_type = "SEPARATE".
#
# The CRS geoarrow writes for "EPSG:3031" is the PROJJSON object from wk's
# bundled table, so the output does not depend on the PROJ install. With
# nanoarrow 0.8.0.1, geoarrow 0.4.4 and wk 0.9.5 a rerun gives identical
# bytes; other versions may write different (equally valid) bytes.

stopifnot(file.exists("schema"), file.exists("fixtures"))
out <- file.path("fixtures", "data")
bad <- file.path(out, "invalid")
dir.create(bad, recursive = TRUE, showWarnings = FALSE)

VIEW_CRS <- "EPSG:3031"

# A native GeoArrow vector from WKT, as aobcore's as_native_vctr() makes one.
native <- function(wkt, coord_type = "INTERLEAVED", crs = VIEW_CRS) {
  g <- wk::wk_set_crs(wk::as_wkb(wk::wkt(wkt)), crs)
  schema <- geoarrow::infer_geoarrow_schema(g, coord_type = coord_type)
  geoarrow::as_geoarrow_vctr(g, schema = schema)
}

# FixedSizeList<uint8, 4>, one c(r, g, b, a) per row (aobcore rgba_array()).
rgba <- function(m) {
  child <- nanoarrow::nanoarrow_array_modify(
    nanoarrow::nanoarrow_array_init(nanoarrow::na_uint8()),
    list(length = length(m), null_count = 0L,
         buffers = list(NULL, nanoarrow::as_nanoarrow_buffer(as.raw(t(m)))))
  )
  nanoarrow::nanoarrow_array_modify(
    nanoarrow::nanoarrow_array_init(nanoarrow::na_fixed_size_list(nanoarrow::na_uint8(), 4L)),
    list(length = nrow(m), null_count = 0L, children = list(child))
  )
}

# One record batch from named columns: a data frame's columns converted as
# nanoarrow converts a data frame, plus any ready-made nanoarrow arrays.
batch <- function(...) {
  cols <- list(...)
  arrays <- lapply(cols, function(x) {
    if (inherits(x, "nanoarrow_array")) x else nanoarrow::as_nanoarrow_array(x)
  })
  schemas <- lapply(arrays, nanoarrow::infer_nanoarrow_schema)
  nanoarrow::nanoarrow_array_modify(
    nanoarrow::nanoarrow_array_init(nanoarrow::na_struct(schemas)),
    list(length = arrays[[1]]$length, null_count = 0L, children = arrays)
  )
}

# Replace a column's metadata, keeping its storage (aobcore with_field_crs()).
set_field_metadata <- function(array, column, metadata) {
  schema <- nanoarrow::infer_nanoarrow_schema(array)
  children <- schema$children
  children[[column]] <- nanoarrow::nanoarrow_schema_modify(children[[column]], list(metadata = metadata))
  schema <- nanoarrow::nanoarrow_schema_modify(schema, list(children = children))
  nanoarrow::nanoarrow_array_set_schema(array, schema, validate = FALSE)
}

write_ipc <- function(array, file) {
  con <- file(file, open = "wb")
  on.exit(close(con))
  nanoarrow::write_nanoarrow(array, con)
  cat(file, "\n")
}

int64 <- function(x) nanoarrow::as_nanoarrow_array(x, schema = nanoarrow::na_int64())

## ---- valid: one per geometry kind -------------------------------------------

# Interleaved: point, linestring, polygon (aobcore's own form).
write_ipc(batch(
  name = c("alpha", "bravo", "charlie"),
  depth_m = c(120.5, 450, 3200.25),
  surveyed = as.Date(c("2024-01-15", "2025-02-03", NA)),
  rgba = rgba(rbind(c(27, 158, 119, 255), c(217, 95, 2, 255), c(117, 112, 179, 255))),
  geometry = native(c("POINT (2300000 600000)", "POINT (1300000 1600000)", "POINT (-1500000 -500000)"))
), file.path(out, "point.arrows"))

write_ipc(batch(
  name = c("east", "west"),
  length_km = c(1414L, 2300L),
  geometry = native(c("LINESTRING (0 0, 1000000 1000000)",
                      "LINESTRING (-500000 0, -1500000 500000, -2500000 -500000)"))
), file.path(out, "linestring.arrows"))

write_ipc(batch(
  zone = c("square with a hole", "triangle"),
  area_km2 = c(3.75e6, 5e5),
  geometry = native(c(
    "POLYGON ((-1000000 -1000000, 1000000 -1000000, 1000000 1000000, -1000000 1000000, -1000000 -1000000), (-500000 -500000, -500000 500000, 500000 500000, 500000 -500000, -500000 -500000))",
    "POLYGON ((1500000 1500000, 2500000 1500000, 1500000 2500000, 1500000 1500000))"
  ))
), file.path(out, "polygon.arrows"))

# Separated: multipoint, multilinestring, multipolygon.
mp <- batch(
  name = c("pair", "trio"),
  count = int64(c(2, 3)),
  geometry = native(c("MULTIPOINT ((100000 -2000000), (300000 -2100000))",
                      "MULTIPOINT ((-2000000 1000000), (-2100000 1200000), (-1900000 1300000))"),
                    coord_type = "SEPARATE")
)
# The CRS as an authority code rather than PROJJSON, which GeoArrow also allows.
write_ipc(set_field_metadata(mp, "geometry", list(
  "ARROW:extension:name" = "geoarrow.multipoint",
  "ARROW:extension:metadata" = '{"crs":"EPSG:3031","crs_type":"authority_code"}'
)), file.path(out, "multipoint.arrows"))

write_ipc(batch(
  name = c("two parts", "one part"),
  seasonal = c(TRUE, FALSE),
  geometry = native(c("MULTILINESTRING ((0 -500000, 0 -2500000), (500000 -500000, 500000 -2500000))",
                      "MULTILINESTRING ((-2500000 2000000, -1000000 2500000))"),
                    coord_type = "SEPARATE")
), file.path(out, "multilinestring.arrows"))

write_ipc(batch(
  name = c("islands", "block"),
  protected = c(TRUE, NA),
  established = as.POSIXct(c("2001-07-01 00:00:00", "2019-12-31 12:30:00"), tz = "UTC"),
  geometry = native(c(
    "MULTIPOLYGON (((2000000 -2000000, 2400000 -2000000, 2400000 -1600000, 2000000 -2000000)), ((2600000 -1400000, 2900000 -1400000, 2900000 -1100000, 2600000 -1400000)))",
    "MULTIPOLYGON (((-2800000 -2800000, -2000000 -2800000, -2000000 -2000000, -2800000 -2000000, -2800000 -2800000)))"
  ), coord_type = "SEPARATE")
), file.path(out, "multipolygon.arrows"))

## ---- invalid: one reason each ------------------------------------------------

line_wkt <- c("LINESTRING (0 0, 1000000 1000000)", "LINESTRING (-500000 0, -1500000 500000)")

# WKB geometry (geoarrow.wkb), with the view CRS.
g <- wk::wk_set_crs(wk::as_wkb(wk::wkt(line_wkt)), VIEW_CRS)
write_ipc(batch(name = c("east", "west"),
                geometry = geoarrow::as_geoarrow_vctr(g, schema = geoarrow::na_extension_wkb(crs = VIEW_CRS))),
          file.path(bad, "wkb.arrows"))

# No CRS in the extension metadata.
write_ipc(batch(name = c("east", "west"), geometry = native(line_wkt, crs = NULL)),
          file.path(bad, "no-crs.arrows"))

# A CRS that is not the view CRS (lon/lat coordinates in OGC:CRS84).
write_ipc(batch(name = c("east", "west"),
                geometry = native(c("LINESTRING (0 -70, 45 -65)", "LINESTRING (-90 -70, -120 -75)"),
                                  crs = "OGC:CRS84")),
          file.path(bad, "crs-not-view.arrows"))

# A crs_type that does not fit the form of crs (a code string called projjson).
write_ipc(set_field_metadata(batch(name = c("east", "west"), geometry = native(line_wkt)), "geometry", list(
  "ARROW:extension:name" = "geoarrow.linestring",
  "ARROW:extension:metadata" = '{"crs":"EPSG:3031","crs_type":"projjson"}'
)), file.path(bad, "crs-type-mismatch.arrows"))

# A geometry collection: geoarrow.geometrycollection, a List of a dense union
# of the native types (type ids 1 point, 2 linestring), which 'geoarrow' in R
# does not write, so it is built from its parts here.
storage <- function(v, name) {
  nanoarrow::nanoarrow_schema_modify(nanoarrow::infer_nanoarrow_schema(v), list(name = name, metadata = list()))
}
pts <- native(c("POINT (0 0)", "POINT (-1000000 -1000000)"))
lns <- native(line_wkt)
u_schema <- nanoarrow::nanoarrow_schema_modify(
  nanoarrow::na_dense_union(list(Point = storage(pts, "Point"), LineString = storage(lns, "LineString"))),
  list(format = "+ud:1,2", name = "geometries")
)
u <- nanoarrow::nanoarrow_array_modify(nanoarrow::nanoarrow_array_init(u_schema), list(
  length = 4L, null_count = 0L,
  buffers = list(nanoarrow::as_nanoarrow_buffer(as.raw(c(1, 2, 1, 2))),
                 nanoarrow::as_nanoarrow_buffer(c(0L, 0L, 1L, 1L))),
  children = list(Point = nanoarrow::nanoarrow_array_set_schema(nanoarrow::as_nanoarrow_array(pts), storage(pts, "Point")),
                  LineString = nanoarrow::nanoarrow_array_set_schema(nanoarrow::as_nanoarrow_array(lns), storage(lns, "LineString")))
))
gc_schema <- nanoarrow::nanoarrow_schema_modify(nanoarrow::na_list(u_schema), list(metadata = list(
  "ARROW:extension:name" = "geoarrow.geometrycollection",
  "ARROW:extension:metadata" = geoarrow::na_extension_geoarrow("POINT", crs = VIEW_CRS)$metadata[["ARROW:extension:metadata"]]
)))
gc <- nanoarrow::nanoarrow_array_modify(nanoarrow::nanoarrow_array_init(gc_schema), list(
  length = 2L, null_count = 0L,
  buffers = list(NULL, nanoarrow::as_nanoarrow_buffer(c(0L, 2L, 4L))),
  children = list(geometries = u)
))
write_ipc(batch(name = c("first", "second"), geometry = gc), file.path(bad, "geometrycollection.arrows"))

# M coordinates (xym points).
g <- wk::wk_set_crs(wk::as_wkb(wk::wkt(c("POINT M (0 0 1)", "POINT M (1000000 1000000 2)"))), VIEW_CRS)
write_ipc(batch(name = c("a", "b"),
                geometry = geoarrow::as_geoarrow_vctr(g, schema = geoarrow::na_extension_geoarrow(
                  "POINT", dimensions = "XYM", coord_type = "INTERLEAVED", crs = VIEW_CRS))),
          file.path(bad, "xym.arrows"))

# Storage that does not match the extension: point storage named a linestring.
p <- batch(name = c("a", "b"), geometry = native(c("POINT (0 0)", "POINT (1000000 1000000)")))
meta <- nanoarrow::infer_nanoarrow_schema(p)$children$geometry$metadata
meta[["ARROW:extension:name"]] <- "geoarrow.linestring"
write_ipc(set_field_metadata(p, "geometry", meta), file.path(bad, "storage-mismatch.arrows"))

# A column of a type popups do not show (binary); its scene names it in a
# popup (an unnamed binary column is allowed and ignored).
write_ipc(batch(name = c("a", "b"),
                payload = nanoarrow::as_nanoarrow_array(list(as.raw(1:3), as.raw(4:6)), schema = nanoarrow::na_binary()),
                geometry = native(c("POINT (0 0)", "POINT (1000000 1000000)"))),
          file.path(bad, "attribute-binary.arrows"))
