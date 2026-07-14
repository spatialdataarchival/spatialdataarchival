# How to Design a 3-Tier Spatial Storage Architecture

Operationalizing a geospatial archive means mapping access frequency, retrieval latency, and storage economics into a deterministic, policy-driven layout — not parking everything in one bucket and hoping the bill stays flat. This how-to is for the data engineer, GIS archivist, or cloud architect standing up a hot/warm/cold layout from scratch, where default object-store configurations fail in three predictable ways: lifecycle rules transition on object age rather than measured access and silently strip custom tags, monolithic GeoTIFFs and legacy shapefiles force full-object downloads on partial spatial queries, and unverified cold-tier locks block the retrieval SLAs a compliance audit depends on. The procedure below gives exact configuration, validation gates with annotated output, and root-cause fixes for each failure mode, building on the broader [hot/warm/cold tier design for geospatial data](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/hotwarmcold-tier-design-for-geospatial-data/) that this page implements step by step.

## Design Phases

The build proceeds through four phases, from tier boundaries to verified retrieval:

<svg viewBox="0 0 1000 112" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Four-phase build sequence, left to right. Phase 1: Tier boundaries — define per-tier SLAs and map lifecycle transitions. Phase 2: COG conversion — partition and rewrite assets as cloud-optimized formats. Phase 3: Metadata sidecars — attach immutable JSON with bbox, CRS and checksum. Phase 4: Lock and retrieval test — apply WORM and verify the restore SLA. Each phase feeds the next and gates the one after it.">
  <title>Three-Tier Architecture Build Sequence</title>
  <desc>A left-to-right pipeline of four phases — Phase 1 Tier boundaries, Phase 2 COG conversion, Phase 3 Metadata sidecars, and Phase 4 Lock plus retrieval test — connected by arrows showing that each phase must complete and validate before the next begins.</desc>
  <defs>
    <marker id="ph-arr" markerWidth="9" markerHeight="9" refX="6" refY="3" orient="auto">
      <path d="M0,0 L0,6 L8,3 z" fill="currentColor"/>
    </marker>
  </defs>
  <rect x="10" y="30" width="215" height="56" rx="6" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-width="1.5"/>
  <text x="117" y="54" text-anchor="middle" font-size="12.5" font-family="sans-serif" fill="currentColor" font-weight="600">Phase 1</text>
  <text x="117" y="72" text-anchor="middle" font-size="10" font-family="sans-serif" fill="currentColor" opacity="0.7">Tier boundaries</text>
  <rect x="265" y="30" width="215" height="56" rx="6" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-width="1.5"/>
  <text x="372" y="54" text-anchor="middle" font-size="12.5" font-family="sans-serif" fill="currentColor" font-weight="600">Phase 2</text>
  <text x="372" y="72" text-anchor="middle" font-size="10" font-family="sans-serif" fill="currentColor" opacity="0.7">COG conversion</text>
  <rect x="520" y="30" width="215" height="56" rx="6" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-width="1.5"/>
  <text x="627" y="54" text-anchor="middle" font-size="12.5" font-family="sans-serif" fill="currentColor" font-weight="600">Phase 3</text>
  <text x="627" y="72" text-anchor="middle" font-size="10" font-family="sans-serif" fill="currentColor" opacity="0.7">Metadata sidecars</text>
  <rect x="775" y="30" width="215" height="56" rx="6" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-width="1.5"/>
  <text x="882" y="54" text-anchor="middle" font-size="12.5" font-family="sans-serif" fill="currentColor" font-weight="600">Phase 4</text>
  <text x="882" y="72" text-anchor="middle" font-size="10" font-family="sans-serif" fill="currentColor" opacity="0.7">Lock + retrieval test</text>
  <line x1="225" y1="58" x2="263" y2="58" stroke="currentColor" stroke-width="1.5" marker-end="url(#ph-arr)"/>
  <line x1="480" y1="58" x2="518" y2="58" stroke="currentColor" stroke-width="1.5" marker-end="url(#ph-arr)"/>
  <line x1="735" y1="58" x2="773" y2="58" stroke="currentColor" stroke-width="1.5" marker-end="url(#ph-arr)"/>
  <text x="500" y="20" text-anchor="middle" font-size="10" font-family="sans-serif" fill="currentColor" opacity="0.6">each phase validates before the next begins</text>
</svg>

