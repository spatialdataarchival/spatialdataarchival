# Converting Legacy Shapefiles to GeoParquet at Scale

Migrating multi-terabyte legacy shapefile archives into columnar GeoParquet storage requires deterministic pipeline orchestration, strict schema enforcement, and cold-storage-aware partitioning. The transition eliminates the 2 GB file-size ceiling, DBF attribute truncation, and unindexed spatial queries inherent to legacy formats. Default `ogr2ogr` one-liners fail here: they load the entire dataset into memory, infer CRS and column types implicitly, and emit a single unpartitioned file that is unusable for predicate-pushdown queries against cold storage. This guide details an exact, production-grade conversion workflow operating under the [Format Conversion & Pipeline Automation](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/) framework, focusing on configuration tuning, validation gates, and edge-case resolution for data engineers, GIS archivists, and compliance teams running batch [GeoParquet Migration Workflows](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/geoparquet-migration-workflows/) at terabyte scale.

## Conversion Stages

Large archives convert in bounded chunks, partitioned and audited end-to-end:

<svg viewBox="0 0 1010 160" role="img" aria-label="Five-stage shapefile to GeoParquet conversion pipeline, left to right: stage one pre-flight validation, stage two chunked read, stage three H3 partition keys, stage four write partitioned GeoParquet, stage five row count and checksum audit gate." xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;color:var(--primary);font-family:var(--font-sans)">
  <title>Shapefile to GeoParquet conversion stages</title>
  <desc>A left-to-right bounded pipeline: pre-flight validation feeds a chunked read, which derives H3 partition keys, which writes partitioned GeoParquet, which is then verified by a row-count and checksum audit gate before promotion.</desc>
  <defs>
    <marker id="conv-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <g text-anchor="middle">
    <!-- stage 1 -->
    <rect x="7" y="34" width="180" height="92" rx="11" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-opacity="0.4"/>
    <circle cx="97" cy="58" r="12" fill="currentColor" fill-opacity="0.12" stroke="currentColor" stroke-opacity="0.5"/>
    <text x="97" y="62" font-size="12" font-weight="700" fill="currentColor">1</text>
    <text x="97" y="90" font-size="13" font-weight="600" fill="currentColor">Pre-flight</text>
    <text x="97" y="108" font-size="13" font-weight="600" fill="currentColor">validation</text>
    <!-- stage 2 -->
    <rect x="211" y="34" width="180" height="92" rx="11" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-opacity="0.4"/>
    <circle cx="301" cy="58" r="12" fill="currentColor" fill-opacity="0.12" stroke="currentColor" stroke-opacity="0.5"/>
    <text x="301" y="62" font-size="12" font-weight="700" fill="currentColor">2</text>
    <text x="301" y="90" font-size="13" font-weight="600" fill="currentColor">Chunked</text>
    <text x="301" y="108" font-size="13" font-weight="600" fill="currentColor">read</text>
    <!-- stage 3 -->
    <rect x="415" y="34" width="180" height="92" rx="11" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-opacity="0.4"/>
    <circle cx="505" cy="58" r="12" fill="currentColor" fill-opacity="0.12" stroke="currentColor" stroke-opacity="0.5"/>
    <text x="505" y="62" font-size="12" font-weight="700" fill="currentColor">3</text>
    <text x="505" y="90" font-size="13" font-weight="600" fill="currentColor">H3 partition</text>
    <text x="505" y="108" font-size="13" font-weight="600" fill="currentColor">keys</text>
    <!-- stage 4 -->
    <rect x="619" y="34" width="180" height="92" rx="11" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-opacity="0.4"/>
    <circle cx="709" cy="58" r="12" fill="currentColor" fill-opacity="0.12" stroke="currentColor" stroke-opacity="0.5"/>
    <text x="709" y="62" font-size="12" font-weight="700" fill="currentColor">4</text>
    <text x="709" y="90" font-size="13" font-weight="600" fill="currentColor">Write partitioned</text>
    <text x="709" y="108" font-size="13" font-weight="600" fill="currentColor">GeoParquet</text>
    <!-- stage 5 (audit gate, highlighted) -->
    <rect x="823" y="34" width="180" height="92" rx="11" fill="currentColor" fill-opacity="0.13" stroke="currentColor" stroke-opacity="0.7" stroke-width="1.5"/>
    <circle cx="913" cy="58" r="12" fill="currentColor" fill-opacity="0.2" stroke="currentColor" stroke-opacity="0.7"/>
    <text x="913" y="62" font-size="12" font-weight="700" fill="currentColor">5</text>
    <text x="913" y="90" font-size="13" font-weight="700" fill="currentColor">Row count +</text>
    <text x="913" y="108" font-size="13" font-weight="700" fill="currentColor">checksum audit</text>
  </g>
  <g stroke="currentColor" stroke-width="2" fill="none" stroke-opacity="0.5">
    <path d="M189 80 H209" marker-end="url(#conv-arrow)"/>
    <path d="M393 80 H413" marker-end="url(#conv-arrow)"/>
    <path d="M597 80 H617" marker-end="url(#conv-arrow)"/>
    <path d="M801 80 H821" marker-end="url(#conv-arrow)"/>
  </g>
