# Automating CRS Transformations in ETL Pipelines for Spatial Data Archival

Uncoordinated Coordinate Reference System (CRS) normalization during batch ingestion is a primary driver of spatial data corruption in cold storage tiers, and it almost never raises an exception — it writes plausible-looking wrong coordinates that only surface in a failed spatial join months later. This page is for the data engineers, GIS archivists, and cloud architects who own a high-throughput ingestion path and need a deterministic, idempotent reprojection stage that default GDAL/OGR configurations cannot give them: the standard fallbacks guess at missing datums, swap axis order, and silently drop vertical components. It operationalises the design decisions in [CRS Synchronization in Pipelines](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/crs-synchronization-in-pipelines/), sits inside the broader [Format Conversion & Pipeline Automation](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/) discipline, and produces archival outputs whose projection is auditable on both sides of every conversion hop.

## Transformation Pipeline

The ETL stage canonicalizes, transforms, validates, then commits — each step auditable:

<svg viewBox="0 0 960 180" role="img" aria-label="A four-stage CRS transformation pipeline running left to right, each stage gated. Stage one interrogates and canonicalizes the source CRS from embedded metadata into WKT2:2019. Stage two runs a single deterministic PROJ transform with ogr2ogr against pinned datum grids. Stage three validates that coordinate bounds and geometry topology survived. Stage four commits the checksummed artifact to cold storage and the audit manifest." xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;color:var(--primary);font-family:var(--font-sans)">
  <title>Deterministic CRS transformation pipeline, left to right</title>
  <desc>Four auditable stages: interrogate and canonicalize the source CRS (embedded metadata to WKT2:2019), apply one deterministic PROJ transform (ogr2ogr against pinned grids), validate bounds and topology (longitude/latitude envelope, multi-geometry), then commit the checksummed artifact to cold storage and the manifest. A failed gate routes the payload to quarantine rather than writing silently wrong coordinates.</desc>
  <defs>
    <marker id="crs-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <g text-anchor="middle" fill="currentColor">
    <g>
      <rect x="8" y="38" width="212" height="74" rx="10" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-opacity="0.4"/>
      <text x="114" y="62" font-size="12.5" font-weight="700">1 · Interrogate +</text>
      <text x="114" y="79" font-size="12.5" font-weight="700">canonicalize CRS</text>
      <text x="114" y="98" font-size="11" fill-opacity="0.75">embedded → WKT2:2019</text>
    </g>
    <g>
      <rect x="248" y="38" width="212" height="74" rx="10" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-opacity="0.4"/>
      <text x="354" y="62" font-size="12.5" font-weight="700">2 · Deterministic</text>
      <text x="354" y="79" font-size="12.5" font-weight="700">PROJ transform</text>
      <text x="354" y="98" font-size="11" fill-opacity="0.75">ogr2ogr · pinned grids</text>
    </g>
    <g>
      <rect x="488" y="38" width="212" height="74" rx="10" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-opacity="0.4"/>
      <text x="594" y="62" font-size="12.5" font-weight="700">3 · Validate bounds</text>
      <text x="594" y="79" font-size="12.5" font-weight="700">+ topology</text>
      <text x="594" y="98" font-size="11" fill-opacity="0.75">−180…180 · multi-geom</text>
    </g>
    <g>
      <rect x="728" y="38" width="212" height="74" rx="10" fill="currentColor" fill-opacity="0.14" stroke="currentColor" stroke-opacity="0.65" stroke-width="1.5"/>
      <text x="834" y="62" font-size="12.5" font-weight="700">4 · Commit to</text>
      <text x="834" y="79" font-size="12.5" font-weight="700">cold storage</text>
      <text x="834" y="98" font-size="11" fill-opacity="0.8">checksum → manifest</text>
    </g>
  </g>
  <g stroke="currentColor" stroke-width="2" stroke-opacity="0.6" fill="none">
    <path d="M222 75 H246" marker-end="url(#crs-arrow)"/>
    <path d="M462 75 H486" marker-end="url(#crs-arrow)"/>
    <path d="M702 75 H726" marker-end="url(#crs-arrow)"/>
  </g>
  <g text-anchor="middle" fill="currentColor">
    <text x="474" y="150" font-size="11.5" fill-opacity="0.7" font-style="italic">Any failed gate → quarantine (never a silent write)</text>
    <path d="M114 130 V112" stroke="currentColor" stroke-width="1.5" stroke-opacity="0.35" stroke-dasharray="3 3" fill="none"/>
    <path d="M354 130 V112" stroke="currentColor" stroke-width="1.5" stroke-opacity="0.35" stroke-dasharray="3 3" fill="none"/>
    <path d="M594 130 V112" stroke="currentColor" stroke-width="1.5" stroke-opacity="0.35" stroke-dasharray="3 3" fill="none"/>
    <line x1="40" y1="130" x2="908" y2="130" stroke="currentColor" stroke-width="1.5" stroke-opacity="0.3" stroke-dasharray="3 3"/>
  </g>
