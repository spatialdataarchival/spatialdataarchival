# Tuning ZSTD Compression for GeoParquet Archives

Default ZSTD settings applied to GeoParquet archives routinely produce suboptimal cold-storage ratios and elevated decompression latency, because generic columnar defaults assume one statistical profile while a GeoParquet file actually carries three very different ones: high-redundancy coordinate arrays, near-static CRS metadata, and high-cardinality GIS attributes. A blanket `zstd(level=3)` across all of them under-compresses geometry and wastes a dictionary page on float columns that can never benefit from it. This walkthrough is for the data engineer, GIS archivist, or cloud architect who has already settled an overall [ZSTD Level Configuration for Spatial Files](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/zstd-level-configuration-for-spatial-files/) policy and now needs the exact column-level GeoParquet writer configuration, the validation thresholds that prove it worked, and the troubleshooting paths for the failures unique to spatial data.

## Tuning Workflow

GeoParquet ZSTD tuning proceeds from a baseline measurement to a benchmarked write:

<svg viewBox="0 0 1080 150" role="img" aria-label="Left-to-right GeoParquet ZSTD tuning pipeline of five steps: baseline the per-column profile, align row groups to spatial extents, set compression_level to 9, disable dictionary encoding on geometry and CRS columns, then benchmark the compression ratio and decompression latency." xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;color:var(--primary);font-family:var(--font-sans)">
  <title>GeoParquet ZSTD tuning workflow</title>
  <desc>Five sequential stages connected by arrows. Step 1 baselines the existing per-column profile. Step 2 aligns row groups to spatial extents. Step 3 sets compression_level to 9. Step 4 disables dictionary encoding on geometry and CRS columns. Step 5 benchmarks the resulting compression ratio and decompression latency.</desc>
  <defs>
    <marker id="zt-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <g text-anchor="middle">
    <circle cx="108" cy="32" r="12" fill="currentColor" fill-opacity="0.1" stroke="currentColor" stroke-opacity="0.35"/>
    <text x="108" y="36" font-size="12" font-weight="700" fill="currentColor">1</text>
    <circle cx="324" cy="32" r="12" fill="currentColor" fill-opacity="0.1" stroke="currentColor" stroke-opacity="0.35"/>
    <text x="324" y="36" font-size="12" font-weight="700" fill="currentColor">2</text>
    <circle cx="540" cy="32" r="12" fill="currentColor" fill-opacity="0.1" stroke="currentColor" stroke-opacity="0.35"/>
    <text x="540" y="36" font-size="12" font-weight="700" fill="currentColor">3</text>
    <circle cx="756" cy="32" r="12" fill="currentColor" fill-opacity="0.1" stroke="currentColor" stroke-opacity="0.35"/>
    <text x="756" y="36" font-size="12" font-weight="700" fill="currentColor">4</text>
    <circle cx="972" cy="32" r="12" fill="currentColor" fill-opacity="0.1" stroke="currentColor" stroke-opacity="0.35"/>
    <text x="972" y="36" font-size="12" font-weight="700" fill="currentColor">5</text>
    <rect x="12" y="56" width="192" height="74" rx="10" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-opacity="0.4"/>
    <text x="108" y="89" font-size="14" font-weight="600" fill="currentColor">Baseline</text>
    <text x="108" y="109" font-size="13" fill="currentColor" fill-opacity="0.85">per-column profile</text>
    <rect x="228" y="56" width="192" height="74" rx="10" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-opacity="0.4"/>
    <text x="324" y="89" font-size="14" font-weight="600" fill="currentColor">Align row groups</text>
    <text x="324" y="109" font-size="13" fill="currentColor" fill-opacity="0.85">to spatial extents</text>
    <rect x="444" y="56" width="192" height="74" rx="10" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-opacity="0.4"/>
    <text x="540" y="89" font-size="14" font-weight="600" fill="currentColor">Set</text>
    <text x="540" y="110" font-size="13" font-family="var(--font-mono)" fill="currentColor" fill-opacity="0.9">compression_level=9</text>
    <rect x="660" y="56" width="192" height="74" rx="10" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-opacity="0.4"/>
    <text x="756" y="89" font-size="14" font-weight="600" fill="currentColor">Disable dict on</text>
    <text x="756" y="109" font-size="13" fill="currentColor" fill-opacity="0.85">geometry &amp; CRS</text>
    <rect x="876" y="56" width="192" height="74" rx="10" fill="currentColor" fill-opacity="0.12" stroke="currentColor" stroke-opacity="0.6"/>
    <text x="972" y="89" font-size="14" font-weight="600" fill="currentColor">Benchmark</text>
    <text x="972" y="109" font-size="13" fill="currentColor" fill-opacity="0.85">ratio + latency</text>
  </g>
  <g stroke="currentColor" stroke-width="2" stroke-opacity="0.55" fill="none">
    <path d="M204 93 H228" marker-end="url(#zt-arrow)"/>
    <path d="M420 93 H444" marker-end="url(#zt-arrow)"/>
    <path d="M636 93 H660" marker-end="url(#zt-arrow)"/>
    <path d="M852 93 H876" marker-end="url(#zt-arrow)"/>
  </g>
