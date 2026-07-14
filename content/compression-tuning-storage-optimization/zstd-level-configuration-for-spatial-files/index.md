# ZSTD Level Configuration for Spatial Files

Zstandard (ZSTD) compression in a geospatial archive is a calibrated control surface, not a static toggle, and the most common way teams waste money on it is by treating one level as correct for every dataset. Pin the level too high on hot, frequently rewritten data and write-time CPU dominates the ingest budget; pin it too low on a multi-year legal-hold archive and storage and egress costs run 50–70% above where they should sit. This page is for data engineers, GIS archivists, cloud architects, and compliance teams who already have columnar storage in place and now need to choose an exact ZSTD level per access tier, wire it into the writer, and prove the result is lossless before promoting it to cold storage. It maps levels to spatial workloads, gives production writer configurations for PyArrow, Spark, and DuckDB, and sets the validation gates that catch precision drift before it reaches an immutable bucket.

## When a Single ZSTD Level Costs You Money

The failure mode this topic solves is *uniform compression policy* — applying one ZSTD level across an archive whose files have wildly different access patterns and entropy profiles. Three concrete symptoms follow from it:

- **CPU-bound ingest on hot data.** Coordinate streams, change-data-capture feeds, and ephemeral staging tables are rewritten constantly. Compressing them at level 15 burns 3–5x the write CPU of level 3 for a storage saving that evaporates within hours when the file is overwritten. The compression bill shows up as throttled ingest workers, not as a line item.
- **Over-paying for storage on cold data.** The inverse failure is leaving deep-archive geometry at level 3 because that was the pipeline default. A decade of LiDAR tiles or cadastral snapshots sitting at baseline compression carries 50–70% more bytes than it needs to, and on Glacier-class tiers that delta compounds every month for the life of the retention mandate.
- **Surprise retrieval latency that is actually a row-group problem.** Teams blame "high compression" for slow cold reads, but ZSTD decompression speed is essentially level-independent — a level-19 archive decompresses at roughly the same throughput as a level-3 archive for the same byte volume. When retrieval is slow, the cause is almost always oversized row groups forcing whole-group decompression, not the level itself.

Choosing the level *per access tier* — rather than per pipeline — is what turns each of these from a recurring cost into a one-time configuration decision.

## What You Need in Place First

ZSTD level selection is a downstream tuning knob; it only behaves predictably once the layout above it is settled. Confirm the following before touching a level parameter:

- **A columnar archive format.** ZSTD here applies per column chunk inside GeoParquet (or a Parquet-backed Iceberg/Delta table), not to a whole opaque blob. If geometry is still in Shapefile or GeoPackage, run the [GeoParquet Migration Workflows](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/geoparquet-migration-workflows/) pipeline first so geometry encoding and CRS metadata land correctly — compressing un-migrated data just locks in a bad layout at a smaller size.
- **Access tiers defined.** You must already know which datasets are hot, nearline, or deep-archive, because the level follows the tier. That classification comes from your storage-class design; settle it with [Object Storage Selection for GIS Archives](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/object-storage-selection-for-gis-archives/) before mapping levels.
- **A row-group baseline.** Level and row-group size interact: ZSTD match-finding works across the whole row group, so the group size you pick changes the ratio a given level delivers. Lock that with [Row Group Sizing Strategies](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/row-group-sizing-strategies/) so you are tuning one variable at a time.

This page sits inside the broader [Compression Tuning & Storage Optimization](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/) methodology; treat that reference as the parent decision spine and this page as the ZSTD-specific layer of it.

## Choosing a Level by Access Pattern

Match the ZSTD level to how often the data is read and rewritten, not to a single house default.

