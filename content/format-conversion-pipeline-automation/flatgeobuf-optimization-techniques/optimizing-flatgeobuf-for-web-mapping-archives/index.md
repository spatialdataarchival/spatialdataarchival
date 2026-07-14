# Optimizing FlatGeobuf for Web Mapping Archives: Pipeline Configuration and Cold Storage Validation

This guide is for data engineers and GIS archivists who serve interactive web maps directly from object storage and need each archived `.fgb` artifact to stay small, deterministic, and cheap to range-read across a multi-year retention horizon. FlatGeobuf (`.fgb`) gives a browser deterministic HTTP range-request access — a client reads only the bytes its bounding box touches — but a default `ogr2ogr` export silently breaks that contract: the packed spatial index misaligns with cloud block sizes, attribute schemas expand unboundedly, and coordinate reference systems (CRS) drift during cold-storage transitions. The procedures below sit inside the broader [Format Conversion & Pipeline Automation](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/) workflow and apply the tuning patterns from [FlatGeobuf Optimization Techniques](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/flatgeobuf-optimization-techniques/) to enforce strict byte-alignment, deterministic index generation, and schema validation so retrieval latency stays flat instead of growing with archive size.

## Web Archive Pipeline

Web-mapping archives normalize, index, validate, then verify on upload:

<svg viewBox="0 0 820 188" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="A four-stage web-mapping archive pipeline: normalize the schema and lock the CRS, build the packed Hilbert spatial index and pad to the 4 KB block grid, validate that range reads return 206 Partial Content, then upload to cold storage and verify a byte-for-byte integrity checksum.">
  <title>FlatGeobuf Web Archive Pipeline</title>
  <desc>Four boxes left to right joined by arrows: Stage one normalizes schema and locks CRS (Phase 1); stage two builds the packed Hilbert index and pads to the 4 KB grid (Phase 2); stage three validates range reads return 206 Partial Content; stage four uploads to cold storage and verifies the integrity checksum (Phase 3). Each stage carries a short subtitle describing its byte-level guarantee.</desc>
  <defs>
    <marker id="fgb-flow" markerWidth="9" markerHeight="9" refX="6.5" refY="3" orient="auto">
      <path d="M0,0 L0,6 L8,3 z" fill="currentColor"/>
    </marker>
  </defs>
  <rect x="12" y="58" width="172" height="74" rx="8" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="98" y="84" text-anchor="middle" font-size="12.5" fill="currentColor" font-family="sans-serif" font-weight="bold">Normalize</text>
  <text x="98" y="101" text-anchor="middle" font-size="10.5" fill="currentColor" font-family="sans-serif">schema + lock CRS</text>
  <text x="98" y="118" text-anchor="middle" font-size="9" fill="currentColor" font-family="sans-serif" opacity=".7">one explicit transform</text>
  <rect x="220" y="58" width="172" height="74" rx="8" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="306" y="84" text-anchor="middle" font-size="12.5" fill="currentColor" font-family="sans-serif" font-weight="bold">Build index</text>
  <text x="306" y="101" text-anchor="middle" font-size="10.5" fill="currentColor" font-family="sans-serif">pack Hilbert R-tree</text>
  <text x="306" y="118" text-anchor="middle" font-size="9" fill="currentColor" font-family="sans-serif" opacity=".7">pad to 4 KB grid</text>
  <rect x="428" y="58" width="172" height="74" rx="8" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="514" y="84" text-anchor="middle" font-size="12.5" fill="currentColor" font-family="sans-serif" font-weight="bold">Validate</text>
  <text x="514" y="101" text-anchor="middle" font-size="10.5" fill="currentColor" font-family="sans-serif">range reads</text>
  <text x="514" y="118" text-anchor="middle" font-size="9" fill="currentColor" font-family="sans-serif" opacity=".7">expect 206 Partial</text>
  <rect x="636" y="58" width="172" height="74" rx="8" fill="currentColor" fill-opacity=".1" stroke="currentColor" stroke-width="1.8"/>
  <text x="722" y="84" text-anchor="middle" font-size="12.5" fill="currentColor" font-family="sans-serif" font-weight="bold">Upload + verify</text>
  <text x="722" y="101" text-anchor="middle" font-size="10.5" fill="currentColor" font-family="sans-serif">cold tier</text>
  <text x="722" y="118" text-anchor="middle" font-size="9" fill="currentColor" font-family="sans-serif" opacity=".7">sha256 integrity</text>
  <line x1="184" y1="95" x2="218" y2="95" stroke="currentColor" stroke-width="1.5" marker-end="url(#fgb-flow)"/>
  <line x1="392" y1="95" x2="426" y2="95" stroke="currentColor" stroke-width="1.5" marker-end="url(#fgb-flow)"/>
  <line x1="600" y1="95" x2="634" y2="95" stroke="currentColor" stroke-width="1.5" marker-end="url(#fgb-flow)"/>
  <text x="98" y="30" text-anchor="middle" font-size="9.5" fill="currentColor" font-family="sans-serif" font-weight="bold" opacity=".75">PHASE 1</text>
  <text x="306" y="30" text-anchor="middle" font-size="9.5" fill="currentColor" font-family="sans-serif" font-weight="bold" opacity=".75">PHASE 2</text>
  <text x="514" y="30" text-anchor="middle" font-size="9.5" fill="currentColor" font-family="sans-serif" font-weight="bold" opacity=".75">VALIDATION</text>
  <text x="722" y="30" text-anchor="middle" font-size="9.5" fill="currentColor" font-family="sans-serif" font-weight="bold" opacity=".75">PHASE 3</text>
  <line x1="12" y1="40" x2="184" y2="40" stroke="currentColor" stroke-width="1" opacity=".35"/>
  <line x1="220" y1="40" x2="392" y2="40" stroke="currentColor" stroke-width="1" opacity=".35"/>
  <line x1="428" y1="40" x2="600" y2="40" stroke="currentColor" stroke-width="1" opacity=".35"/>
  <line x1="636" y1="40" x2="808" y2="40" stroke="currentColor" stroke-width="1" opacity=".35"/>
  <text x="410" y="166" text-anchor="middle" font-size="9.5" fill="currentColor" font-family="sans-serif" opacity=".6">retrieval latency stays flat as the archive grows — bytes read scale with the bounding box, not the file</text>
