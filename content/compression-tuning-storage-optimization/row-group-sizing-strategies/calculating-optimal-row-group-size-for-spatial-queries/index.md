# Calculating Optimal Row Group Size for Spatial Queries

Data engineers, GIS archivists, and cloud architects who tier large vector archives to object storage hit the same wall: spatial predicate queries (`ST_Intersects`, `ST_DWithin`, `ST_Contains`) scan far more blocks than the filter geometry should touch, and cold-storage egress bills climb accordingly. The cause is that default columnar row-group sizing targets uniform tabular analytics — it assumes near-constant per-row byte width and no spatial locality. Serialized geometry violates both assumptions: WKB payloads vary by orders of magnitude between a survey point and a coastline multipolygon, and unsorted rows scatter neighbouring features across every block. This page gives a deterministic, execution-ready procedure for calculating row-group boundaries that preserve predicate pushdown, bound min/max envelope overlap, and keep ranged-GET retrieval costs low.

## Sizing Workflow

The routine moves from profiling to a validated, spatially clustered write:

<svg viewBox="0 0 980 132" role="img" aria-label="Five-stage row-group sizing pipeline: profile geometry size distribution, compute R_opt from the formula, cap at one million rows, Hilbert-cluster the rows, then write the file and validate its statistics." xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;color:var(--primary);font-family:var(--font-sans)">
  <title>Row-group sizing pipeline</title>
  <desc>A left-to-right flow of five stages: profile geometry size distribution, compute R_opt, cap at 1,000,000 rows, Hilbert-cluster rows, and write plus validate statistics. The final write-and-validate stage is highlighted as the gated output.</desc>
  <defs>
    <marker id="rgflow-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <g text-anchor="middle">
    <g>
      <rect x="8" y="34" width="168" height="64" rx="11" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-opacity="0.4"/>
      <text x="92" y="60" font-size="13.5" font-weight="700" fill="currentColor">Profile geometry</text>
      <text x="92" y="79" font-size="11.5" fill="currentColor" fill-opacity="0.75">size distribution</text>
    </g>
    <g>
      <rect x="202" y="34" width="168" height="64" rx="11" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-opacity="0.4"/>
      <text x="286" y="60" font-size="13.5" font-weight="700" fill="currentColor">Compute R_opt</text>
      <text x="286" y="79" font-size="11.5" fill="currentColor" fill-opacity="0.75">from the formula</text>
    </g>
    <g>
      <rect x="396" y="34" width="168" height="64" rx="11" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-opacity="0.4"/>
      <text x="480" y="60" font-size="13.5" font-weight="700" fill="currentColor">Cap at</text>
      <text x="480" y="79" font-size="11.5" fill="currentColor" fill-opacity="0.75">1,000,000 rows</text>
    </g>
    <g>
      <rect x="590" y="34" width="168" height="64" rx="11" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-opacity="0.4"/>
      <text x="674" y="60" font-size="13.5" font-weight="700" fill="currentColor">Hilbert-cluster</text>
      <text x="674" y="79" font-size="11.5" fill="currentColor" fill-opacity="0.75">rows</text>
    </g>
    <g>
      <rect x="784" y="34" width="188" height="64" rx="11" fill="currentColor" fill-opacity="0.14" stroke="currentColor" stroke-opacity="0.7" stroke-width="1.5"/>
      <text x="878" y="60" font-size="13.5" font-weight="700" fill="currentColor">Write + validate</text>
      <text x="878" y="79" font-size="11.5" fill="currentColor" fill-opacity="0.85">row-group stats</text>
    </g>
  </g>
  <g stroke="currentColor" stroke-width="2" fill="none" stroke-opacity="0.55">
    <path d="M176 66 H200" marker-end="url(#rgflow-arrow)"/>
    <path d="M370 66 H394" marker-end="url(#rgflow-arrow)"/>
    <path d="M564 66 H588" marker-end="url(#rgflow-arrow)"/>
    <path d="M758 66 H782" marker-end="url(#rgflow-arrow)"/>
  </g>
</svg>

This procedure assumes the source is already a columnar archive (Parquet/GeoParquet) and that a [Compression Tuning & Storage Optimization](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/) baseline — codec and compression level — is in place; row-group sizing is tuned *after* the codec is fixed, because the expected compression ratio feeds directly into the row-count formula below.

