# Row Group Sizing Strategies for Spatial Data Archival

Row group boundaries in columnar storage are engineered thresholds, not framework defaults, and getting them wrong is the single most common reason a cold-archive query bill grows faster than the archive itself. For data engineers, GIS archivists, cloud architects, and compliance teams running spatial archival pipelines, the row group is the unit that dictates I/O patterns, compression efficiency, predicate pushdown, and cold-tier retrieval SLAs. This page sets the exact sizes, writer settings, and validation steps that keep coordinate-heavy geometry, attribute payloads, and regulatory retention mandates aligned with a deterministic physical layout.

## When Default Row Group Sizing Fails

Library defaults are tuned for homogeneous analytical tables of fixed-width numerics, not for Well-Known Binary (WKB) geometries whose serialized size swings by three orders of magnitude between a survey point and a multipolygon coastline. Three failure modes recur in spatial archives:

- **Egress amplification on cold reads.** Object-storage retrieval is priced per request and per byte scanned. A `ST_Intersects` filter that should touch one metropolitan tile ends up issuing thousands of `GET`/`HEAD` calls against a fragmented file, or — at the other extreme — forces a query engine to pull and decompress a 512 MB group to satisfy a 2 MB answer. Both inflate the bill; neither shows up until the dataset is already in Glacier.
- **Out-of-memory failures on spatial joins.** Engines materialise a full row group per worker during deserialization. Oversized groups holding dense geometry buffers blow past executor heap limits during `ST_Contains` joins or reprojection passes, producing intermittent OOM kills that are hard to reproduce.
- **Non-deterministic, non-auditable layouts.** Static row-count targets ignore WKB byte variance, so two writes of the "same" partition produce different group boundaries, different checksums, and a compaction job that can never prove byte-for-byte stability across an audit cycle.

Sizing the row group correctly is what turns each of these from a recurring incident into a one-time configuration decision.

## What You Need in Place First

Row group sizing is a downstream control. It only behaves predictably once the upstream layout decisions are settled, so confirm the following before tuning a single parameter:

- **A columnar archive format.** Data must already be written as GeoParquet (or a Parquet-backed Delta/Iceberg table), not Shapefile, GeoPackage, or raw WKT. Row groups are a columnar construct. If you are still migrating, run the [GeoParquet Migration Workflows](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/geoparquet-migration-workflows/) pipeline first so geometry encoding and CRS metadata land correctly.
- **Spatial partitioning chosen.** Row group boundaries operate strictly *within* a partition file. Decide your partition scheme — H3 cells, administrative boundaries, or a Z-order/Hilbert curve — using [Spatial Partitioning Techniques](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/spatial-partitioning-techniques/) before sizing, so spatial locality is already aligned to physical files.
- **A compression baseline.** Row group size and compression codec interact: ZSTD match-finding works across the whole group, so the size you pick changes the ratio you get. Lock a baseline with [ZSTD Level Configuration for Spatial Files](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/zstd-level-configuration-for-spatial-files/) first.

This topic sits inside the broader [Compression Tuning & Storage Optimization](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/) methodology; treat that reference as the parent decision spine and this page as the row-group-specific layer of it.

## Sizing Decisions: Parameters and Thresholds

Row group size is a balance: too small inflates metadata and request counts; too large forces wasteful decompression.

