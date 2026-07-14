# Partitioning Cold Spatial Archives by Administrative Boundary

Partitioning a cold spatial archive by administrative boundary — country, then state or province, then county — aligns the physical file layout with how governance, retention law, and analyst queries actually slice the data, at the cost of the wild size skew that uneven feature density inflicts on grid-free layouts. This guide is for the data engineers, GIS archivists, and compliance teams deciding whether boundary-aligned partitions beat a uniform spatial grid, and shows exactly how to build a hybrid admin-plus-grid tree that keeps sparse rural jurisdictions and dense metros both within a workable file-size band. It operates under the [Compression Tuning & Storage Optimization](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/) framework, where partition layout drives predicate pushdown, per-request billing, and the blast radius of a retention deletion. Naive "one file per county" partitioning fails the moment a single urban county holds a hundred times the features of its neighbors.

## When Boundary Partitions Beat a Grid

A uniform grid — the [H3, S2, or quadkey](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/spatial-partitioning-techniques/choosing-h3-vs-s2-vs-quadkey-for-archive-partitioning/) schemes — optimizes for spatial-proximity queries and even cell sizes. Administrative partitioning optimizes for a different axis: it wins when your queries, your retention obligations, and your access controls all follow political boundaries rather than geographic windows. Three signals say "partition by boundary." First, queries name jurisdictions ("all parcels in Harris County") far more often than they draw bounding boxes. Second, retention and legal-hold rules differ by jurisdiction — a state-mandated seven-year hold applies to one state's records and not another's, and you want that boundary to be a clean prefix your [retention policy framework](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/retention-policy-frameworks/) can target. Third, data ownership and deletion requests arrive per jurisdiction, so a boundary-aligned prefix makes a lawful deletion a single-prefix operation instead of a full-archive scan.

The cost of that alignment is size skew: administrative units are not equal-area or equal-density. A grid gives you controllable cell sizes; boundaries give you meaningful prefixes but leave one county holding gigabytes and another holding kilobytes. The fix is a hybrid tree that partitions by boundary down to a level that stays meaningful, then falls back to a spatial grid inside any partition that exceeds a size threshold.

Skew is not a nuisance you can average away, because it is bimodal in the way that hurts most. A national parcel or address archive typically has thousands of low-population counties that each compress to a few megabytes — well below any cold tier's minimum object size, so each one wastes the minimum-billable footprint and adds a `LIST`/`GET` line item — alongside a handful of metropolitan counties that each hold enough features to make a single-file read pull hundreds of megabytes out of cold storage under a restore SLA. A pure boundary layout is therefore wrong at both ends of the distribution simultaneously: too many tiny objects and a few oversized ones. The hybrid approach fixes the oversized end by subdividing, and you address the tiny end by choosing how deep the administrative nesting goes — stopping at state rather than county for sparse regions, or coalescing small adjacent counties under a single state-level file. The threshold-driven procedure below encodes exactly that logic.