<svg viewBox="0 0 900 300" role="img" aria-label="Decision diagram mapping a dataset's access frequency to a ZSTD level range. A dataset flows into an access-frequency decision that splits four ways: hot or streaming data uses ZSTD 1 to 3 for real-time, change-data-capture and staging; nearline data uses ZSTD 4 to 7 for daily batch ETL outputs; balanced cold data uses ZSTD 8 to 12 for compliance snapshots; and deep archive data uses ZSTD 13 to 19 for legal hold and multi-year retention." xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;color:var(--primary);font-family:var(--font-sans)">
  <title>Choosing a ZSTD level by access frequency</title>
  <desc>A dataset enters an access-frequency decision that branches to four level ranges: ZSTD 1–3 for hot/streaming, 4–7 for nearline ETL, 8–12 for balanced cold, and 13–19 for deep archive.</desc>
  <defs>
    <marker id="zl-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <!-- dataset node -->
  <rect x="20" y="124" width="120" height="48" rx="10" fill="currentColor" fill-opacity="0.06" stroke="currentColor" stroke-opacity="0.45"/>
  <text x="80" y="153" text-anchor="middle" font-size="14" font-weight="700" fill="currentColor">Dataset</text>
  <!-- decision diamond -->
  <polygon points="250,104 314,148 250,192 186,148" fill="currentColor" fill-opacity="0.08" stroke="currentColor" stroke-opacity="0.55"/>
  <g text-anchor="middle" fill="currentColor" font-size="12">
    <text x="250" y="144" font-weight="700">Access</text>
    <text x="250" y="160" font-weight="700">frequency</text>
  </g>
  <!-- connectors -->
  <g stroke="currentColor" fill="none" stroke-width="1.8" stroke-opacity="0.5">
    <path d="M140 148 H186" marker-end="url(#zl-arrow)"/>
    <path d="M314 148 C 390 148 390 42 460 42" marker-end="url(#zl-arrow)"/>
    <path d="M314 148 C 390 148 390 110 460 110" marker-end="url(#zl-arrow)"/>
    <path d="M314 148 C 390 148 390 178 460 178" marker-end="url(#zl-arrow)"/>
    <path d="M314 148 C 390 148 390 246 460 246" marker-end="url(#zl-arrow)"/>
  </g>
  <!-- outcome rows -->
  <g>
    <rect x="460" y="13" width="424" height="58" rx="10" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-opacity="0.35"/>
    <rect x="460" y="81" width="424" height="58" rx="10" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-opacity="0.35"/>
    <rect x="460" y="149" width="424" height="58" rx="10" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-opacity="0.35"/>
    <rect x="460" y="217" width="424" height="58" rx="10" fill="currentColor" fill-opacity="0.1" stroke="currentColor" stroke-opacity="0.6" stroke-width="1.5"/>
  </g>
  <!-- left labels -->
  <g text-anchor="start" font-size="13.5" font-weight="700" fill="currentColor">
    <text x="478" y="38">Hot / streaming</text>
    <text x="478" y="106">Nearline / ETL</text>
    <text x="478" y="174">Balanced cold</text>
    <text x="478" y="242">Deep archive</text>
  </g>
  <!-- subtitles -->
  <g text-anchor="start" font-size="11" fill="currentColor" fill-opacity="0.7">
    <text x="478" y="57">Real-time, CDC, ephemeral staging</text>
    <text x="478" y="125">Daily batch loads, intermediate outputs</text>
    <text x="478" y="193">Compliance snapshots, analytical cold tier</text>
    <text x="478" y="261" fill-opacity="0.8">Legal hold, multi-year retention, SLA &gt;24h</text>
  </g>
  <!-- level pills -->
  <g>
    <rect x="744" y="28" width="124" height="28" rx="14" fill="currentColor" fill-opacity="0.12" stroke="currentColor" stroke-opacity="0.4"/>
    <text x="806" y="47" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">ZSTD 1–3</text>
    <rect x="744" y="96" width="124" height="28" rx="14" fill="currentColor" fill-opacity="0.12" stroke="currentColor" stroke-opacity="0.4"/>
    <text x="806" y="115" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">ZSTD 4–7</text>
    <rect x="744" y="164" width="124" height="28" rx="14" fill="currentColor" fill-opacity="0.12" stroke="currentColor" stroke-opacity="0.4"/>
    <text x="806" y="183" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">ZSTD 8–12</text>
    <rect x="744" y="232" width="124" height="28" rx="14" fill="currentColor" fill-opacity="0.18" stroke="currentColor" stroke-opacity="0.6"/>
    <text x="806" y="251" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">ZSTD 13–19</text>
  </g>