</svg>

## Before You Start

This procedure tunes a file that is *already* GeoParquet. If geometry is still in Shapefile or GeoPackage, run the [GeoParquet Migration Workflows](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/geoparquet-migration-workflows/) pipeline first so geometry encoding and CRS metadata land in proper column chunks — compressing an un-migrated layout just locks in a bad structure at a smaller size. You should also have a row-group target from [Calculating Optimal Row Group Size for Spatial Queries](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/row-group-sizing-strategies/calculating-optimal-row-group-size-for-spatial-queries/), because ZSTD match-finding runs across the whole group and the group size changes the ratio a given level delivers.

Target the following operational thresholds for the cold tier, and treat them as the pass/fail gate for the steps below:

- Compression ratio ≥ 3.5:1 for geometry columns
- Decompression latency ≤ 120 ms per 100 MB row group on a standard cloud VM (e.g. `c6i.large` / `t3.medium`)
- Storage footprint reduction ≥ 28% versus the default `zstd(level=3)`

## Step-by-Step Procedure

### Step 1 — Baseline the existing archive

Before changing any parameter, capture per-column compressed/uncompressed sizes so the after-tuning numbers have something to beat. Isolating geometry columns from attribute columns here is what later lets you assign parameters per column type rather than uniformly.

```python
import pyarrow.parquet as pq
import pandas as pd

meta = pq.read_metadata("archives/cadastral/2024/parcels_input.parquet")
stats = []
for i in range(meta.num_row_groups):
    rg = meta.row_group(i)
    for j in range(rg.num_columns):
        col = rg.column(j)
        stats.append({
            "row_group": i,
            "column": col.path_in_schema,
            "total_compressed": col.total_compressed_size,
            "total_uncompressed": col.total_uncompressed_size,
            "ratio": col.total_uncompressed_size / max(col.total_compressed_size, 1),
        })
baseline_df = pd.DataFrame(stats)
print(baseline_df.groupby("column")["ratio"].mean())
```

### Step 2 — Align row group boundaries with spatial extents

ZSTD dictionary effectiveness degrades when a row group splits spatially contiguous geometries, because match-finding can no longer exploit the locality between neighbouring features. Derive the target row count from the row-group sizing formula, then cap it so groups never straddle a spatial partition.