<svg viewBox="0 0 960 300" role="img" aria-label="Hybrid administrative-plus-grid partition tree. The archive root branches by country into country=US, then by state into state=CA and state=TX. state=CA branches by county. A sparse county, county=Alpine, is written as a single small GeoParquet file because it falls under the size threshold. A dense county, county=LosAngeles, exceeds the threshold and is subdivided by an H3 grid into h3_cell leaf files, restoring even partition sizes while preserving the administrative prefix." xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;color:var(--primary);font-family:var(--font-sans)">
  <title>Hybrid administrative-plus-grid partition tree</title>
  <desc>The archive root branches by country, then state, then county. Sparse counties become a single GeoParquet file, while a dense county that exceeds the size threshold is subdivided by an H3 grid into per-cell leaves, keeping partition sizes even without losing the administrative prefix.</desc>
  <defs>
    <marker id="adm-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <g stroke="currentColor" stroke-width="1.8" fill="none">
    <path d="M150 150 L214 96" stroke-opacity="0.6" marker-end="url(#adm-arrow)"/>
    <path d="M150 150 L214 204" stroke-opacity="0.4" marker-end="url(#adm-arrow)"/>
    <path d="M368 78 L432 52" stroke-opacity="0.55" marker-end="url(#adm-arrow)"/>
    <path d="M368 78 L432 132" stroke-opacity="0.55" marker-end="url(#adm-arrow)"/>
    <path d="M586 132 L650 96" stroke-opacity="0.55" marker-end="url(#adm-arrow)"/>
    <path d="M586 132 L650 176" stroke-opacity="0.55" marker-end="url(#adm-arrow)"/>
    <path d="M586 132 L650 244" stroke-opacity="0.4" marker-end="url(#adm-arrow)"/>
  </g>
  <!-- root -->
  <rect x="14" y="124" width="136" height="52" rx="10" fill="currentColor" fill-opacity="0.08" stroke="currentColor" stroke-opacity="0.6"/>
  <text x="82" y="147" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">spatial-archive/</text>
  <text x="82" y="164" text-anchor="middle" font-size="9.5" fill="currentColor" fill-opacity="0.7">parcels/</text>
  <!-- country -->
  <g text-anchor="middle">
    <rect x="214" y="72" width="154" height="46" rx="9" fill="currentColor" fill-opacity="0.06" stroke="currentColor" stroke-opacity="0.5"/>
    <text x="291" y="100" font-size="12.5" font-weight="600" fill="currentColor">country=US</text>
    <rect x="214" y="182" width="154" height="46" rx="9" fill="currentColor" fill-opacity="0.04" stroke="currentColor" stroke-opacity="0.35"/>
    <text x="291" y="210" font-size="12.5" font-weight="600" fill="currentColor" fill-opacity="0.75">country=&#8230;</text>
  </g>
  <!-- state -->
  <g text-anchor="middle">
    <rect x="432" y="30" width="154" height="44" rx="9" fill="currentColor" fill-opacity="0.06" stroke="currentColor" stroke-opacity="0.5"/>
    <text x="509" y="57" font-size="12.5" font-weight="600" fill="currentColor">state=CA</text>
    <rect x="432" y="110" width="154" height="44" rx="9" fill="currentColor" fill-opacity="0.04" stroke="currentColor" stroke-opacity="0.35"/>
    <text x="509" y="137" font-size="12.5" font-weight="600" fill="currentColor" fill-opacity="0.75">state=TX</text>
  </g>
  <!-- county / leaf -->
  <g text-anchor="middle">
    <rect x="650" y="74" width="296" height="46" rx="9" fill="currentColor" fill-opacity="0.1" stroke="currentColor" stroke-opacity="0.55"/>
    <text x="798" y="94" font-size="11.5" font-weight="600" fill="currentColor">county=Alpine/part-0000.parquet</text>
    <text x="798" y="110" font-size="9.5" fill="currentColor" fill-opacity="0.75">sparse &#183; single file below threshold</text>
    <rect x="650" y="132" width="296" height="60" rx="9" fill="currentColor" fill-opacity="0.13" stroke="currentColor" stroke-opacity="0.7" stroke-width="1.4"/>
    <text x="798" y="153" font-size="11.5" font-weight="700" fill="currentColor">county=LosAngeles/h3_cell=&#8230;</text>
    <text x="798" y="169" font-size="9.5" fill="currentColor" fill-opacity="0.8">dense &#183; exceeds threshold</text>
    <text x="798" y="184" font-size="9.5" fill="currentColor" fill-opacity="0.8">&#8594; subdivided by H3 grid</text>
    <rect x="650" y="204" width="296" height="44" rx="9" fill="currentColor" fill-opacity="0.04" stroke="currentColor" stroke-opacity="0.35"/>
    <text x="798" y="230" font-size="11.5" font-weight="600" fill="currentColor" fill-opacity="0.75">county=&#8230; (per jurisdiction)</text>
  </g>
</svg>

## Step 1: Join Features to Administrative Units