<svg viewBox="0 0 900 250" role="img" aria-label="Three row-group sizing regimes and their consequences: undersized groups cause metadata overhead and more GET requests; oversized groups force whole-group decompression and high time-to-first-byte; right-sized groups of 128 to 256 megabytes enable predicate pushdown at low cost." xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;color:var(--primary);font-family:var(--font-sans)">
  <title>Row-group sizing regimes and their consequences</title>
  <desc>Undersized groups lead to metadata overhead and more GET requests; oversized groups force whole-group decompression and high time-to-first-byte; right-sized 128 to 256 megabyte groups give predicate pushdown at low cost — the only regime that hits the target.</desc>
  <defs>
    <marker id="rg1-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <g font-size="13.5" text-anchor="middle">
    <!-- row 1: undersized -->
    <rect x="16" y="20" width="250" height="56" rx="10" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-opacity="0.35"/>
    <text x="141" y="44" font-weight="700" fill="currentColor">Undersized groups</text>
    <text x="141" y="63" font-size="11.5" fill="currentColor" fill-opacity="0.75">&lt; 64 MB</text>
    <rect x="430" y="20" width="454" height="56" rx="10" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-opacity="0.3"/>
    <text x="657" y="53" fill="currentColor">Metadata overhead + many small GET requests</text>
    <!-- row 2: oversized -->
    <rect x="16" y="97" width="250" height="56" rx="10" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-opacity="0.35"/>
    <text x="141" y="121" font-weight="700" fill="currentColor">Oversized groups</text>
    <text x="141" y="140" font-size="11.5" fill="currentColor" fill-opacity="0.75">&gt; 256 MB</text>
    <rect x="430" y="97" width="454" height="56" rx="10" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-opacity="0.3"/>
    <text x="657" y="130" fill="currentColor">Whole-group decompression + high time-to-first-byte</text>
    <!-- row 3: right-sized (highlighted) -->
    <rect x="16" y="174" width="250" height="56" rx="10" fill="currentColor" fill-opacity="0.14" stroke="currentColor" stroke-opacity="0.7" stroke-width="1.5"/>
    <text x="141" y="198" font-weight="700" fill="currentColor">Right-sized</text>
    <text x="141" y="217" font-size="11.5" fill="currentColor" fill-opacity="0.85">128–256 MB</text>
    <rect x="430" y="174" width="454" height="56" rx="10" fill="currentColor" fill-opacity="0.14" stroke="currentColor" stroke-opacity="0.6" stroke-width="1.5"/>
    <text x="657" y="207" font-weight="700" fill="currentColor">Predicate pushdown + low cold-read cost</text>
  </g>
  <g stroke="currentColor" stroke-width="2" fill="none">
    <path d="M266 48 H426" stroke-opacity="0.45" marker-end="url(#rg1-arrow)"/>
    <path d="M266 125 H426" stroke-opacity="0.45" marker-end="url(#rg1-arrow)"/>
    <path d="M266 202 H426" stroke-opacity="0.7" marker-end="url(#rg1-arrow)"/>
  </g>
</svg>

Columnar formats (Parquet, Delta, Iceberg) segment data into row groups, each containing column chunks with independent dictionaries, min/max statistics, and compression blocks. For spatial archives, calibrate three parameters explicitly rather than accepting writer defaults:

1. **Target group size (compressed, on disk): 128–256 MB.** This is the dominant lever. Below ~64 MB the per-group footer metadata and the object-storage request count dominate; above ~256 MB a single predicate forces decompression of a large irrelevant span. 128 MB is the safe default for mixed geometry; push toward 256 MB only for archival tiers that are read in full-scan batch jobs rather than point queries.
2. **Row count cap, derived not fixed.** Writers accept a *row* count, but your real target is a *byte* size, so derive the row count from the measured mean serialized row size: `rows_per_group ≈ target_bytes / mean_row_bytes`. Cap it at 1,000,000 rows to bound metadata regardless of how small individual geometries are. The derivation itself — including geometry profiling and memory-ceiling modelling — is worked end to end in [Calculating Optimal Row Group Size for Spatial Queries](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/row-group-sizing-strategies/calculating-optimal-row-group-size-for-spatial-queries/).
3. **Data page size: 1 MB.** Pages are the sub-unit that carries the column min/max statistics that drive bounding-box skipping. 1 MB pages give the query engine tighter `bbox` statistics per page, sharpening predicate pushdown without materially raising footer overhead.

The reason these numbers differ from tabular defaults is geometry payload variance. Point datasets exhibit uniform row sizes, while cadastral parcels, hydrological networks, and administrative boundaries vary by orders of magnitude. A static row count that produces a tidy 128 MB group for points will produce a 6 GB group for coastlines. Always size by bytes, derive the row count, and cap it.