<svg viewBox="0 0 1080 470" role="img" aria-label="Two stacked Parquet files compared against the same four spatial partition tiles. In the top file the row-group boundaries fall mid-tile, so each row group straddles two tiles and a cold read triggers a dictionary cache miss. In the bottom file every row-group boundary lines up with a tile boundary, so each row group maps to exactly one tile and cold reads stay clean." xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;color:var(--primary);font-family:var(--font-sans)">
  <title>Row-group boundaries aligned versus misaligned with spatial partition tiles</title>
  <desc>Top panel, misaligned: four row groups whose edges fall at 195, 455 and 715 cross the tile boundaries at 280, 540 and 800, so three split points are flagged and a cold read misses the cache. Bottom panel, aligned: the four row-group edges sit exactly on the tile boundaries, so each row group covers one whole tile and the read is marked OK.</desc>
  <defs>
    <marker id="rg-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <!-- ===== TOP: misaligned ===== -->
  <text x="20" y="34" font-size="15" font-weight="700" fill="currentColor">Misaligned — a row group straddles two tiles</text>
  <!-- tile boundary guides -->
  <g stroke="currentColor" stroke-opacity="0.45" stroke-width="1.5" stroke-dasharray="4 4">
    <line x1="280" y1="56" x2="280" y2="196"/>
    <line x1="540" y1="56" x2="540" y2="196"/>
    <line x1="800" y1="56" x2="800" y2="196"/>
  </g>
  <!-- row-group band (edges at 195,455,715) -->
  <g font-size="13" font-weight="600" text-anchor="middle">
    <rect x="20" y="58" width="175" height="40" rx="6" fill="currentColor" fill-opacity="0.07" stroke="currentColor" stroke-opacity="0.45"/>
    <text x="107" y="83" fill="currentColor">RG&#8201;1</text>
    <rect x="195" y="58" width="260" height="40" rx="6" fill="currentColor" fill-opacity="0.07" stroke="currentColor" stroke-opacity="0.45"/>
    <text x="325" y="83" fill="currentColor">RG&#8201;2</text>
    <rect x="455" y="58" width="260" height="40" rx="6" fill="currentColor" fill-opacity="0.07" stroke="currentColor" stroke-opacity="0.45"/>
    <text x="585" y="83" fill="currentColor">RG&#8201;3</text>
    <rect x="715" y="58" width="345" height="40" rx="6" fill="currentColor" fill-opacity="0.07" stroke="currentColor" stroke-opacity="0.45"/>
    <text x="887" y="83" fill="currentColor">RG&#8201;4</text>
  </g>
  <!-- split markers where RG edges cross tiles -->
  <g text-anchor="middle">
    <circle cx="280" cy="78" r="10" fill="currentColor" fill-opacity="0.16" stroke="currentColor" stroke-opacity="0.6"/>
    <text x="280" y="82" font-size="12" font-weight="700" fill="currentColor">&#33;</text>
    <circle cx="540" cy="78" r="10" fill="currentColor" fill-opacity="0.16" stroke="currentColor" stroke-opacity="0.6"/>
    <text x="540" y="82" font-size="12" font-weight="700" fill="currentColor">&#33;</text>
    <circle cx="800" cy="78" r="10" fill="currentColor" fill-opacity="0.16" stroke="currentColor" stroke-opacity="0.6"/>
    <text x="800" y="82" font-size="12" font-weight="700" fill="currentColor">&#33;</text>
  </g>
  <!-- tiles band -->
  <g font-size="12.5" text-anchor="middle">
    <rect x="20" y="120" width="260" height="56" rx="6" fill="currentColor" fill-opacity="0.04" stroke="currentColor" stroke-opacity="0.3"/>
    <text x="150" y="153" fill="currentColor" fill-opacity="0.85">Tile A</text>
    <rect x="280" y="120" width="260" height="56" rx="6" fill="currentColor" fill-opacity="0.04" stroke="currentColor" stroke-opacity="0.3"/>
    <text x="410" y="153" fill="currentColor" fill-opacity="0.85">Tile B</text>
    <rect x="540" y="120" width="260" height="56" rx="6" fill="currentColor" fill-opacity="0.04" stroke="currentColor" stroke-opacity="0.3"/>
    <text x="670" y="153" fill="currentColor" fill-opacity="0.85">Tile C</text>
    <rect x="800" y="120" width="260" height="56" rx="6" fill="currentColor" fill-opacity="0.04" stroke="currentColor" stroke-opacity="0.3"/>
    <text x="930" y="153" fill="currentColor" fill-opacity="0.85">Tile D</text>
  </g>
  <text x="20" y="212" font-size="13" font-weight="600" fill="currentColor">3 split points &#8594; dictionary cache miss on cold read</text>
  <!-- ===== BOTTOM: aligned ===== -->
  <text x="20" y="288" font-size="15" font-weight="700" fill="currentColor">Aligned — each row group maps to one tile</text>
  <g stroke="currentColor" stroke-opacity="0.45" stroke-width="1.5" stroke-dasharray="4 4">
    <line x1="280" y1="310" x2="280" y2="450"/>
    <line x1="540" y1="310" x2="540" y2="450"/>
    <line x1="800" y1="310" x2="800" y2="450"/>
  </g>
  <!-- row-group band (edges at tile boundaries) -->
  <g font-size="13" font-weight="600" text-anchor="middle">
    <rect x="20" y="312" width="260" height="40" rx="6" fill="currentColor" fill-opacity="0.1" stroke="currentColor" stroke-opacity="0.55"/>
    <text x="150" y="337" fill="currentColor">RG&#8201;1</text>
    <rect x="280" y="312" width="260" height="40" rx="6" fill="currentColor" fill-opacity="0.1" stroke="currentColor" stroke-opacity="0.55"/>
    <text x="410" y="337" fill="currentColor">RG&#8201;2</text>
    <rect x="540" y="312" width="260" height="40" rx="6" fill="currentColor" fill-opacity="0.1" stroke="currentColor" stroke-opacity="0.55"/>
    <text x="670" y="337" fill="currentColor">RG&#8201;3</text>
    <rect x="800" y="312" width="260" height="40" rx="6" fill="currentColor" fill-opacity="0.1" stroke="currentColor" stroke-opacity="0.55"/>
    <text x="930" y="337" fill="currentColor">RG&#8201;4</text>
  </g>
  <!-- tiles band -->
  <g font-size="12.5" text-anchor="middle">
    <rect x="20" y="374" width="260" height="56" rx="6" fill="currentColor" fill-opacity="0.04" stroke="currentColor" stroke-opacity="0.3"/>
    <text x="150" y="407" fill="currentColor" fill-opacity="0.85">Tile A</text>
    <rect x="280" y="374" width="260" height="56" rx="6" fill="currentColor" fill-opacity="0.04" stroke="currentColor" stroke-opacity="0.3"/>
    <text x="410" y="407" fill="currentColor" fill-opacity="0.85">Tile B</text>
    <rect x="540" y="374" width="260" height="56" rx="6" fill="currentColor" fill-opacity="0.04" stroke="currentColor" stroke-opacity="0.3"/>
    <text x="670" y="407" fill="currentColor" fill-opacity="0.85">Tile C</text>
    <rect x="800" y="374" width="260" height="56" rx="6" fill="currentColor" fill-opacity="0.04" stroke="currentColor" stroke-opacity="0.3"/>
    <text x="930" y="407" fill="currentColor" fill-opacity="0.85">Tile D</text>
  </g>
  <text x="20" y="466" font-size="13" font-weight="600" fill="currentColor">Boundaries match &#8594; one decompression context per tile, OK</text>
