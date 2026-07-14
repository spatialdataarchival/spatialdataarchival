# Partitioning GeoParquet by H3 Spatial Index

Partitioning a GeoParquet archive by H3 cell turns a directory of opaque columnar files into a spatially prunable dataset, where a query engine reads only the partitions whose hexagons intersect a bounding box instead of scanning every object in cold storage. This guide is for data engineers and GIS archivists who need a deterministic, cold-storage-aware partition scheme: choosing an H3 resolution that balances predicate-pushdown selectivity against a cloud provider's minimum-object-size billing, deriving stable cell keys from geometry centroids, and writing a Hive-style `h3_cell=` layout that DuckDB, GDAL, and pyarrow can prune without opening files. Default writers ignore this entirely — they emit a flat file set with no partition column, so every spatial filter degrades into a full-archive scan. It operates under the [Format Conversion & Pipeline Automation](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/) framework and extends the batch [GeoParquet Migration Workflows](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/geoparquet-migration-workflows/) reference with a partition-key strategy tuned for archival economics.

## Why H3 for Archive Partitioning

H3 is a hierarchical hexagonal grid: every cell has exactly one parent at the next-coarser resolution, so a partition scheme built on it is reprojectable up the hierarchy without recomputing keys from geometry. Hexagons also have uniform neighbor distance — unlike a quadkey grid, adjacent cells are equidistant, which keeps a radius query from fetching a lopsided set of partitions. The single decision that governs everything downstream is **resolution**: it fixes cell area, and therefore the feature count and byte size of each partition file.

