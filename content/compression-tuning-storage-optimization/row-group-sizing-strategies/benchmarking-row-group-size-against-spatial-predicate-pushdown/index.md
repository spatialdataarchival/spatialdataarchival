# Benchmarking Row-Group Size Against Spatial Predicate Pushdown

Row-group size is the single knob that decides how much of a GeoParquet archive a bounding-box query can skip, yet it is almost always set by copy-pasted defaults rather than measured against real spatial predicates. This guide is for data engineers who need a repeatable benchmark harness that quantifies row-group skipping on bbox filters and finds the size that maximizes pruning without drowning the reader in tiny-group metadata overhead. Default writers emit 128 MB or one-million-row groups regardless of the data's spatial clustering, so a tightly clustered LiDAR tile set and a globally scattered vector layer end up with identical, wrong row-group sizes. The procedure below builds a DuckDB and pyarrow harness that measures groups-scanned versus groups-pruned across candidate sizes and pins the optimum, operating under the [Compression Tuning & Storage Optimization](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/) framework and refining the analytical model in [Calculating Optimal Row-Group Size for Spatial Queries](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/row-group-sizing-strategies/calculating-optimal-row-group-size-for-spatial-queries/).

## How Spatial Pruning Depends on Row-Group Size

A Parquet reader can skip a row group entirely if the query predicate provably excludes it, using the per-column min/max statistics stored in the footer. For spatial filters this works through the geometry's bounding-box columns — a GeoParquet file that materializes `bbox.xmin`, `bbox.ymin`, `bbox.xmax`, `bbox.ymax` as native columns lets the reader compare each row group's min/max against the query window and prune non-overlapping groups without reading a single data page.

The catch is that each row group's bbox statistic is the union of every feature it contains. A large row group spans a wide geographic extent, so its bbox overlaps almost any query window and is rarely prunable — you scan nearly everything. A tiny row group has a tight bbox and prunes precisely, but thousands of them bloat the footer, multiply per-group read requests, and add metadata-decode time that can exceed the scan you saved. The optimum sits where marginal pruning gain equals marginal overhead, and that point moves with the data's spatial density. Only a benchmark against your actual features finds it.

<svg viewBox="0 0 840 280" role="img" aria-label="Row-group pruning against a query window across three row-group sizes. With a large row group, one wide group covers the whole file and its bounding box overlaps the query window, so it must be scanned and nothing is pruned. With a medium row group, four groups tile the extent and the query window overlaps one, so three are pruned and one scanned. With a small row group, sixteen tight groups tile the extent, the query window overlaps one, fifteen are pruned but footer overhead grows. The middle size gives the best pruning-to-overhead balance." xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;color:var(--primary);font-family:var(--font-sans)">
  <title>Row-group pruning versus size against a fixed query window</title>
  <desc>Three panels showing a fixed query window over a file split into large, medium, and small row groups. Large groups prune nothing, small groups prune almost everything but add footer overhead, and the medium size balances precise pruning against per-group cost.</desc>
  <g font-size="11" font-weight="700" fill="currentColor" text-anchor="middle">
    <text x="130" y="26">Large row group</text>
    <text x="420" y="26">Medium row group</text>
    <text x="710" y="26">Small row group</text>
  </g>
  <!-- Panel 1: single group -->
  <rect x="40" y="40" width="180" height="180" fill="currentColor" fill-opacity="0.08" stroke="currentColor" stroke-opacity="0.55" stroke-width="1.5"/>
  <!-- query window -->
  <rect x="95" y="95" width="60" height="60" fill="none" stroke="currentColor" stroke-opacity="0.9" stroke-width="2.2" stroke-dasharray="5 3"/>
  <text x="130" y="240" text-anchor="middle" font-size="10" fill="currentColor">1 scanned &#183; 0 pruned</text>
  <!-- Panel 2: 4 groups -->
  <g stroke="currentColor" stroke-opacity="0.45" stroke-width="1.2">
    <rect x="330" y="40" width="90" height="90" fill="currentColor" fill-opacity="0.04"/>
    <rect x="420" y="40" width="90" height="90" fill="currentColor" fill-opacity="0.04"/>
    <rect x="330" y="130" width="90" height="90" fill="currentColor" fill-opacity="0.15"/>
    <rect x="420" y="130" width="90" height="90" fill="currentColor" fill-opacity="0.04"/>
  </g>
  <rect x="352" y="152" width="46" height="46" fill="none" stroke="currentColor" stroke-opacity="0.9" stroke-width="2.2" stroke-dasharray="5 3"/>
  <text x="420" y="240" text-anchor="middle" font-size="10" fill="currentColor">1 scanned &#183; 3 pruned</text>
  <!-- Panel 3: 16 groups -->
  <g stroke="currentColor" stroke-opacity="0.4" stroke-width="0.9" fill="currentColor" fill-opacity="0.04">
    <rect x="620" y="40" width="45" height="45"/><rect x="665" y="40" width="45" height="45"/><rect x="710" y="40" width="45" height="45"/><rect x="755" y="40" width="45" height="45"/>
    <rect x="620" y="85" width="45" height="45"/><rect x="665" y="85" width="45" height="45"/><rect x="710" y="85" width="45" height="45"/><rect x="755" y="85" width="45" height="45"/>
    <rect x="620" y="130" width="45" height="45"/><rect x="665" y="130" width="45" height="45" fill-opacity="0.18"/><rect x="710" y="130" width="45" height="45"/><rect x="755" y="130" width="45" height="45"/>
    <rect x="620" y="175" width="45" height="45"/><rect x="665" y="175" width="45" height="45"/><rect x="710" y="175" width="45" height="45"/><rect x="755" y="175" width="45" height="45"/>
  </g>
  <rect x="668" y="133" width="39" height="39" fill="none" stroke="currentColor" stroke-opacity="0.9" stroke-width="2" stroke-dasharray="4 3"/>
  <text x="710" y="240" text-anchor="middle" font-size="10" fill="currentColor">1 scanned &#183; 15 pruned</text>
  <text x="710" y="256" text-anchor="middle" font-size="9" fill="currentColor" fill-opacity="0.7">+ footer overhead grows</text>
  <text x="420" y="272" text-anchor="middle" font-size="10.5" font-weight="600" fill="currentColor">dashed box = query window &#183; shaded groups overlap it and are scanned</text>
