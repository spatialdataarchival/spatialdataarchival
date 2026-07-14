# GeoParquet vs FlatGeobuf for Cold-Archive Retrieval

Choosing between GeoParquet and FlatGeobuf for a cold spatial archive is a decision about access pattern, not file size: GeoParquet's columnar layout and per-row-group statistics win analytical scans that touch few columns across many features, while FlatGeobuf's packed Hilbert R-tree and HTTP range streaming win feature-by-bounding-box reads served straight from object storage. Both are cloud-native, both read anywhere GDAL runs, and both beat legacy shapefiles for archival — but they optimize opposite retrieval shapes, and picking the wrong one turns a penny range request into a multi-gigabyte download. This decision guide is for the data engineers and cloud architects who must commit an archive to one format per access tier under the [Format Conversion & Pipeline Automation](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/) framework, weighing predicate pushdown, index structure, compression, and tooling against how each dataset is actually retrieved.

## Framing the Decision

Cold-archive retrieval is dominated by two workloads that pull the format choice in opposite directions. The first is the analytical scan: "sum the burned area across every wildfire polygon in the 2015–2023 archive," which reads two or three columns from millions of features and never materializes geometry. The second is the point read: "fetch the parcels intersecting this map viewport," which needs whole features inside a small bounding box and nothing else. A columnar format serves the first for the cost of reading a few column chunks; a spatially indexed feature format serves the second for the cost of an R-tree descent plus a few range requests. The mistake is committing an archive to one format before profiling which workload dominates — or worse, assuming one format can be optimal for both. The tiering logic here mirrors the broader [hot/warm/cold tier design for geospatial data](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/hotwarmcold-tier-design-for-geospatial-data/): access pattern, not age alone, drives the layout.

## Head-to-Head Comparison

The two formats differ on every axis that matters for retrieval economics:

