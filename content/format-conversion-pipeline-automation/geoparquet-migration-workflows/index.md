# GeoParquet Migration Workflows

Migrating legacy spatial datasets into GeoParquet fails most often not at the geometry-encoding step but in the quiet gaps around it: an attribute column silently downcast from `float64` to `float32`, a `.prj` that never resolved to an authority code, a partition layout that buries predicate pushdown under thousands of tiny files. This page is for the data engineers and GIS archivists who own that conversion path and need a deterministic, auditable migration — one that preserves geometric fidelity, exploits columnar compression, and lands query-ready assets in cold storage without paying for re-ingestion six months later. It sits inside the broader [Format Conversion & Pipeline Automation](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/) discipline and treats GeoParquet migration as a repeatable workflow, never a one-off export.

## The Failure Mode: Lossy, Non-Reproducible Migration

The defining problem with shapefile-to-GeoParquet migration is that the most damaging errors do not raise exceptions. A pipeline reads a 30-year-old shapefile, writes a valid Parquet file, registers a clean catalog entry — and only months later does an analyst discover that survey-grade coordinates were truncated to two decimals, that a reserved-keyword column name broke a downstream query engine, or that `LineString` and `MultiLineString` features were silently coerced into a single mixed-geometry column that no spatial index can partition cleanly.

Four distinct conditions feed this failure mode:

- **Attribute degradation.** Legacy DBF stores everything as fixed-width text; an undisciplined reader infers types per-chunk, so the same column lands as `int64` in one partition and `string` in another, fracturing the schema across the dataset.
- **Geometry coercion.** Mixed single/multi geometries, unclosed rings, and self-intersections pass through naive writers and surface later as invalid WKB that breaks spatial joins.
- **CRS loss.** A missing or free-text `.prj` defaults silently to `EPSG:4326`, writing projected metre coordinates into a longitude/latitude column.
- **Pathological partitioning.** Writing one file per source feature, or one giant unpartitioned file, destroys the predicate pushdown that makes columnar archives worth the migration in the first place.

<svg viewBox="0 0 900 340" role="img" aria-label="A funnel showing a legacy shapefile entering naive migration. Four silent corruptions leak out of the funnel before a verified GeoParquet write is reached: attribute downcast from float64 to float32, geometry coercion of mixed single and multi geometries, a silent CRS default to EPSG:4326, and a tiny-file explosion that loses predicate pushdown. Only by stopping all four leaks does the funnel deliver a verified GeoParquet output." xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;color:var(--primary);font-family:var(--font-sans)">
  <title>Silent corruptions leaking out of a naive GeoParquet migration</title>
  <desc>A legacy shapefile enters a naive-migration funnel. Four defects that raise no exception — attribute downcast (float64 to float32), geometry coercion (mixed single/multi), silent CRS default to EPSG:4326, and a tiny-file explosion that destroys predicate pushdown — leak out before the narrow end. The funnel only yields a verified GeoParquet write (WKB, ZSTD, per-row bbox) once every leak is gated shut.</desc>
  <defs>
    <marker id="fnl-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <!-- input -->
  <rect x="14" y="95" width="150" height="70" rx="10" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-opacity="0.4"/>
  <g text-anchor="middle" fill="currentColor">
    <text x="89" y="125" font-size="13.5" font-weight="700">Legacy shapefile</text>
    <text x="89" y="146" font-size="11.5" fill-opacity="0.75">.shp · .dbf · .prj</text>
  </g>
  <path d="M164 130 H210" stroke="currentColor" stroke-width="2" stroke-opacity="0.55" fill="none" marker-end="url(#fnl-arrow)"/>
  <!-- funnel -->
  <polygon points="212,50 600,110 600,150 212,210" fill="currentColor" fill-opacity="0.06" stroke="currentColor" stroke-opacity="0.4"/>
  <g text-anchor="middle" fill="currentColor">
    <text x="392" y="118" font-size="13.5" font-weight="700">Naive migration</text>
    <text x="392" y="137" font-size="11.5" fill-opacity="0.7">valid Parquet, no exception raised</text>
  </g>
  <!-- output -->
  <path d="M600 130 H628" stroke="currentColor" stroke-width="2" stroke-opacity="0.7" fill="none" marker-end="url(#fnl-arrow)"/>
  <rect x="630" y="95" width="166" height="70" rx="10" fill="currentColor" fill-opacity="0.14" stroke="currentColor" stroke-opacity="0.65" stroke-width="1.5"/>
  <g text-anchor="middle" fill="currentColor">
    <text x="713" y="125" font-size="13.5" font-weight="700">Verified GeoParquet</text>
    <text x="713" y="146" font-size="11.5" fill-opacity="0.8">WKB · ZSTD · bbox</text>
  </g>
  <!-- leaks -->
  <g stroke="currentColor" stroke-width="2" stroke-opacity="0.5" fill="none" stroke-dasharray="4 3">
    <path d="M300 196 L116 246" marker-end="url(#fnl-arrow)"/>
    <path d="M400 181 L335 246" marker-end="url(#fnl-arrow)"/>
    <path d="M500 166 L554 246" marker-end="url(#fnl-arrow)"/>
    <path d="M580 153 L773 246" marker-end="url(#fnl-arrow)"/>
  </g>
  <g fill="currentColor">
    <circle cx="300" cy="196" r="3"/><circle cx="400" cy="181" r="3"/><circle cx="500" cy="166" r="3"/><circle cx="580" cy="153" r="3"/>
  </g>
  <g text-anchor="middle">
    <g>
      <rect x="14" y="250" width="204" height="68" rx="9" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-opacity="0.32"/>
      <text x="116" y="278" font-size="12.5" font-weight="700" fill="currentColor">Attribute downcast</text>
      <text x="116" y="298" font-size="11" fill="currentColor" fill-opacity="0.75">float64 → float32</text>
    </g>
    <g>
      <rect x="233" y="250" width="204" height="68" rx="9" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-opacity="0.32"/>
      <text x="335" y="278" font-size="12.5" font-weight="700" fill="currentColor">Geometry coercion</text>
      <text x="335" y="298" font-size="11" fill="currentColor" fill-opacity="0.75">mixed single / multi</text>
    </g>
    <g>
      <rect x="452" y="250" width="204" height="68" rx="9" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-opacity="0.32"/>
      <text x="554" y="278" font-size="12.5" font-weight="700" fill="currentColor">CRS default</text>
      <text x="554" y="298" font-size="11" fill="currentColor" fill-opacity="0.75">silent EPSG:4326</text>
    </g>
    <g>
      <rect x="671" y="250" width="215" height="68" rx="9" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-opacity="0.32"/>
      <text x="778" y="278" font-size="12.5" font-weight="700" fill="currentColor">Tiny-file explosion</text>
      <text x="778" y="298" font-size="11" fill="currentColor" fill-opacity="0.75">predicate pushdown lost</text>
    </g>
  </g>