</svg>

## Step-by-Step Benchmark Procedure

### 1. Write the sample at several candidate row-group sizes

Materialize a bbox column so pushdown has statistics to work with, then emit one file per candidate size from the same source features.

```python
import pyarrow.parquet as pq
import pyarrow.dataset as ds

src = ds.dataset("s3://spatial-archive/vectors/buildings/2023/", format="parquet").to_table()
# src already carries bbox.xmin/ymin/xmax/ymax columns per the GeoParquet 1.1 bbox covering

for rows in (50_000, 200_000, 1_000_000, 4_000_000):
    pq.write_table(
        src,
        f"/bench/buildings_rg{rows}.parquet",
        row_group_size=rows,
        compression="zstd",
        compression_level=6,
        write_statistics=["bbox.xmin", "bbox.ymin", "bbox.xmax", "bbox.ymax"],
    )
```

Writing `write_statistics` explicitly on the bbox columns guarantees the min/max are present in the footer; without them the reader cannot prune at all regardless of size.

### 2. Instrument groups-scanned with DuckDB

DuckDB reports how many row groups it actually read versus skipped. Run a representative bbox predicate against each file and capture the scan profile.

```bash
duckdb -c "
  SET enable_profiling='json';
  SET profiling_output='/bench/profile_rg200000.json';
  INSTALL spatial; LOAD spatial;
  SELECT count(*) FROM read_parquet('/bench/buildings_rg200000.parquet')
  WHERE bbox.xmin < -73.93 AND bbox.xmax > -73.99
    AND bbox.ymin <  40.78 AND bbox.ymax >  40.74;  -- a ~2km Manhattan window
"
```

The emitted profile JSON records `row_groups_total` and the count read after pruning. Loop the same predicate over every candidate file so the only variable is row-group size.

### 3. Reduce the results to a pruning-versus-overhead table

Parse each profile and compute the pruning rate and the bytes actually read. The winning size maximizes pruning rate while its footer and per-group request count stay flat.

```python
import json, glob, pyarrow.parquet as pq

for prof in sorted(glob.glob("/bench/profile_rg*.json")):
    p = json.load(open(prof))
    size = prof.split("rg")[1].split(".")[0]
    path = f"/bench/buildings_rg{size}.parquet"
    md = pq.ParquetFile(path).metadata
    total = md.num_row_groups
    # DuckDB profile exposes scanned groups under the parquet scan operator
    scanned = p["result"]["scanned_row_groups"]
    print(f"rg={size:>8}  groups={total:>5}  scanned={scanned:>5}  "
          f"pruned={100*(total-scanned)/total:5.1f}%  footer_kb={md.serialized_size//1024}")
```

Read the table for the knee: pruning climbs steeply as groups shrink, then flattens while `footer_kb` and group count keep rising. Pick the largest size still on the steep part of the pruning curve — it captures most of the skip benefit at the least metadata cost.

## Reading the Curve and Choosing the Size