<svg viewBox="0 0 860 366" role="img" aria-label="GeoParquet versus FlatGeobuf comparison matrix across eight dimensions. Physical layout: GeoParquet is columnar, FlatGeobuf is row-oriented per feature. Spatial index: GeoParquet uses row-group bounding-box statistics, FlatGeobuf uses a packed Hilbert R-tree. Best access pattern: GeoParquet favors analytical column scans, FlatGeobuf favors feature-by-bounding-box reads. Compression: GeoParquet applies strong per-column ZSTD, FlatGeobuf is lighter with packed geometry. HTTP range read: GeoParquet at row-group granularity, FlatGeobuf per feature streaming. Predicate pushdown: GeoParquet strong on columns and statistics, FlatGeobuf spatial bounding box only. Partial column read: GeoParquet yes via projection, FlatGeobuf no whole feature. Tooling: GeoParquet with DuckDB, Arrow, and GDAL, FlatGeobuf with GDAL and web mapping libraries." xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;color:var(--primary);font-family:var(--font-sans)">
  <title>GeoParquet versus FlatGeobuf retrieval comparison matrix</title>
  <desc>An eight-row matrix comparing GeoParquet and FlatGeobuf across physical layout, spatial index, best access pattern, compression, HTTP range read granularity, predicate pushdown, partial column read, and tooling. GeoParquet leads on analytical and columnar dimensions; FlatGeobuf leads on per-feature spatial reads and streaming.</desc>
  <rect x="10" y="10" width="840" height="36" fill="currentColor" fill-opacity="0.07"/>
  <rect x="10" y="10" width="840" height="346" fill="none" stroke="currentColor" stroke-width="1.2" stroke-opacity="0.5"/>
  <line x1="300" y1="10" x2="300" y2="356" stroke="currentColor" stroke-width="1" stroke-opacity="0.3"/>
  <line x1="580" y1="10" x2="580" y2="356" stroke="currentColor" stroke-width="1" stroke-opacity="0.3"/>
  <line x1="10" y1="46" x2="850" y2="46" stroke="currentColor" stroke-width="1" stroke-opacity="0.3"/>
  <line x1="10" y1="84" x2="850" y2="84" stroke="currentColor" stroke-width="1" stroke-opacity="0.3"/>
  <line x1="10" y1="122" x2="850" y2="122" stroke="currentColor" stroke-width="1" stroke-opacity="0.3"/>
  <line x1="10" y1="160" x2="850" y2="160" stroke="currentColor" stroke-width="1" stroke-opacity="0.3"/>
  <line x1="10" y1="198" x2="850" y2="198" stroke="currentColor" stroke-width="1" stroke-opacity="0.3"/>
  <line x1="10" y1="236" x2="850" y2="236" stroke="currentColor" stroke-width="1" stroke-opacity="0.3"/>
  <line x1="10" y1="274" x2="850" y2="274" stroke="currentColor" stroke-width="1" stroke-opacity="0.3"/>
  <line x1="10" y1="312" x2="850" y2="312" stroke="currentColor" stroke-width="1" stroke-opacity="0.3"/>
  <g text-anchor="start">
    <text x="20" y="32" font-size="11" font-weight="700" fill="currentColor">Dimension</text>
    <text x="310" y="32" font-size="11" font-weight="700" fill="currentColor">GeoParquet</text>
    <text x="590" y="32" font-size="11" font-weight="700" fill="currentColor">FlatGeobuf</text>
    <!-- rows -->
    <text x="20" y="69" font-size="10.5" fill="currentColor">Physical layout</text>
    <text x="310" y="69" font-size="10" fill="currentColor">columnar (Parquet)</text>
    <text x="590" y="69" font-size="10" fill="currentColor">row-oriented per feature</text>
    <text x="20" y="107" font-size="10.5" fill="currentColor">Spatial index</text>
    <text x="310" y="107" font-size="10" fill="currentColor">row-group bbox stats</text>
    <text x="590" y="107" font-size="10" fill="currentColor">packed Hilbert R-tree</text>
    <text x="20" y="145" font-size="10.5" fill="currentColor">Best access pattern</text>
    <text x="310" y="145" font-size="10" fill="currentColor">analytical column scans</text>
    <text x="590" y="145" font-size="10" fill="currentColor">feature-by-bbox reads</text>
    <text x="20" y="183" font-size="10.5" fill="currentColor">Compression</text>
    <text x="310" y="183" font-size="10" fill="currentColor">strong per-column ZSTD</text>
    <text x="590" y="183" font-size="10" fill="currentColor">lighter, packed geometry</text>
    <text x="20" y="221" font-size="10.5" fill="currentColor">HTTP range read</text>
    <text x="310" y="221" font-size="10" fill="currentColor">row-group granularity</text>
    <text x="590" y="221" font-size="10" fill="currentColor">per-feature streaming</text>
    <text x="20" y="259" font-size="10.5" fill="currentColor">Predicate pushdown</text>
    <text x="310" y="259" font-size="10" fill="currentColor">strong (column + stats)</text>
    <text x="590" y="259" font-size="10" fill="currentColor">spatial bbox only</text>
    <text x="20" y="297" font-size="10.5" fill="currentColor">Partial column read</text>
    <text x="310" y="297" font-size="10" fill="currentColor">yes (projection)</text>
    <text x="590" y="297" font-size="10" fill="currentColor">no (whole feature)</text>
    <text x="20" y="335" font-size="10.5" fill="currentColor">Tooling</text>
    <text x="310" y="335" font-size="10" fill="currentColor">DuckDB &#183; Arrow &#183; GDAL</text>
    <text x="590" y="335" font-size="10" fill="currentColor">GDAL &#183; web mapping libs</text>
  </g>
</svg>

## Per-Dimension Analysis

### Physical layout and partial reads

GeoParquet stores each attribute in its own contiguous column chunk, so a query that needs `burn_area_ha` and `fire_year` reads exactly those two chunks and skips the geometry entirely. That projection is impossible in FlatGeobuf, where every feature is a self-contained record: reading one attribute means paging in the whole feature, geometry included. For an analytical scan over a wide attribute table, this is the single largest difference in bytes transferred — often an order of magnitude — because cold-storage cost is dominated by what you move, not what you store. FlatGeobuf's row orientation is the correct trade only when you genuinely want the whole feature.

### Index structure and the point-read path