</svg>

ZSTD operates across levels 1–22. Each increment applies more aggressive match-finding, longer hash chains, and deeper entropy coding. For spatial files — coordinate arrays, Well-Known Binary (WKB) geometry, topology graphs, and attribute tables — the optimal level is dictated by data entropy, access frequency, and the compute window available at write time. Because decompression throughput is roughly constant across levels, the only real trade is *write CPU now* against *bytes stored for years*, which is exactly why the access tier is the deciding input.

| ZSTD Level | Operational Tier | CPU Overhead (Write) | Storage Reduction vs. Level 3 | Recommended Spatial Workloads |
|------------|------------------|----------------------|-------------------------------|-------------------------------|
| 1–3 | Hot / Streaming | Minimal | Baseline | Real-time ingestion, CDC streams, ephemeral staging |
| 4–7 | Nearline / ETL | 10–15% | +10–20% | Daily batch loads, intermediate Parquet/GeoJSON outputs |
| 8–12 | Balanced Cold | 25–40% | +30–50% | Quarterly access, compliance snapshots, analytical cold tier |
| 13–19 | Deep Archive | 3–5x baseline | +50–70% | Legal hold, multi-year retention, retrieval SLA >24h |
| 20–22 | Ultra / Max | 5–8x baseline | +5–10% over 19 | Maximum-ratio static archives; levels 20–22 require the `--ultra` flag |

Two thresholds matter most in practice. **Level 11–12** is the sweet spot for the balanced cold tier: it captures most of the achievable ratio while keeping write CPU within a normal nightly compute window. **Level 19** is the practical ceiling for deep archive — the jump to 20–22 adds only single-digit extra reduction while multiplying CPU, so reserve `--ultra` for genuinely static, write-once datasets where the compute window is fully decoupled from production. For levels 13–19, provision burstable compute or schedule off-peak extraction jobs so compression never throttles live analytics.

