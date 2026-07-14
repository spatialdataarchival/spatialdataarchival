# Writing GeoParquet Bounding-Box Metadata for Predicate Pushdown

A GeoParquet file with a `bbox` covering column lets a query engine skip entire row groups on a spatial filter, reading only the fraction of an archived object whose features fall inside the query envelope — without decoding a single WKB geometry. This guide is for data engineers who have already partitioned an archive and now need intra-file selectivity: writing a per-row bounding-box struct column, ensuring Parquet writes `min`/`max` statistics for its four members, and verifying that DuckDB spatial, GDAL, and pyarrow actually prune on those stats. The trap is that the `bbox` column and its row-group statistics are two different things — a writer can emit the covering column and still fail to populate the statistics that make pushdown work, leaving you with a correct file that scans in full. It operates under the [Format Conversion & Pipeline Automation](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/) framework and refines the [GeoParquet Migration Workflows](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/geoparquet-migration-workflows/) reference with the covering-metadata layer that sits beneath directory-level partition pruning.

## How Bbox Pruning Actually Works

Parquet stores each column in row groups, and for each column chunk it records `min` and `max` statistics in the file footer. A query engine reads the footer first, compares the filter to those statistics, and skips any row group whose range cannot satisfy the predicate. Geometry itself is an opaque WKB blob with no meaningful min/max, so it cannot be pruned. The GeoParquet `bbox` covering column solves this by adding a struct of four plain `float` columns — `xmin`, `ymin`, `xmax`, `ymax` — that the writer computes per feature. Because those four are ordinary numeric columns, Parquet writes real statistics for them, and a spatial filter becomes four numeric range comparisons the engine already knows how to push down.

<svg viewBox="0 0 860 300" role="img" aria-label="Row-group skipping via bbox statistics. A query envelope with x from 4 to 7 and y from 2 to 5 is tested against three row groups in a GeoParquet file. Row group 0 covers xmin 0 to xmax 3 and does not overlap, so it is skipped. Row group 1 covers xmin 4 to xmax 8 and overlaps, so it is read. Row group 2 covers xmin 12 to xmax 15 and does not overlap, so it is skipped. Only one of three row groups is decoded." xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;color:var(--primary);font-family:var(--font-sans)">
  <title>Row-group skipping from bbox min/max statistics</title>
  <desc>A query envelope is compared against the bbox min and max statistics of three row groups. Two row groups whose ranges do not intersect the envelope are skipped from the footer alone; the one overlapping row group is read and its geometries decoded.</desc>
  <defs>
    <marker id="bbx-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <!-- query envelope box -->
  <rect x="14" y="20" width="250" height="58" rx="9" fill="currentColor" fill-opacity="0.13" stroke="currentColor" stroke-opacity="0.65" stroke-width="1.5"/>
  <text x="139" y="44" text-anchor="middle" font-size="12.5" font-weight="700" fill="currentColor">Query envelope</text>
  <text x="139" y="63" text-anchor="middle" font-size="11" fill="currentColor" fill-opacity="0.85">x &#8712; [4, 7] &#183; y &#8712; [2, 5]</text>
  <!-- footer read note -->
  <text x="300" y="54" font-size="10.5" fill="currentColor" fill-opacity="0.7">footer stats tested &#8594;</text>
  <!-- row group 0: skipped -->
  <rect x="470" y="16" width="376" height="72" rx="9" fill="currentColor" fill-opacity="0.03" stroke="currentColor" stroke-opacity="0.3" stroke-dasharray="5 4"/>
  <text x="486" y="40" font-size="12" font-weight="600" fill="currentColor" fill-opacity="0.65">Row group 0</text>
  <text x="486" y="59" font-size="10.5" fill="currentColor" fill-opacity="0.65">xmin 0 &#183; xmax 3 &#183; ymin 0 &#183; ymax 4</text>
  <text x="486" y="77" font-size="10.5" font-weight="700" fill="currentColor" fill-opacity="0.6">no overlap &#8594; SKIP</text>
  <!-- row group 1: read -->
  <rect x="470" y="112" width="376" height="72" rx="9" fill="currentColor" fill-opacity="0.14" stroke="currentColor" stroke-opacity="0.7" stroke-width="1.5"/>
  <text x="486" y="136" font-size="12" font-weight="700" fill="currentColor">Row group 1</text>
  <text x="486" y="155" font-size="10.5" fill="currentColor">xmin 4 &#183; xmax 8 &#183; ymin 1 &#183; ymax 6</text>
  <text x="486" y="173" font-size="10.5" font-weight="700" fill="currentColor">overlaps &#8594; READ &amp; decode WKB</text>
  <!-- row group 2: skipped -->
  <rect x="470" y="208" width="376" height="72" rx="9" fill="currentColor" fill-opacity="0.03" stroke="currentColor" stroke-opacity="0.3" stroke-dasharray="5 4"/>
  <text x="486" y="232" font-size="12" font-weight="600" fill="currentColor" fill-opacity="0.65">Row group 2</text>
  <text x="486" y="251" font-size="10.5" fill="currentColor" fill-opacity="0.65">xmin 12 &#183; xmax 15 &#183; ymin 8 &#183; ymax 11</text>
  <text x="486" y="269" font-size="10.5" font-weight="700" fill="currentColor" fill-opacity="0.6">no overlap &#8594; SKIP</text>
  <!-- connectors -->
  <g stroke="currentColor" stroke-width="1.8" fill="none" stroke-opacity="0.55">
    <path d="M264 49 C 400 49, 420 52, 468 52" marker-end="url(#bbx-arrow)"/>
    <path d="M264 49 C 400 49, 420 148, 468 148" marker-end="url(#bbx-arrow)"/>
    <path d="M264 49 C 400 49, 420 244, 468 244" marker-end="url(#bbx-arrow)"/>
  </g>