## Phase 1: Tier Boundary Enforcement & Lifecycle Policy Mapping

Define explicit SLAs per tier before provisioning storage classes. Spatial data exhibits non-uniform access patterns; LiDAR point clouds and historical orthomosaics require different transition thresholds than real-time sensor feeds. Align tier boundaries with organizational data governance mandates using established [Spatial Archival Architecture & Tiering Strategy](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/) frameworks to prevent jurisdictional residency violations during automated transitions. The specific storage classes and their minimum-storage windows differ by provider, so resolve vendor selection through [AWS S3 vs Azure Blob for GIS cold storage](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/object-storage-selection-for-gis-archives/aws-s3-vs-azure-blob-for-gis-cold-storage/) before the thresholds below are committed.

<svg viewBox="0 0 1000 188" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Three-tier storage map. Hot tier uses the STANDARD storage class, targets under 100 millisecond reads, and holds live tiles and fresh ingest. After 30 days of object age the lifecycle engine transitions objects to the Warm tier on STANDARD_IA, which serves second-scale reads for quarterly refresh workloads. After 365 days objects transition to the Cold tier on GLACIER, with hours-scale restore latency for compliance archives. The day-30 and day-365 thresholds label the two transition arrows.">
  <title>Hot / Warm / Cold Tier Map with Transition Thresholds</title>
  <desc>Three storage tiers laid out left to right — Hot (STANDARD, under 100 ms, live tiles and ingest), Warm (STANDARD_IA, seconds, quarterly refresh), and Cold (GLACIER, hours, compliance archive) — joined by two lifecycle-transition arrows labelled day 30 and day 365.</desc>
  <defs>
    <marker id="tm-arr" markerWidth="9" markerHeight="9" refX="6" refY="3" orient="auto">
      <path d="M0,0 L0,6 L8,3 z" fill="currentColor"/>
    </marker>
  </defs>
  <text x="20" y="22" font-size="10" font-family="sans-serif" fill="currentColor" opacity="0.6">Transitions run on object age, not last access — only Intelligent-Tiering reacts to reads</text>
  <rect x="20" y="44" width="270" height="100" rx="7" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-width="1.5"/>
  <text x="155" y="72" text-anchor="middle" font-size="14" font-family="sans-serif" fill="currentColor" font-weight="600">HOT</text>
  <text x="155" y="92" text-anchor="middle" font-size="10" font-family="sans-serif" fill="currentColor" opacity="0.7">STANDARD</text>
  <text x="155" y="112" text-anchor="middle" font-size="10.5" font-family="sans-serif" fill="currentColor">latency &lt; 100 ms</text>
  <text x="155" y="132" text-anchor="middle" font-size="9.5" font-family="sans-serif" fill="currentColor" opacity="0.65">live tiles &amp; fresh ingest</text>
  <rect x="365" y="44" width="270" height="100" rx="7" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-width="1.5"/>
  <text x="500" y="72" text-anchor="middle" font-size="14" font-family="sans-serif" fill="currentColor" font-weight="600">WARM</text>
  <text x="500" y="92" text-anchor="middle" font-size="10" font-family="sans-serif" fill="currentColor" opacity="0.7">STANDARD_IA</text>
  <text x="500" y="112" text-anchor="middle" font-size="10.5" font-family="sans-serif" fill="currentColor">latency seconds</text>
  <text x="500" y="132" text-anchor="middle" font-size="9.5" font-family="sans-serif" fill="currentColor" opacity="0.65">quarterly refresh &amp; ETL staging</text>
  <rect x="710" y="44" width="270" height="100" rx="7" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-width="1.5"/>
  <text x="845" y="72" text-anchor="middle" font-size="14" font-family="sans-serif" fill="currentColor" font-weight="600">COLD</text>
  <text x="845" y="92" text-anchor="middle" font-size="10" font-family="sans-serif" fill="currentColor" opacity="0.7">GLACIER</text>
  <text x="845" y="112" text-anchor="middle" font-size="10.5" font-family="sans-serif" fill="currentColor">latency hours</text>
  <text x="845" y="132" text-anchor="middle" font-size="9.5" font-family="sans-serif" fill="currentColor" opacity="0.65">compliance archive</text>
  <line x1="290" y1="94" x2="363" y2="94" stroke="currentColor" stroke-width="1.5" marker-end="url(#tm-arr)"/>
  <line x1="635" y1="94" x2="708" y2="94" stroke="currentColor" stroke-width="1.5" marker-end="url(#tm-arr)"/>
  <text x="326" y="82" text-anchor="middle" font-size="10" font-family="sans-serif" fill="currentColor" font-weight="600">day 30</text>
  <text x="326" y="112" text-anchor="middle" font-size="8.5" font-family="sans-serif" fill="currentColor" opacity="0.6">transition</text>
  <text x="671" y="82" text-anchor="middle" font-size="10" font-family="sans-serif" fill="currentColor" font-weight="600">day 365</text>
  <text x="671" y="112" text-anchor="middle" font-size="8.5" font-family="sans-serif" fill="currentColor" opacity="0.6">transition</text>
  <text x="155" y="170" text-anchor="middle" font-size="9" font-family="sans-serif" fill="currentColor" opacity="0.55">highest cost / GB</text>
  <text x="845" y="170" text-anchor="middle" font-size="9" font-family="sans-serif" fill="currentColor" opacity="0.55">lowest cost / GB</text>
  <line x1="240" y1="166" x2="760" y2="166" stroke="currentColor" stroke-width="1" opacity="0.3" marker-end="url(#tm-arr)"/>