</svg>

This page assumes you have already selected a target object store and storage class, that a [retention policy framework](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/retention-policy-frameworks/) governs how long `.fgb` artifacts are held, and that a [hot/warm/cold tier design](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/hotwarmcold-tier-design-for-geospatial-data/) decides which tier serves live maps versus deep archive. FlatGeobuf owns the range-read web-delivery tier; if your access pattern is analytical, the [GeoParquet Migration Workflows](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/geoparquet-migration-workflows/) pipeline owns the columnar tier and the two formats coexist behind one manifest.

## Step-by-Step Procedure

### Phase 1 — Normalize Schema and Lock CRS Before Serialization

Implicit CRS declarations and unbounded attribute types are the primary drivers of archive bloat and client-side rendering failures. Lock the coordinate transformation and prune the schema in a single deterministic pass before the file is ever serialized. Detailed projection-registry handling belongs to [CRS synchronization in pipelines](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/crs-synchronization-in-pipelines/); here you only enforce one explicit transform at the ingestion gateway.

```bash
# Force EPSG:4326 and prune attributes in one pass. ogr2ogr reprojects via
# -t_srs, so the geometry must NOT be reprojected again in -sql (OGR SQL has
# no ST_Transform). Build the index in Phase 2, not here.
ogr2ogr -f "FlatGeobuf" \
  datasets/parcels/staging/archive_normalized.fgb \
  datasets/parcels/raw/source_parcels.gpkg \
  -s_srs EPSG:2913 -t_srs EPSG:4326 \
  -lco SPATIAL_INDEX=NO \
  -sql "SELECT id, name FROM parcels"
```