</svg>

Pruning works only when three conditions hold together: the `bbox` column exists and is registered in the `geo` metadata as the covering for the geometry column, the four members carry populated `min`/`max` statistics, and the features are ordered so that a row group covers a compact region rather than the whole extent. Miss any one and the engine reads every row group.

Engine support differs in how the covering is consumed, so validate against the readers your archive actually serves. DuckDB's spatial extension reads the `covering` field from the `geo` metadata and rewrites a `ST_Intersects` predicate on the geometry into range comparisons on the bbox members automatically, so a spatial filter prunes with no query rewrite from the caller. GDAL's Parquet driver, from the version that implements GeoParquet 1.1, applies the same skipping when a spatial filter is set through `-spat` or the OGR API. Plain `pyarrow` does not understand spatial semantics, but because the bbox members are ordinary float columns you can push a numeric filter on `bbox.xmin` and friends through `pq.read_table(..., filters=...)` and it prunes on the identical statistics. All three lean on the same footer `min`/`max`, which is why the verification below inspects the statistics directly rather than trusting any one engine.

## Computing and Writing the Bbox Covering Column

The `bbox` column is a Parquet struct with float fields `xmin`, `ymin`, `xmax`, `ymax`, computed in the geometry's stored CRS. Compute it from the geometry bounds, then declare it in the `geo` metadata under the geometry column's `covering` key so a reader knows which column covers which geometry. Write the members as `float` (not `double`) where precision allows — narrower columns produce tighter statistics pages and smaller footers.

```python
import json
import geopandas
import pyarrow as pa
import pyarrow.parquet as pq

def write_with_bbox(src: str, dst: str, crs_epsg: int = 4326):
    gdf = geopandas.read_parquet(src)
    bounds = gdf.geometry.bounds  # DataFrame: minx, miny, maxx, maxy

    tbl = pa.Table.from_pandas(gdf.drop(columns="geometry"), preserve_index=False)
    # bbox as a struct column of four floats — the covering the engine prunes on.
    bbox = pa.StructArray.from_arrays(
        [pa.array(bounds.minx, pa.float32()), pa.array(bounds.miny, pa.float32()),
         pa.array(bounds.maxx, pa.float32()), pa.array(bounds.maxy, pa.float32())],
        names=["xmin", "ymin", "xmax", "ymax"])
    geom = pa.array(gdf.geometry.to_wkb())
    tbl = tbl.append_column("bbox", bbox).append_column("geometry", geom)

    geo_meta = {
        "version": "1.1.0", "primary_column": "geometry",
        "columns": {"geometry": {
            "encoding": "WKB",
            "geometry_types": sorted(gdf.geom_type.unique().tolist()),
            "crs": f"EPSG:{crs_epsg}",
            # Registers the bbox struct as the covering for this geometry column.
            "covering": {"bbox": {
                "xmin": ["bbox", "xmin"], "ymin": ["bbox", "ymin"],
                "xmax": ["bbox", "xmax"], "ymax": ["bbox", "ymax"]}}}},
    }
    tbl = tbl.replace_schema_metadata({b"geo": json.dumps(geo_meta).encode()})
    pq.write_table(tbl, dst, compression="zstd", compression_level=3,
                   row_group_size=50_000, write_statistics=True)
```

Two writer settings are load-bearing. `write_statistics=True` is the default in modern pyarrow, but pin it explicitly — a writer configured without it emits the covering column with no `min`/`max`, and pruning silently degrades to a full scan. `row_group_size` sets the granularity of pruning: smaller groups skip more precisely but enlarge the footer, and the sweet spot for archived spatial data is covered in the [Row Group Sizing Strategies](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/row-group-sizing-strategies/) reference.

## Ordering Features So Row Groups Stay Compact

Statistics only prune well when each row group covers a small, contiguous area. If features are in insertion order — say, chronological survey order that criss-crosses a continent — every row group's bbox spans the whole extent, the `min`/`max` ranges all overlap the query, and nothing is skipped even though the statistics are present. Sort by a spatial key before writing so adjacent rows are spatially adjacent.