## Step 1: Profile Geometry Payload Distribution

Serialized spatial payloads exhibit high byte-size variance. Unchecked variance forces oversized row groups, triggering full-block decompression during spatial filtering and inflating cold-storage egress.

```python
import pyarrow.parquet as pq
import numpy as np

# Sample 10,000+ records from the target dataset
table = pq.read_table("datasets/cadastre/raw/parcels_2024.parquet",
                      columns=["geometry_wkb"])
wkb_bytes = table.column("geometry_wkb").to_pylist()
sizes = np.array([len(b) for b in wkb_bytes], dtype=np.float64)

p50, p90, p99 = np.percentile(sizes, [50, 90, 99])
g_avg = sizes.mean()
sigma_g = sizes.std()
variance_ratio = sigma_g / g_avg

print(f"G_avg: {g_avg:.0f}B | sigma_G: {sigma_g:.0f}B | ratio: {variance_ratio:.2f}")
```

**Validation gate:** if `variance_ratio > 0.6`, halt archival promotion. Isolate high-complexity polygons (p99 > 500 KB) into a separate tier or apply geometry simplification before grouping. High variance directly correlates with false-positive block scans during `ST_Intersects` evaluation, and it is also the dominant cause of poor ratios when [tuning ZSTD compression for GeoParquet archives](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/zstd-level-configuration-for-spatial-files/tuning-zstd-compression-for-geoparquet-archives/) — so resolving it here pays off twice.

## Step 2: Derive Target Row Count per Group

Optimal row-group size ($R_{opt}$) balances block-level I/O efficiency against spatial index granularity. Apply the deterministic formula:

$R_{opt} = \lfloor (T_{block} \times C_{ratio}) / (G_{avg} + A_{attr}) \rfloor$

Parameter definitions:

- $T_{block}$: target compressed block size. Use `128MB` for standard object storage, `256MB` for deep-archive tiers.
- $C_{ratio}$: expected compression ratio. Spatial WKB typically yields `1.8–3.2x` with ZSTD; pull the exact figure for your codec from your [ZSTD Level Configuration for Spatial Files](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/zstd-level-configuration-for-spatial-files/) baseline rather than guessing.
- $G_{avg}$: average serialized geometry byte size (from Step 1).
- $A_{attr}$: average serialized attribute payload per row (non-geometry columns).

```python
target_block_mb = 128
c_ratio = 2.5
a_attr = 45  # bytes, measured from the non-geometry columns

r_opt = int((target_block_mb * 1024 * 1024 * c_ratio) / (g_avg + a_attr))

# Hard cap to prevent spatial-join materialization OOM
R_FINAL = min(r_opt, 1_000_000)
print(f"Calculated R_opt: {r_opt} | Enforced cap: {R_FINAL}")
```

Exceeding 1,000,000 rows per group introduces memory pressure during spatial-join materialization and increases bounding-box overlap probability. Where a single dataset spans wildly different geographic densities, split it along the same boundaries you use for [spatial partitioning techniques](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/spatial-partitioning-techniques/) before applying the cap, so no group straddles two partitions.