Constrain attribute types by casting them in the `-sql`/`-select` step; FlatGeobuf stores variable-length strings and IEEE doubles, so there is no field-width environment variable to set. Truncating attributes at the source is the same discipline that prevents silent [attribute loss during format conversion](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/schema-mapping-attribute-validation/).

### Phase 2 — Build the Packed Hilbert Index and Align to Storage Blocks

The FlatGeobuf spatial index uses a Hilbert curve to order features. Misalignment between the index structure and cloud storage block boundaries forces excessive `206 Partial Content` requests, inflating retrieval cost and latency.

```bash
# Build the packed Hilbert R-tree spatial index (depth is managed automatically).
ogr2ogr -f "FlatGeobuf" \
  datasets/parcels/staging/archive_indexed.fgb \
  datasets/parcels/staging/archive_normalized.fgb \
  -lco SPATIAL_INDEX=YES
```

For datasets larger than 10 GB, bypass in-memory sorting: extract the Hilbert keys, run an external merge sort, then reassemble with the `flatgeobuf` CLI bindings. Cloud object storage optimizes range requests at 4 KB or 8 KB boundaries, so the transition from the spatial index to the geometry payload must be padded to prevent cross-boundary fetches.

```python
# Pad the index-to-geometry boundary to the 4 KB cloud range-read grid.
import os

path = "datasets/parcels/staging/archive_indexed.fgb"
with open(path, "r+b") as f:
    f.seek(0, os.SEEK_END)
    size = f.tell()
    padding = (4096 - (size % 4096)) % 4096
    f.write(b"\x00" * padding)
print(f"padded {padding} bytes -> {size + padding} total")
```

### Phase 3 — Upload to Cold Storage With Integrity-Preserving Settings

Multipart uploads and tiered-storage transitions frequently corrupt FlatGeobuf headers or fragment the spatial index. Capture a pre-upload checksum and force an opaque content type so no transfer-layer transform touches the first 4 KB block. FlatGeobuf has no internal codec, so any space savings come from the storage or transport layer — pair this tier with [ZSTD level configuration for spatial files](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/zstd-level-configuration-for-spatial-files/) only where the client can transparently decompress.

```bash
# 1. Pre-upload checksum.
sha256sum datasets/parcels/staging/archive_indexed.fgb \
  > datasets/parcels/staging/archive_indexed.sha256

# 2. Upload to a retrieval-friendly cold tier; never let the client recompress.
aws s3 cp datasets/parcels/staging/archive_indexed.fgb \
  s3://geo-archive-prod/fgb/parcels/archive_indexed.fgb \
  --storage-class GLACIER_IR \
  --metadata-directive REPLACE \
  --content-type "application/octet-stream"
```

## Validation & Verification

Confirm feature counts, range-read behavior, and byte-for-byte integrity before declaring the artifact archival-ready.

```bash
# Spatial index + feature count present after Phase 2.
ogrinfo -so datasets/parcels/staging/archive_indexed.fgb
# Expected: "Feature Count: 482817" and a non-empty Extent line.

# Simulate a cold range request with a GET (HEAD/-I will not show 206).
curl -s -r 0-4095 -o /dev/null -D - \
  https://geo-archive-prod.s3.amazonaws.com/fgb/parcels/archive_indexed.fgb
# Expected: HTTP/1.1 206 Partial Content
#           Content-Range: bytes 0-4095/...
#           Content-Length: 4096

# Post-transfer: hash the full restored object and compare to the pre-upload sum.
downloaded=$(aws s3 cp s3://geo-archive-prod/fgb/parcels/archive_indexed.fgb - \
  | sha256sum | awk '{print $1}')
[ "$downloaded" = "$(awk '{print $1}' \
  datasets/parcels/staging/archive_indexed.sha256)" ] \
  && echo "INTEGRITY OK" || echo "INTEGRITY FAIL"
# Expected: INTEGRITY OK
```