</svg>

Deploy lifecycle rules using infrastructure-as-code to guarantee reproducibility. The following AWS S3 JSON enforces strict 30-day warm transition and 365-day cold archival with automatic expiration of incomplete multipart uploads:

```json
{
  "Rules": [
    {
      "ID": "SpatialTierTransition",
      "Status": "Enabled",
      "Filter": {"Prefix": "datasets/"},
      "Transitions": [
        {"Days": 30, "StorageClass": "STANDARD_IA"},
        {"Days": 365, "StorageClass": "GLACIER"}
      ],
      "Expiration": {"Days": 3650},
      "AbortIncompleteMultipartUpload": {"DaysAfterInitiation": 7}
    }
  ]
}
```

Apply via CLI:

```bash
aws s3api put-bucket-lifecycle-configuration \
  --bucket spatial-archive-prod \
  --lifecycle-configuration file://lifecycle-policy.json
```

### Validation Gate

Verify rule propagation and object class assignment:

```bash
aws s3api head-object \
  --bucket spatial-archive-prod \
  --key datasets/2023/ortho_mosaic.tif | jq '.StorageClass'
```

**Expected Output:** `"STANDARD"` (initially), transitioning to `"STANDARD_IA"` after 30 days and `"GLACIER"` after 365.

**Root-Cause Analysis:** If objects remain in `STANDARD` past the threshold, verify the rule's `Filter` prefix actually matches the object keys — S3 lifecycle transitions run on object age, not last access, so reads never delay them (only S3 Intelligent-Tiering reacts to access frequency). Transitions are also applied by a daily batch process, so allow up to 48 hours of lag before escalating.

## Phase 2: Spatial Partitioning & Format Pipeline

Monolithic GeoTIFFs and legacy shapefiles force full-object downloads during partial spatial queries, triggering massive egress penalties. Enforce cloud-native spatial partitioning and optimized formats before enabling automated tiering. Migrating vector layers to a columnar archive format is handled end to end by the [GeoParquet migration workflows](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/geoparquet-migration-workflows/converting-legacy-shapefiles-to-geoparquet-at-scale/) pipeline, which this phase assumes as an upstream dependency for any non-raster assets.

### Partitioning & Key Structure

Shard datasets using H3 or S2 hexagonal grids. Store each tile as an independent object with a deterministic key of the form `/{dataset_id}/{year}/{resolution}/{tile_id}.{format}`, for example `lidar_2023/2023/1m/8a2a1072b5fffff.laz`. Independent tile objects are what make HTTP range requests and selective restore possible — a single packed archive forfeits both.

### Format Conversion Commands

Execute batch conversion using GDAL pipelines. Validate internal block alignment to ensure HTTP range requests function correctly across all storage classes.

**Raster → Cloud-Optimized GeoTIFF (COG):**

```bash
gdal_translate input.tif output.cog \
  -of COG \
  -co BLOCKSIZE=512 \
  -co COMPRESS=ZSTD \
  -co RESAMPLING=NEAREST \
  -co OVERVIEWS=IGNORE_EXISTING \
  -co SPARSE_OK=TRUE
```