</svg>

Because columnar archives are immutable once written, every one of these defects costs a full re-ingestion rather than an in-place patch. The migration workflow below is therefore built as a sequence of fail-fast gates, not a best-effort transform.

## Migration Flow

Legacy formats are harmonized and reprojected before a verified GeoParquet write:

<svg viewBox="0 0 960 150" role="img" aria-label="Five-stage GeoParquet migration pipeline running left to right: a legacy shapefile or GeoJSON is harmonized to a strict schema and type set, then reprojected and CRS-validated, then written to GeoParquet as WKB with ZSTD compression, and finally verified and catalogued." xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;color:var(--primary);font-family:var(--font-sans)">
  <title>GeoParquet migration pipeline, left to right</title>
  <desc>Legacy formats are harmonized and reprojected before a verified GeoParquet write: legacy shapefile/GeoJSON → harmonize schema and types → reproject and validate CRS → write GeoParquet (WKB, ZSTD) → verify and catalog.</desc>
  <defs>
    <marker id="pipe-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <g text-anchor="middle" fill="currentColor">
    <g>
      <rect x="8" y="45" width="174" height="64" rx="10" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-opacity="0.4"/>
      <text x="95" y="73" font-size="12.5" font-weight="700">Legacy shapefile</text>
      <text x="95" y="91" font-size="12" fill-opacity="0.78">/ GeoJSON</text>
    </g>
    <g>
      <rect x="198" y="45" width="174" height="64" rx="10" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-opacity="0.4"/>
      <text x="285" y="73" font-size="12.5" font-weight="700">Harmonize</text>
      <text x="285" y="91" font-size="12" fill-opacity="0.78">schema + types</text>
    </g>
    <g>
      <rect x="388" y="45" width="174" height="64" rx="10" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-opacity="0.4"/>
      <text x="475" y="73" font-size="12.5" font-weight="700">Reproject +</text>
      <text x="475" y="91" font-size="12" fill-opacity="0.78">validate CRS</text>
    </g>
    <g>
      <rect x="578" y="45" width="174" height="64" rx="10" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-opacity="0.4"/>
      <text x="665" y="73" font-size="12.5" font-weight="700">Write GeoParquet</text>
      <text x="665" y="91" font-size="12" fill-opacity="0.78">WKB · ZSTD</text>
    </g>
    <g>
      <rect x="768" y="45" width="174" height="64" rx="10" fill="currentColor" fill-opacity="0.14" stroke="currentColor" stroke-opacity="0.65" stroke-width="1.5"/>
      <text x="855" y="73" font-size="12.5" font-weight="700">Verify +</text>
      <text x="855" y="91" font-size="12" fill-opacity="0.85">catalog</text>
    </g>
  </g>
  <g stroke="currentColor" stroke-width="2" stroke-opacity="0.55" fill="none">
    <path d="M182 77 H198" marker-end="url(#pipe-arrow)"/>
    <path d="M372 77 H388" marker-end="url(#pipe-arrow)"/>
    <path d="M562 77 H578" marker-end="url(#pipe-arrow)"/>
    <path d="M752 77 H768" marker-end="url(#pipe-arrow)"/>
  </g>