<svg viewBox="0 0 1000 432" role="img" aria-label="Comparison matrix scoring three row-group sizes across five operational dimensions. Undersized 64-megabyte groups: about 16,000 GET requests per terabyte, minimal decompression per hit, low executor memory, fragmented predicate stats, high cold-read cost. Right-sized 128-to-256-megabyte groups: about 6,000 to 8,000 requests, moderate decompression, moderate memory, sharp predicate skipping, lowest cold-read cost. Oversized 512-megabyte groups: about 2,000 requests, wasteful decompression per hit, high memory with out-of-memory risk, coarse predicate stats, high cold-read cost on selective queries. The right-sized column is the balanced winner." xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;color:var(--primary);font-family:var(--font-sans)">
  <title>Row-group size comparison matrix across five operational dimensions</title>
  <desc>Five rows — GET requests per terabyte, decompression scope per hit, executor memory, predicate skip quality, and cold-read cost — scored across undersized 64 MB, right-sized 128–256 MB, and oversized 512 MB groups. The right-sized middle column is highlighted as the balanced optimum.</desc>
  <!-- highlighted winner column background -->
  <rect x="478" y="20" width="244" height="400" rx="12" fill="currentColor" fill-opacity="0.09" stroke="currentColor" stroke-opacity="0.5" stroke-width="1.5"/>
  <!-- column headers -->
  <g text-anchor="middle">
    <text x="600" y="16" font-size="11" font-weight="700" letter-spacing="0.04em" fill="currentColor" fill-opacity="0.85">BALANCED OPTIMUM</text>
    <text x="356" y="46" font-size="14.5" font-weight="700" fill="currentColor">Undersized</text>
    <text x="356" y="65" font-size="12" fill="currentColor" fill-opacity="0.75">64 MB</text>
    <text x="600" y="46" font-size="14.5" font-weight="700" fill="currentColor">Right-sized</text>
    <text x="600" y="65" font-size="12" fill="currentColor" fill-opacity="0.85">128–256 MB</text>
    <text x="844" y="46" font-size="14.5" font-weight="700" fill="currentColor">Oversized</text>
    <text x="844" y="65" font-size="12" fill="currentColor" fill-opacity="0.75">512 MB</text>
  </g>
  <!-- row separators -->
  <g stroke="currentColor" stroke-opacity="0.18" stroke-width="1">
    <line x1="16" y1="84" x2="984" y2="84"/>
    <line x1="16" y1="152" x2="984" y2="152"/>
    <line x1="16" y1="220" x2="984" y2="220"/>
    <line x1="16" y1="288" x2="984" y2="288"/>
    <line x1="16" y1="356" x2="984" y2="356"/>
  </g>
  <!-- row labels -->
  <g text-anchor="start" font-size="13" font-weight="600" fill="currentColor">
    <text x="20" y="122">GET requests / TB</text>
    <text x="20" y="190">Decompression / hit</text>
    <text x="20" y="258">Executor memory</text>
    <text x="20" y="326">Predicate skipping</text>
    <text x="20" y="394">Cold-read cost</text>
  </g>
  <!-- cell values: text-anchor middle per column. Severity shown via fill-opacity dot. -->
  <g text-anchor="middle" font-size="12.5">
    <!-- GET requests -->
    <text x="356" y="118" fill="currentColor">~16,000</text>
    <text x="356" y="135" font-size="11" fill="currentColor" fill-opacity="0.7">High</text>
    <text x="600" y="118" font-weight="700" fill="currentColor">~6,000–8,000</text>
    <text x="600" y="135" font-size="11" fill="currentColor" fill-opacity="0.8">Moderate</text>
    <text x="844" y="118" fill="currentColor">~2,000</text>
    <text x="844" y="135" font-size="11" fill="currentColor" fill-opacity="0.7">Low</text>
    <!-- decompression -->
    <text x="356" y="186" fill="currentColor">Minimal</text>
    <text x="600" y="186" font-weight="700" fill="currentColor">Moderate</text>
    <text x="844" y="186" fill="currentColor">Wasteful</text>
    <!-- executor memory -->
    <text x="356" y="254" fill="currentColor">Low</text>
    <text x="600" y="254" font-weight="700" fill="currentColor">Moderate</text>
    <text x="844" y="248" fill="currentColor">High</text>
    <text x="844" y="265" font-size="11" fill="currentColor" fill-opacity="0.7">OOM risk</text>
    <!-- predicate skipping -->
    <text x="356" y="322" fill="currentColor">Fine but</text>
    <text x="356" y="338" font-size="11" fill="currentColor" fill-opacity="0.7">fragmented</text>
    <text x="600" y="322" font-weight="700" fill="currentColor">Sharp</text>
    <text x="844" y="322" fill="currentColor">Coarse</text>
    <!-- cold-read cost -->
    <text x="356" y="390" fill="currentColor">High</text>
    <text x="600" y="390" font-weight="700" fill="currentColor">Lowest</text>
    <text x="844" y="390" fill="currentColor">High</text>
  </g>