The `COMPRESS=ZSTD` choice trades a small CPU cost at write time for a markedly smaller cold footprint; picking the level that balances ratio against cold-restore decompression latency is covered in [ZSTD level configuration for spatial files](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/zstd-level-configuration-for-spatial-files/tuning-zstd-compression-for-geoparquet-archives/).

**Vector → GeoParquet:**

```bash
ogr2ogr -f GeoParquet output.parquet input.shp \
  -lco GEOMETRY_ENCODING=WKB \
  -lco COMPRESSION=SNAPPY
```

**Point Cloud → LAZ (indexed):**

```bash
# las2las from LAStools converts and indexes LAS/LAZ files
las2las -i input.las -o output.laz -set_version 1.4
```

### Validation Gate

Verify range-request capability and internal tiling:

```bash
curl -sI -r 0-511 \
  https://spatial-archive-prod.s3.us-west-2.amazonaws.com/datasets/2023/1m/8a2a1072b5fffff.cog \
  | grep -i "accept-ranges"
```

**Expected Output:** `Accept-Ranges: bytes`

Cross-validate COG internal structure with `gdalinfo`:

```bash
gdalinfo -stats output.cog | grep -iE "Block|Compression|Overview"
```

**Expected Output:** `Block=512x512`, `COMPRESSION=ZSTD`, and `Overviews` present.

**Root-Cause Analysis:** If `Accept-Ranges` is missing or `Block=0x0` appears, the file was not written with cloud-optimized headers. Re-run `gdal_translate` with `-co TILED=YES` and `-co COPY_SRC_OVERVIEWS=YES`. Legacy software often strips TIFF directory offsets during upload, breaking spatial subsetting.

## Phase 3: Metadata Sidecars & Index Integrity

Do not embed critical metadata solely in object tags; cross-tier replication and lifecycle transitions frequently strip or truncate custom tags. Attach immutable JSON sidecars containing bounding boxes, CRS, acquisition timestamps, and cryptographic checksums. Keeping the projection authoritative across every transition is itself a discipline — the deterministic enforcement in [automating CRS transformations in ETL pipelines](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/crs-synchronization-in-pipelines/automating-crs-transformations-in-etl-pipelines/) prevents the silent reprojection drift that corrupts a sidecar's `bbox` and `crs` fields.

### Sidecar Schema & Generation

Generate sidecars during ingestion:

```bash
sha256_val=$(sha256sum 8a2a1072b5fffff.laz | awk '{print $1}')
cat > 8a2a1072b5fffff.json <<EOF
{
  "dataset_id": "lidar_2023",
  "tile_id": "8a2a1072b5fffff",
  "crs": "EPSG:32610",
  "bbox": [-122.419, 37.774, -122.418, 37.775],
  "acquisition_ts": "2023-08-14T10:00:00Z",
  "sha256": "${sha256_val}"
}
EOF
```

### Validation Gate

Validate JSON structure and checksum integrity before tier promotion:

```bash
jq -e '.bbox | length == 4' 8a2a1072b5fffff.json && echo "BBOX VALID" || echo "BBOX INVALID"
sha256sum -c <<< "$(jq -r '.sha256' 8a2a1072b5fffff.json)  8a2a1072b5fffff.laz"
```

**Expected Output:** `BBOX VALID` followed by `8a2a1072b5fffff.laz: OK`.

**Root-Cause Analysis:** Failed checksum validation indicates silent bit-rot during upload or concurrent write collisions. Implement `x-amz-checksum-sha256` headers during `PutObject` to enforce server-side validation. For CRS mismatches causing projection failures in downstream GIS tools, enforce `EPSG` codes via `gdal_translate -a_srs EPSG:32610` prior to archival.

## Phase 4: Compliance Locking & Retrieval Testing

Cold-tier archival requires immutable storage for regulatory compliance. Apply WORM (Write Once, Read Many) policies and validate retrieval SLAs before decommissioning hot-tier copies. The retention windows and legal-hold semantics applied here are derived from the broader [retention policy frameworks](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/retention-policy-frameworks/implementing-lifecycle-rules-for-shapefile-archives/) that govern how long each dataset class must remain locked.

### Object Lock Configuration

Enable S3 Object Lock at bucket creation (requires versioning):

```bash
aws s3api put-object-lock-configuration \
  --bucket spatial-compliance-archive \
  --object-lock-configuration '{"ObjectLockEnabled":"Enabled"}'

aws s3api put-object-retention \
  --bucket spatial-compliance-archive \
  --key datasets/2020/ortho_raw.tif \
  --retention '{"Mode":"GOVERNANCE","RetainUntilDate":"2030-01-01T00:00:00Z"}'
```