<svg viewBox="0 0 900 440" role="img" aria-label="Line chart of ZSTD level from 1 to 22 against two relative curves. Storage reduction rises quickly through the mid levels then flattens after about level 19, gaining only a few extra percent at levels 20 to 22. Write CPU cost rises gently through level 13 and then climbs steeply, reaching its maximum at levels 20 to 22. The plot is divided into five vertical tier bands: Hot at levels 1 to 3, Nearline 4 to 7, Balanced 8 to 12, Deep archive 13 to 19, and Ultra 20 to 22. A dashed marker at level 19 highlights the practical ceiling, beyond which CPU keeps climbing while storage gains barely move." xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;color:var(--primary);font-family:var(--font-sans)">
  <title>Storage reduction versus write-CPU cost across ZSTD levels</title>
  <desc>Storage reduction rises and flattens after level 19, while write-CPU cost climbs steeply past level 13. Five vertical bands mark the Hot, Nearline, Balanced, Deep and Ultra tiers, with level 19 marked as the practical ceiling.</desc>
  <!-- tier bands -->
  <g>
    <rect x="70" y="40" width="94" height="340" fill="currentColor" fill-opacity="0.03"/>
    <rect x="164" y="40" width="150.5" height="340" fill="currentColor" fill-opacity="0.06"/>
    <rect x="314.5" y="40" width="188.1" height="340" fill="currentColor" fill-opacity="0.03"/>
    <rect x="502.6" y="40" width="263.4" height="340" fill="currentColor" fill-opacity="0.06"/>
    <rect x="766" y="40" width="94" height="340" fill="currentColor" fill-opacity="0.1"/>
  </g>
  <!-- band labels -->
  <g text-anchor="middle" font-size="11" font-weight="700" fill="currentColor" fill-opacity="0.85">
    <text x="117" y="33">Hot</text>
    <text x="239" y="33">Nearline</text>
    <text x="408" y="33">Balanced</text>
    <text x="634" y="33">Deep archive</text>
    <text x="813" y="33">Ultra</text>
  </g>
  <!-- y gridlines + labels -->
  <g stroke="currentColor" stroke-opacity="0.12" stroke-width="1">
    <line x1="70" y1="380" x2="860" y2="380"/>
    <line x1="70" y1="295" x2="860" y2="295"/>
    <line x1="70" y1="210" x2="860" y2="210"/>
    <line x1="70" y1="125" x2="860" y2="125"/>
    <line x1="70" y1="40" x2="860" y2="40"/>
  </g>
  <g text-anchor="end" font-size="10.5" fill="currentColor" fill-opacity="0.6">
    <text x="60" y="384">0</text>
    <text x="60" y="299">25</text>
    <text x="60" y="214">50</text>
    <text x="60" y="129">75</text>
    <text x="60" y="44">100</text>
  </g>
  <!-- axes -->
  <g stroke="currentColor" stroke-opacity="0.45" stroke-width="1.5">
    <line x1="70" y1="40" x2="70" y2="380"/>
    <line x1="70" y1="380" x2="860" y2="380"/>
  </g>
  <!-- level-19 ceiling marker -->
  <line x1="747.14" y1="40" x2="747.14" y2="380" stroke="currentColor" stroke-opacity="0.5" stroke-width="1.3" stroke-dasharray="4 4"/>
  <text x="743" y="54" text-anchor="end" font-size="10.5" font-weight="700" fill="currentColor" fill-opacity="0.8">L19 practical ceiling</text>
  <!-- storage reduction curve (solid) -->
  <polyline points="70,363 145.24,339.2 220.48,295 295.71,261 370.95,216.8 446.19,176 521.43,142 596.67,114.8 671.9,94.4 747.14,74 784.76,63.8 860,53.6" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linejoin="round" stroke-linecap="round"/>
  <!-- write-CPU curve (dashed) -->
  <polyline points="70,369.8 145.24,359.6 220.48,346 295.71,329 370.95,305.2 446.19,278 521.43,237.2 596.67,182.8 671.9,135.2 747.14,91 784.76,67.2 860,40" fill="none" stroke="currentColor" stroke-width="2.6" stroke-opacity="0.65" stroke-dasharray="7 5" stroke-linejoin="round" stroke-linecap="round"/>
  <!-- x ticks -->
  <g text-anchor="middle" font-size="10.5" fill="currentColor" fill-opacity="0.7">
    <text x="70" y="396">1</text>
    <text x="145.24" y="396">3</text>
    <text x="295.71" y="396">7</text>
    <text x="503.8" y="396">12</text>
    <text x="747.14" y="396">19</text>
    <text x="860" y="396">22</text>
  </g>
  <text x="465" y="418" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor" fill-opacity="0.8">ZSTD level</text>
  <text x="20" y="210" text-anchor="middle" font-size="11" fill="currentColor" fill-opacity="0.6" transform="rotate(-90 20 210)">relative (%)</text>
  <!-- legend -->
  <g font-size="12" fill="currentColor">
    <line x1="92" y1="62" x2="124" y2="62" stroke="currentColor" stroke-width="2.6"/>
    <text x="132" y="66">Storage reduction</text>
    <line x1="92" y1="84" x2="124" y2="84" stroke="currentColor" stroke-width="2.6" stroke-opacity="0.65" stroke-dasharray="7 5"/>
    <text x="132" y="88">Write-CPU cost</text>
  </g>
</svg>

## Production Configurations & Engine Integration

Compression must be pinned explicitly at the writer layer. Engine-level defaults frequently override implicit settings, producing inconsistent archival footprints across otherwise identical jobs. The configurations below target the balanced cold tier (level 11) and use realistic archive paths.

**PyArrow / GeoParquet writer**
```python
import pyarrow.parquet as pq

# Balanced cold tier: level 11 captures most of the ratio
# while staying inside a nightly compute window.
pq.write_table(
    table,
    "lidar/2024/region_north_cold.parquet",
    compression="zstd",
    compression_level=11,
    use_dictionary=True,      # lower entropy on categorical attrs before ZSTD
    write_statistics=True,    # per-column min/max enables predicate pushdown
    row_group_size=256 * 1024 * 1024,
)
```