<svg viewBox="0 0 980 472" role="img" aria-label="Side-by-side comparison of row-group bounding-box envelopes. Left: an unsorted Parquet file where four row-group envelopes all sprawl across the entire map extent and overlap heavily, so any spatial filter touches every block. Right: a Hilbert-sorted file where rows follow a space-filling curve and each of the four row groups occupies a tight, non-overlapping quadrant, letting the query engine skip the blocks a filter does not intersect." xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;color:var(--primary);font-family:var(--font-sans)">
  <title>Unsorted versus Hilbert-sorted row-group envelopes</title>
  <desc>Left panel: an unsorted file with four overlapping row-group envelopes spanning the full extent, so every block is scanned. Right panel: a Hilbert-sorted file whose space-filling curve packs each row group into a tight, non-overlapping quadrant, so the engine skips irrelevant blocks.</desc>
  <g text-anchor="middle">
    <text x="245" y="26" font-size="15" font-weight="700" fill="currentColor">Unsorted file</text>
    <text x="245" y="46" font-size="11.5" fill="currentColor" fill-opacity="0.75">envelopes overlap the whole extent</text>
    <text x="735" y="26" font-size="15" font-weight="700" fill="currentColor">Hilbert-sorted file</text>
    <text x="735" y="46" font-size="11.5" fill="currentColor" fill-opacity="0.75">tight, non-overlapping envelopes</text>
  </g>
  <line x1="490" y1="14" x2="490" y2="430" stroke="currentColor" stroke-opacity="0.18" stroke-width="1"/>
  <!-- LEFT: unsorted, overlapping envelopes -->
  <rect x="40" y="62" width="410" height="320" rx="6" fill="currentColor" fill-opacity="0.02" stroke="currentColor" stroke-opacity="0.25"/>
  <g fill="currentColor" fill-opacity="0.06" stroke="currentColor" stroke-opacity="0.55" stroke-width="1.5">
    <rect x="58" y="80" width="318" height="190" rx="5"/>
    <rect x="108" y="120" width="316" height="208" rx="5"/>
    <rect x="78" y="150" width="338" height="180" rx="5"/>
    <rect x="132" y="92" width="284" height="248" rx="5"/>
  </g>
  <g font-size="11" font-weight="700" fill="currentColor" fill-opacity="0.85">
    <text x="66" y="94">RG1</text>
    <text x="116" y="134">RG2</text>
    <text x="86" y="164">RG3</text>
    <text x="140" y="106">RG4</text>
  </g>
  <!-- RIGHT: Hilbert-sorted, tight quadrant envelopes -->
  <rect x="540" y="62" width="400" height="300" rx="6" fill="currentColor" fill-opacity="0.02" stroke="currentColor" stroke-opacity="0.25"/>
  <!-- four tiled, non-overlapping row-group envelopes -->
  <g fill="currentColor" fill-opacity="0.10" stroke="currentColor" stroke-opacity="0.6" stroke-width="1.5">
    <rect x="546" y="68" width="192" height="142" rx="5"/>
    <rect x="744" y="68" width="190" height="142" rx="5"/>
    <rect x="744" y="216" width="190" height="140" rx="5"/>
    <rect x="546" y="216" width="192" height="140" rx="5"/>
  </g>
  <g font-size="11" font-weight="700" fill="currentColor" fill-opacity="0.85">
    <text x="554" y="84">RG1</text>
    <text x="752" y="84">RG2</text>
    <text x="752" y="232">RG3</text>
    <text x="554" y="232">RG4</text>
  </g>
  <!-- Hilbert space-filling curve through 4x4 cell centres -->
  <polyline fill="none" stroke="currentColor" stroke-opacity="0.85" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"
    points="590,127 590,202 690,202 690,127 790,127 890,127 890,202 790,202 790,277 890,277 890,352 790,352 690,352 690,277 590,277 590,352"/>
  <text x="490" y="456" text-anchor="middle" font-size="12.5" fill="currentColor" fill-opacity="0.85">Overlapping envelopes force every block to be scanned; tight envelopes let the engine skip non-matching blocks.</text>
</svg>

## Step 3: Apply Spatial Clustering Prior to Grouping

Row groups must be spatially coherent. Unsorted data scatters geographic regions across blocks, defeating min/max statistics and forcing full-block decompression. DuckDB's `ST_Hilbert` function takes a geometry and a `BOX_2D` extent and returns a uint64 Hilbert-curve key, so the dataset extent must be computed first.

```sql
-- Step 1: compute the dataset extent
CREATE TEMPORARY TABLE dataset_extent AS
SELECT ST_Extent_Agg(geometry) AS ext FROM archive_source;

-- Step 2: sort rows along the Hilbert curve, then write
COPY (
  SELECT s.*
  FROM archive_source s, dataset_extent e
  ORDER BY ST_Hilbert(s.geometry, e.ext)
)
TO 'datasets/cadastre/cold/parcels_optimized.parquet'
(FORMAT PARQUET, ROW_GROUP_SIZE 500000, COMPRESSION ZSTD);
```

Sorting by a Hilbert curve aligns physical storage with spatial locality. Each row group's min/max bounding-box envelope then tightly encloses its contents, letting the query engine skip irrelevant blocks during `ST_DWithin` and `ST_Contains` evaluations. Without this step, spatial predicate pushdown degrades to sequential full-table scans regardless of how carefully $R_{opt}$ was chosen.