FlatGeobuf embeds a packed Hilbert R-tree in the file header, laid out so a bounding-box query resolves to a small set of byte ranges without a full scan. A client issues one range request for the index, walks it, then issues range requests for the matching feature bytes — three or four round trips to pull the parcels in a viewport, straight from S3 with no server. GeoParquet's spatial "index" is coarser: per-row-group bounding-box statistics let a reader skip row groups that cannot intersect the query, but within a surviving row group it still scans. If your row groups are spatially clustered — the payoff of [spatial partitioning techniques](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/spatial-partitioning-techniques/) — this pruning is effective for regional filters, but it will never match FlatGeobuf's per-feature precision for a tight bbox over a dense layer.

### Compression and cold-storage footprint

Columnar storage compresses better because a column is a run of like-typed, often low-cardinality values — exactly what dictionary and ZSTD encoders exploit. A GeoParquet archive of categorical vector data routinely lands well under half the size of the equivalent FlatGeobuf, and the ratio widens as you tune the encoder; the level-versus-latency trade-off is laid out in [ZSTD level configuration for spatial files](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/zstd-level-configuration-for-spatial-files/). FlatGeobuf compresses its geometry buffer efficiently but cannot reach columnar ratios on attributes, because each feature interleaves fields of different types. For a deep-archive tier billed purely on stored bytes, GeoParquet's footprint advantage is decisive; for a warm tier billed on retrieval, footprint matters less than range-read efficiency.

### Streaming and serverless retrieval

FlatGeobuf was designed to stream: a reader can begin emitting features before the whole file arrives, and the format is a first-class citizen of browser mapping stacks that fetch directly from object storage over HTTP range requests. That makes it the natural archive format when the retrieval client is a map, not a query engine, and there is no compute layer between the bucket and the user. GeoParquet retrieval assumes a reader that understands row groups and statistics — DuckDB, Arrow, GDAL, or a Spark job — so it shines when a serverless SQL engine sits in front of the archive, and is awkward when the consumer is a thin web client. The optimization details for the streaming path are covered under [FlatGeobuf optimization techniques](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/flatgeobuf-optimization-techniques/), and the columnar migration path under [GeoParquet migration workflows](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/geoparquet-migration-workflows/).

### Tooling and durability

Both formats are open and GDAL-native, so neither is a lock-in risk. GeoParquet inherits the entire Parquet and Arrow ecosystem — DuckDB, pandas, Spark, cloud query services — which is a large advantage for analytical archives and for interoperability with non-spatial data lakes. FlatGeobuf's ecosystem is narrower and mapping-centric, but its specification is simpler, which some archivists weigh as a durability argument for a format that must remain readable for decades. Both are backed by public specifications; verify writer conformance against the [GeoParquet specification](https://geoparquet.org/) and the [FlatGeobuf specification](https://flatgeobuf.org/) before committing an archive.

## Recommendation by Scenario

**Analytical archive queried by SQL — choose GeoParquet.** When the dominant workload is aggregations, filters, and joins across many features touching few columns — climate model outputs, census-scale demographics, sensor time series — the columnar layout and predicate pushdown make GeoParquet the clear winner, and its compression minimizes the deep-archive bill.

**Web-map archive served straight from object storage — choose FlatGeobuf.** When retrieval means "give me the features in this viewport" and the client is a browser hitting a bucket with no query engine in between, FlatGeobuf's packed R-tree and range streaming deliver sub-second bbox reads that GeoParquet cannot match on a dense layer.

**Mixed archive with both patterns — dual-encode by tier.** Keep the authoritative copy as partitioned GeoParquet in the cold, cost-optimized tier for analytics and long-term preservation, and derive a FlatGeobuf copy into a warm, retrieval-optimized tier for the map-serving path. The GeoParquet partition boundary maps cleanly onto the FlatGeobuf tiles, so the derivation is deterministic, and each tier's storage class is chosen against its real access economics rather than a single compromise.

**Uncertain or evolving access pattern — default to GeoParquet.** Its broader tooling and superior compression make it the safer default when you cannot yet profile the workload; a FlatGeobuf derivative can always be generated later from the columnar master, whereas reconstructing columnar statistics from FlatGeobuf is a full rewrite.

