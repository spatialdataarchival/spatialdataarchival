# Choosing H3 vs S2 vs Quadkey for Archive Partitioning

Choosing a discrete global grid as the partition key for a cold spatial archive is a one-way decision: it fixes your directory tree, your file counts, and the shape of every predicate-pushdown query for the life of the dataset. This guide compares H3 hexagons, S2 cells, and quadkey/tile schemes head-to-head for partitioning multi-terabyte GeoParquet and columnar archives, weighing cell-shape and area uniformity, resolution-to-partition mapping, neighbor-query ergonomics, library maturity, and the file-count blowup each scheme inflicts on object storage. It is written for the data engineers and GIS archivists who have to live with the layout after ingest, under the [Compression Tuning & Storage Optimization](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/) framework where partition granularity and file size drive both scan cost and per-request billing. Default "just partition by lat/lon bucket" advice fails here because naive rectangular buckets vary wildly in feature density and produce partitions that are unusable for the bounded-scan queries cold retrieval depends on.

## Why the Grid Choice Is Load-Bearing

A partition key is not just a folder name. It determines how many objects land in your bucket (and therefore your `LIST` and `GET` request bill), how tightly a bounding-box query can prune partitions before it touches cold storage, and whether a "give me this cell and its neighbors" query is one index lookup or a spatial join. The three dominant discrete global grids each make a different trade. H3 tiles the globe in hexagons; S2 projects the sphere onto a cube and recursively quarters each face into cells addressed by a Hilbert curve; quadkey (the Bing/slippy-map scheme) recursively quarters a Web Mercator plane into square tiles addressed by a base-4 string. The differences look academic until a query planner has to prune 40 million partitions.

