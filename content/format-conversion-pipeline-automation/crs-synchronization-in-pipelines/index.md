# CRS Synchronization in Pipelines: Production Configurations for Spatial Archival

Coordinate Reference System (CRS) desynchronization is the most expensive silent failure in spatial archival. When heterogeneous sources land in a single pipeline carrying mismatched projections, geometries drift by metres to kilometres, spatial joins return empty result sets, bounding-box indexes point at the wrong tiles, and compliance audits fail months after the data was written. This page is for the data engineers, GIS archivists, and cloud architects who own the ingestion path and need a deterministic way to normalise CRS metadata before anything is serialised, partitioned, or tiered to cold storage. It sits inside the broader [Format Conversion & Pipeline Automation](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/) discipline and assumes you are converting raw vector and raster assets into archival columnar formats at scale.

## The Failure Mode: Silent Geometry Drift

The defining problem is that CRS errors do not raise exceptions — they produce *plausible-looking wrong answers*. A pipeline that assumes WGS84 (`EPSG:4326`) but ingests a UTM-projected shapefile (`EPSG:26910`) will happily write coordinates in the hundreds of thousands into a longitude/latitude column. Nothing crashes. The Parquet file validates. The catalog entry looks correct. The corruption only surfaces when a downstream consumer runs a spatial intersection and gets zero matches, or when an auditor overlays the archive on a basemap and the features land in the ocean.

Three distinct conditions feed this failure:

- **Absent CRS metadata.** Object-storage connectors and distributed readers frequently default to `EPSG:4326` when a `.prj` sidecar is missing or a GeoJSON omits its `crs` member. The default is applied silently and never logged.
- **Authority-code ambiguity.** A source may declare `WGS_1984` as a free-text WKT string that does not cleanly map to an authority code, leaving the reprojection step to guess.
- **Datum-shift omission.** Reprojecting between datums (for example NAD27 to NAD83) without the correct transformation grid introduces systematic shifts of tens of metres that pass every bounds check yet violate survey-grade accuracy requirements.