</svg>

## Step-by-Step Procedure

### Phase 0: Pipeline Configuration & Environment Hardening

The transformation stage must operate as a stateless, projection-aware middleware layer. Implicit GDAL/OGR fallbacks introduce non-reproducible datum shifts and silently drop vertical/horizontal components, so the first task is to pin PROJ data paths, disable on-the-fly CRS guessing, and force strict WKT2:2019 canonicalization before any payload is read.

```bash
# Pin PROJ/GDAL data dirs and disable every non-deterministic fallback.
export PROJ_DATA=/usr/share/proj          # PROJ 9.1+ name for the data dir
export PROJ_LIB=/usr/share/proj           # legacy pre-9.1 name, kept for older images
export GDAL_DATA=/usr/share/gdal
export GDAL_DISABLE_READDIR_ON_OPEN=EMPTY_DIR
export OGR_ENABLE_PARTIAL_REPROJECTION=NO  # never write a partially-reprojected layer
export PROJ_NETWORK=OFF                     # no runtime grid downloads in cold-storage workers
```

Route all spatial payloads through a dedicated CRS normalization container before partitioning. This isolates geometry transformation from attribute serialization, preventing cross-format metadata bleed, and lets the type-coercion contract in [Schema Mapping & Attribute Validation](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/schema-mapping-attribute-validation/) run alongside reprojection rather than fighting it. Mount the PROJ database read-only so no worker node can mutate `proj.db` mid-run.

### Phase 1: Input CRS Interrogation & Canonicalization

Resolve the source CRS from embedded metadata only — never from a connector default — and reject anything that cannot be mapped to a current authority code.

```python
import json, hashlib, sys
import pyproj
from osgeo import gdal

gdal.UseExceptions()
INPUT = "datasets/vector/raw/parcels_region_north.shp"

src = gdal.OpenEx(INPUT, gdal.OF_VECTOR)
src_srs = src.GetLayer().GetSpatialRef()
if src_srs is None:
    sys.exit(f"QUARANTINE: {INPUT} has no embedded CRS; refusing implicit EPSG:4326")

crs = pyproj.CRS.from_wkt(src_srs.ExportToWkt())
if crs.is_deprecated or not crs.to_epsg():
    sys.exit(f"QUARANTINE: {INPUT} declares a deprecated or non-authority CRS")

# Normalize to WKT2:2019 so downstream readers never re-guess axis order.
canonical_wkt = crs.to_wkt(version="WKT2_2019")
with open(INPUT, "rb") as fh:
    src_hash = hashlib.sha256(fh.read()).hexdigest()

with open("/var/log/crs_manifest.jsonl", "a") as log:
    log.write(json.dumps({
        "file": INPUT, "status": "CANONICALIZED",
        "source_epsg": crs.to_epsg(), "sha256": src_hash,
    }) + "\n")
```

Writing the canonical WKT and source hash to a manifest before transformation gives you an exactly-once reconciliation record that is independent of the storage write, and an absent-CRS payload halts the run instead of inheriting a silent geographic assumption that would violate archival compliance.

### Phase 2: Deterministic PROJ Transformation Execution

Apply a single, auditable reprojection targeting the archival standard CRS (`EPSG:4326` for global indexing, `EPSG:3857` for tiled web archives). Vector reprojection uses `ogr2ogr` — `gdalwarp` is a raster utility and cannot reproject vector layers. Skip the transform entirely when source already equals target so the stage stays idempotent.

```bash
# Idempotent vector reprojection to the archival target CRS.
ogr2ogr \
  -t_srs "EPSG:4326" \
  -nlt PROMOTE_TO_MULTI \
  --config OGR_NUM_THREADS ALL_CPUS \
  -lco GEOMETRY_NAME=geom \
  -overwrite \
  datasets/vector/normalized/parcels_region_north.gpkg \
  datasets/vector/raw/parcels_region_north.shp
```

For datum changes (for example NAD27 → NAD83) the correct `.gsb`/`.gtx` transformation grid must be present, because `PROJ_NETWORK=OFF` makes PROJ silently fall back to a lower-accuracy ballpark shift if the grid is missing. Pre-bundle every required grid into the container image and treat a missing grid as a hard failure:

```bash
# Fail the build if a required datum-shift grid was not baked into the image.
for grid in us_noaa_nadcon5_nad27_nad83.tif ca_nrc_ntv2_0.tif; do
  test -f "$PROJ_DATA/$grid" || { echo "FATAL: missing grid $grid"; exit 1; }
done
```

## Validation & Verification

Before committing to cold storage, assert coordinate bounds, geometry topology, and that the CRS authority code survived the write into the output file metadata.

