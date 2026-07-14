# Building a FlatGeobuf Spatial Index for HTTP Range Reads

Building a FlatGeobuf spatial index converts a flat `.fgb` file into a cloud-native asset a client can query with HTTP range requests, reading only the byte ranges its bounding box intersects instead of downloading the whole file from cold object storage. The index is a packed Hilbert R-tree written between the file header and the feature payload, and it is the single structural feature that separates an archival `.fgb` from an inert blob. This guide is for data engineers and GIS archivists who write `.fgb` artifacts into warm and cold tiers and need every one of them to stay range-readable for years — it details the on-disk anatomy of the index, the exact `ogr2ogr`/GDAL invocations that produce a correctly packed R-tree, and the verification steps that prove the index header is present before the object is promoted. It sits inside the broader [Format Conversion & Pipeline Automation](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/) workflow and applies the tuning patterns from [FlatGeobuf Optimization Techniques](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/flatgeobuf-optimization-techniques/).

## Anatomy of an Indexed FlatGeobuf File

A FlatGeobuf file is four contiguous byte segments, and a range-reading client walks them in order without ever holding the full object in memory:

<svg viewBox="0 0 900 250" role="img" aria-label="Anatomy of an indexed FlatGeobuf file drawn left to right as four contiguous byte segments: an eight-byte magic marker, a header holding schema, CRS and bounding box, a packed Hilbert R-tree index of node ranges and feature offsets, and the feature data payload of geometry and attributes. Below, three numbered range reads point up: read one fetches the header, read two fetches the R-tree, read three fetches only the matched feature byte ranges highlighted inside the payload." xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;color:var(--primary);font-family:var(--font-sans)">
  <title>Indexed FlatGeobuf file layout and range-read sequence</title>
  <desc>Four contiguous segments — magic marker, header with schema and CRS and bounding box, packed Hilbert R-tree index, and feature data payload. Three numbered HTTP range reads fetch the header, then the R-tree, then only the feature byte ranges the query bounding box intersects, never the whole file.</desc>
  <defs>
    <marker id="idx-up" viewBox="0 0 10 10" refX="5" refY="2" markerWidth="8" markerHeight="8" orient="auto">
      <path d="M0 8 L5 0 L10 8 z" fill="currentColor"/>
    </marker>
  </defs>
  <text x="14" y="34" font-size="10" fill="currentColor" fill-opacity="0.7">byte offset 0 &#8594; end of file</text>
  <!-- file segments -->
  <g text-anchor="middle">
    <rect x="14" y="48" width="70" height="72" rx="7" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-opacity="0.45"/>
    <text x="49" y="80" font-size="10.5" font-weight="700" fill="currentColor">Magic</text>
    <text x="49" y="98" font-size="9" fill="currentColor" fill-opacity="0.7">8 B</text>
    <rect x="88" y="48" width="168" height="72" rx="7" fill="currentColor" fill-opacity="0.06" stroke="currentColor" stroke-opacity="0.5"/>
    <text x="172" y="80" font-size="12" font-weight="700" fill="currentColor">Header</text>
    <text x="172" y="99" font-size="9" fill="currentColor" fill-opacity="0.72">schema &#183; CRS &#183; bbox</text>
    <rect x="260" y="48" width="300" height="72" rx="7" fill="currentColor" fill-opacity="0.1" stroke="currentColor" stroke-opacity="0.6" stroke-width="1.4"/>
    <text x="410" y="80" font-size="12" font-weight="700" fill="currentColor">Packed Hilbert R-tree</text>
    <text x="410" y="99" font-size="9" fill="currentColor" fill-opacity="0.72">node ranges &#183; feature offsets</text>
    <rect x="564" y="48" width="322" height="72" rx="7" fill="currentColor" fill-opacity="0.04" stroke="currentColor" stroke-opacity="0.4"/>
    <text x="725" y="80" font-size="12" font-weight="700" fill="currentColor">Feature data</text>
    <text x="725" y="99" font-size="9" fill="currentColor" fill-opacity="0.72">geometry + attributes</text>
    <!-- matched-feature highlight inside payload -->
    <rect x="600" y="52" width="92" height="64" rx="5" fill="currentColor" fill-opacity="0.16" stroke="currentColor" stroke-opacity="0.7"/>
    <text x="646" y="115" font-size="8.5" fill="currentColor" fill-opacity="0.8">matched</text>
  </g>
  <!-- range-read pointers -->
  <g stroke="currentColor" stroke-width="1.6" fill="none" stroke-opacity="0.65">
    <path d="M172 158 V124" marker-end="url(#idx-up)"/>
    <path d="M410 158 V124" marker-end="url(#idx-up)"/>
    <path d="M646 158 V124" marker-end="url(#idx-up)"/>
  </g>
  <g text-anchor="middle">
    <text x="172" y="176" font-size="10" font-weight="600" fill="currentColor">&#9312; fetch header</text>
    <text x="410" y="176" font-size="10" font-weight="600" fill="currentColor">&#9313; fetch R-tree</text>
    <text x="646" y="176" font-size="10" font-weight="600" fill="currentColor">&#9314; fetch matches</text>
  </g>
  <text x="450" y="218" text-anchor="middle" font-size="10" fill="currentColor" fill-opacity="0.75">A cold read touches the header and index, then only the feature byte ranges the bounding box intersects &#8212; never the whole file.</text>