<svg viewBox="0 0 940 212" role="img" aria-label="Comparison matrix of three partition grid schemes. H3: hexagon cells, high area uniformity, 16 resolutions with fixed 1-to-7 nesting, single-step neighbor ring via k-ring, mature Uber libraries, moderate file-count risk. S2: quadrilateral cells on a cube face, medium area uniformity, 31 levels with 1-to-4 nesting, neighbor lookup via cell edges, mature Google libraries, low-to-moderate file-count risk. Quadkey: square Web Mercator tiles, low area uniformity that distorts toward the poles, 24-plus zoom levels with 1-to-4 nesting, trivial string-prefix neighbor logic, ubiquitous tiling libraries, high file-count risk at deep zoom." xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;color:var(--primary);font-family:var(--font-sans)">
  <title>Partition grid comparison matrix: H3 vs S2 vs Quadkey</title>
  <desc>A three-row matrix comparing H3, S2, and quadkey partition schemes across cell shape, area uniformity, resolution nesting, neighbor-query ergonomics, library support, and file-count risk. H3 wins on area uniformity, quadkey wins on neighbor simplicity, S2 balances both, and quadkey carries the highest file-count risk at deep zoom.</desc>
  <rect x="10" y="10" width="920" height="36" fill="currentColor" fill-opacity="0.07"/>
  <rect x="10" y="10" width="920" height="192" fill="none" stroke="currentColor" stroke-width="1.2" stroke-opacity="0.5"/>
  <line x1="120" y1="10" x2="120" y2="202" stroke="currentColor" stroke-width="1" stroke-opacity="0.3"/>
  <line x1="250" y1="10" x2="250" y2="202" stroke="currentColor" stroke-width="1" stroke-opacity="0.3"/>
  <line x1="390" y1="10" x2="390" y2="202" stroke="currentColor" stroke-width="1" stroke-opacity="0.3"/>
  <line x1="510" y1="10" x2="510" y2="202" stroke="currentColor" stroke-width="1" stroke-opacity="0.3"/>
  <line x1="640" y1="10" x2="640" y2="202" stroke="currentColor" stroke-width="1" stroke-opacity="0.3"/>
  <line x1="785" y1="10" x2="785" y2="202" stroke="currentColor" stroke-width="1" stroke-opacity="0.3"/>
  <line x1="10" y1="46" x2="930" y2="46" stroke="currentColor" stroke-width="1" stroke-opacity="0.3"/>
  <line x1="10" y1="98" x2="930" y2="98" stroke="currentColor" stroke-width="1" stroke-opacity="0.3"/>
  <line x1="10" y1="150" x2="930" y2="150" stroke="currentColor" stroke-width="1" stroke-opacity="0.3"/>
  <text x="20" y="32" font-size="11" font-weight="600" fill="currentColor">Scheme</text>
  <text x="130" y="32" font-size="11" font-weight="600" fill="currentColor">Cell shape</text>
  <text x="260" y="32" font-size="11" font-weight="600" fill="currentColor">Area uniformity</text>
  <text x="400" y="32" font-size="11" font-weight="600" fill="currentColor">Resolution nesting</text>
  <text x="520" y="32" font-size="11" font-weight="600" fill="currentColor">Neighbors</text>
  <text x="650" y="32" font-size="11" font-weight="600" fill="currentColor">Libraries</text>
  <text x="795" y="32" font-size="11" font-weight="600" fill="currentColor">File-count risk</text>
  <text x="20" y="68" font-size="12" font-weight="700" fill="currentColor">H3</text>
  <text x="20" y="83" font-size="8.5" fill="currentColor" fill-opacity="0.7">Uber</text>
  <text x="130" y="76" font-size="10" fill="currentColor">hexagon</text>
  <text x="260" y="76" font-size="10" fill="currentColor">high (&#177;10% area)</text>
  <text x="400" y="76" font-size="10" fill="currentColor">16 res &#183; 1&#8594;7</text>
  <text x="520" y="76" font-size="10" fill="currentColor">k-ring, uniform</text>
  <text x="650" y="76" font-size="10" fill="currentColor">mature (h3)</text>
  <text x="795" y="76" font-size="10" fill="currentColor">moderate</text>
  <text x="20" y="120" font-size="12" font-weight="700" fill="currentColor">S2</text>
  <text x="20" y="135" font-size="8.5" fill="currentColor" fill-opacity="0.7">Google</text>
  <text x="130" y="128" font-size="10" fill="currentColor">quad (curved)</text>
  <text x="260" y="128" font-size="10" fill="currentColor">medium</text>
  <text x="400" y="128" font-size="10" fill="currentColor">31 levels &#183; 1&#8594;4</text>
  <text x="520" y="128" font-size="10" fill="currentColor">edge neighbors</text>
  <text x="650" y="128" font-size="10" fill="currentColor">mature (s2)</text>
  <text x="795" y="128" font-size="10" fill="currentColor">low&#8211;moderate</text>
  <text x="20" y="172" font-size="12" font-weight="700" fill="currentColor">Quadkey</text>
  <text x="20" y="187" font-size="8.5" fill="currentColor" fill-opacity="0.7">Bing / XYZ</text>
  <text x="130" y="180" font-size="10" fill="currentColor">square tile</text>
  <text x="260" y="180" font-size="10" fill="currentColor">low (pole skew)</text>
  <text x="400" y="180" font-size="10" fill="currentColor">24+ zooms &#183; 1&#8594;4</text>
  <text x="520" y="180" font-size="10" fill="currentColor">prefix string</text>
  <text x="650" y="180" font-size="10" fill="currentColor">ubiquitous</text>
  <text x="795" y="180" font-size="10" fill="currentColor">high (deep zoom)</text>
</svg>

## Reading the Matrix Dimension by Dimension

**Cell shape and area uniformity.** H3 hexagons hold their surface area within roughly ten percent across the globe and, critically, every neighbor sits at an identical center-to-center distance — there are no diagonal-versus-orthogonal neighbors as there are with squares. That regularity makes per-partition feature counts far more even for spatially concentrated data such as urban vector layers or AIS tracks. S2 cells are curved quadrilaterals whose area varies more than H3 but far less than a naive lat/lon grid, because the cube projection compensates for most of the Mercator distortion. Quadkey tiles are true Web Mercator squares, so their ground area collapses toward the poles: a zoom-10 tile covers vastly more ground at the equator than at 60° latitude, which skews partition sizes badly for any archive spanning a wide latitude range.

**Resolution-to-partition mapping.** This is where the file-count math lives. H3 nests one parent to seven children (aperture 7), so each resolution step multiplies partition count by roughly seven and cell area shrinks by the same factor. S2 and quadkey both quarter — one parent to four children — so each level multiplies partitions by four. The practical consequence: to move from "too few, oversized partitions" to "right-sized," H3 gives you coarser control steps (×7) while S2 and quadkey let you tune in finer ×4 increments. When you are targeting a specific partition byte-size to satisfy a cold tier's minimum-object-size rule, that granularity matters, and it interacts directly with your [row-group sizing strategy](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/row-group-sizing-strategies/).

**Neighbor queries.** Quadkey wins on raw simplicity: a tile's parent is its string with the last character removed, and adjacency is cheap integer arithmetic on the X/Y at a zoom. H3's `k-ring` (or `grid_disk`) returns all cells within `k` steps in one call with uniform distance semantics — ideal for "buffer this cell" retrieval. S2 exposes edge neighbors and, because cells lie on a Hilbert curve, contiguous ranges of S2 cell IDs map to contiguous regions, which is excellent for range-scan pruning but less intuitive for ring buffers.

**Library support and file-count risk.** All three have production libraries (`h3`, `s2sphere`/`s2geometry`, `mercantile`). The file-count risk column is the one that silently wrecks archives: quadkey at deep zoom explodes into millions of tiny tiles, each an object with its own `PUT`/`GET`/lifecycle-transition cost. Choose a resolution that keeps partition files comfortably above the tier's minimum object size described in [Hot/Warm/Cold Tier Design for Geospatial Data](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/hotwarmcold-tier-design-for-geospatial-data/), and model the request-count consequences against the [spatial archive cost model](https://www.spatialdataarchival.org/spatial-archive-cost-modeling/) before committing.

## Generating Partition Keys in All Three Schemes

Compute the key the same way regardless of scheme: derive a representative point (centroid for polygons, the point itself for points) in `EPSG:4326`, then index it. The following resolves one partition key per feature for each grid so you can compare partition cardinality before you commit.

```python
import geopandas as gpd
import h3
import s2sphere
import mercantile

# Read a projected source; H3/S2/quadkey all index geographic coordinates.
gdf = gpd.read_file("s3://spatial-archive/vector/2024/parcels_region_north.fgb")
pts = gdf.geometry.to_crs(4326).representative_point()

H3_RES, S2_LEVEL, QK_ZOOM = 6, 10, 10  # coarse-to-comparable partition granularity

def keys(pt):
    lat, lng = pt.y, pt.x
    h3_key = h3.latlng_to_cell(lat, lng, H3_RES)
    s2_cell = s2sphere.CellId.from_lat_lng(
        s2sphere.LatLng.from_degrees(lat, lng)
    ).parent(S2_LEVEL)
    s2_key = s2_cell.to_token()              # compact hex token, e.g. "89c2594"
    qk_key = mercantile.quadkey(             # base-4 string, e.g. "0231010121"
        mercantile.tile(lng, lat, QK_ZOOM)
    )
    return h3_key, s2_key, qk_key

gdf[["h3_cell", "s2_token", "quadkey"]] = [keys(p) for p in pts]

# Partition cardinality is the number of directories each scheme would create.
for col in ("h3_cell", "s2_token", "quadkey"):
    print(f"{col:10s} -> {gdf[col].nunique():>8d} partitions")
```

Write the winning key into the Hive-style path exactly as the migration pipeline does — `s3://spatial-archive/vector/h3_cell=8a2a1072b59ffff/part-0000.parquet` — so the partition column is prunable at query time. The mechanics of that partitioned write are covered in [Converting Legacy Shapefiles to GeoParquet at Scale](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/geoparquet-migration-workflows/converting-legacy-shapefiles-to-geoparquet-at-scale/).

## Validating Partition Balance Before You Commit

The failure mode is a heavy-tailed partition distribution: a handful of cells over dense metros hold most of the features while thousands of rural cells hold a few rows each. Measure the skew directly with DuckDB against the keyed output before you write the final tree.

```bash
duckdb -c "
SELECT h3_cell,
       count(*)                    AS features,
       count(*) FILTER (WHERE true) * 1.0 /
         (SELECT avg(c) FROM (SELECT count(*) c FROM read_parquet('keyed/*.parquet') GROUP BY h3_cell)) AS skew_ratio
FROM read_parquet('keyed/*.parquet')
GROUP BY h3_cell
ORDER BY features DESC
LIMIT 5"
```

Expected output — the top partitions should sit within roughly an order of magnitude of the mean; a `skew_ratio` above ~50 means the resolution is too coarse for your dense regions and those cells will dominate scan time:

```text
┌─────────────────┬──────────┬────────────┐
│     h3_cell     │ features │ skew_ratio │
│     varchar     │  int64   │   double   │
├─────────────────┼──────────┼────────────┤
│ 8a2a1072b59ffff │   184213 │      7.4   │
│ 8a2a1072b5b7fff │   151902 │      6.1   │
│ 8a1fb46622dffff │   142338 │      5.7   │
│ 8a2a10725d37fff │   128004 │      5.1   │
│ 8a1fb46622c7fff │   119887 │      4.8   │
└─────────────────┴──────────┴────────────┘
```

If the skew is unacceptable, either step to a finer resolution for the whole dataset or split only the hot cells to a deeper resolution — a mixed-resolution layout H3 and S2 both support natively because a parent cell ID unambiguously contains its children.

## Common Partition-Key Failures

| Symptom | Cause | Fix |
|---------|-------|-----|
| A few partitions 100&#215; larger than the median | Resolution too coarse for dense metros; uniform grid can't adapt to concentrated features | Step one resolution finer, or split only hot cells to a deeper H3/S2 child level |
| Millions of sub-megabyte partition files, high `LIST`/`GET` bill | Quadkey zoom (or H3/S2 level) too deep; each cell became its own object | Coarsen the level; target partition files above the tier minimum object size |
| Bounding-box query scans the whole tree | Partition column not written into the path, so the planner can't prune | Emit `scheme_cell=VALUE` as a real Hive path segment, not just a table column |
| Cells straddling the antimeridian or poles behave oddly | Quadkey undefined beyond &#177;85.05° Mercator latitude; polar data lost | Use H3 or S2, which cover the full sphere including the poles |

## Operational Execution Checklist

- [ ] Derive partition keys from a representative point in `EPSG:4326`, never from projected coordinates, so cell assignment is stable.
- [ ] Run the three-scheme cardinality comparison and pick the grid whose partition count matches your target file size.
- [ ] Measure partition skew with the DuckDB `skew_ratio` query and reject any resolution that leaves a `skew_ratio` above ~50.
- [ ] Confirm target partition files exceed the cold tier's minimum object size to avoid per-request and early-deletion penalties.
- [ ] Write the chosen key as a real Hive path segment (`h3_cell=`, `s2_token=`, or `quadkey=`) so predicate pushdown can prune.
- [ ] For wide-latitude or polar archives, choose H3 or S2 — never quadkey — because Mercator tiling breaks past &#177;85° and skews area badly.
- [ ] Record the scheme, resolution, and key derivation as an immutable part of the dataset contract; changing it later is a full rewrite.

## Related

- Up: [Spatial Partitioning Techniques](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/spatial-partitioning-techniques/) — the parent reference for choosing and sizing partition keys across an archive.
- [Partitioning Cold Spatial Archives by Administrative Boundary](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/spatial-partitioning-techniques/partitioning-cold-spatial-archives-by-administrative-boundary/) — the sibling approach when queries and retention follow country/state lines rather than a uniform grid.
- [Calculating Optimal Row-Group Size for Spatial Queries](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/row-group-sizing-strategies/calculating-optimal-row-group-size-for-spatial-queries/) — sizing row groups within each partition once the grid resolution is fixed.
- [Hot/Warm/Cold Tier Design for Geospatial Data](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/hotwarmcold-tier-design-for-geospatial-data/) — the minimum-object-size and retrieval constraints that bound your grid resolution.
- [Spatial Archive Cost Modeling](https://www.spatialdataarchival.org/spatial-archive-cost-modeling/) — model the request-count and storage impact of file-count blowup before committing to a resolution.

_Part of the [Spatial Data Archival](https://www.spatialdataarchival.org/) knowledge base._