The benchmark table encodes a tension that a single number cannot capture, so read it as a curve rather than a leaderboard. As row groups shrink, the pruning rate climbs because each group's bounding box tightens and excludes more of the extent — but the climb decelerates. Past a certain fineness every group already sits inside the query window's neighborhood, so halving the size again prunes only a few more groups while doubling the footer entry count, the number of range requests the reader issues, and the metadata-decode time before any data is read. Plotted, pruning rate rises steeply then flattens into a plateau; overhead rises roughly linearly the whole way. The best size is the largest one still on the steep segment, just before the plateau — it banks nearly all the skip benefit at the least metadata cost.

That knee moves with two properties of the data, which is exactly why an analytical formula alone under-serves and the benchmark is worth running. The first is spatial density: a globally scattered layer needs finer groups to achieve any pruning because features that are far apart still land in the same group unless the group is small, whereas a locally dense layer prunes well even at coarse sizes. The second is sort quality. Pruning is only possible when features near each other in space are also near each other in write order, so that a row group's bounding box stays tight. An archive written in ingest order — arrival time, file name — scatters nearby features across many groups and every group's bbox balloons to near the full extent, flattening the pruning curve at every size. Apply a Hilbert-curve or H3 sort before the write and re-run the benchmark; the whole curve shifts up, and the optimal size usually grows because coarser groups now prune effectively. Never tune row-group size against unsorted data, or you will over-fragment to compensate for a locality problem the sort would have solved.

## Validation & Verification

Confirm pruning is real, not just reported, by comparing bytes read for a tight local query against a full-extent query on the chosen file. A well-sized file reads a small fraction for the local window.

```bash
duckdb -c "
  SET enable_profiling='query_tree';
  SELECT count(*) FROM read_parquet('/bench/buildings_rg200000.parquet')
  WHERE bbox.xmin < -73.93 AND bbox.xmax > -73.99
    AND bbox.ymin <  40.78 AND bbox.ymax >  40.74;
"
```

Expected output — the scan node should report only a handful of the total row groups touched:

```text
┌─ SEQ_SCAN (buildings_rg200000.parquet) ─┐
│  Row Groups: 61                          │
│  Row Groups Pruned: 57                   │
│  Rows Scanned: 118,204 / 12,000,000      │
└──────────────────────────────────────────┘
```

`Row Groups Pruned: 57` of `61` confirms spatial pushdown is skipping non-overlapping groups. If pruned is `0`, the bbox statistics are missing or the predicate does not reference the bbox columns directly. Validate the bbox covering against the [GeoParquet specification](https://geoparquet.org/) so the columns the reader needs are the columns you wrote.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `Row Groups Pruned: 0` on every query | Predicate filters on `geometry` not the `bbox` struct columns | Rewrite the filter against `bbox.xmin`/`xmax`/`ymin`/`ymax`, which carry min/max stats |
| Pruning good but query still slow | Row groups too small — thousands of footer entries dominate open time | Move up one candidate size; overhead falls faster than pruning drops |
| Same pruning at every size | Features are randomly scattered, so every group's bbox spans the extent | Spatially sort and co-locate features before writing so neighbors share a row group |
| Pruning great on sample, poor in production | Sample was pre-sorted; the archive is written in ingest order | Apply a Hilbert or H3 sort key at write time to restore locality |

## Operational Execution Checklist

- [ ] Materialize `bbox.xmin/ymin/xmax/ymax` columns and write statistics on them explicitly.
- [ ] Emit the same source features at four or more candidate row-group sizes.
- [ ] Run one representative bbox predicate against every candidate under DuckDB profiling.
- [ ] Tabulate pruning rate against footer size and group count, then pick the knee of the curve.
- [ ] Verify `Row Groups Pruned` is non-zero and the predicate references the bbox columns.
- [ ] Spatially sort features (Hilbert/H3) before writing so row-group bboxes stay tight.
- [ ] Re-benchmark whenever the query mix shifts from local windows to wide-extent scans.

## Related

- Up: [Row-Group Sizing Strategies](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/row-group-sizing-strategies/) — the parent reference for choosing row-group size across spatial query and archival goals.
- [Calculating Optimal Row-Group Size for Spatial Queries](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/row-group-sizing-strategies/calculating-optimal-row-group-size-for-spatial-queries/) — the analytical model this benchmark harness validates empirically.
- [Sizing Row Groups for Glacier Retrieval of GeoParquet](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/row-group-sizing-strategies/sizing-row-groups-for-glacier-retrieval-of-geoparquet/) — the sibling guide that trades query pruning against cold-storage restore economics.
- [Converting Legacy Shapefiles to GeoParquet at Scale](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/geoparquet-migration-workflows/converting-legacy-shapefiles-to-geoparquet-at-scale/) — the conversion pipeline where spatial sorting and row-group size are first set.
- [Object Storage Selection for GIS Archives](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/object-storage-selection-for-gis-archives/) — how the substrate's range-read behavior shapes whether pruning translates into real I/O savings.

_Part of the [Spatial Data Archival](https://www.spatialdataarchival.org/) knowledge base._