</svg>

## Production Writer Configuration

Implementation requires explicit writer-level overrides. Framework defaults assume homogeneous tabular data and will misallocate spatial payloads. Set the row group target, page size, and dictionary policy at write time; never rely on the compaction job to "fix" layout afterwards.

### PyArrow / DuckDB baseline

```python
import pyarrow.parquet as pq

pq.write_table(
    spatial_table,
    "s3://cold-archive/geospatial/v2/parcels/region_north.parquet",
    row_group_size=1_000_000,           # rows per group, derived toward a ~128 MB on-disk target
    data_page_size=1 * 1024 * 1024,     # 1 MB pages -> tighter per-page bbox statistics
    use_dictionary=False,               # disable for the WKB geometry column (high-cardinality, no benefit)
    compression="zstd",
    compression_level=3,
)
```

The 128 MB target balances cold-tier read cost against memory safety, and the 1 MB data pages improve the min/max bounding-box statistics that enable tight predicate pushdown. Dictionary encoding is disabled for the geometry column because WKB values are effectively unique — dictionaries there only bloat the file. Categorical GIS attributes are the opposite case and should be handled separately with [Dictionary Encoding for GIS Attributes](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/dictionary-encoding-for-gis-attributes/), which can apply per-column dictionary policy without touching geometry.

### Spark SQL / Delta engine

```sql
SET spark.sql.parquet.rowGroupSize=134217728;       -- 128 MB
SET spark.sql.parquet.dataPageSize=1048576;         -- 1 MB
SET spark.sql.parquet.enableDictionary=false;       -- geometry column; set per-column where supported
SET spark.sql.parquet.compression.codec=zstd;
SET spark.sql.parquet.zstdCompressionLevel=3;
```

When writing to Delta or Iceberg tables, enforce these settings at the session level before every `INSERT` or `MERGE`. Critically, compaction and `OPTIMIZE` jobs must inherit the *identical* row group target — otherwise compaction quietly rewrites files at the engine default and your carefully sized layout drifts after the first maintenance window.

## Validation Gate

Never assume the writer honoured the target — inspect the actual physical layout after the write. The fastest cross-engine check reads the Parquet footer metadata directly with DuckDB:

```bash
duckdb -c "
  SELECT row_group_id,
         row_group_num_rows                         AS rows,
         round(row_group_bytes / 1048576.0, 1)      AS mb
  FROM parquet_metadata('s3://cold-archive/geospatial/v2/parcels/region_north.parquet')
  GROUP BY ALL ORDER BY row_group_id;
"
```

Expected output for a healthy 128 MB layout — group sizes clustered tightly around target, row counts varying to absorb geometry size variance:

```
┌──────────────┬─────────┬───────┐
│ row_group_id │  rows   │  mb   │
├──────────────┼─────────┼───────┤
│ 0            │ 712334  │ 131.4 │
│ 1            │ 698120  │ 129.8 │
│ 2            │ 705991  │ 130.2 │
│ ...          │ ...     │ ...   │
└──────────────┴─────────┴───────┘
```

**Most common failure — every group reads as one giant block (e.g. a single 6 GB group, or `mb` values in the thousands).** Root cause: the writer received a row count target but the geometry column's mean serialized size was far larger than assumed, so a 1,000,000-row cap translated to gigabytes. Fix: profile mean WKB bytes on a sample, recompute `rows_per_group = target_bytes / mean_row_bytes`, and rewrite — do not patch with compaction, which inherits the same bad ratio. The full profiling routine is in [Calculating Optimal Row Group Size for Spatial Queries](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/row-group-sizing-strategies/calculating-optimal-row-group-size-for-spatial-queries/).