</svg>

## Pre-Flight Validation & Schema Enforcement

Shapefiles frequently fail during bulk ingestion due to implicit encoding mismatches, malformed `.prj` definitions, and untyped attribute columns. Execute a deterministic validation gate before triggering conversion jobs.

1. **Extract Metadata Deterministically:**
```bash
ogrinfo -ro -json -al -geom=NO input.shp > manifest.json
```
 Parse `featureCount`, `geometryType`, CRS, and field definitions from the JSON. Reject datasets where `featureCount` is `-1` or unknown; these indicate a corrupted `.shx` index, which you regenerate by rewriting the dataset (`ogr2ogr regenerated.shp input.shp`).

2. **Enforce CRS Synchronization:** Missing or legacy WKT1 `.prj` files cause downstream projection drift. Normalize explicitly:
```bash
gdalsrsinfo -o proj4 input.prj
```
 If the output is ambiguous, force EPSG:4326 or a project-specific projected CRS using `ogr2ogr -t_srs EPSG:XXXX`. Store the resolved EPSG code directly in the GeoParquet `geo` metadata block. Do not rely on implicit CRS inference. Refer to [CRS Synchronization in Pipelines](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/crs-synchronization-in-pipelines/) for standardized projection registries.

3. **Map DBF Types to Arrow Primitives:** DBF lacks native boolean, date, or 64-bit integer support. Apply explicit type coercion during ingestion:
 | DBF Type | Arrow Primitive | Coercion Logic |
 |----------|----------------|----------------|
 | `String(254)` | `large_string` | Truncate with audit log if `>254` chars |
 | `Numeric(10,2)` | `float64` | Preserve precision; reject `NaN` unless explicitly allowed |
 | `Date(YYYYMMDD)` | `date32` | Parse via `pd.to_datetime(..., format='%Y%m%d')` |
 | `Logical` | `boolean` | Map `T/F/Y/N/1/0` → `True/False` |

 Log any field exceeding 254 characters to a compliance manifest before truncation. Reject implicit type promotion to prevent silent data loss.

## Pipeline Architecture & Configuration Tuning

Monolithic `ogr2ogr` invocations exhaust memory and stall on terabyte-scale archives. Implement a chunked, parallelized pipeline with strict resource boundaries.

**GDAL Environment Configuration:**
```bash
export GDAL_NUM_THREADS=ALL_CPUS
export OGR_MAX_BUFFER_SIZE=512000000
export CPL_DEBUG=ON
export SHAPE_ENCODING=UTF-8
export GDAL_CACHEMAX=2048
```