```bash
# 1. Bounds must fall inside the EPSG:4326 envelope.
ogrinfo datasets/vector/normalized/parcels_region_north.gpkg -al -so | grep -i "Extent"

# 2. Serialize to the archival columnar format with topology promotion.
ogr2ogr -f Parquet \
  datasets/vector/archive/parcels_region_north.parquet \
  datasets/vector/normalized/parcels_region_north.gpkg \
  -nlt PROMOTE_TO_MULTI -lco COMPRESSION=ZSTD

# 3. Assert the embedded CRS on the FINAL artifact, not just the intermediate.
python -c "
import geopandas as gpd, pyproj
df = gpd.read_parquet('datasets/vector/archive/parcels_region_north.parquet')
assert pyproj.CRS(df.crs).equals(pyproj.CRS('EPSG:4326')), 'CRS mismatch in Parquet geo metadata'
print('Schema validation passed.')"

# 4. Checksum the immutable artifact into the audit manifest.
sha256sum datasets/vector/archive/parcels_region_north.parquet >> /var/log/crs_manifest.jsonl
```

Annotated expected output of step 1:

```
Extent: (-123.421000, 48.401000) - (-122.118000, 49.002000)
```

X stays within −180…180 and Y within −90…90, confirming the geometries are in longitude/latitude order rather than projected metres. If you see values in the hundreds of thousands (for example `Extent: (472000, 5360000) - …`), projected coordinates were written into a geographic column and the artifact must be rejected. The `-lco COMPRESSION=ZSTD` flag only sets a default level; tune it deliberately with [ZSTD Level Configuration for Spatial Files](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/zstd-level-configuration-for-spatial-files/) after — never before — coordinate precision is fixed at this CRS stage.

## Troubleshooting

| Symptom | Root cause | Diagnostic & fix |
|---------|------------|------------------|
| Coordinates shifted ~10–100 m, bounds still valid | Datum-shift grid missing under `PROJ_NETWORK=OFF`; PROJ used a ballpark transform | `ls "$PROJ_DATA"/*.tif` to confirm the grid is staged; bake the `.gsb`/`.gtx`/`.tif` into the image and treat a missing grid as a hard error, not a downgrade |
| X/Y axis swapped (features mirrored across the diagonal) | WKT1 vs WKT2:2019 axis-order ambiguity; writer assumed lon/lat | Export `WKT2_2019` and force `OAMS_TRADITIONAL_GIS_ORDER` / `always_xy=True` on every transformer; verify against a known control point |
| Geometry silently collapsed to `POINT` | Mixed single/multi geometry types serialized without promotion | Re-run with `-nlt PROMOTE_TO_MULTI`; inspect the `Geometry:` line from `ogrinfo -al -so` |
| `proj_create_from_database: Cannot find proj.db` | `PROJ_DATA`/`PROJ_LIB` path wrong or DB not mounted in the container | `echo $PROJ_DATA && ls $PROJ_DATA/proj.db`; mount the host PROJ DB read-only or bake it in, and align `GDAL_DATA` |
| Parquet `geo` metadata fails CRS assertion | Footer carries a legacy PROJ string instead of an authority code | Inspect the `geo` key in the Parquet footer; inject WKT2:2019 via a `pyarrow` schema update before the archival write |

**Operational note:** never rely on implicit OGR driver defaults for CRS normalization — they prioritise throughput over projection fidelity and can drop vertical datums or apply heuristic shifts without logging. Enforce an explicit `ogr2ogr -t_srs` / `pyproj.Transformer` pipeline for vector archival outputs, and reserve `gdalwarp` for raster reprojection.

## Operational Execution Checklist

- [ ] PROJ/GDAL data paths pinned and every non-deterministic fallback disabled before the first read
- [ ] Source CRS resolved from embedded metadata only; absent or deprecated CRS routed to quarantine
- [ ] Canonical WKT2:2019 and source SHA-256 written to the manifest ahead of the transform
- [ ] Idempotent guard skips reprojection when source CRS already equals the target
- [ ] Required datum-shift grids baked into the image; a missing grid fails the build
- [ ] Transformers forced to traditional GIS (lon/lat) axis order
- [ ] Post-write bounds, topology, and `geo`-metadata assertions gate the commit
- [ ] Final artifact checksummed into the immutable audit manifest
- [ ] Raw untransformed source retained in a separate cold tier for forensic re-projection

## Related

- **Up one level:** [CRS Synchronization in Pipelines](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/crs-synchronization-in-pipelines/) — the parent design page covering target-CRS selection, quarantine policy, and write-time partition constraints this procedure implements.
- [GeoParquet Migration Workflows](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/geoparquet-migration-workflows/) — the sibling conversion path where the normalised CRS is embedded into columnar geometry metadata during the archival write.
- [Schema Mapping & Attribute Validation](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/schema-mapping-attribute-validation/) — the attribute contract that runs alongside reprojection so a precision change never breaks a join key.
- [Metadata Cataloging & Discovery](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/metadata-cataloging-discovery/) — the catalog layer that records the transformation pipeline string and grid version as lineage for every committed artifact.