A second-line check confirms the statistics that drive skipping actually exist:

```bash
duckdb -c "
  SELECT path_in_schema, stats_min IS NOT NULL AS has_min, stats_max IS NOT NULL AS has_max
  FROM parquet_metadata('s3://cold-archive/geospatial/v2/parcels/region_north.parquet')
  WHERE path_in_schema LIKE 'bbox%';
"
```

If `has_min`/`has_max` are false on the `bbox` columns, predicate pushdown is silently disabled and every query becomes a full scan regardless of row group size.

## Cost & Performance Trade-offs

Cold-storage pricing models (AWS S3 Glacier Deep Archive, Azure Cool/Archive Blob) are heavily request-sensitive, and retrieval cost scales with the number of row groups a query has to touch. The table below models a 1 TB spatial archive at three group sizes, assuming a typical spatial filter that returns roughly 5% of features:

| Row group size | Groups per 1 TB | Object reads, point query | Decompression scope per hit | Executor memory pressure | Best fit |
|---|---|---|---|---|---|
| 64 MB | ~16,000 | High (many small `GET`s) | Minimal | Low | Frequently-queried warm tier |
| 128 MB | ~8,000 | Moderate | Moderate | Moderate | **Default for mixed archives** |
| 256 MB | ~4,000 | Low | Large per hit | Elevated | Batch full-scan / deep archive |
| 512 MB | ~2,000 | Very low | Wasteful on selective reads | High (OOM risk) | Avoid for point queries |

The diagonal is the whole point: shrinking groups cuts decompression waste but multiplies request count and cost; growing them cuts request count but risks decompressing megabytes to answer a kilobyte and pushes executors toward OOM. 128 MB is the cost-minimising default across mixed query patterns; reserve 256 MB for archives that are genuinely only ever read in full-scan batch jobs.

<svg viewBox="0 0 900 430" role="img" aria-label="A cost curve chart with row-group size from 64 to 512 megabytes on the horizontal axis. The object-read cost curve falls as groups grow larger, while the decompression-waste cost curve rises. The two curves cross inside the shaded 128-to-256-megabyte band, where the summed total-cost curve reaches its minimum — the cost-minimising sweet spot." xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;color:var(--primary);font-family:var(--font-sans)">
  <title>Total cold-read cost is minimised in the 128–256 MB band</title>
  <desc>As row-group size grows from 64 to 512 MB, object-read cost falls and decompression-waste cost rises. The curves cross within the shaded 128–256 MB band, where the total of the two costs bottoms out.</desc>
  <!-- optimum band -->
  <rect x="320" y="48" width="280" height="300" fill="currentColor" fill-opacity="0.08"/>
  <text x="460" y="40" text-anchor="middle" font-size="12.5" font-weight="700" fill="currentColor">128–256 MB optimum</text>
  <!-- axes -->
  <g stroke="currentColor" stroke-opacity="0.45" stroke-width="1.5" fill="none">
    <path d="M70 48 V348 H850"/>
  </g>
  <!-- x ticks -->
  <g text-anchor="middle" font-size="12" fill="currentColor" fill-opacity="0.8">
    <text x="70" y="372">64 MB</text>
    <text x="320" y="372">128 MB</text>
    <text x="600" y="372">256 MB</text>
    <text x="850" y="372">512 MB</text>
  </g>
  <text x="460" y="400" text-anchor="middle" font-size="12.5" font-weight="600" fill="currentColor" fill-opacity="0.85">Row group size →</text>
  <text x="58" y="44" text-anchor="end" font-size="12" fill="currentColor" fill-opacity="0.8" transform="rotate(-90 58 44)" style="transform-box:fill-box">Cost →</text>
  <!-- object-read cost: falling -->
  <path d="M70 80 C 280 118 400 190 460 200 S 690 280 850 308" fill="none" stroke="currentColor" stroke-width="2.5" stroke-opacity="0.85"/>
  <!-- decompression-waste cost: rising -->
  <path d="M70 308 C 280 280 400 210 460 200 S 690 118 850 80" fill="none" stroke="currentColor" stroke-width="2.5" stroke-opacity="0.55" stroke-dasharray="7 5"/>
  <!-- total cost: U-shape, min in band -->
  <path d="M70 110 C 250 188 410 250 460 252 C 510 250 660 188 850 110" fill="none" stroke="currentColor" stroke-width="3.5" stroke-opacity="0.95"/>
  <!-- crossing / minimum marker -->
  <circle cx="460" cy="252" r="5" fill="currentColor"/>
  <!-- legend -->
  <g font-size="12" fill="currentColor">
    <line x1="630" y1="424" x2="660" y2="424" stroke="currentColor" stroke-width="2.5" stroke-opacity="0.85"/>
    <text x="666" y="428" fill-opacity="0.9">Object-read cost</text>
    <line x1="70" y1="424" x2="100" y2="424" stroke="currentColor" stroke-width="2.5" stroke-opacity="0.55" stroke-dasharray="7 5"/>
    <text x="106" y="428" fill-opacity="0.9">Decompression waste</text>
    <line x1="320" y1="424" x2="350" y2="424" stroke="currentColor" stroke-width="3.5"/>
    <text x="356" y="428" fill-opacity="0.9">Total cost</text>
  </g>
