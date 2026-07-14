# Compression Tuning & Storage Optimization for Geospatial Cold Storage

Petabyte-scale spatial archives only become affordable when compression, physical layout, and partitioning are tuned to the structure of the data rather than left at library defaults. This guide is the operational reference for data engineers, GIS archivists, cloud architects, and compliance teams who need to shrink cold-tier footprint and egress cost without sacrificing query performance, auditability, or retention guarantees. It connects entropy profiling, columnar layout, attribute encoding, and spatial partitioning into one production methodology you can enforce as code.

## Optimization Pipeline at a Glance

Cold-storage optimization moves each dataset through profiling, compression, physical layout, and governed lifecycle transitions:

<svg viewBox="0 0 1080 250" role="img" aria-label="Cold-storage optimization pipeline: a spatial dataset moves through entropy and cardinality profiling, ZSTD level tuning, row group sizing, dictionary encoding, spatial partitioning, and a cold-tier lifecycle transition, with savings compounding from roughly three-fold to twelve-fold across the stages." xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;color:var(--primary);font-family:var(--font-sans)">
  <title>Cold-storage optimization pipeline</title>
  <desc>Seven sequential stages — spatial dataset, profile entropy and cardinality, ZSTD level tuning, row group sizing, dictionary encoding, spatial partitioning, and cold-tier lifecycle — where each stage compounds the storage savings of the one before it, taking a typical archive from about three-fold to twelve-fold reduction.</desc>
  <g font-size="12.5" font-weight="600" text-anchor="middle">
    <!-- stage 0 -->
    <rect x="14" y="66" width="130" height="94" rx="10" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-opacity="0.35"/>
    <circle cx="79" cy="92" r="12" fill="currentColor"/>
    <text x="79" y="96" fill="var(--surface)" font-size="12">1</text>
    <text x="79" y="126" fill="currentColor">Spatial</text>
    <text x="79" y="144" fill="currentColor">dataset</text>
    <!-- stage 1 -->
    <rect x="166" y="66" width="130" height="94" rx="10" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-opacity="0.35"/>
    <circle cx="231" cy="92" r="12" fill="currentColor"/>
    <text x="231" y="96" fill="var(--surface)" font-size="12">2</text>
    <text x="231" y="126" fill="currentColor">Profile entropy</text>
    <text x="231" y="144" fill="currentColor">&amp; cardinality</text>
    <!-- stage 2 -->
    <rect x="318" y="66" width="130" height="94" rx="10" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-opacity="0.35"/>
    <circle cx="383" cy="92" r="12" fill="currentColor"/>
    <text x="383" y="96" fill="var(--surface)" font-size="12">3</text>
    <text x="383" y="126" fill="currentColor">ZSTD level</text>
    <text x="383" y="144" fill="currentColor">tuning</text>
    <!-- stage 3 -->
    <rect x="470" y="66" width="130" height="94" rx="10" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-opacity="0.35"/>
    <circle cx="535" cy="92" r="12" fill="currentColor"/>
    <text x="535" y="96" fill="var(--surface)" font-size="12">4</text>
    <text x="535" y="126" fill="currentColor">Row group</text>
    <text x="535" y="144" fill="currentColor">sizing</text>
    <!-- stage 4 -->
    <rect x="622" y="66" width="130" height="94" rx="10" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-opacity="0.35"/>
    <circle cx="687" cy="92" r="12" fill="currentColor"/>
    <text x="687" y="96" fill="var(--surface)" font-size="12">5</text>
    <text x="687" y="126" fill="currentColor">Dictionary</text>
    <text x="687" y="144" fill="currentColor">encoding</text>
    <!-- stage 5 -->
    <rect x="774" y="66" width="130" height="94" rx="10" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-opacity="0.35"/>
    <circle cx="839" cy="92" r="12" fill="currentColor"/>
    <text x="839" y="96" fill="var(--surface)" font-size="12">6</text>
    <text x="839" y="126" fill="currentColor">Spatial</text>
    <text x="839" y="144" fill="currentColor">partitioning</text>
    <!-- stage 6 -->
    <rect x="926" y="66" width="130" height="94" rx="10" fill="currentColor" fill-opacity="0.12" stroke="currentColor" stroke-opacity="0.6"/>
    <circle cx="991" cy="92" r="12" fill="currentColor"/>
    <text x="991" y="96" fill="var(--surface)" font-size="12">7</text>
    <text x="991" y="126" fill="currentColor">Cold-tier</text>
    <text x="991" y="144" fill="currentColor">lifecycle</text>
  </g>
  <g stroke="currentColor" stroke-width="2" stroke-opacity="0.55" fill="none">
    <path d="M144 113 H162" marker-end="url(#ct-arrow)"/>
    <path d="M296 113 H314" marker-end="url(#ct-arrow)"/>
    <path d="M448 113 H466" marker-end="url(#ct-arrow)"/>
    <path d="M600 113 H618" marker-end="url(#ct-arrow)"/>
    <path d="M752 113 H770" marker-end="url(#ct-arrow)"/>
    <path d="M904 113 H922" marker-end="url(#ct-arrow)"/>
  </g>
  <defs>
    <marker id="ct-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <g>
    <path d="M14 196 H1040" stroke="currentColor" stroke-width="2" stroke-opacity="0.4" marker-end="url(#ct-arrow)" fill="none"/>
    <text x="14" y="226" font-size="12.5" font-weight="600" fill="currentColor" fill-opacity="0.85" text-anchor="start">Savings compound stage by stage</text>
    <text x="1040" y="226" font-size="12.5" font-weight="700" fill="currentColor" text-anchor="end">~3&#215; &#8594; ~12&#215; total reduction</text>
  </g>