**Partitioning Strategy:** GeoParquet performs optimally when partitioned by spatial index or administrative boundary. Generate H3 resolution 6 or S2 level 8 partition keys during ingestion. Write output to `s3://archive-bucket/year=YYYY/month=MM/h3_cell=XXXXXX.parquet`. Enable ZSTD compression (`compression=ZSTD`, `compression_level=3`) to balance archival footprint and decompression latency for cold-storage retrieval; the trade-off between ratio and CPU is covered in depth under [ZSTD Level Configuration for Spatial Files](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/zstd-level-configuration-for-spatial-files/). Choosing a target storage class up front matters because aggressive [Hot/Warm/Cold Tier Design for Geospatial Data](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/hotwarmcold-tier-design-for-geospatial-data/) imposes minimum-object-size and early-deletion constraints that should shape your H3 resolution and row-group sizing.

<svg viewBox="0 0 1000 272" role="img" aria-label="Hive-style partition tree. The bucket s3://archive-bucket branches by year, for example year=2024 and year=2025. year=2024 branches by month into month=01 through month=12. month=01 branches into per-cell leaves named h3_cell=8a2a1072b59ffff.parquet and h3_cell=8a2a1072b5b7fff.parquet, one GeoParquet file per H3 cell. Every leaf is a ZSTD-compressed, row-group-bounded GeoParquet file." xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;color:var(--primary);font-family:var(--font-sans)">
  <title>Hive-style GeoParquet partition tree</title>
  <desc>s3://archive-bucket branches into year=YYYY, then month=MM, then one h3_cell=XXXXXX.parquet leaf per spatial cell. Each leaf is a ZSTD-compressed, row-group-bounded GeoParquet file.</desc>
  <defs>
    <marker id="part-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <!-- connectors -->
  <g stroke="currentColor" stroke-width="1.8" fill="none">
    <path d="M190 177 L250 119" stroke-opacity="0.6" marker-end="url(#part-arrow)"/>
    <path d="M190 177 L250 233" stroke-opacity="0.4" marker-end="url(#part-arrow)"/>
    <path d="M398 119 L452 66" stroke-opacity="0.55" marker-end="url(#part-arrow)"/>
    <path d="M398 119 L452 172" stroke-opacity="0.4" marker-end="url(#part-arrow)"/>
    <path d="M592 66 L648 38" stroke-opacity="0.55" marker-end="url(#part-arrow)"/>
    <path d="M592 66 L648 112" stroke-opacity="0.55" marker-end="url(#part-arrow)"/>
    <path d="M592 172 L648 192" stroke-opacity="0.4" marker-end="url(#part-arrow)"/>
  </g>
  <!-- bucket -->
  <rect x="14" y="150" width="176" height="54" rx="10" fill="currentColor" fill-opacity="0.08" stroke="currentColor" stroke-opacity="0.6"/>
  <text x="102" y="182" text-anchor="middle" font-size="12.5" font-weight="700" fill="currentColor">s3://archive-bucket/</text>
  <!-- year level -->
  <g text-anchor="middle">
    <rect x="250" y="96" width="148" height="46" rx="9" fill="currentColor" fill-opacity="0.06" stroke="currentColor" stroke-opacity="0.5"/>
    <text x="324" y="124" font-size="13" font-weight="600" fill="currentColor">year=2024</text>
    <rect x="250" y="210" width="148" height="46" rx="9" fill="currentColor" fill-opacity="0.04" stroke="currentColor" stroke-opacity="0.35"/>
    <text x="324" y="238" font-size="13" font-weight="600" fill="currentColor" fill-opacity="0.75">year=2025</text>
  </g>
  <!-- month level -->
  <g text-anchor="middle">
    <rect x="452" y="44" width="140" height="44" rx="9" fill="currentColor" fill-opacity="0.06" stroke="currentColor" stroke-opacity="0.5"/>
    <text x="522" y="71" font-size="13" font-weight="600" fill="currentColor">month=01</text>
    <rect x="452" y="150" width="140" height="44" rx="9" fill="currentColor" fill-opacity="0.04" stroke="currentColor" stroke-opacity="0.35"/>
    <text x="522" y="177" font-size="13" font-weight="600" fill="currentColor" fill-opacity="0.75">month=12</text>
  </g>
  <!-- leaf level -->
  <g text-anchor="middle">
    <rect x="648" y="14" width="336" height="50" rx="9" fill="currentColor" fill-opacity="0.1" stroke="currentColor" stroke-opacity="0.55"/>
    <text x="816" y="36" font-size="12.5" font-weight="600" fill="currentColor">h3_cell=8a2a1072b59ffff.parquet</text>
    <text x="816" y="53" font-size="10.5" fill="currentColor" fill-opacity="0.75">ZSTD · row-group-bounded GeoParquet</text>
    <rect x="648" y="88" width="336" height="50" rx="9" fill="currentColor" fill-opacity="0.1" stroke="currentColor" stroke-opacity="0.55"/>
    <text x="816" y="110" font-size="12.5" font-weight="600" fill="currentColor">h3_cell=8a2a1072b5b7fff.parquet</text>
    <text x="816" y="127" font-size="10.5" fill="currentColor" fill-opacity="0.75">ZSTD · row-group-bounded GeoParquet</text>
    <rect x="648" y="166" width="336" height="50" rx="9" fill="currentColor" fill-opacity="0.04" stroke="currentColor" stroke-opacity="0.35"/>
    <text x="816" y="188" font-size="12.5" font-weight="600" fill="currentColor" fill-opacity="0.75">h3_cell=…</text>
    <text x="816" y="205" font-size="10.5" fill="currentColor" fill-opacity="0.7">one .parquet file per H3 cell</text>
  </g>