</svg>

The first eight bytes are a fixed magic marker that identifies the format and its version. Immediately after comes the header: a FlatBuffers-encoded table carrying the layer name, the attribute column definitions, the geometry type, the coordinate reference system (CRS) as WKT, and the dataset's total bounding box and feature count. Because the header is small and lives at a known offset, a client resolves the entire schema in one short request without touching a single feature.

The third segment is the packed Hilbert R-tree, and it is what this guide exists to produce. Rather than an incrementally balanced tree, FlatGeobuf sorts every feature along a Hilbert space-filling curve — which keeps spatially adjacent features adjacent on disk — then packs a static, bottom-up R-tree over that order. Each node stores a bounding box and a byte offset into the feature payload. The tree is written breadth-first with a fixed node size, so its total length is a deterministic function of the feature count, and a client can compute exactly where the index ends and the payload begins. Traversing the tree with a query rectangle yields a small set of byte ranges; those ranges are then fetched directly from the feature data segment. This is the mechanism behind cold-storage byte-range reads: the index turns "find features intersecting this box" into "read these three offset ranges", and the practical client-side workflow for issuing those reads is covered in the sibling guide on [streaming FlatGeobuf features over HTTP range requests](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/flatgeobuf-optimization-techniques/streaming-flatgeobuf-features-over-http-range-requests/).

Without the index, none of this holds. An unindexed `.fgb` forces a client to stream every feature from offset zero to find the ones it wants — on a multi-gigabyte parcel layer parked in a warm tier, that is the difference between a 30 KB read and a full-object egress charge. The index is therefore not an optimization to add later; it is the archival contract you write at serialization time.

## Writing an Indexed FlatGeobuf

The GDAL FlatGeobuf driver builds the packed Hilbert R-tree when the `SPATIAL_INDEX` layer-creation option is enabled. The steps below take a source dataset through a clean, index-bearing export.

1. **Lock the CRS and prune the schema first.** The index is built over the geometries as they will be stored, so any reprojection must happen before packing. Force an explicit source and target CRS and keep only the attributes you archive; detailed projection-registry handling belongs to [CRS synchronization in pipelines](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/crs-synchronization-in-pipelines/).

```bash
# Reproject and prune WITHOUT an index first, so the packing step
# in phase 2 sorts the final geometries. OGR SQL has no ST_Transform,
# so -t_srs does the reprojection, not the -sql clause.
ogr2ogr -f "FlatGeobuf" \
  datasets/parcels/staging/region_north_normalized.fgb \
  datasets/parcels/raw/region_north.gpkg \
  -s_srs EPSG:2913 -t_srs EPSG:4326 \
  -lco SPATIAL_INDEX=NO \
  -sql "SELECT parcel_id, zoning, assessed_value FROM parcels"
```

2. **Pack the Hilbert R-tree.** Re-serialize the normalized file with the index enabled. The driver sorts features along the Hilbert curve and writes the static tree between the header and the payload; node size and tree depth are managed automatically.

```bash
# Build the packed Hilbert R-tree spatial index.
ogr2ogr -f "FlatGeobuf" \
  datasets/parcels/staging/region_north_indexed.fgb \
  datasets/parcels/staging/region_north_normalized.fgb \
  -lco SPATIAL_INDEX=YES
```

3. **Size the source for in-memory packing.** The driver sorts feature bounding boxes in memory during packing. For datasets past roughly 10 GB, raise the GDAL cache so the sort does not spill, and run the export on a worker with headroom rather than inside a shared conversion pool.

```bash
export GDAL_CACHEMAX=4096          # MB of block cache for the sort
export OGR_ORGANIZE_POLYGONS=SKIP  # skip ring-orientation cost on clean data
ogr2ogr -f "FlatGeobuf" \
  s3://spatial-archive/fgb/parcels/2024/region_north_indexed.fgb \
  datasets/parcels/staging/region_north_normalized.fgb \
  -lco SPATIAL_INDEX=YES \
  --config CPL_VSIL_USE_TEMP_FILE_FOR_RANDOM_WRITE YES
```

The `/vsis3/`-style write path lets GDAL stream the indexed output straight to object storage, but the index is still assembled locally first — the temp-file config keeps the random writes off the network path until the object is complete.