<svg viewBox="0 0 840 232" role="img" aria-label="H3 resolution selection matrix for archive partitioning. Resolution 3: average cell area about 12,400 square kilometres, coarse pruning, oversized multi-gigabyte files. Resolution 4: about 1,770 square kilometres, good regional pruning, 200 megabyte to 1 gigabyte files, the recommended default for continental archives. Resolution 5: about 252 square kilometres, fine pruning, 30 to 200 megabyte files. Resolution 6: about 36 square kilometres, very fine pruning, sub-30-megabyte files that fall below the cold-storage minimum object size and bloat the file count." xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;color:var(--primary);font-family:var(--font-sans)">
  <title>H3 resolution versus partition file size trade-off</title>
  <desc>A four-row matrix mapping H3 resolution to average cell area, pruning granularity, and typical partition file size. Coarse resolutions yield oversized files with weak pruning; fine resolutions prune well but produce tiny objects that fall below cold-storage minimum billing. Resolution 4 is highlighted as the balanced default.</desc>
  <rect x="10" y="10" width="820" height="34" fill="currentColor" fill-opacity="0.07"/>
  <rect x="10" y="10" width="820" height="212" fill="none" stroke="currentColor" stroke-width="1.2" stroke-opacity="0.5"/>
  <line x1="120" y1="10" x2="120" y2="222" stroke="currentColor" stroke-width="1" stroke-opacity="0.3"/>
  <line x1="300" y1="10" x2="300" y2="222" stroke="currentColor" stroke-width="1" stroke-opacity="0.3"/>
  <line x1="500" y1="10" x2="500" y2="222" stroke="currentColor" stroke-width="1" stroke-opacity="0.3"/>
  <line x1="10" y1="44" x2="830" y2="44" stroke="currentColor" stroke-width="1" stroke-opacity="0.3"/>
  <line x1="10" y1="88" x2="830" y2="88" stroke="currentColor" stroke-width="1" stroke-opacity="0.3"/>
  <line x1="10" y1="132" x2="830" y2="132" stroke="currentColor" stroke-width="1" stroke-opacity="0.3"/>
  <line x1="10" y1="176" x2="830" y2="176" stroke="currentColor" stroke-width="1" stroke-opacity="0.3"/>
  <!-- highlight res 4 row -->
  <rect x="10" y="88" width="820" height="44" fill="currentColor" fill-opacity="0.09"/>
  <g font-family="var(--font-sans)">
    <text x="20" y="32" font-size="11" font-weight="700" fill="currentColor">Resolution</text>
    <text x="130" y="32" font-size="11" font-weight="700" fill="currentColor">Avg cell area</text>
    <text x="310" y="32" font-size="11" font-weight="700" fill="currentColor">Pruning granularity</text>
    <text x="510" y="32" font-size="11" font-weight="700" fill="currentColor">Typical partition file</text>
    <!-- res 3 -->
    <text x="20" y="71" font-size="12" font-weight="600" fill="currentColor">res 3</text>
    <text x="130" y="71" font-size="10.5" fill="currentColor">~12,400 km&#178;</text>
    <text x="310" y="71" font-size="10.5" fill="currentColor">coarse &#183; whole regions</text>
    <text x="510" y="71" font-size="10.5" fill="currentColor" fill-opacity="0.8">multi-GB &#183; weak pushdown</text>
    <!-- res 4 highlighted -->
    <text x="20" y="115" font-size="12" font-weight="700" fill="currentColor">res 4</text>
    <text x="130" y="115" font-size="10.5" font-weight="600" fill="currentColor">~1,770 km&#178;</text>
    <text x="310" y="115" font-size="10.5" font-weight="600" fill="currentColor">regional &#183; balanced</text>
    <text x="510" y="115" font-size="10.5" font-weight="600" fill="currentColor">200 MB&#8211;1 GB &#183; default</text>
    <!-- res 5 -->
    <text x="20" y="159" font-size="12" font-weight="600" fill="currentColor">res 5</text>
    <text x="130" y="159" font-size="10.5" fill="currentColor">~252 km&#178;</text>
    <text x="310" y="159" font-size="10.5" fill="currentColor">fine &#183; metro-scale</text>
    <text x="510" y="159" font-size="10.5" fill="currentColor" fill-opacity="0.8">30&#8211;200 MB</text>
    <!-- res 6 -->
    <text x="20" y="203" font-size="12" font-weight="600" fill="currentColor">res 6</text>
    <text x="130" y="203" font-size="10.5" fill="currentColor">~36 km&#178;</text>
    <text x="310" y="203" font-size="10.5" fill="currentColor">very fine</text>
    <text x="510" y="203" font-size="10.5" fill="currentColor" fill-opacity="0.8">&#60;30 MB &#183; file-count bloat</text>
  </g>
</svg>

The resolution you pick is a storage-economics decision as much as a query one, so make it against the same cold-tier minimums that drive [Hot/Warm/Cold Tier Design for Geospatial Data](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/hotwarmcold-tier-design-for-geospatial-data/) — pick the coarsest resolution whose median file still clears the tier's minimum billable object size.

## Sizing the Resolution Against Cold-Storage Minimums

Cold classes bill a minimum object size and a minimum retention duration regardless of the bytes you actually store. AWS Glacier Deep Archive rounds every object up to a 128 KB billable floor and adds a per-object overhead, so a partition scheme that shatters a dataset into millions of sub-megabyte files pays overhead on every one and cripples restore throughput. The countervailing pressure is pushdown: coarser cells mean fewer, larger files, so a tight bounding-box query still drags in gigabytes of irrelevant features.

Compute the resolution empirically rather than guessing. Sample the feature density of the source, project a per-cell byte estimate at each candidate resolution, and pick the coarsest one whose median file lands in your target range (a common archival target is 200 MB–1 GB per object, large enough to amortize per-object overhead, small enough to parallelize restore).