### Retrieval Validation Script

Simulate cold-tier rehydration and measure latency against SLA:

```bash
#!/bin/bash
START=$(date +%s%N)
aws s3api restore-object \
  --bucket spatial-compliance-archive \
  --key datasets/2020/ortho_raw.tif \
  --restore-request '{"Days":1,"GlacierJobParameters":{"Tier":"Standard"}}'
END=$(date +%s%N)
ELAPSED=$(( (END - START) / 1000000 ))
echo "Rehydration request submitted in ${ELAPSED}ms"
```

**Expected Output:** a sub-second submission time (the request is asynchronous), then poll `aws s3api head-object` until `.Restore` reports `ongoing-request="false"`.

**Root-Cause Analysis:** If retrieval exceeds the 12-hour SLA, verify `GlacierJobParameters.Tier`. `Expedited` (1–5 min) incurs higher egress costs; `Standard` (3–5 hours) is the default; `Bulk` (5–12 hours) is cheapest but violates active-discovery SLAs. Cross-reference job status via `aws s3api head-object --key datasets/2020/ortho_raw.tif | jq '.Restore'`. A `false` value with no `ongoing-request` indicates the job is queued or failed due to insufficient IAM `s3:RestoreObject` permissions.

## Troubleshooting Matrix

| Symptom | Probable Cause | Immediate Fix |
|---------|----------------|---------------|
| `HTTP 416 Range Not Satisfiable` on COG | Missing TIFF directory offsets or non-tiled compression | Re-export with `gdal_translate -co TILED=YES -co COPY_SRC_OVERVIEWS=YES` |
| Lifecycle transition skipped | Rule `Filter` prefix or tag does not match the object key | Verify rule scope with `aws s3api get-bucket-lifecycle-configuration`; correct the prefix |
| GeoParquet fails in QGIS/ArcGIS | Missing `geo` metadata key in Parquet footer | Run `geopandas.GeoDataFrame.to_parquet(..., schema_version="1.0.0")` |
| Checksum mismatch on cold retrieval | Incomplete multipart upload or network truncation | Abort incomplete uploads via lifecycle rule; enforce `--expected-checksum` in CLI |
| WORM policy blocks metadata update | `GOVERNANCE` mode with missing `bypass-governance-retention` | Use `--bypass-governance-retention` flag, or switch to `COMPLIANCE` mode only for finalized datasets |

## Operational Execution Checklist

- [ ] Define and document per-tier SLAs (latency, durability, residency) before any storage class is provisioned.
- [ ] Commit the lifecycle policy as infrastructure-as-code and confirm the `Filter` prefix matches live object keys.
- [ ] Convert every raster to COG and every vector layer to GeoParquet, partitioned on an H3/S2 key, before tiering is enabled.
- [ ] Validate `Accept-Ranges: bytes` and `Block=512x512` on a sample COG to confirm range-readability across tiers.
- [ ] Generate an immutable JSON sidecar (bbox, CRS, acquisition timestamp, SHA-256) for each object and validate it before promotion.
- [ ] Enable versioning and Object Lock on the compliance bucket and apply the retention mode the data class requires.
- [ ] Run the rehydration script against a cold object and confirm measured retrieval latency meets the documented SLA.

## Related

- Up: [Hot/Warm/Cold Tier Design for Geospatial Data](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/hotwarmcold-tier-design-for-geospatial-data/) — the parent reference that defines the tier model this procedure implements end to end.
- [Implementing Lifecycle Rules for Shapefile Archives](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/retention-policy-frameworks/implementing-lifecycle-rules-for-shapefile-archives/) — companion procedure for the retention windows and legal holds applied in Phase 4.
- [AWS S3 vs Azure Blob for GIS Cold Storage](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/object-storage-selection-for-gis-archives/aws-s3-vs-azure-blob-for-gis-cold-storage/) — resolve provider storage classes and retrieval mechanics before fixing the Phase 1 thresholds.
- [Tuning ZSTD Compression for GeoParquet Archives](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/zstd-level-configuration-for-spatial-files/tuning-zstd-compression-for-geoparquet-archives/) — cross-domain guidance on the compression level that balances cold footprint against restore-time decompression cost.