Assign every feature its jurisdiction codes with a spatial join against an authoritative boundary set — census TIGER, GADM, or a national cadastre. Use a stable code (FIPS, ISO 3166-2) rather than a display name, because names change spelling and codes do not. Perform the join in a projected CRS appropriate to the region so the point-in-polygon test is geometrically sound, then carry the codes as plain columns.

```python
import geopandas as gpd

parcels = gpd.read_file("s3://spatial-archive/vector/2024/parcels_raw.fgb")
counties = gpd.read_file("s3://spatial-archive/reference/tiger_2023_counties.fgb")

# Project both to an equal-area CRS for a correct point-in-polygon assignment.
parcels_m = parcels.to_crs("EPSG:5070")      # CONUS Albers equal-area
counties_m = counties.to_crs("EPSG:5070")

joined = gpd.sjoin(
    parcels_m,
    counties_m[["STATEFP", "COUNTYFP", "geometry"]],
    how="left",
    predicate="within",
)

# Features that miss every polygon (offshore, digitizing slivers) must not be dropped.
unmatched = joined["COUNTYFP"].isna().sum()
print(f"unmatched features routed to _unassigned/: {unmatched}")
joined["COUNTYFP"] = joined["COUNTYFP"].fillna("_unassigned")
joined["STATEFP"] = joined["STATEFP"].fillna("_unassigned")
```

## Step 2: Measure Skew and Set a Split Threshold

Before writing the tree, size each candidate leaf partition. The goal is a target file-size band — large enough to clear the cold tier's minimum object size, small enough that a single-jurisdiction query does not drag a multi-gigabyte file out of cold storage. Compute per-county byte estimates and flag the ones that need grid subdivision.

```bash
duckdb -c "
SELECT STATEFP, COUNTYFP,
       count(*)                       AS features,
       round(count(*) * 512.0 / 1e6, 1) AS est_mb   -- ~512 bytes/feature after ZSTD
FROM read_parquet('joined/*.parquet')
GROUP BY STATEFP, COUNTYFP
ORDER BY features DESC
LIMIT 5"
```

Any county whose `est_mb` exceeds your upper band (for example 512 MB) gets a second-level H3 grid; everything else is written as a single file per county.

## Step 3: Write the Hybrid Tree

Partition by `STATEFP` and `COUNTYFP` for normal jurisdictions, and add an `h3_cell` sub-level only inside the oversized ones. The administrative prefix survives either way, so a jurisdiction-scoped lifecycle rule or deletion still targets one clean path.

```python
import h3
import pyarrow as pa
import pyarrow.parquet as pq

SPLIT_MB, H3_RES = 512, 7

for (statefp, countyfp), grp in joined.groupby(["STATEFP", "COUNTYFP"]):
    base = f"s3://spatial-archive/parcels/country=US/state={statefp}/county={countyfp}"
    est_mb = len(grp) * 512 / 1e6
    if est_mb > SPLIT_MB:
        pts = grp.geometry.to_crs(4326).representative_point()
        grp = grp.assign(h3_cell=[h3.latlng_to_cell(p.y, p.x, H3_RES) for p in pts])
        for cell, sub in grp.groupby("h3_cell"):
            _write(sub, f"{base}/h3_cell={cell}/part-0000.parquet")
    else:
        _write(grp, f"{base}/part-0000.parquet")

def _write(frame, path):
    table = pa.Table.from_pandas(frame.drop(columns="geometry").assign(
        geometry=frame.geometry.to_wkb()), preserve_index=False)
    pq.write_table(table, path, compression="zstd", compression_level=9,
                   row_group_size=100_000)
```

Compression level here leans aggressive because these are cold, rarely-read partitions; the ratio-versus-CPU trade is covered under [tuning ZSTD compression for GeoParquet archives](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/zstd-level-configuration-for-spatial-files/tuning-zstd-compression-for-geoparquet-archives/).

## Validation: Confirm Balanced, Prunable Partitions

Verify two properties: no partition file blew past the band, and a jurisdiction query prunes to a single prefix. Check the size distribution and run an `EXPLAIN` to confirm partition pruning fires.