Verify the schema and CRS survived the round trip by inspecting the restored object in place, then compare against the pre-upload manifest:

```python
import pyogrio

meta = pyogrio.read_info("/vsis3/geo-archive-prod/fgb/parcels/archive_indexed.fgb")
assert meta["crs"] == "EPSG:4326", meta["crs"]
assert meta["geometry_type"] in ("Polygon", "MultiPolygon", "Point")
# pyogrio returns "dtypes" parallel to "fields"; iterate it directly.
assert all(dt in ("int32", "int64", "float32", "float64", "object")
           for dt in meta["dtypes"])
print("schema + CRS verified")
```

## Troubleshooting

| Symptom | Root cause | Fix |
|---|---|---|
| Client-side geometry jitter or `NaN` coordinates on render | Implicit CRS drift during multi-stage pipeline staging | Force `-s_srs`/`-t_srs` at ingestion and strip every source `.prj`; apply one deterministic transform before serialization (Phase 1). |
| Cold-tier retrieval latency >2 s for a <10 MB tile, `206` request count >50 per tile | Unpadded index-to-geometry boundary, or the spatial index was never built | Rebuild with `-lco SPATIAL_INDEX=YES`, pad to the 4 KB boundary, then re-run the `curl -r 0-4095` range test (Phase 2). |
| `OGR: FlatGeobuf: Invalid header` or `Geometry collection not supported` after restore | Multipart-upload chunk misalignment or cold-tier decompression altered the first 4096 bytes | Disable client-side compression, force `--content-type application/octet-stream`, and re-validate the first 4 KB block immediately after transfer (Phase 3). |
| `HTTP 416 Range Not Satisfiable` on a known-good offset | Index header exceeds the declared size after an incomplete re-serialization | Re-serialize cleanly with `SPATIAL_INDEX=YES` and re-pad to the 4 KB boundary before upload. |

Consult the [GDAL FlatGeobuf driver documentation](https://gdal.org/drivers/vector/flatgeobuf.html) for version-specific header-parsing edge cases, the [FlatGeobuf specification](https://flatgeobuf.org/) for strict CRS header encoding, and the [AWS S3 GetObject Range header](https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObject.html) reference for storage-tier range compatibility.

## Operational Execution Checklist

- [ ] Source CRS resolved and a single explicit `-s_srs`/`-t_srs` transform applied; all `.prj` artifacts stripped
- [ ] Attribute schema pruned and cast in the `-sql`/`-select` step; serialized payload per feature kept lean
- [ ] Packed Hilbert spatial index built with `-lco SPATIAL_INDEX=YES`
- [ ] Index-to-geometry boundary padded to the 4 KB cloud range-read grid
- [ ] `ogrinfo -so` confirms feature count and non-empty extent
- [ ] `curl -r 0-4095` returns `206 Partial Content` with `Content-Length: 4096`
- [ ] Pre-upload `sha256sum` captured and re-verified against the restored object (`INTEGRITY OK`)
- [ ] Restored object uploaded with `--content-type application/octet-stream` to the chosen cold tier
- [ ] `pyogrio.read_info()` on the `/vsis3/` object matches the pre-upload schema + CRS manifest

## Related

- Up to the parent topic: [FlatGeobuf Optimization Techniques](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/flatgeobuf-optimization-techniques/) covers indexing, compression, schema, and CRS tuning across the whole `.fgb` lifecycle.
- Sibling procedure: [Automating CRS Transformations in ETL Pipelines](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/crs-synchronization-in-pipelines/automating-crs-transformations-in-etl-pipelines/) standardizes the projection step this page depends on.
- Cross-topic: [How to Design a 3-Tier Spatial Storage Architecture](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/hotwarmcold-tier-design-for-geospatial-data/how-to-design-a-3-tier-spatial-storage-architecture/) decides which tier serves live `.fgb` web maps versus deep archive.
- Parent framework: [Format Conversion & Pipeline Automation](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/) for the end-to-end conversion architecture these phases plug into.