</svg>

The resolved EPSG code, geometry encoding, and partition scheme are the three invariants every downstream consumer depends on; treat any change to them as a schema break.

**Parallel Orchestration:** Distribute conversion at the file granularity, not the feature granularity — one shapefile per worker keeps GDAL's `.shx`/`.dbf` file handles local to each task and avoids cross-worker contention on shared indexes. Cap per-worker concurrency to `nproc / 2` so the ZSTD encoder and the GDAL block cache do not compete for the same cores. Emit each worker's output under a worker-scoped staging prefix (`s3://archive-bucket/_staging/worker=NN/`) and run an atomic rename into the canonical `year=/month=/h3_cell=` tree only after that worker's validation gate passes. This staging-then-promote pattern keeps a partially converted archive invisible to query engines, so a mid-batch crash never exposes torn partitions to readers.

## Exact Conversion Workflow

Execute the conversion using a streaming architecture to maintain a constant memory footprint. The following Python implementation uses `pyogrio` for fast vector I/O and `pyarrow` for columnar serialization.

```python
import os
import json
import pandas as pd
import pyogrio
import pyproj
import pyarrow as pa
import pyarrow.parquet as pq
import h3


def convert_shapefile_to_geoparquet(
    src_path: str,
    dst_dir: str,
    chunk_size: int = 500_000,
    h3_res: int = 6,
):
    # 1. Schema & CRS extraction
    info = pyogrio.read_info(src_path)
    crs_epsg = (
        pyproj.CRS.from_user_input(info["crs"]).to_epsg() if info.get("crs") else 4326
    )

    # 2. read_dataframe returns one frame; slice it into fixed-size chunks so
    #    per-chunk memory stays bounded (it has no chunk_size/streaming mode).
    gdf = pyogrio.read_dataframe(src_path)
    for chunk_idx, start in enumerate(range(0, len(gdf), chunk_size)):
        chunk = gdf.iloc[start : start + chunk_size].copy()

        # 3. Spatial partition key: H3 needs lat/lng, so derive centroids in EPSG:4326.
        centroids = chunk.geometry.to_crs(4326).centroid
        chunk["h3_cell"] = [h3.latlng_to_cell(pt.y, pt.x, h3_res) for pt in centroids]
        geometry_types = sorted(chunk.geometry.geom_type.unique().tolist())

        # 4. Encode geometry as WKB (the GeoParquet "geo" encoding) before Arrow.
        chunk["geometry"] = chunk.geometry.to_wkb()
        frame = pd.DataFrame(chunk)

        # 5. Type enforcement (example: collapse low-cardinality text cols to boolean).
        for col in frame.select_dtypes(include=["object"]).columns:
            if col != "geometry" and frame[col].nunique() <= 2:
                frame[col] = frame[col].astype("boolean")

        geo_meta = {
            "version": "1.1.0",
            "primary_column": "geometry",
            "columns": {
                "geometry": {
                    "encoding": "WKB",
                    "geometry_types": geometry_types,
                    "crs": f"EPSG:{crs_epsg}",
                }
            },
        }
        geo_bytes = json.dumps(geo_meta).encode()

        # 6. Partitioned write: one file per distinct H3 cell in this chunk.
        for cell, part in frame.groupby("h3_cell"):
            table = pa.Table.from_pandas(part, preserve_index=False)
            table = table.replace_schema_metadata({b"geo": geo_bytes})
            partition_path = os.path.join(dst_dir, f"h3_cell={cell}")
            os.makedirs(partition_path, exist_ok=True)
            pq.write_table(
                table,
                os.path.join(partition_path, f"chunk_{chunk_idx:04d}.parquet"),
                compression="zstd",
                compression_level=3,
                row_group_size=100_000,
            )
```