**Apache Spark SQL (DataFrame API)**
```python
df.write \
  .option("compression", "zstd") \
  .option("parquet.compression.codec.zstd.level", "11") \
  .option("parquet.enable.dictionary", "true") \
  .mode("overwrite") \
  .parquet("s3://gis-cold-storage/cadastral/snapshots/2024q2/")
```

**DuckDB (CLI / Python)**
```sql
COPY spatial_dataset
  TO 'imagery/scenes/2024/archive_cold.parquet'
  (FORMAT PARQUET, COMPRESSION ZSTD, COMPRESSION_LEVEL 11, ROW_GROUP_SIZE 1000000);
```

Align the compression boundary with your row-group layout: oversized row groups force full-group decompression during predicate pushdown and negate the cold-storage cost benefit, so target 128 MB–256 MB groups per the [Row Group Sizing Strategies](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/row-group-sizing-strategies/) thresholds. Categorical GIS attributes — land-use codes, sensor IDs, jurisdiction codes — should be dictionary-encoded *before* ZSTD applies match-finding; see [Dictionary Encoding for GIS Attributes](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/dictionary-encoding-for-gis-attributes/) for the schema-level patterns that make level 8–12 pay off. For GeoParquet-specific column tuning that aligns ZSTD with geometry encoding, the [Tuning ZSTD Compression for GeoParquet Archives](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/zstd-level-configuration-for-spatial-files/tuning-zstd-compression-for-geoparquet-archives/) walkthrough takes these defaults to the column level.

## Validation Gate

ZSTD is lossless at the byte level, so a correct round trip must reproduce the input exactly. What can still go wrong is the *spatial writer* truncating coordinate precision before ZSTD ever sees the bytes — that loss is invisible to a compression test and only surfaces when a downstream join misaligns. Validate both the byte round trip and the geometry before promoting a dataset to cold storage.

Confirm the codec and level that actually landed in the file (do not trust the job config — confirm the artifact):

```bash
parquet-tools inspect lidar/2024/region_north_cold.parquet | grep -i "compression\|codec"
```

Expected output (every column chunk reports the codec you pinned):

```
  geometry: ... compression: ZSTD ...
  attributes: ... compression: ZSTD ...
```

Then verify the geometry survived the write losslessly by comparing the bounding box and vertex count before and after:

```python
import geopandas as gpd

before = gpd.read_parquet("staging/region_north.parquet")
after  = gpd.read_parquet("lidar/2024/region_north_cold.parquet")

assert before.total_bounds.round(9).tolist() == after.total_bounds.round(9).tolist()
assert before.geometry.apply(lambda g: len(g.exterior.coords) if g.geom_type == "Polygon" else g.length).sum() \
     == after.geometry.apply(lambda g: len(g.exterior.coords) if g.geom_type == "Polygon" else g.length).sum()
print("round-trip OK")
```

**Most common failure — `compression: UNCOMPRESSED` on the geometry column.** The root cause is almost always an engine default overriding the writer option: older Spark/Parquet builds ignore a codec set at the session level unless it is set per-write, and some GDAL-based writers fall back to Snappy when `compression_level` is passed but `compression` is not. Fix it by setting both the codec and the level on the *write call itself*, as in the configurations above, then re-inspect. A secondary failure — a bounding-box delta in the assertion — is never a ZSTD fault; it means the writer truncated coordinate precision, so check the geometry-encoding precision setting, not the compression level.

## Cost & Performance Trade-offs

The economics of level selection are a balance between one-time write CPU and recurring storage and egress charges. The table below quantifies the trade for a representative 1 TB (level-3 baseline) spatial archive.

| ZSTD Level | Stored Size (from 1 TB) | Write CPU (relative) | Decompression Speed | Best When |
|------------|-------------------------|----------------------|---------------------|-----------|
| 3 | 1.00 TB | 1x | Fast | Data rewritten within hours |
| 7 | ~0.85 TB | ~1.4x | Fast | Daily-touched ETL outputs |
| 11 | ~0.62 TB | ~3x | Fast | Quarterly-access cold tier |
| 19 | ~0.45 TB | ~6x | Fast | Multi-year retention, rare reads |