</svg>

```python
import pyarrow.parquet as pq

# Disable dictionary encoding for geometry/CRS float columns; keep it elsewhere.
dict_map = {
    col: ("geometry" not in col and "crs" not in col)
    for col in table.column_names
}

pq.write_table(
    table,
    "archives/cadastral/2024/parcels_tuned.parquet",
    row_group_size=1_000_000,   # rows per group, tuned toward a ~256 MB target
    compression="zstd",
    compression_level=9,        # 1-22; applied to every zstd column
    use_dictionary=dict_map,
    write_statistics=True,      # per-column min/max enables predicate pushdown
)
```

Misaligned groups trigger dictionary cache misses during cold retrieval, so confirm the alignment with a metadata scan (`pq.read_metadata(...).row_group(i)`) before promoting the file.

### Step 3 — Configure ZSTD parameters for geometry columns

Coordinate arrays show high sequential redundancy but low cross-column correlation, so the single lever that matters in PyArrow is `compression_level`. Level 9 is the practical sweet spot for cold archival: levels above 11 yield less than 2% additional ratio for a 40%+ write-CPU penalty, while dictionary encoding on float geometry only inflates dictionary pages without ever finding repeats. (For the categorical attribute columns that *do* benefit, follow the cardinality thresholds in [When to Use Dictionary Encoding for Categorical GIS Fields](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/dictionary-encoding-for-gis-attributes/when-to-use-dictionary-encoding-for-categorical-gis-fields/).)

PyArrow does **not** expose ZSTD's advanced frame parameters (window log, chain log, hash log, minimum match). If a workload genuinely needs them, compress the raw column buffers with the `zstd` CLI outside the Parquet writer, where they are configurable:

```bash
# Advanced ZSTD frame tuning lives in the zstd CLI, not PyArrow.
zstd --ultra -22 --long=27 -c archives/cadastral/2024/coords.bin \
  > archives/cadastral/2024/coords.bin.zst
```

## Validation & Verification

Do not trust the job config — confirm the artifact. First check that the codec and level actually landed on every column chunk:

```bash
parquet-tools inspect archives/cadastral/2024/parcels_tuned.parquet \
  | grep -iE "path|compression"
```

Expected output (geometry and attribute chunks both report the pinned codec):

```
path: geometry        compression: ZSTD
path: parcel_id       compression: ZSTD
path: land_use_code   compression: ZSTD
```

Then verify the geometry ratio and cold-read latency against the thresholds from the start of this page. Do not rely on file size alone — measure actual decompression throughput:

```python
import pyarrow.parquet as pq
import time

pf = pq.ParquetFile("archives/cadastral/2024/parcels_tuned.parquet")
meta = pf.metadata

# 1. Geometry compression ratio gate
for i in range(meta.num_row_groups):
    rg = meta.row_group(i)
    for col_idx in range(rg.num_columns):
        col = rg.column(col_idx)
        if "geometry" in col.path_in_schema:
            ratio = col.total_uncompressed_size / col.total_compressed_size
            assert ratio >= 3.5, f"RG {i} geometry ratio {ratio:.2f} < 3.5:1"

# 2. Decompression latency gate (per row group)
for i in range(meta.num_row_groups):
    start = time.perf_counter()
    pf.read_row_group(i)  # force full decompression into memory
    elapsed_ms = (time.perf_counter() - start) * 1000
    rg_mb = sum(c.total_compressed_size for c in meta.row_group(i).columns) / (1024**2)
    print(f"RG {i} ({rg_mb:.1f} MB) decompressed in {elapsed_ms:.1f} ms")
    assert elapsed_ms <= 120, f"latency {elapsed_ms:.1f} ms exceeds 120 ms threshold"
print("validation OK")
```

A clean run prints one timing line per row group and ends with `validation OK`; any `AssertionError` points directly at the symptom you tune against below.

## Troubleshooting

| Symptom | Root cause | Fix |
|---------|------------|-----|
| Geometry ratio < 2.8:1 | `compression_level` too low, or a row group splits contiguous spatial features | Raise `compression_level` toward 11 and recompute the row count so groups don't straddle spatial partitions |
| Decompression latency > 180 ms | Oversized row groups force whole-group decode for a small predicate result | Reduce `row_group_size`; align groups to typical query extents |
| OOM during read | Dictionary encoding forced on high-cardinality float columns | Set `use_dictionary=False` for geometry/CRS columns; confirm encodings with `parquet-tools` |
| Inconsistent ratios across partitions | Mixed CRS or varying coordinate precision within one column | Normalise CRS to EPSG:4326 or EPSG:3857 pre-write and round coordinates to 6 decimals; see CRS synchronization below |
| Codec reports `UNCOMPRESSED` / `SNAPPY` | Engine default overrode the writer option (level passed but `compression` omitted) | Set both `compression="zstd"` and `compression_level` on the write call, then re-inspect |

Uneven ratios across partitions almost always trace back to CRS drift; lock a single projection upstream with [Automating CRS Transformations in ETL Pipelines for Spatial Data Archival](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/crs-synchronization-in-pipelines/automating-crs-transformations-in-etl-pipelines/) so every partition presents the same coordinate distribution to ZSTD. For compliance, store the chosen `dict_map` and `compression_level` alongside each dataset manifest, and confirm that object-storage lifecycle policies do not re-encode files on read — that silently invalidates the tuned ZSTD contexts you just verified.

## Operational Execution Checklist

- [ ] Confirm the input is GeoParquet, not Shapefile/GeoPackage, before tuning
- [ ] Capture a per-column baseline ratio table from the input file
- [ ] Cap `row_group_size` so no group straddles a spatial partition
- [ ] Set `use_dictionary=False` for geometry and CRS float columns; keep it on for categorical attributes
- [ ] Pin both `compression="zstd"` and `compression_level=9` on the write call itself
- [ ] Inspect the written file to confirm the codec landed on every column chunk
- [ ] Assert geometry ratio ≥ 3.5:1 and per-100 MB decompression ≤ 120 ms
- [ ] Normalise CRS and coordinate precision when ratios vary across partitions
- [ ] Record `dict_map` and `compression_level` in the dataset manifest for audit

## Related

- [ZSTD Level Configuration for Spatial Files](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/zstd-level-configuration-for-spatial-files/) — the parent topic that sets per-tier level policy this column-level walkthrough refines.
- [Calculating Optimal Row Group Size for Spatial Queries](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/row-group-sizing-strategies/calculating-optimal-row-group-size-for-spatial-queries/) — the sibling procedure that produces the row-group target Step 2 caps.
- [GeoParquet Migration Workflows](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/geoparquet-migration-workflows/) — convert legacy formats to GeoParquet before any compression tuning begins.

Validate parameter limits against the [Zstandard compression manual](https://facebook.github.io/zstd/zstd_manual.html) and GeoParquet column conformance against the [OGC GeoParquet specification](https://geoparquet.org/).

Up one level: [ZSTD Level Configuration for Spatial Files](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/zstd-level-configuration-for-spatial-files/).