</svg>

Each stage compounds the savings of the one before it: profiling tells you how aggressively to compress, compression level interacts with row group size, row groups bound how well dictionaries pack, and partitioning determines how much of the archive a cold query has to touch at all. Treating these as a single tuning surface — rather than four independent settings — is what separates a 3x reduction from a 12x one.

## Core Concepts & Definitions

The decisions throughout this guide depend on a shared vocabulary. These terms recur in every section below:

- **GeoParquet** — a columnar storage format that encodes geometry (WKB) and attributes in separate, independently compressible columns, enabling predicate pushdown and selective decompression. It is the default cold-archive target produced by the [GeoParquet Migration Workflows](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/geoparquet-migration-workflows/) pipeline.
- **Row group** — the atomic unit of read I/O inside a Parquet file. A scan never reads less than one row group's worth of a column, so row group size sets the floor on time-to-first-byte and the granularity of statistics-based skipping.
- **ZSTD (Zstandard)** — a tunable, dictionary-capable compression codec (levels 1–22) that dominates spatial archival because it pairs high ratios with fast decompression. Level selection is covered in depth under [ZSTD Level Configuration for Spatial Files](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/zstd-level-configuration-for-spatial-files/).
- **Dictionary encoding** — a column encoding that replaces repeated values with small integer codes plus a lookup table, ideal for low-cardinality categorical GIS attributes.
- **Cardinality** — the count of distinct values in a column; the primary signal for whether dictionary encoding helps or hurts.
- **Entropy** — a measure of value unpredictability; high-entropy coordinate mantissas resist compression, while low-entropy categorical fields compress dramatically.
- **Spatial partitioning** — splitting an archive into files keyed by a discrete spatial index (H3, S2, or Quadtree) so that bounded geographic queries prune the majority of objects before any byte is fetched.
- **Cold tier** — an archival storage class (S3 Glacier Deep Archive, Azure Archive) with the lowest per-GB price but the highest retrieval latency and per-request cost, governed by the [retention policy frameworks](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/retention-policy-frameworks/) that lock objects for their mandated lifetime.
- **WORM** — write-once-read-many object locking that makes archives immutable for a compliance window.

## Cold Storage I/O Realities & Cost Drivers