## Validation & Verification

Run these gates against the written file before promoting it to a cold tier. Expected output is annotated inline.

```python
import pyarrow.parquet as pq

meta = pq.read_metadata("datasets/cadastre/cold/parcels_optimized.parquet")

prev = None
overlaps = 0
for i in range(meta.num_row_groups):
    rg = meta.row_group(i)
    # column 0 here is the X ordinate of the bbox; adapt to your schema
    min_x = rg.column(0).statistics.min
    max_x = rg.column(0).statistics.max
    if prev is not None:
        p_min, p_max = prev
        # 1-D overlap fraction along X as a fast proxy for envelope overlap
        inter = max(0.0, min(max_x, p_max) - max(min_x, p_min))
        union = max(max_x, p_max) - min(min_x, p_min)
        if union > 0 and inter / union > 0.10:
            overlaps += 1
    prev = (min_x, max_x)

print(f"Row groups: {meta.num_row_groups}")
print(f"Overlap violations: {overlaps}")
assert overlaps < meta.num_row_groups * 0.10, "FAIL: spatial coherence threshold breached"
```

Expected output on a correctly Hilbert-sorted archive:

```text
Row groups: 84
Overlap violations: 3        # < 10% of 84 → PASS
```

If `Overlap violations` approaches the row-group count, the sort did not take effect (see Troubleshooting). Cross-check the three thresholds below directly from `parquet_metadata()`:

| Validation gate | Threshold | Check | Failure root cause |
|----------------|-----------|-------|--------------------|
| Bounding-box overlap | `< 10%` between adjacent envelopes | compare adjacent row-group min/max envelopes | insufficient clustering; Hilbert key collision or centroid skew |
| Block decompression ratio | `< 15%` of blocks scanned per query | `blocks_scanned` vs `blocks_returned` | oversized groups; variance > 0.6 bypassed |
| Attribute sparsity alignment | `NULL/empty < 5%` per group | per-column null stats from metadata | mixed geometry types in one group |

## Troubleshooting

| Symptom | Root cause | Fix |
|---------|------------|-----|
| `ST_Intersects` scans 100% of blocks despite a tight filter | row groups unsorted; envelopes span multiple regions | re-run the Hilbert sort and rewrite with `write_statistics=True` so min/max stats regenerate |
| Cold-storage retrieval cost spikes on monthly audits | groups exceed ~1.2M rows; reads spill to disk | enforce `R_FINAL = min(R_opt, 1_000_000)` and split by geographic partition first |
| Geometry-column compression drops below 1.2x | mixed topology types (points, lines, multipolygons) in one group | isolate geometry types and apply type-specific encoding per [dictionary encoding for GIS attributes](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/dictionary-encoding-for-gis-attributes/) |
| Query engine ignores spatial stats entirely | Parquet metadata not refreshed after the sort | rewrite with `write_statistics=True` (PyArrow) or re-`COPY` through DuckDB |

For cloud-native cold retrieval, align row-group boundaries with your object store's ranged-GET request sizing (typically 8–16 MB per request) to avoid partial-object retrieval penalties, and consult the [Apache Parquet file format specification](https://parquet.apache.org/docs/file-format/) for the exact metadata layout.

## Related

- Up to the parent topic: [Row Group Sizing Strategies](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/row-group-sizing-strategies/) frames how block sizing interacts with every columnar writer in a spatial archive.
- Sibling procedure: [Tuning ZSTD Compression for GeoParquet Archives](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/zstd-level-configuration-for-spatial-files/tuning-zstd-compression-for-geoparquet-archives/) sets the compression ratio that feeds this page's row-count formula.
- Sibling procedure: [When to Use Dictionary Encoding for Categorical GIS Fields](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/dictionary-encoding-for-gis-attributes/when-to-use-dictionary-encoding-for-categorical-gis-fields/) keeps attribute payload ($A_{attr}$) small without breaking group statistics.
- Cross-topic: [Hot/Warm/Cold Tier Design for Geospatial Data](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/hotwarmcold-tier-design-for-geospatial-data/) explains which tier these optimized files should land in and how retrieval pricing shapes the target block size.