</svg>

## Failure Modes & Edge Cases

- **Compaction layout drift.** `OPTIMIZE`/`VACUUM` jobs that don't inherit the session row group target rewrite files at the engine default, silently undoing your sizing after the first maintenance window. Pin the target in the compaction job config, not just the ingest job, and re-run the validation query after every maintenance cycle.
- **Mixed-geometry partitions skew the mean.** A partition holding both survey points and coastline multipolygons has a bimodal byte distribution, so a single mean produces groups that are too big for the polygons and too small for the points. Where feasible, route geometry types to separate partitions before sizing, or size against the 90th-percentile row size rather than the mean.
- **Page size starves the statistics.** Leaving `data_page_size` at the multi-megabyte default coarsens the per-page bounding box so much that predicate pushdown can no longer skip within a group — the group is right-sized but every read still scans it end to end. Keep pages at 1 MB for spatial columns.
- **Dictionary overflow on geometry.** Leaving `use_dictionary=True` on the WKB column makes the writer attempt — and usually abort — a dictionary of near-unique values, bloating the file and occasionally fragmenting groups below target. Disable dictionaries on geometry columns explicitly; apply them only to categorical attributes.

## Operational Execution Checklist

- [ ] Confirm the dataset is GeoParquet/Parquet-backed and spatially partitioned before sizing.
- [ ] Profile mean (and p90) serialized WKB bytes on a representative sample.
- [ ] Derive `rows_per_group = target_bytes / mean_row_bytes`; cap at 1,000,000.
- [ ] Set `row_group_size`, `data_page_size=1 MB`, `use_dictionary=False` on geometry, and ZSTD codec at write time.
- [ ] Apply identical row group targets to compaction/`OPTIMIZE` jobs.
- [ ] Run the `parquet_metadata` validation query; confirm group sizes land within 128–256 MB.
- [ ] Confirm `bbox` min/max statistics are present for predicate pushdown.
- [ ] Record the chosen target and checksums in the archive manifest for audit reproducibility.

## Related

- Up to the parent reference: [Compression Tuning & Storage Optimization](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/) — the full cold-storage optimisation methodology this layout decision sits inside.
- [Calculating Optimal Row Group Size for Spatial Queries](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/row-group-sizing-strategies/calculating-optimal-row-group-size-for-spatial-queries/) — the deterministic byte-derivation and Hilbert-clustering routine behind the numbers above.
- [Spatial Partitioning Techniques](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/spatial-partitioning-techniques/) — set partition boundaries first, since row groups operate within them.
- [ZSTD Level Configuration for Spatial Files](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/zstd-level-configuration-for-spatial-files/) — the codec baseline that interacts with group size to set the final compression ratio.
- [Hot/Warm/Cold Tier Design for Geospatial Data](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/hotwarmcold-tier-design-for-geospatial-data/) — how group size feeds the retrieval-cost assumptions of each storage tier.

For cross-engine compatibility, follow the [Apache Parquet file format](https://parquet.apache.org/docs/file-format/) specification, and validate spatial metadata against the [OGC GeoParquet specification](https://geoparquet.org/) so row group statistics remain readable across archival tiers.