</svg>

## Prerequisite Context

This workflow assumes several upstream decisions are already settled. You should have a target object store and storage class chosen — the trade-offs are covered in [Object Storage Selection for GIS Archives](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/object-storage-selection-for-gis-archives/) — and a [Hot/Warm/Cold Tier Design for Geospatial Data](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/hotwarmcold-tier-design-for-geospatial-data/) in place so freshly migrated partitions land in the correct tier rather than incurring early-deletion penalties. A canonical attribute contract should already exist; the type-coercion matrices live in [Schema Mapping & Attribute Validation](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/schema-mapping-attribute-validation/), and CRS normalization should be handled by the [CRS Synchronization in Pipelines](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/crs-synchronization-in-pipelines/) controls so this writer can assume a single, validated projection. This page owns the step where those inputs are serialized into GeoParquet; it links up to the [Format Conversion & Pipeline Automation](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/) discipline for the orchestration context around it.

## Concept & Design Decisions

GeoParquet is Apache Parquet with a `geo` metadata block in the file footer plus one or more geometry columns encoded as WKB (Well-Known Binary). The migration decisions that matter are the ones that are expensive or impossible to change after the write.

**Geometry encoding.** Encode geometry as WKB in a dedicated `geometry` column and record the bounding box and authority CRS in the `geo` metadata. Validate topology before serialization — repair unclosed rings and self-intersections at ingest, because invalid WKB is not detectable from the Parquet schema alone.

**Schema harmonization and type coercion.** Normalize attribute schemas before any geometry is written. Enforce a strict Parquet-compatible type set (`string`, `int64`, `float64`, `boolean`, `timestamp`), apply deterministic `snake_case` casing, strip reserved SQL keywords and non-alphanumeric characters, and reject silent type downgrades (a `float64`→`float32` coercion that quietly drops survey precision must be a hard error, not a warning). Drive schema evolution from a versioned manifest so incremental field additions apply as backward-compatible column appends rather than triggering a full dataset rewrite.

**CRS synchronization.** Cast every geometry to one target CRS — `EPSG:4326` for global archival, a local projected CRS for high-precision engineering datasets — and validate bounding boxes after transformation to catch coordinate wrapping or datum-shift omission. Cap coordinate precision explicitly: 7 decimal places gives roughly 11 mm resolution at the equator, beyond which you pay storage for noise. Always use `pyproj`/GDAL with the correct transformation grid; a missing grid is a hard error, never a silent fallback.

**Partitioning.** Partition by a spatial index (H3, S2, or geohash) or by temporal/business keys to maximize predicate pushdown. Target 128 MB–256 MB per file: smaller files drown the catalog in metadata and kill range-request efficiency, while larger files force readers to scan past the row groups they need. Avoid over-partitioning — one file per source feature is the single most common throughput killer.

**Compression.** Use ZSTD for archival writes; levels 3–5 give the best ratio-to-CPU balance for spatial coordinates and categorical attributes. Snappy remains viable only for high-throughput streaming where CPU is the binding constraint. Tune the codec after the schema is settled, following [ZSTD Level Configuration for Spatial Files](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/zstd-level-configuration-for-spatial-files/), and size row groups deliberately per [Row Group Sizing Strategies](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/row-group-sizing-strategies/) so coordinate columns compress as a block.

## Implementation

The writer below performs the full migration for one source dataset: pre-flight schema harmonization, CRS validation, topology repair, spatial partitioning, and a ZSTD-compressed GeoParquet write with explicit row-group sizing. It is idempotent — re-running it overwrites the same partition keys deterministically.