```python
import h3
# Sort features along a spatial curve so each 50k-row group is spatially compact.
c = gdf.geometry.to_crs(4326).centroid
gdf["_sort"] = [h3.latlng_to_cell(p.y, p.x, 7) for p in c]  # fine H3 as a proxy curve
gdf = gdf.sort_values("_sort").drop(columns="_sort").reset_index(drop=True)
```

A finer H3 index or a Hilbert curve both work as the sort key; the goal is only that spatial neighbors become row neighbors. This is complementary to directory-level pruning: [partitioning by H3 spatial index](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/geoparquet-migration-workflows/partitioning-geoparquet-by-h3-spatial-index/) skips whole files, then bbox statistics skip row groups inside the files that survive.

## Verifying the Statistics Are Populated

Do not trust that the covering column implies working pruning — inspect the footer directly. `parquet-tools` (or `pyarrow`'s metadata API) exposes per-row-group statistics for each bbox member.

```bash
python -c "
import pyarrow.parquet as pq
md = pq.ParquetFile('s3://spatial-archive/parcels/region_north.parquet').metadata
for rg in range(md.num_row_groups):
    for col in range(md.num_columns):
        c = md.row_group(rg).column(col)
        if c.path_in_schema.startswith('bbox.'):
            s = c.statistics
            print(f'rg{rg} {c.path_in_schema}: min={s.min} max={s.max} '
                  f'has_stats={s.has_min_max}')"
```

Expected output — every bbox member must report `has_stats=True` with a `min`/`max` that varies across row groups (proving spatial ordering worked):

```text
rg0 bbox.xmin: min=-124.41 max=-122.09 has_stats=True
rg0 bbox.xmax: min=-124.38 max=-121.94 has_stats=True
rg1 bbox.xmin: min=-121.88 max=-119.02 has_stats=True   ← distinct range from rg0
rg1 bbox.xmax: min=-121.80 max=-118.91 has_stats=True
```

If ranges are identical across row groups, ordering failed and no pruning will occur. If `has_stats=False`, the writer dropped statistics. To confirm an engine acts on the stats, run `EXPLAIN ANALYZE` in DuckDB with a tight envelope filter on the bbox members and check that the reported rows-scanned count is a fraction of the file total. Validate the covering structure against the official [GeoParquet Specification](https://geoparquet.org/) `covering` field definition.

## Troubleshooting Bbox Pushdown

| Symptom | Cause | Fix |
|---------|-------|-----|
| Full file scanned despite a bbox filter | `min`/`max` statistics absent from the footer | Set `write_statistics=True` and re-write; verify with the pyarrow metadata dump |
| Statistics present but nothing skipped | Features unsorted, so every row-group bbox spans the whole extent | Sort by an H3 or Hilbert key before writing so row groups stay spatially compact |
| Engine ignores the `bbox` column entirely | `covering` not declared in the `geo` metadata | Add the `covering.bbox` member paths so readers map the struct to the geometry column |
| Pruning works in DuckDB but not GDAL | Reader predates GeoParquet 1.1 covering support | Confirm the GDAL/engine version implements the 1.1 `covering` spec; upgrade if older |

## Operational Execution Checklist

- [ ] Compute a per-feature `bbox` struct (`xmin`/`ymin`/`xmax`/`ymax`) in the geometry's stored CRS and append it as a float column.
- [ ] Declare the `covering.bbox` member paths inside the `geo` metadata so readers map the struct to the geometry column.
- [ ] Pin `write_statistics=True` on the writer and confirm the footer carries `min`/`max` for every bbox member.
- [ ] Sort features by an H3 or Hilbert key before writing so each row group covers a compact region.
- [ ] Choose a `row_group_size` that balances pruning granularity against footer size for your query envelopes.
- [ ] Verify with a pyarrow metadata dump that bbox statistics vary across row groups, then confirm pruning with `EXPLAIN ANALYZE`.

## Related

- Up: [GeoParquet Migration Workflows](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/geoparquet-migration-workflows/) — the parent reference for the metadata invariants this covering column extends.
- [Partitioning GeoParquet by H3 Spatial Index](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/geoparquet-migration-workflows/partitioning-geoparquet-by-h3-spatial-index/) — the directory-level prune that runs before row-group bbox pruning inside each file.
- [Incremental GeoParquet Updates Without a Full Rewrite](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/geoparquet-migration-workflows/incremental-geoparquet-updates-without-full-rewrite/) — keeping bbox coverings and statistics consistent when appending to an existing archive.
- [Calculating Optimal Row Group Size for Spatial Queries](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/row-group-sizing-strategies/calculating-optimal-row-group-size-for-spatial-queries/) — sizing the row groups whose statistics do the skipping here.
- [Object Storage Selection for GIS Archives](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/object-storage-selection-for-gis-archives/) — how range-request support in the substrate turns row-group skipping into fewer bytes fetched from cold storage.

_Part of the [Spatial Data Archival](https://www.spatialdataarchival.org/) knowledge base._