```python
import h3
import geopandas
import numpy as np

# Sample 1% of a large source to estimate per-cell feature density.
sample = geopandas.read_parquet("s3://spatial-archive/staging/parcels_sample.parquet")
centroids = sample.geometry.to_crs(4326).centroid
avg_bytes_per_feature = 320  # measured: WKB geometry + attribute columns, post-ZSTD

for res in (3, 4, 5, 6):
    cells = [h3.latlng_to_cell(pt.y, pt.x, res) for pt in centroids]
    counts = np.array(list({c: cells.count(c) for c in set(cells)}.values()))
    # scale the 1% sample up to the full population
    est_features = counts * 100
    est_mb = est_features * avg_bytes_per_feature / 1_048_576
    print(f"res={res}: partitions={len(counts):>6d}  "
          f"median_file={np.median(est_mb):8.1f} MB  p95={np.percentile(est_mb,95):8.1f} MB")
```

Read the output as a curve: resolution is right when the median file clears your cold-tier floor and the p95 file stays under the restore-parallelism ceiling you can tolerate. If the p95 is an order of magnitude above the median, the data is spatially skewed (dense urban cells, empty ocean cells) and a single global resolution will not fit — see the mitigation below.

## Deriving Stable Cell Keys and Writing the Layout

Derive the H3 index from the geometry **centroid in EPSG:4326**, because H3 is defined on the WGS84 sphere and `latlng_to_cell` expects geographic coordinates. Deriving from a projected CRS silently places features in the wrong cell. Pin the CRS explicitly — the same discipline enforced by [CRS Synchronization in Pipelines](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/crs-synchronization-in-pipelines/) — and store the resolution in the archive manifest so future writers reproduce identical keys.

```python
import json
import geopandas
import pyarrow as pa
import pyarrow.parquet as pq

H3_RES = 4  # pinned in the archive manifest; never change without a full repartition

def write_h3_partitioned(src: str, dst_root: str, crs_epsg: int = 4326):
    gdf = geopandas.read_parquet(src)
    # Centroid in EPSG:4326 is the ONLY correct input to H3.
    centroids = gdf.geometry.to_crs(4326).centroid
    gdf["h3_cell"] = [h3.latlng_to_cell(p.y, p.x, H3_RES) for p in centroids]

    geo_meta = {
        "version": "1.1.0",
        "primary_column": "geometry",
        "columns": {"geometry": {"encoding": "WKB",
                                  "geometry_types": sorted(gdf.geom_type.unique().tolist()),
                                  "crs": f"EPSG:{crs_epsg}"}},
    }
    gdf["geometry"] = gdf.geometry.to_wkb()

    for cell, part in gdf.groupby("h3_cell"):
        table = pa.Table.from_pandas(part, preserve_index=False)
        table = table.replace_schema_metadata({b"geo": json.dumps(geo_meta).encode()})
        # Hive-style directory: the engine reads h3_cell from the path, not the file.
        out = f"{dst_root}/h3_cell={cell}/part-0000.parquet"
        pq.write_table(table, out, compression="zstd", compression_level=3,
                       row_group_size=100_000)
```

The written tree is Hive-partitioned: `s3://spatial-archive/parcels/h3_cell=8428309ffffffff/part-0000.parquet`. The `h3_cell` value lives in the path, not inside the file, so a partition-pruning engine skips whole directories before it opens a single Parquet footer. Note the `h3_cell` column is dropped from the file body by convention — it is redundant with the path — which also shrinks each object.

For skewed data where one resolution cannot serve both dense and sparse regions, partition at a coarse base resolution and let row-group sizing handle intra-partition selectivity instead of pushing to a finer H3 level; the [Row Group Sizing Strategies](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/row-group-sizing-strategies/) reference covers picking a row-group size that keeps in-file pruning effective on multi-gigabyte partitions.

## Verifying Predicate Pushdown on the Partition Column

Writing the layout is only half the job; confirm that engines actually prune it. DuckDB with `hive_partitioning=1` exposes `h3_cell` as a virtual column and skips non-matching directories.

```bash
duckdb -c "
  SET enable_object_cache=true;
  EXPLAIN ANALYZE
  SELECT count(*) FROM read_parquet(
      's3://spatial-archive/parcels/**/*.parquet', hive_partitioning=1)
  WHERE h3_cell IN ('8428309ffffffff','842830bffffffff');"
```