Before committing either choice at scale, model the retrieval side — request counts, egress, and restore fees — with [spatial archive cost modeling](https://www.spatialdataarchival.org/spatial-archive-cost-modeling/), because for cold data the retrieval bill, not the storage bill, usually decides the winner.

## Validating the Choice on Real Data

Before standardizing a format, benchmark both against a representative sample and measure bytes transferred, not just wall-clock time. Encode the same layer each way, then run each format's characteristic query directly against object storage:

```bash
# GeoParquet: analytical scan touching two columns, projection pushdown
duckdb -c "
  INSTALL httpfs; LOAD httpfs; INSTALL spatial; LOAD spatial;
  SELECT fire_year, sum(burn_area_ha) AS total_ha
  FROM read_parquet('s3://spatial-archive/fire/geoparquet/**/*.parquet')
  GROUP BY fire_year ORDER BY fire_year;"

# FlatGeobuf: bounding-box feature read, R-tree range requests only
ogr2ogr -f GPKG /vsimem/viewport.gpkg \
  /vsis3/spatial-archive/fire/fire_perimeters.fgb \
  -spat -122.6 37.7 -122.3 37.9 -progress
```

Expected shape of the result — the GeoParquet scan returns an aggregate having read only two column chunks, confirming projection pushdown worked:

```text
┌───────────┬───────────┐
│ fire_year │ total_ha  │
├───────────┼───────────┤
│   2015    │  184203.5 │
│   2016    │  201884.1 │
└───────────┴───────────┘
```

Compare the bytes each retrieval moved — enable request logging on the bucket — and let the transfer volume, weighted by your real query mix, settle the decision.

## Troubleshooting Format Selection

| Symptom | Cause | Fix |
|---------|-------|-----|
| GeoParquet bbox reads scan far more than expected | Row groups are not spatially clustered, so statistics prune poorly | Sort by a spatial key and re-write with smaller row groups before archiving |
| FlatGeobuf analytical scan transfers the whole file | Row-oriented layout has no column projection | Move analytics to a GeoParquet copy; keep FlatGeobuf only for bbox reads |
| GeoParquet retrieval needs a running engine users lack | Consumers are thin web clients, not query engines | Derive a FlatGeobuf tier for direct-from-bucket map serving |
| Deep-archive bill higher than modeled | FlatGeobuf attribute compression trails columnar | Store the preservation master as GeoParquet; treat FlatGeobuf as a derived access copy |

## Operational Execution Checklist

- [ ] Profile the archive's real retrieval mix — analytical scans versus bounding-box feature reads — before choosing a format.
- [ ] Default to GeoParquet for SQL-driven analytical archives and for the cost-optimized preservation master.
- [ ] Choose FlatGeobuf when a browser or thin client reads features by bbox directly from object storage with no query engine.
- [ ] For mixed workloads, dual-encode: partitioned GeoParquet master plus a derived FlatGeobuf access tier.
- [ ] Spatially cluster and size row groups so GeoParquet statistics prune effectively for regional filters.
- [ ] Benchmark both encodings on a representative sample and compare bytes transferred, not wall-clock time.
- [ ] Model retrieval, egress, and restore fees before standardizing, since the retrieval bill usually decides cold-data winners.

## Related

- Up: [Format Conversion & Pipeline Automation](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/) — the parent reference for the conversion pipelines that produce both formats.
- [Converting Legacy Shapefiles to GeoParquet at Scale](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/geoparquet-migration-workflows/converting-legacy-shapefiles-to-geoparquet-at-scale/) — the columnar migration path for the GeoParquet side of this decision.
- [Optimizing FlatGeobuf for Web Mapping Archives](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/flatgeobuf-optimization-techniques/optimizing-flatgeobuf-for-web-mapping-archives/) — tuning the packed R-tree and streaming path for the FlatGeobuf side.
- [Tuning ZSTD Compression for GeoParquet Archives](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/zstd-level-configuration-for-spatial-files/tuning-zstd-compression-for-geoparquet-archives/) — compression tuning that widens GeoParquet's footprint advantage.
- [Spatial Archive Cost Modeling](https://www.spatialdataarchival.org/spatial-archive-cost-modeling/) — modeling the retrieval and storage economics that ultimately settle the format choice.

_Part of the [Spatial Data Archival](https://www.spatialdataarchival.org/) knowledge base._