Once spatial data crosses the cold threshold defined by your [hot/warm/cold tier design](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/hotwarmcold-tier-design-for-geospatial-data/), I/O patterns shift from random reads and frequent updates to sequential scans and targeted spatial predicates. Cloud object storage pricing models penalize inefficient retrieval through egress fees, per-object `GET` and restore request counts, and decompression compute overhead. Optimizing this transition requires a deliberate stack: modern columnar formats, algorithmic compression tuned to spatial entropy, and layout strategies that minimize data movement. Misaligned archives trigger unnecessary requests, inflate retrieval SLAs, and complicate compliance audits by scattering metadata across fragmented objects. Quantify each of these levers against real coefficients with the [Spatial Archive Cost Modeling](https://www.spatialdataarchival.org/spatial-archive-cost-modeling/) reference, which prices storage, retrieval, early-deletion penalties, and compression ratio as one model.

The cost model has four levers, and every section below moves at least one of them:

| Lever | What inflates it | What this guide tunes |
|-------|------------------|-----------------------|
| Per-GB storage | Weak compression ratio | ZSTD level + dictionary encoding |
| Restore / request count | Too many small objects | Row group + partition sizing |
| Egress volume | Scanning more than the query needs | Spatial partition pruning |
| Decompression compute | Over-aggressive codec level | Entropy-matched level selection |

<svg viewBox="0 0 1000 440" role="img" aria-label="Matrix of the four cold-storage cost levers and the tuning knob that controls each: per-GB storage is set by ZSTD level plus dictionary encoding; decompression compute by entropy-matched level selection; restore and request count by row-group and partition sizing; egress volume by spatial partition pruning. Two trade-off arrows show that a higher ZSTD level cuts storage but adds CPU, and that sizing balances request count against egress." xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;color:var(--primary);font-family:var(--font-sans)">
  <title>Cold-storage cost levers versus their controlling tuning knobs</title>
  <desc>Each of the four cost drivers — per-GB storage, decompression compute, restore and request count, and egress volume — is paired with the single tuning knob that moves it. Trade-off brackets mark the two tensions: raising the ZSTD level shrinks storage while adding decompression CPU, and row-group and partition sizing balances request count against egress volume.</desc>
  <g text-anchor="start">
    <text x="24" y="28" font-size="12.5" font-weight="700" fill="currentColor" fill-opacity="0.7" letter-spacing="0.04em">COST LEVER</text>
    <text x="540" y="28" font-size="12.5" font-weight="700" fill="currentColor" fill-opacity="0.7" letter-spacing="0.04em">TUNING KNOB THAT CONTROLS IT</text>
  </g>
  <!-- connectors: knob controls lever -->
  <g stroke="currentColor" stroke-width="2" stroke-opacity="0.45" fill="none">
    <path d="M540 80 H332" marker-end="url(#ct2-arrow)"/>
    <path d="M540 175 H332" marker-end="url(#ct2-arrow)"/>
    <path d="M540 295 H332" marker-end="url(#ct2-arrow)"/>
    <path d="M540 390 H332" marker-end="url(#ct2-arrow)"/>
  </g>
  <!-- lever cards -->
  <g>
    <rect x="24" y="48" width="300" height="64" rx="10" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-opacity="0.3"/>
    <text x="40" y="76" font-size="13.5" font-weight="700" fill="currentColor">Per-GB storage</text>
    <text x="40" y="96" font-size="11" fill="currentColor" fill-opacity="0.7">inflated by a weak compression ratio</text>
    <rect x="24" y="143" width="300" height="64" rx="10" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-opacity="0.3"/>
    <text x="40" y="171" font-size="13.5" font-weight="700" fill="currentColor">Decompression compute</text>
    <text x="40" y="191" font-size="11" fill="currentColor" fill-opacity="0.7">inflated by an over-aggressive codec level</text>
    <rect x="24" y="263" width="300" height="64" rx="10" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-opacity="0.3"/>
    <text x="40" y="291" font-size="13.5" font-weight="700" fill="currentColor">Restore / request count</text>
    <text x="40" y="311" font-size="11" fill="currentColor" fill-opacity="0.7">inflated by too many small objects</text>
    <rect x="24" y="358" width="300" height="64" rx="10" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-opacity="0.3"/>
    <text x="40" y="386" font-size="13.5" font-weight="700" fill="currentColor">Egress volume</text>
    <text x="40" y="406" font-size="11" fill="currentColor" fill-opacity="0.7">inflated by scanning beyond the query</text>
  </g>
  <!-- knob cards -->
  <g text-anchor="middle">
    <rect x="540" y="56" width="336" height="48" rx="10" fill="currentColor" fill-opacity="0.1" stroke="currentColor" stroke-opacity="0.45"/>
    <text x="708" y="85" font-size="13" font-weight="650" fill="currentColor">ZSTD level + dictionary encoding</text>
    <rect x="540" y="151" width="336" height="48" rx="10" fill="currentColor" fill-opacity="0.1" stroke="currentColor" stroke-opacity="0.45"/>
    <text x="708" y="180" font-size="13" font-weight="650" fill="currentColor">Entropy-matched level selection</text>
    <rect x="540" y="271" width="336" height="48" rx="10" fill="currentColor" fill-opacity="0.1" stroke="currentColor" stroke-opacity="0.45"/>
    <text x="708" y="300" font-size="13" font-weight="650" fill="currentColor">Row-group + partition sizing</text>
    <rect x="540" y="366" width="336" height="48" rx="10" fill="currentColor" fill-opacity="0.1" stroke="currentColor" stroke-opacity="0.45"/>
    <text x="708" y="395" font-size="13" font-weight="650" fill="currentColor">Spatial partition pruning</text>
  </g>
  <!-- trade-off brackets -->
  <g stroke="currentColor" stroke-width="1.6" stroke-opacity="0.6" stroke-dasharray="4 3" fill="none">
    <path d="M876 80 H912 V175 H876" marker-start="url(#ct2-arrow)" marker-end="url(#ct2-arrow)"/>
    <path d="M876 295 H912 V390 H876" marker-start="url(#ct2-arrow)" marker-end="url(#ct2-arrow)"/>
  </g>
  <g font-size="10.5" font-weight="600" text-anchor="middle" fill="currentColor" fill-opacity="0.85">
    <text transform="rotate(-90 934 127)" x="934" y="127">level &#8593;: &#8722;storage / +CPU</text>
    <text transform="rotate(-90 934 342)" x="934" y="342">sizing: requests &#8596; egress</text>
  </g>
  <defs>
    <marker id="ct2-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
</svg>

## Algorithmic Compression & Entropy Profiling

Compression is the primary lever for reducing cold storage footprint. General-purpose algorithms rarely align with the structural characteristics of coordinate arrays, topology graphs, or categorical GIS attributes. Zstandard has emerged as the default for spatial workloads due to its tunable compression levels, dictionary support, and fast decompression. Applying a blanket compression level across heterogeneous datasets, however, wastes CPU cycles during archival or leaves storage savings on the table. Profiling coordinate variance, attribute cardinality, and temporal density lets teams assign an optimal compression tier per dataset class, ensuring predictable decompression throughput during cold retrieval. The full entropy-driven tuning matrices and CLI validation workflows live in [ZSTD Level Configuration for Spatial Files](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/zstd-level-configuration-for-spatial-files/).

```bash
# Train a ZSTD dictionary on a coordinate sample, then compress with it
zstd --train datasets/lidar/2023/coords_sample.bin -o dicts/spatial_dict.zdict
zstd -D dicts/spatial_dict.zdict -19 -c datasets/lidar/2023/raw_coords.bin \
  > archive/lidar/2023/compressed_coords.bin
```

A practical heuristic: profile before you pick a level. Coordinate columns whose low-order mantissa bits are effectively random gain almost nothing above level 12 and only burn CPU; categorical and temporal columns keep improving toward level 19. Splitting a dataset by column entropy and compressing each group at its own level is the single highest-leverage decision in the pipeline.

## Columnar Layout & Row Group Architecture

Columnar formats like GeoParquet decouple geometry from attributes, enabling selective decompression and predicate pushdown. Yet the physical layout within those columns dictates cold retrieval efficiency. Row groups act as the fundamental unit of I/O in cloud object stores. Oversized groups increase memory pressure during partial scans and delay time-to-first-byte; undersized groups inflate metadata overhead, increase API request volume, and fragment compression dictionaries. The sizing model in [Row Group Sizing Strategies](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/row-group-sizing-strategies/) aligns groups with typical cold-query scan windows (commonly 128–256 MB compressed per group) while respecting cloud storage chunk boundaries.

```python
# PyArrow row group sizing for cold storage optimization
import pyarrow.parquet as pq

pq.write_table(
    geospatial_table,
    "s3://geo-archive/parquet/lidar/2023/region_north.parquet",
    row_group_size=1_000_000,   # rows per group, tuned toward a ~128 MB target
    compression="zstd",
    compression_level=19,
    use_dictionary=True,
    write_statistics=True,       # min/max stats enable row-group skipping
)
```

The `write_statistics=True` flag is what makes row groups useful for cold queries: per-group min/max statistics let an engine skip groups whose bounding values fall outside a spatial or temporal predicate, turning a full-file restore into a handful of ranged reads.

## Attribute Encoding & Dictionary Optimization

Categorical fields — land use codes, sensor IDs, jurisdictional boundaries — dominate GIS attribute tables. When cardinality remains low, dictionary encoding drastically reduces storage overhead and accelerates equality predicates. High-cardinality fields, by contrast, degrade dictionary efficiency and increase decode latency. The cardinality thresholds and fallback strategies in [Dictionary Encoding for GIS Attributes](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/dictionary-encoding-for-gis-attributes/) prevent decompression bottlenecks during compliance-driven attribute scans.

```python
# Force dictionary encoding only on low-cardinality categorical columns,
# leaving high-cardinality IDs to plain ZSTD to avoid dictionary bloat.
import pyarrow.parquet as pq

pq.write_table(
    geospatial_table,
    "s3://geo-archive/parquet/parcels/2024/landuse.parquet",
    compression="zstd",
    use_dictionary=["land_use_code", "zoning_class", "jurisdiction"],
    column_encoding={"parcel_uuid": "PLAIN"},   # high cardinality: skip dictionary
    write_statistics=True,
)
```

The rule of thumb that drives the explicit list above: enable dictionary encoding when a column's distinct-value count stays under roughly 10–20% of its row count, and disable it for unique identifiers where the dictionary would be as large as the data it replaces.

## Spatial Partitioning & Physical Layout

Partitioning is the first line of defense against full-archive scans. Spatial partitioning techniques such as H3 hexagons, S2 cells, or Quadtree grids align physical file boundaries with geographic query extents. Combined with temporal partitioning (for example `year/month`), partition pruning eliminates the majority of unnecessary object retrievals before a single byte leaves cold storage. The implementation patterns in [Spatial Partitioning Techniques](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/spatial-partitioning-techniques/) reduce egress and request costs while keeping retrieval paths deterministic for audit trails.

```python
# Partition a GeoParquet archive by H3 cell and year so cold queries
# prune to a bounded set of objects before any restore is issued.
import h3
import pyarrow.dataset as ds

def h3_partition(lat, lon, res=6):
    return h3.latlng_to_cell(lat, lon, res)

geospatial_table = geospatial_table.append_column(
    "h3_r6",
    [[h3_partition(lat, lon) for lat, lon in coords]],
)

ds.write_dataset(
    geospatial_table,
    base_dir="s3://geo-archive/parquet/sensors/",
    format="parquet",
    partitioning=ds.partitioning(
        flavor="hive", field_names=["h3_r6", "year"]
    ),
)
```

Partition resolution is itself a tuning decision: too coarse and each partition is a multi-gigabyte restore; too fine and metadata and small-object overhead dominate. Resolution 6–7 H3 cells map well to regional query extents for most archival workloads.

## Cross-Cutting Infrastructure & IaC Enforcement

Production readiness requires automated lifecycle transitions governed by infrastructure-as-code rather than console clicks. Storage-class transitions, retention windows, and compliance tags must be declared once and enforced continuously. The reference Terraform below transitions GeoParquet archives to Glacier Deep Archive after 90 days, scopes the rule to a prefix-and-tag filter, and applies an Object Lock so the data cannot be deleted inside its retention window:

```hcl
resource "aws_s3_bucket_lifecycle_configuration" "spatial_cold_tier" {
  bucket = var.spatial_archive_bucket
  rule {
    id     = "geo-archive-to-deep-archive"
    status = "Enabled"
    transition {
      days          = 90
      storage_class = "DEEP_ARCHIVE"
    }
    # Combine a prefix and a tag with an `and` block.
    filter {
      and {
        prefix = "geospatial/parquet/"
        tags = {
          compliance_retention = "7y"
        }
      }
    }
  }
}

# Object Lock is its own resource, not a lifecycle sub-block.
resource "aws_s3_bucket_object_lock_configuration" "spatial_cold_tier" {
  bucket = var.spatial_archive_bucket
  rule {
    default_retention {
      mode = "GOVERNANCE"
      days = 2555 # ~7 years
    }
  }
}
```

Two cross-cutting realities shape these choices. First, **egress and restore pricing dominate cold economics**: Deep Archive storage is cheap, but bulk restores and egress are not, which is why the partitioning and row-group work above pays for itself by shrinking how much you ever retrieve. Second, **vendor compatibility is not symmetric** — Glacier Deep Archive, Azure Archive, and GCS Archive differ in minimum-storage-duration penalties and restore tiers, so the object-store decision documented under [object storage selection for GIS archives](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/object-storage-selection-for-gis-archives/) should be made before compression parameters are frozen. For the authoritative tiering and restore-fee constraints, consult the [AWS S3 lifecycle management documentation](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lifecycle-mgmt.html).

## Compliance & Retention Integration

Compression and layout decisions intersect retention mandates more often than teams expect. Object Lock in `GOVERNANCE` or `COMPLIANCE` mode enforces immutability for windows set by mandates such as SEC Rule 17a-4 or GDPR retention limits, and those locks must survive any re-compression or re-partitioning job. That constraint means optimization is mostly a write-time decision: once an object is locked, you cannot rewrite it at a better compression level until its retention expires, so the tuning has to be correct before the lock is applied. Equally, partition boundaries should align with audit scopes — a legal-hold or jurisdiction-scoped audit becomes a single deterministic restore when partitioning follows the audit's geographic and temporal seams instead of cutting across them. The [retention policy frameworks](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/retention-policy-frameworks/) section details how to express these windows as code, and metadata captured during conversion — including the source CRS preserved by [CRS synchronization in pipelines](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/crs-synchronization-in-pipelines/) — is what keeps a locked archive provably faithful to its source.

## Operational Execution Checklist

Work through these steps when promoting a spatial dataset into optimized cold storage:

- [ ] Profile each column for entropy and cardinality before choosing any codec level
- [ ] Split columns into compression groups and assign a ZSTD level per group
- [ ] Set `row_group_size` toward a ~128 MB compressed target and enable `write_statistics`
- [ ] Enable dictionary encoding only on columns below the cardinality threshold; force `PLAIN` on unique IDs
- [ ] Choose an H3/S2/Quadtree partition resolution aligned to typical query extents
- [ ] Add temporal partitioning (`year/month`) where queries are time-bounded
- [ ] Declare the lifecycle transition and Object Lock as infrastructure-as-code
- [ ] Verify retention mode and window match the governing regulatory mandate
- [ ] Confirm source CRS and attribute schema were preserved during conversion
- [ ] Run a sample cold restore and measure time-to-first-byte against your SLA

## Conclusion

Cold storage optimization for geospatial data is not a static configuration but a continuous alignment of compression, layout, indexing, and governance. By profiling spatial entropy, enforcing row group boundaries, applying dictionary thresholds, and automating lifecycle transitions, organizations achieve predictable retrieval SLAs, audit-ready archives, and sustainable cost structures. For the format-level specification that underpins every decision above, consult the [Apache Parquet documentation](https://parquet.apache.org/docs/) to ensure compliance across ingestion pipelines.

## Related

- [ZSTD Level Configuration for Spatial Files](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/zstd-level-configuration-for-spatial-files/) — entropy-driven level matrices and CPU-vs-ratio trade-offs for coordinate and attribute columns.
- [Row Group Sizing Strategies](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/row-group-sizing-strategies/) — sizing row groups to cold-query scan windows and storage chunk boundaries.
- [Dictionary Encoding for GIS Attributes](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/dictionary-encoding-for-gis-attributes/) — cardinality thresholds and fallback encodings for categorical fields.
- [Spatial Partitioning Techniques](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/spatial-partitioning-techniques/) — H3, S2, and Quadtree layouts that enable partition pruning on cold reads.
- [Spatial Archive Cost Modeling](https://www.spatialdataarchival.org/spatial-archive-cost-modeling/) — the pricing, early-deletion penalty, and compression-ratio tables that turn these layout choices into a defensible budget.
- [Format Conversion & Pipeline Automation](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/) — the conversion and validation stage that produces the GeoParquet inputs this optimization assumes.
- [Spatial Archival Architecture & Tiering Strategy](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/) — the parent tiering model that defines when data becomes eligible for cold-tier optimization.

Up one level: [Spatial Data Archival & Cold Storage Optimization](https://www.spatialdataarchival.org/).