The `EXPLAIN ANALYZE` output must show that only the matching partitions were read. Look for the `Files Read` counter — it should equal the number of cells in your `IN` list, not the archive total:

```text
┌─────────────────────────────────────┐
│           PARQUET_SCAN              │
│   Files Read: 2 / 18443             │  ← pruned to the two matching cells
│   Rows Scanned: 214,880            │
│   Total Time: 0.31s                │
└─────────────────────────────────────┘
```

If `Files Read` equals the archive total, pruning failed — the filter did not reference the partition column, or `hive_partitioning` was off. To resolve a bounding box to the set of cells to query, use `h3.polygon_to_cells` on the query envelope and pass the result as the `IN` list; this is how you translate a map viewport into a partition predicate.

## Troubleshooting Partition Pruning

| Symptom | Cause | Fix |
|---------|-------|-----|
| Query scans every file despite a spatial filter | Filter uses `ST_Intersects` on geometry, not the `h3_cell` path column | Resolve the query envelope to cells with `h3.polygon_to_cells` and filter `WHERE h3_cell IN (...)` |
| Millions of sub-megabyte partition files | Resolution too fine for the data's spatial density | Drop one H3 resolution and re-derive keys via `h3.cell_to_parent(cell, res-1)` — no geometry recompute needed |
| One partition is 40× larger than the median | Spatial skew (dense metro cell) at a coarse resolution | Keep the coarse base and rely on row-group pruning inside the file rather than splitting the whole archive finer |
| Features land in the wrong cell | Centroid computed in a projected CRS instead of EPSG:4326 | Always `to_crs(4326)` before `latlng_to_cell`; H3 is defined on WGS84 |

## Operational Execution Checklist

- [ ] Estimate per-cell feature density from a 1% sample and pick the coarsest H3 resolution whose median file clears the cold-tier minimum object size.
- [ ] Pin the chosen `H3_RES` in the archive manifest; treat any change as a full repartition, not an incremental edit.
- [ ] Derive every cell key from the geometry centroid reprojected to EPSG:4326 — never from a projected CRS.
- [ ] Write a Hive-style `h3_cell=<index>/` tree and drop the redundant `h3_cell` column from the file body.
- [ ] Preserve the `geo` metadata block (version, `primary_column`, WKB encoding, CRS) on every partition write.
- [ ] Verify pruning with `EXPLAIN ANALYZE` and confirm `Files Read` matches only the intersecting cells.
- [ ] Translate query bounding boxes to partition predicates with `h3.polygon_to_cells`, not geometry-level `ST_Intersects` on the whole archive.

## Related

- Up: [GeoParquet Migration Workflows](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/geoparquet-migration-workflows/) — the parent reference for archive-wide partitioning and metadata heuristics this scheme plugs into.
- [Converting Legacy Shapefiles to GeoParquet at Scale](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/geoparquet-migration-workflows/converting-legacy-shapefiles-to-geoparquet-at-scale/) — the batch conversion job that generates the H3 keys written here.
- [Writing GeoParquet Bounding-Box Metadata for Predicate Pushdown](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/geoparquet-migration-workflows/writing-geoparquet-bbox-covering-metadata-for-predicate-pushdown/) — the intra-file complement to partition pruning, skipping row groups after the directory prune.
- [Calculating Optimal Row Group Size for Spatial Queries](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/row-group-sizing-strategies/calculating-optimal-row-group-size-for-spatial-queries/) — sizing row groups so pruning still works inside a skewed, oversized partition.
- [Spatial Archive Cost Modeling](https://www.spatialdataarchival.org/spatial-archive-cost-modeling/) — the minimum-object-size and per-request math that sets the floor on your H3 resolution.

_Part of the [Spatial Data Archival](https://www.spatialdataarchival.org/) knowledge base._