The decisive insight is that decompression speed barely moves down the column, so retrieval latency is *not* a reason to avoid high levels — read cost is governed by row-group scope and partition pruning, not by the compression level. The real constraint on going higher is the write-time compute window. On deep-archive tiers, the recurring monthly storage saving from level 19 typically repays the one-time CPU cost within the first quarter and then accrues for the life of the retention mandate, which is why write-once legal-hold data justifies the highest levels your compute schedule can absorb. Pair these numbers with the storage-class pricing in [Object Storage Selection for GIS Archives](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/object-storage-selection-for-gis-archives/) to convert ratio into actual dollars per tier.

## Failure Modes & Edge Cases

Four pitfalls account for most ZSTD problems in geospatial archives:

- **High level on incompressible data.** Already-compressed payloads — JPEG-in-TIFF imagery, pre-compressed point clouds, encrypted columns — have near-maximum entropy, so level 19 spends 6x the CPU to shave a percent or two. Detect these columns and drop them to level 3; raising the level on high-entropy data is pure CPU waste.
- **Level set in config but lost at the artifact.** A codec pinned at session or cluster scope is silently ignored by some writers, so the file lands at the engine default. This is the single most common surprise and is exactly why the validation gate above inspects the written file rather than trusting the job config.
- **Row-group/level mismatch inflating reads.** A high level on an oversized row group means every predicate-pushdown read decompresses a huge group to return a small answer, erasing the cold-storage saving. Keep the group at 128–256 MB so decompression scope stays bounded to the queried extent.
- **Compression mistaken for an immutability control.** A smaller file is still mutable and deletable. ZSTD level has no bearing on retention guarantees, so deep-archive data must be paired with WORM lifecycle controls (S3 Object Lock, equivalent bucket-lock policies) under a defined [Retention Policy Frameworks](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/retention-policy-frameworks/) design — the level decision and the retention decision are independent and both mandatory.

When deep-archive media is eventually rotated out, follow the NIST media-sanitization guidance referenced in your retention design rather than assuming compression obscures residual data.

## Operational Execution Checklist

- [ ] Classify each dataset into hot, nearline, balanced-cold, or deep-archive before choosing a level
- [ ] Confirm geometry is in GeoParquet (or a Parquet-backed table), not Shapefile/GeoPackage
- [ ] Lock a row-group size (128–256 MB) so level is the only variable you tune
- [ ] Pin both `compression=zstd` and the explicit level on the write call, not at session scope
- [ ] Enable dictionary encoding for categorical attribute columns before raising the level
- [ ] Use level 11–12 for balanced cold and 19 for deep archive; reserve `--ultra` (20–22) for static write-once data
- [ ] Inspect the written file to confirm the codec and level actually landed
- [ ] Run a bounding-box + vertex-count round-trip check to rule out precision truncation
- [ ] Drop already-compressed / high-entropy columns to level 3
- [ ] Pair deep-archive files with WORM lifecycle policies — compression is not a retention control

## Related

- [Compression Tuning & Storage Optimization](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/) — the parent methodology this ZSTD decision sits inside; start here for the full optimization spine.
- [Row Group Sizing Strategies](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/row-group-sizing-strategies/) — set the group size that determines the ratio a given ZSTD level delivers.
- [Dictionary Encoding for GIS Attributes](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/dictionary-encoding-for-gis-attributes/) — lower categorical entropy so levels 8–12 actually pay off.
- [Tuning ZSTD Compression for GeoParquet Archives](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/zstd-level-configuration-for-spatial-files/tuning-zstd-compression-for-geoparquet-archives/) — column-level GeoParquet walkthrough that extends these defaults.
- [Object Storage Selection for GIS Archives](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/object-storage-selection-for-gis-archives/) — convert compression ratio into per-tier storage cost across providers.

Validate algorithmic parameter limits against the [Zstandard compression manual](https://facebook.github.io/zstd/zstd_manual.html), GeoParquet compliance against the [OGC GeoParquet specification](https://geoparquet.org/), and immutability configuration against the [AWS S3 Object Lifecycle documentation](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lifecycle-mgmt.html).

Up one level: [Compression Tuning & Storage Optimization for Geospatial Cold Storage](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/).