```python
# migrate_to_geoparquet.py — shapefile/GeoJSON → partitioned GeoParquet
# Run: python migrate_to_geoparquet.py
import geopandas as gpd
import pandas as pd
import h3
from pathlib import Path

SOURCE = "datasets/parcels/raw/county_parcels_1998.shp"
DEST   = "datasets/parcels/geoparquet/"        # partitioned output root
TARGET_CRS = "EPSG:4326"                         # global archival projection
COORD_PRECISION = 7                              # ~11 mm at the equator
H3_RES = 7                                        # ~5 km² cells, balances file count

# Canonical Parquet-compatible attribute contract (reject anything else).
SCHEMA = {
    "parcel_id": "string",
    "owner": "string",
    "assessed_value": "float64",
    "last_sale": "datetime64[ns]",
    "zoning": "string",
}

def harmonize(gdf: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    # snake_case, strip non-alphanumerics, drop reserved-keyword collisions.
    gdf.columns = [c.strip().lower().replace(" ", "_") for c in gdf.columns]
    for col, dtype in SCHEMA.items():
        if col not in gdf.columns:
            raise ValueError(f"missing required column: {col}")
        # Hard-fail on lossy downcast instead of silently truncating precision.
        if dtype == "float64" and gdf[col].dtype == "float32":
            raise ValueError(f"refusing float32 downcast on {col}")
        gdf[col] = gdf[col].astype(dtype)
    return gdf[list(SCHEMA) + ["geometry"]]

def main():
    gdf = gpd.read_file(SOURCE)
    if gdf.crs is None:
        raise ValueError("source CRS is absent — refusing silent EPSG:4326 default")
    gdf = gdf.to_crs(TARGET_CRS)                  # explicit reprojection

    # Topology repair: fix unclosed rings / self-intersections before WKB encode.
    gdf["geometry"] = gdf.geometry.make_valid()
    gdf = gdf[~gdf.geometry.is_empty & gdf.geometry.notna()]

    gdf = harmonize(gdf)

    # Cap coordinate precision to remove storage-inflating noise.
    gdf["geometry"] = gdf.geometry.set_precision(10 ** -COORD_PRECISION)

    # Spatial partition key from representative point (centroid of geometry).
    reps = gdf.geometry.representative_point()
    gdf["h3_cell"] = [
        h3.latlng_to_cell(p.y, p.x, H3_RES) for p in reps
    ]

    Path(DEST).mkdir(parents=True, exist_ok=True)
    gdf.to_parquet(
        DEST,
        partition_cols=["h3_cell"],   # predicate pushdown by spatial cell
        compression="zstd",
        compression_level=4,          # ratio/CPU sweet spot for coordinates
        row_group_size=120_000,       # ~128–256 MB groups for these columns
        geometry_encoding="WKB",
        write_covering_bbox=True,      # bbox per row for fast spatial filter
        index=False,
    )

if __name__ == "__main__":
    main()
```

The spatial-specific choices are deliberate: `make_valid()` runs before encoding so no invalid WKB reaches the footer; `set_precision()` caps coordinates so ZSTD is not asked to compress survey noise; `write_covering_bbox=True` adds the per-row bounding box that lets readers skip row groups during spatial filters; and `partition_cols=["h3_cell"]` yields balanced files instead of the per-feature explosion that naive writers produce.

## Validation Gate

Never promote a migrated partition to production storage without an automated gate that asserts row counts, CRS, and geometry validity against the source. The fastest check uses GDAL's `ogrinfo`, which reads the GeoParquet `geo` metadata directly:

```bash
# Assert the written CRS and feature count match the source manifest.
ogrinfo -so -al datasets/parcels/geoparquet/ 2>/dev/null \
  | grep -E "Feature Count|Geometry|PROJCRS|GEOGCRS|ID\[\"EPSG\""
```

Expected output for a correctly migrated parcels dataset:

```
Geometry: Polygon
Feature Count: 184213
        ID["EPSG",4326]]
```

The most common failure here is a `Feature Count` lower than the source. The root cause is almost always the `~gdf.geometry.is_empty` filter discarding geometries that `make_valid()` could not repair — typically degenerate polygons with zero area or rings collapsed to a single point. Resolve it by logging the dropped feature IDs to a quarantine manifest rather than silently shrinking the dataset; an unexplained count drop must fail the gate, not pass it. Cross-validate bounding-box extents and SHA-256 checksums per partition against the source manifest before flipping the catalog entry to `published`.

## Cost & Performance Trade-offs

The migration parameters trade compute spend at write time against storage and retrieval spend for the life of the archive. The dominant levers and their measured impact on a representative 50 GB vector archive:

| Decision | Setting | Storage / Speed impact | When to choose |
| --- | --- | --- | --- |
| Compression codec | ZSTD-4 | ~3.1× ratio, ~140 MB/s write | Default archival writes |
| Compression codec | ZSTD-9 | ~3.4× ratio, ~38 MB/s write | Rarely-read deep archive |
| Compression codec | Snappy | ~2.2× ratio, ~480 MB/s write | CPU-bound streaming ingest |
| Coordinate precision | 7 dp | Baseline storage | Survey/engineering data |
| Coordinate precision | 5 dp | ~12% smaller geometry column | Web/visualization archives |
| Partition size | 128–256 MB | Optimal pushdown + low metadata | Standard query workloads |
| Partition size | <16 MB | 4–9× catalog metadata overhead | Avoid — pathological |

The 6% extra compression from ZSTD-9 over ZSTD-4 costs roughly 3.7× the write CPU; for cold archives read a few times a year that trade is worth it, but for actively queried tiers it is not. Trimming precision from 7 to 5 decimal places is the single cheapest storage win for visualization-grade data, but it is irreversible — once written you cannot recover the discarded digits, so apply it only where sub-metre accuracy is genuinely not required.

## Failure Modes & Edge Cases

- **Mixed single/multi geometries in one column.** A source mixing `Polygon` and `MultiPolygon` writes a heterogeneous geometry column that some readers reject and that no spatial index partitions cleanly. Promote everything to the multi-variant (`MultiPolygon`) during harmonization so the column is homogeneous.
- **Row-group boundaries that split spatial locality.** If `row_group_size` is set without regard to partition ordering, geographically adjacent features scatter across row groups and the per-row bbox stops helping. Sort by the H3 cell before writing so each row group covers a contiguous spatial extent — see [Row Group Sizing Strategies](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/row-group-sizing-strategies/).
- **CRS metadata present in the file but absent from the partition key.** Catalog discovery that filters on a `crs` partition column will miss data whose CRS lives only in the `geo` footer. Expose the authority code as both file metadata and a partition key, and register it in [Metadata Cataloging & Discovery](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/metadata-cataloging-discovery/).
- **High-entropy geometry defeating compression.** Densely vertexed coastlines or LiDAR-derived polygons can push ZSTD ratios below 1.5×, inflating storage unexpectedly. Detect it with a post-write ratio check and either simplify geometry upstream or accept the cost — do not silently raise the compression level, which only burns CPU. For latency-sensitive web-mapping retrieval where columnar batch reads are too slow, evaluate [FlatGeobuf Optimization Techniques](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/flatgeobuf-optimization-techniques/) as a complementary format.

## Operational Execution Checklist

- [ ] Canonical attribute contract defined; required columns and Parquet types enforced before any geometry write
- [ ] Lossy type downcasts (`float64`→`float32`) configured as hard errors, not warnings
- [ ] Source CRS resolved from embedded metadata only; absent CRS quarantined, never defaulted
- [ ] All geometries reprojected to one target CRS and bounding boxes re-validated post-transform
- [ ] Topology repaired (`make_valid`) and empty/degenerate geometries routed to a quarantine manifest
- [ ] Coordinate precision capped to the domain's accuracy requirement before serialization
- [ ] Geometry written as WKB with per-row covering bbox enabled
- [ ] Spatial partition key (H3/S2/geohash) applied; files sized 128–256 MB
- [ ] ZSTD level and row-group size tuned for the read profile, not left at defaults
- [ ] Validation gate asserts feature count, authority CRS, and SHA-256 checksums against source
- [ ] Lineage tagged with source version, transform commit hash, grid version, and run ID
- [ ] Catalog entry flipped to `published` only after the gate passes; raw source retained in cold tier

## Related

- [Converting Legacy Shapefiles to GeoParquet at Scale](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/geoparquet-migration-workflows/converting-legacy-shapefiles-to-geoparquet-at-scale/) — the step-by-step procedure for chunked reads, memory-mapped I/O, and batch sizing that operationalises this workflow at multi-terabyte scale.
- [Schema Mapping & Attribute Validation](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/schema-mapping-attribute-validation/) — the attribute contract and type-coercion matrices that the harmonization stage depends on.
- [CRS Synchronization in Pipelines](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/crs-synchronization-in-pipelines/) — the upstream control that delivers a single validated projection before this writer runs.
- [ZSTD Level Configuration for Spatial Files](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/zstd-level-configuration-for-spatial-files/) — codec tuning that should follow, not precede, settling the schema and precision.
- [Retention Policy Frameworks](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/retention-policy-frameworks/) — the lifecycle rules that move migrated partitions through hot, warm, and cold tiers without early-deletion penalties.

**Up one level:** [Format Conversion & Pipeline Automation](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/)