**CLI Fallback for Non-Python Environments:**
```bash
ogr2ogr -f "Parquet" output.parquet input.shp \
  -lco COMPRESSION=ZSTD \
  -lco COMPRESSION_LEVEL=3 \
  -lco ROW_GROUP_SIZE=100000 \
  -lco GEOMETRY_ENCODING=WKB \
  -nln layer_name \
  -progress
```
Validate driver capabilities against the official [GDAL Parquet Driver Documentation](https://gdal.org/drivers/vector/parquet.html) before deploying CLI pipelines.

## Post-Conversion Validation & Integrity Gates

Never assume successful write equals data fidelity. Execute automated validation gates immediately after ingestion.

1. **Schema & Metadata Verification:**
```bash
parquet-tools meta output.parquet | grep -A2 'geo'
```
 Expected output (the `geo` key must be present and report WKB encoding plus the resolved CRS):
```text
extra:    geo = {"version":"1.1.0","primary_column":"geometry",
         "columns":{"geometry":{"encoding":"WKB","geometry_types":["Polygon"],"crs":"EPSG:4326"}}}
```
 Confirm the `geo` metadata key exists, contains `primary_column`, and matches the `WKB` encoding standard defined in the [GeoParquet Specification](https://geoparquet.org/). A missing `geo` key means the writer dropped spatial metadata — see [Schema Mapping & Attribute Validation](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/schema-mapping-attribute-validation/) for the field-level parity checks that catch this before publish.

2. **Spatial Integrity Check:**
```python
import json
import pyarrow.parquet as pq
import geopandas as gpd

expected_epsg = 4326  # set to your archival target CRS

table = pq.read_table("output.parquet")
geo = json.loads(table.schema.metadata[b"geo"])
stored_crs = geo["columns"][geo["primary_column"]]["crs"]

df = table.to_pandas()
gdf = gpd.GeoDataFrame(df, geometry=gpd.GeoSeries.from_wkb(df["geometry"], crs=stored_crs))
assert gdf.is_valid.all(), "Invalid geometries detected post-conversion"
assert gdf.crs.to_epsg() == expected_epsg, "CRS drift detected"
```

3. **Row Count & Checksum Audit:**
 Compare `featureCount` from the pre-flight manifest against the converted row count. Use DuckDB to count rows across the entire partitioned tree in one pass:
```bash
duckdb -c "SELECT count(*) FROM read_parquet('s3://archive-bucket/year=2024/**/*.parquet')"
```
 Expected output — the count must equal `featureCount` from `manifest.json` exactly:
```text
┌──────────────┐
│ count_star() │
│    int64     │
├──────────────┤
│   4821736    │
└──────────────┘
```
 Any deficit signals dropped geometries (filtered nulls) or a partition write that silently failed. Generate SHA-256 hashes for the raw `.shp` and the converted `.parquet` set, and log discrepancies to an immutable compliance ledger governed by your [Retention Policy Frameworks](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/retention-policy-frameworks/).

## Root-Cause Analysis for Conversion Failures

| Symptom | Root Cause | Resolution |
|---------|------------|------------|
| `ArrowInvalid: Cannot convert string to large_string` | DBF field contains null bytes or mixed encodings | Strip `\x00` via `df.replace(r'\x00', '', regex=True)` before casting |
| `CRS mismatch during spatial join` | `.prj` missing or contains deprecated PROJ strings | Force `gdalsrsinfo -o WKT2` and inject EPSG explicitly into `geo` metadata |
| `MemoryError: Unable to allocate X GB` | Chunk size exceeds available RAM or unbounded geometry complexity | Reduce `chunk_size` to `100_000`, enable `GDAL_CACHEMAX`, and explode multi-part geometries pre-write |
| `Invalid WKB: Unexpected end of buffer` | Corrupted `.shp` vertex arrays or zero-length geometries | Filter `df[df.geometry.notna() & df.geometry.is_valid]` before serialization |
| `Attribute truncation warnings` | Legacy DBF 254-character hard limit | Split oversized text fields into a normalized lookup table or use `large_string` with explicit truncation logging |

Deploy these validation gates and configuration boundaries to guarantee deterministic, auditable, and cold-storage-optimized spatial archives.

## Operational Execution Checklist

- [ ] Run the `ogrinfo -ro -json` pre-flight gate and reject any dataset with `featureCount = -1` or a corrupted `.shx` index.
- [ ] Resolve and pin an explicit EPSG code from the `.prj`; never allow implicit CRS inference.
- [ ] Map every DBF field to an explicit Arrow primitive and log 254-character truncations to a compliance manifest.
- [ ] Export the GDAL environment tuning block (`GDAL_NUM_THREADS`, `GDAL_CACHEMAX`, `SHAPE_ENCODING`) before launching workers.
- [ ] Generate H3/S2 partition keys and write to the `year=/month=/h3_cell=` Hive-style layout with ZSTD level 3.
- [ ] Confirm the `geo` metadata block (version, `primary_column`, WKB encoding, CRS) on a sample partition.
- [ ] Reconcile converted row count against the pre-flight `featureCount` and store SHA-256 hashes in the compliance ledger.

## Related

- Up: [GeoParquet Migration Workflows](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/geoparquet-migration-workflows/) — the parent reference for pipeline-wide partitioning and metadata heuristics.
- [Handling Attribute Loss During Spatial Format Conversion](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/schema-mapping-attribute-validation/handling-attribute-loss-during-spatial-format-conversion/) — companion procedure for preserving DBF fields the converter would otherwise drop.
- [Automating CRS Transformations in ETL Pipelines](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/crs-synchronization-in-pipelines/automating-crs-transformations-in-etl-pipelines/) — deterministic projection enforcement for the CRS step above.
- [Tuning ZSTD Compression for GeoParquet Archives](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/zstd-level-configuration-for-spatial-files/tuning-zstd-compression-for-geoparquet-archives/) — companion compression guidance on picking the level that balances ratio against cold-storage decompression latency.