<svg viewBox="0 0 760 318" role="img" aria-label="Cascade diagram: a single mislabeled-CRS source enters the ingestion pipeline and silently contaminates every partition it touches, triggering four downstream corruptions — empty spatial joins, bounding-box indexes pointing at the wrong tiles, a failed compliance audit that surfaces months later, and features landing off the basemap in the ocean." xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;color:var(--primary);font-family:var(--font-sans)">
  <title>One mislabeled CRS source cascades into four silent downstream corruptions</title>
  <desc>A mislabeled-CRS source feeds the ingestion pipeline, which writes contaminated partitions that no exception catches. The corruption fans out into empty spatial joins, wrong index tiles, a failed compliance audit, and features rendered off the basemap.</desc>
  <defs>
    <marker id="crs-cascade-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <!-- source -->
  <rect x="14" y="123" width="192" height="72" rx="10" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-opacity="0.5" stroke-width="1.5"/>
  <text x="110" y="152" text-anchor="middle" font-size="14" font-weight="700" fill="currentColor">Mislabeled CRS source</text>
  <text x="110" y="172" text-anchor="middle" font-size="11" fill="currentColor" fill-opacity="0.75">absent · ambiguous · wrong datum</text>
  <!-- pipeline -->
  <rect x="258" y="119" width="150" height="80" rx="10" fill="currentColor" fill-opacity="0.1" stroke="currentColor" stroke-opacity="0.6" stroke-width="1.5"/>
  <text x="333" y="150" text-anchor="middle" font-size="13.5" font-weight="700" fill="currentColor">Ingestion</text>
  <text x="333" y="168" text-anchor="middle" font-size="13.5" font-weight="700" fill="currentColor">pipeline</text>
  <text x="333" y="186" text-anchor="middle" font-size="10.5" fill="currentColor" fill-opacity="0.7">no exception raised</text>
  <!-- four corruptions -->
  <g>
    <rect x="470" y="20" width="276" height="56" rx="9" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-opacity="0.4"/>
    <text x="486" y="44" font-size="13" font-weight="700" fill="currentColor">Empty spatial joins</text>
    <text x="486" y="62" font-size="11" fill="currentColor" fill-opacity="0.75">intersections return zero matches</text>
  </g>
  <g>
    <rect x="470" y="92" width="276" height="56" rx="9" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-opacity="0.4"/>
    <text x="486" y="116" font-size="13" font-weight="700" fill="currentColor">Wrong index tiles</text>
    <text x="486" y="134" font-size="11" fill="currentColor" fill-opacity="0.75">bbox index points at the wrong tiles</text>
  </g>
  <g>
    <rect x="470" y="164" width="276" height="56" rx="9" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-opacity="0.4"/>
    <text x="486" y="188" font-size="13" font-weight="700" fill="currentColor">Failed compliance audit</text>
    <text x="486" y="206" font-size="11" fill="currentColor" fill-opacity="0.75">surfaces months after the write</text>
  </g>
  <g>
    <rect x="470" y="236" width="276" height="56" rx="9" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-opacity="0.4"/>
    <text x="486" y="260" font-size="13" font-weight="700" fill="currentColor">Features off-basemap</text>
    <text x="486" y="278" font-size="11" fill="currentColor" fill-opacity="0.75">geometries land in the ocean</text>
  </g>
  <!-- connectors -->
  <g stroke="currentColor" fill="none" stroke-width="2">
    <path d="M206 159 H254" stroke-opacity="0.55" marker-end="url(#crs-cascade-arrow)"/>
    <path d="M408 159 H440 V48 H466" stroke-opacity="0.45" marker-end="url(#crs-cascade-arrow)"/>
    <path d="M408 159 H440 V120 H466" stroke-opacity="0.45" marker-end="url(#crs-cascade-arrow)"/>
    <path d="M408 159 H440 V192 H466" stroke-opacity="0.45" marker-end="url(#crs-cascade-arrow)"/>
    <path d="M408 159 H440 V264 H466" stroke-opacity="0.45" marker-end="url(#crs-cascade-arrow)"/>
  </g>
</svg>

A single mislabeled source contaminates every partition it touches, and because columnar archives are immutable once written, recovery means a full re-ingestion rather than an in-place patch. Eliminating the failure mode is therefore an ingestion-time control, not a post-processing cleanup.

## Prerequisite Context

Before enforcing CRS synchronisation you should already have:

- A target archival format selected and a writer configured — typically GeoParquet via the [GeoParquet Migration Workflows](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/geoparquet-migration-workflows/) path for analytical archives, or FlatGeobuf via [FlatGeobuf Optimization Techniques](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/flatgeobuf-optimization-techniques/) for streaming and web-mapping retrieval.
- An attribute contract in place. CRS normalisation runs alongside, not instead of, the type-coercion rules defined in [Schema Mapping & Attribute Validation](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/schema-mapping-attribute-validation/); a reprojection that changes coordinate precision must not silently break a join key.
- A PROJ installation pinned to a known version (PROJ 9.x) with access to its transformation-grid cache, because datum-shift accuracy is version-sensitive.

This page is one branch of the parent [Format Conversion & Pipeline Automation](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/) workflow; if you have not yet standardised your ingestion orchestration, start there before wiring in the CRS gate described below.

## CRS Normalization Flow

Every input is interrogated and reprojected before serialization, or quarantined if its CRS cannot be trusted:

<svg viewBox="0 0 800 236" role="img" aria-label="CRS normalization flow: a source vector is interrogated to detect its source CRS, then a validity gate decides its path. If the CRS cannot be trusted the record is quarantined; if it is valid the geometry is reprojected to the canonical EPSG:4326 and its CRS is embedded in the output metadata before serialization." xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;color:var(--primary);font-family:var(--font-sans)">
  <title>CRS normalization flow with a fail-fast validity gate</title>
  <desc>Source vector goes to detect source CRS, then a CRS-valid decision. Invalid records branch down to quarantine; valid records reproject to EPSG:4326 and embed the CRS in metadata.</desc>
  <defs>
    <marker id="crs-flow-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <g font-size="12.5" text-anchor="middle">
    <!-- source -->
    <rect x="12" y="44" width="124" height="56" rx="10" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-opacity="0.5"/>
    <text x="74" y="77" font-weight="700" fill="currentColor">Source vector</text>
    <!-- detect -->
    <rect x="160" y="44" width="132" height="56" rx="10" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-opacity="0.5"/>
    <text x="226" y="70" font-weight="700" fill="currentColor">Detect</text>
    <text x="226" y="87" font-weight="700" fill="currentColor">source CRS</text>
    <!-- decision diamond -->
    <path d="M376 30 L436 72 L376 114 L316 72 Z" fill="currentColor" fill-opacity="0.1" stroke="currentColor" stroke-opacity="0.6" stroke-width="1.5"/>
    <text x="376" y="76" font-weight="700" fill="currentColor">CRS valid?</text>
    <!-- reproject -->
    <rect x="468" y="44" width="156" height="56" rx="10" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-opacity="0.5"/>
    <text x="546" y="70" font-weight="700" fill="currentColor">Reproject to</text>
    <text x="546" y="87" font-weight="700" fill="currentColor">EPSG:4326</text>
    <!-- embed -->
    <rect x="652" y="44" width="136" height="56" rx="10" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-opacity="0.5"/>
    <text x="720" y="70" font-weight="700" fill="currentColor">Embed CRS</text>
    <text x="720" y="87" font-weight="700" fill="currentColor">in metadata</text>
    <!-- quarantine -->
    <rect x="316" y="166" width="120" height="52" rx="10" fill="currentColor" fill-opacity="0.12" stroke="currentColor" stroke-opacity="0.65" stroke-width="1.5"/>
    <text x="376" y="196" font-weight="700" fill="currentColor">Quarantine</text>
  </g>
  <!-- edge labels -->
  <text x="450" y="62" font-size="11" text-anchor="middle" fill="currentColor" fill-opacity="0.8" font-weight="700">Yes</text>
  <text x="390" y="146" font-size="11" text-anchor="start" fill="currentColor" fill-opacity="0.8" font-weight="700">No</text>
  <!-- connectors -->
  <g stroke="currentColor" fill="none" stroke-width="2" stroke-opacity="0.5">
    <path d="M136 72 H156" marker-end="url(#crs-flow-arrow)"/>
    <path d="M292 72 H312" marker-end="url(#crs-flow-arrow)"/>
    <path d="M436 72 H464" marker-end="url(#crs-flow-arrow)"/>
    <path d="M624 72 H648" marker-end="url(#crs-flow-arrow)"/>
    <path d="M376 114 V162" marker-end="url(#crs-flow-arrow)"/>
  </g>
</svg>

## Concept & Design Decisions

The synchronisation layer is a single deterministic stage positioned immediately after raw ingestion and before partitioning. Four decisions define its behaviour.

**1. Choose one canonical target CRS per data domain.** Use `EPSG:4326` for global, multi-region archives where interoperability and tile alignment matter more than linear accuracy. Use a projected CRS (for example `EPSG:5070` CONUS Albers for US-wide analysis, or the relevant UTM zone for a single region) when downstream consumers compute areas, lengths, or buffers and need metric units. Mixing geographic and projected CRSs within one domain reintroduces the very drift you are trying to remove, so the target is a domain-level constant, not a per-file decision.