## Verifying the Index Header

A successful write is not proof of a usable index. Confirm the header reports a spatial index and that the feature count survived, then inspect the raw bytes to prove the index segment is physically present.

```bash
# 1. Driver-level confirmation of index + geometry metadata.
ogrinfo -so datasets/parcels/staging/region_north_indexed.fgb
```

Expected output — the CRS must be the resolved EPSG code, the feature count must match the source, and the extent must be non-empty:

```text
INFO: Open of 'region_north_indexed.fgb' using driver 'FlatGeobuf' successful.

Layer name: region_north_indexed
Geometry: Polygon
Feature Count: 482817
Extent: (-123.482, 45.230) - (-121.905, 46.388)
Layer SRS WKT: GEOGCRS["WGS 84", ... ID["EPSG",4326]]
```

FlatGeobuf does not print an "index present" flag through `ogrinfo`, so confirm the index physically by checking that the header's `index_node_size` is non-zero. Read it directly from the FlatBuffers header:

```python
# Confirm the packed R-tree exists by reading index_node_size from the header.
# A value of 0 means SPATIAL_INDEX=NO was used and no tree was written.
from flatgeobuf import HeaderReader  # pip install flatgeobuf

with open("datasets/parcels/staging/region_north_indexed.fgb", "rb") as f:
    header = HeaderReader.read(f)

assert header.index_node_size > 0, "no spatial index — file is not range-readable"
assert header.features_count == 482817, "feature count drift"
assert "4326" in (header.crs.code_string or str(header.crs.code))
print(f"index_node_size={header.index_node_size} features={header.features_count}")
# index_node_size=16 features=482817
```

An `index_node_size` of `0` means the file was written with `SPATIAL_INDEX=NO`; the file is valid but not range-readable, and every client will fall back to a full scan. Treat this check as a hard gate before any object is promoted into a tier that bills for egress.

## Troubleshooting

| Symptom | Root cause | Fix |
|---|---|---|
| `ogrinfo` reports the correct feature count but clients still download the whole file | File written with `SPATIAL_INDEX=NO`; `index_node_size` is 0 and no R-tree exists | Re-run the export with `-lco SPATIAL_INDEX=YES` and confirm `index_node_size > 0` before upload |
| `Cannot allocate memory` or a spill to disk during the index build | Hilbert sort of feature bounding boxes exceeds the GDAL cache on a large layer | Raise `GDAL_CACHEMAX` (4096+), split the layer by region, and index each partition independently |
| Range reads return features far outside the query box | Index was built before the final reprojection, so node bounding boxes are in the wrong CRS | Rebuild: normalize and reproject in phase 1, then pack the index over the reprojected geometries in phase 2 |

Consult the [GDAL FlatGeobuf driver documentation](https://gdal.org/drivers/vector/flatgeobuf.html) for the exact creation-option matrix and the [FlatGeobuf specification](https://flatgeobuf.org/) for the header and packed R-tree binary encoding.

## Operational Execution Checklist

- [ ] Source CRS resolved and a single explicit `-s_srs`/`-t_srs` transform applied before the index is packed
- [ ] Attribute schema pruned in the `-sql`/`-select` step so the payload the index points into stays lean
- [ ] Index built with `-lco SPATIAL_INDEX=YES` in a step that re-serializes the already-reprojected geometries
- [ ] `GDAL_CACHEMAX` raised for layers past ~10 GB so the Hilbert sort does not spill
- [ ] `ogrinfo -so` confirms feature count matches the source and the extent is non-empty
- [ ] `index_node_size > 0` verified from the FlatBuffers header before the object is promoted
- [ ] Indexed object written to its target tier only after the header check passes

## Related

- Up: [FlatGeobuf Optimization Techniques](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/flatgeobuf-optimization-techniques/) — the parent reference for indexing, schema, and CRS tuning across the whole `.fgb` lifecycle.
- [Streaming FlatGeobuf Features Over HTTP Range Requests](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/flatgeobuf-optimization-techniques/streaming-flatgeobuf-features-over-http-range-requests/) — the client-side workflow that consumes the R-tree this page builds.
- [Converting GeoPackage to FlatGeobuf for Web Archives](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/flatgeobuf-optimization-techniques/converting-geopackage-to-flatgeobuf-for-web-archives/) — the batch conversion procedure that feeds indexed `.fgb` into web archives.
- [Optimizing FlatGeobuf for Web Mapping Archives](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/flatgeobuf-optimization-techniques/optimizing-flatgeobuf-for-web-mapping-archives/) — block-alignment and upload-integrity steps that complement index construction.
- [Object Storage Selection for GIS Archives](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/object-storage-selection-for-gis-archives/) — choosing a substrate whose range-request support the index depends on.

_Part of the [Spatial Data Archival](https://www.spatialdataarchival.org/) knowledge base._