```bash
# 1. No leaf file should exceed the upper band after the hybrid split.
duckdb -c "
SELECT max(file_size_mb), avg(file_size_mb), count(*)
FROM (SELECT filename, sum(bytes)/1e6 AS file_size_mb
      FROM parquet_file_metadata('s3://spatial-archive/parcels/**/*.parquet')
      GROUP BY filename)"
```

Expected output — the maximum stays within the band and the mean sits comfortably above the tier minimum:

```text
┌───────────────────┬───────────────────┬──────────────┐
│ max(file_size_mb) │ avg(file_size_mb) │ count_star() │
│      double       │      double       │    int64     │
├───────────────────┼───────────────────┼──────────────┤
│       498.2       │       143.6       │     3187     │
└───────────────────┴───────────────────┴──────────────┘
```

A query filtered on `state='06' AND county='037'` should read only that county's files. If `EXPLAIN` shows a full-tree scan, the partition columns are not in the path and pruning cannot fire — the single most common boundary-partitioning defect.

## Boundary Partitioning Failure Modes

| Symptom | Cause | Fix |
|---------|-------|-----|
| One county file is 100&#215; the median size | Dense urban jurisdiction never triggered the split threshold | Lower `SPLIT_MB` or add the H3 sub-level; re-run only the oversized prefixes |
| Features silently missing from every partition | Offshore or sliver geometries matched no boundary polygon and were dropped | Route unmatched features to an explicit `_unassigned/` prefix, never `NaN`-drop them |
| Jurisdiction query scans the whole archive | `STATEFP`/`COUNTYFP` stored as columns but not as Hive path segments | Emit `state=`/`county=` as real directory levels so predicate pushdown prunes |
| Boundary revision reshuffles thousands of files | County lines or FIPS codes changed between vintages | Pin the boundary-set vintage in the dataset contract; treat a re-vintage as a versioned rewrite |

## Operational Execution Checklist

- [ ] Spatially join features to an authoritative boundary set in an equal-area CRS, keying on stable codes (FIPS, ISO 3166-2) not names.
- [ ] Route unmatched features to an explicit `_unassigned/` prefix so nothing is silently dropped during the join.
- [ ] Estimate per-jurisdiction partition sizes and set a split threshold that clears the cold tier minimum object size.
- [ ] Subdivide only oversized jurisdictions with a second-level H3 grid, preserving the administrative prefix on every leaf.
- [ ] Write `state=`/`county=` (and `h3_cell=` where split) as real Hive path segments so jurisdiction queries prune to one prefix.
- [ ] Verify the max leaf-file size stays within the target band and that `EXPLAIN` confirms partition pruning on a jurisdiction filter.
- [ ] Pin the boundary-set vintage in the dataset contract and version any re-vintage as a deliberate rewrite.

## Related

- Up: [Spatial Partitioning Techniques](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/spatial-partitioning-techniques/) — the parent reference for choosing between boundary, grid, and hybrid partition layouts.
- [Choosing H3 vs S2 vs Quadkey for Archive Partitioning](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/spatial-partitioning-techniques/choosing-h3-vs-s2-vs-quadkey-for-archive-partitioning/) — the sibling grid-based approach and the H3 grid used for subdividing dense jurisdictions here.
- [Implementing Lifecycle Rules for Shapefile Archives](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/retention-policy-frameworks/implementing-lifecycle-rules-for-shapefile-archives/) — jurisdiction-scoped retention rules that map cleanly onto the administrative prefix.
- [GeoParquet Migration Workflows](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/geoparquet-migration-workflows/) — the conversion pipeline that produces the columnar files this tree organizes.
- [Spatial Archive Cost Modeling](https://www.spatialdataarchival.org/spatial-archive-cost-modeling/) — model how partition count and per-jurisdiction file sizes drive storage and request costs.

_Part of the [Spatial Data Archival](https://www.spatialdataarchival.org/) knowledge base._