**2. Resolve the source CRS from authoritative metadata, never from filename or convention.** Extract it from the embedded source: the `.prj` WKT for shapefiles, the `crs` member for GeoJSON, GeoKeys for GeoTIFF, and the `geometry_columns` / `spatial_ref_sys` views for PostGIS. Validate the resolved authority code against the [EPSG registry](https://epsg.org/) and fail fast on anything you cannot resolve to a concrete authority:code pair.

**3. Make datum shifts explicit.** For any transformation that crosses datums, require the correct grid (for example the NADCON5 or the relevant NTv2 grid) and record the transformation pipeline string in the audit log. Set a maximum acceptable transformation accuracy threshold (for instance, reject any operation whose advertised accuracy exceeds 1 metre for survey-grade domains) rather than accepting whatever PROJ picks by default.

**4. Cap coordinate precision deliberately.** After reprojection, truncate to the precision the domain actually needs — 7 decimal places gives roughly 11 mm resolution at the equator for `EPSG:4326` and prevents storage inflation from meaningless trailing digits. Precision choices interact directly with downstream compression, which is why the codec settings in [ZSTD Level Configuration for Spatial Files](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/zstd-level-configuration-for-spatial-files/) should be tuned after, not before, the CRS stage is fixed.

The output of these decisions is a contract: every record leaving the stage carries an explicit, validated CRS, a recorded transformation lineage, and bounded precision. For the automated routing logic that selects grids and allocates compute per source, the dedicated [Automating CRS Transformations in ETL Pipelines](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/crs-synchronization-in-pipelines/automating-crs-transformations-in-etl-pipelines/) procedure builds on these design rules with error-handling thresholds and retry policy.

## Implementation

The implementations below cover the three engines you are most likely to run: GDAL/OGR for file-level conversion, PROJ-aware Python for in-pipeline transforms, and Spark/GeoParquet for distributed archival writes. Every path uses explicit `-s_srs`/`-t_srs` or an explicit `pyproj.CRS` — implicit engine defaults are the root cause of the failure mode and are never relied on.

**GDAL/OGR (CLI conversion with explicit source and target)**

```bash
# Reproject a UTM Zone 10N county parcel layer into WGS84 for the global archive.
# Source CRS is declared explicitly so a missing/garbled .prj cannot silently
# default the reader to EPSG:4326.
ogr2ogr -f "GeoJSON" \
  datasets/parcels/normalized/king_county_4326.geojson \
  datasets/parcels/raw/king_county.shp \
  -s_srs EPSG:26910 -t_srs EPSG:4326 \
  -lco COORDINATE_PRECISION=7 \
  -lco RFC7946=YES
```

Run conversions with `PROJ_NETWORK=ON` so PROJ can fetch transformation grids on demand, but mount a shared volume of pre-cached grids to keep ephemeral containers reproducible and avoid per-run egress:

```bash
# Pre-stage the grid cache once, then point every container at it read-only.
export PROJ_NETWORK=ON
export PROJ_DATA=/opt/proj/grids        # mounted volume of cached .tif grids
projsync --target-dir /opt/proj/grids --bbox -125,24,-66,50   # CONUS grids only
```

**PROJ-aware Python (in-pipeline transform with bounds validation)**

```python
import pyproj
from shapely.ops import transform
from shapely.geometry import box

SOURCE = pyproj.CRS.from_epsg(26910)      # UTM 10N, declared — never inferred
TARGET = pyproj.CRS.from_epsg(4326)

# always_xy keeps lon/lat axis order consistent with GeoJSON/GeoParquet writers
project = pyproj.Transformer.from_crs(SOURCE, TARGET, always_xy=True).transform

def normalize(geom):
    reprojected = transform(project, geom)
    # Fail fast if the result escapes the valid WGS84 envelope — the canonical
    # symptom of a wrong source CRS or swapped axis order.
    if not box(-180, -90, 180, 90).contains(reprojected.envelope):
        raise ValueError(f"Reprojected geometry out of WGS84 bounds: {reprojected.bounds}")
    return reprojected
```

**Apache Spark / GeoParquet (CRS as first-class schema metadata)**

In distributed writes, the CRS must travel with the data, not live in a side channel. Store it as explicit columns for filtering *and* attach it to the GeoParquet column metadata so the archive is self-describing:

```python
# Tag every row with its resolved CRS lineage, then write GeoParquet with the
# CRS embedded in the "geo" metadata block so readers reproject correctly.
df = (raw_df
      .withColumn("crs_authority", F.lit("EPSG"))
      .withColumn("crs_code",      F.lit(4326))
      .withColumn("datum_shift_applied", F.lit(True)))

(df.write
   .format("geoparquet")
   .option("geoparquet.crs", "EPSG:4326")     # written into the file's geo metadata
   .partitionBy("crs_code", "region")          # CRS is a partition key, not an assumption
   .mode("overwrite")
   .save("s3://geo-archive-cold/parcels/geoparquet/"))
```

Reprojection in Spark is CPU-bound; schedule large back-fills on spot instances with checkpointing enabled so a preemption resumes from the last committed partition rather than recomputing the whole job. Align the partition key with the normalised CRS so that the projection-consistent partitions described in [Spatial Partitioning Techniques](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/spatial-partitioning-techniques/) prune cleanly at query time.

## Validation Gate

Never promote a normalised dataset to the archive without an automated check that the written CRS matches the contract. The fastest gate is `gdalsrsinfo` / `ogrinfo` against the output:

```bash
# Confirm the written archive carries exactly EPSG:4326 and nothing else.
ogrinfo -so -json datasets/parcels/normalized/king_county_4326.geojson king_county_4326 \
  | jq -r '.layers[0].geometryFields[0].coordinateSystem.projjson.id | "\(.authority):\(.code)"'
```

Expected output:

```
EPSG:4326
```

For GeoParquet outputs, read the embedded `geo` metadata block directly and assert on the CRS:

```bash
python -c "import pyarrow.parquet as pq, json; \
md = pq.read_schema('s3://geo-archive-cold/parcels/geoparquet/region=king/part-0.parquet').metadata; \
print(json.loads(md[b'geo'])['columns']['geometry']['crs']['id'])"
# -> {'authority': 'EPSG', 'code': 4326}
```

**Root-cause analysis of the most common failure.** When the gate reports the *target* code but downstream joins still miss, the usual cause is **axis-order inversion**: the geometries are numerically in `EPSG:4326` but were written latitude-first while the consumer reads longitude-first. The fix is to enforce `always_xy=True` on every `pyproj.Transformer` and `RFC7946=YES` (which mandates lon/lat order) on GeoJSON writes, then re-run the bounds check in the Python `normalize()` function — out-of-envelope results expose swapped axes immediately. The second most common cause is a stale or missing datum-shift grid: `gdalsrsinfo` will report the correct CRS while coordinates are systematically offset, which only the audit-logged transformation-pipeline string and a known control point will reveal.

## Cost & Performance Trade-offs

Reprojection is compute-intensive and its costs compound across egress, runtime, and query latency. The table below quantifies the levers.

| Decision | Cheap default (often wrong) | Production setting | Impact |
| --- | --- | --- | --- |
| Grid resolution | Fetch grids per run over network | Pre-cached grids on mounted volume | Removes per-job egress; deterministic builds |
| Transform implementation | Row-level Python UDF | Vectorised `pyproj.Transformer` over arrays | 10–50x throughput on large batches |
| Partition alignment | Partition by ingest date only | Partition by normalised `crs_code` + region | Predicate pushdown skips non-matching tiles |
| Raw asset handling | Discard source after transform | Keep raw in a separate cold tier | Forensic re-projection without re-ingestion |
| Precision | Full float64 coordinates | Capped to domain need (e.g. 7 dp) | Smaller files, higher compression ratio |

Two architectural choices matter most. First, cache transformation grids in a regional bucket and mount them read-only into every worker; repeated network fetches of NTv2/GeoTIFF grids are a silent and recurring egress charge. Second, keep raw, untransformed assets in a separate cold tier so that a later discovery of a wrong source CRS can be corrected by re-projecting the original rather than re-acquiring it — a pattern that pairs directly with [Hot/Warm/Cold Tier Design for Geospatial Data](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/hotwarmcold-tier-design-for-geospatial-data/). In multi-source archives, moving CRS resolution to ingestion time and aligning partitions to the canonical CRS typically removes the majority of downstream reconciliation work that mismatched projections would otherwise generate.

## Failure Modes & Edge Cases

- **CRS metadata loss on format conversion.** Converting through an intermediate format that does not preserve CRS (an unprojected CSV of coordinates, or a shapefile written without its `.prj`) strips the authority code, and the next reader applies its default. Always assert the CRS on *both* sides of every conversion hop, not just at the pipeline boundary.
- **Axis-order swap between geographic CRSs.** `EPSG:4326` is formally latitude-first, but most file formats and writers expect longitude-first. A transform that respects the formal axis order writes geometries that look in-bounds but are mirrored across the diagonal. Standardise on `always_xy=True` everywhere and verify with a known control point.
- **Datum shift skipped under `PROJ_NETWORK=OFF`.** If grid download is disabled and the grid is not cached, PROJ silently falls back to a lower-accuracy ballpark transformation. Coordinates land tens of metres off, pass bounds checks, and corrupt survey-grade archives. Treat a missing grid as a hard failure, not a downgrade.
- **Mixed CRS across partitions of one dataset.** Appending a new region that was normalised to a different target CRS than earlier partitions breaks spatial joins across the dataset even though each partition is internally valid. Enforce the domain-level target CRS as a write-time constraint, and record it in the catalog alongside the lineage described in [Metadata Cataloging & Discovery](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/metadata-cataloging-discovery/).

## Operational Execution Checklist

- [ ] Canonical target CRS chosen and documented per data domain (geographic vs projected)
- [ ] Source CRS resolved from embedded metadata only, validated against the EPSG registry
- [ ] Fail-fast quarantine routing wired for absent, ambiguous, or unresolvable CRS
- [ ] Transformation grids pre-cached on a mounted read-only volume; missing grid is a hard error
- [ ] All transformers use `always_xy=True`; GeoJSON writes use `RFC7946=YES`
- [ ] Coordinate precision capped to the domain's accuracy requirement
- [ ] CRS written into output file metadata AND exposed as a partition key
- [ ] Post-write validation gate (`ogrinfo` / Parquet `geo` block) asserts the exact authority:code
- [ ] Transformation pipeline string and grid version recorded in the immutable audit log
- [ ] Raw untransformed source retained in a separate cold tier for forensic re-projection

## Related

- [Automating CRS Transformations in ETL Pipelines](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/crs-synchronization-in-pipelines/automating-crs-transformations-in-etl-pipelines/) — the step-by-step procedure for grid selection, compute allocation, and retry handling that operationalises this page.
- [GeoParquet Migration Workflows](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/geoparquet-migration-workflows/) — where the normalised CRS is embedded in the columnar geometry metadata during archival writes.
- [Schema Mapping & Attribute Validation](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/schema-mapping-attribute-validation/) — the attribute contract that runs alongside CRS normalisation so reprojection never breaks join keys.
- [ZSTD Level Configuration for Spatial Files](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/zstd-level-configuration-for-spatial-files/) — codec tuning that should follow, not precede, fixing coordinate precision at the CRS stage.
- [Hot/Warm/Cold Tier Design for Geospatial Data](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/hotwarmcold-tier-design-for-geospatial-data/) — the tiering pattern that keeps raw assets recoverable for re-projection.

**Up one level:** [Format Conversion & Pipeline Automation](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/)
