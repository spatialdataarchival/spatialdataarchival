# Preserving Field Names Across Shapefile to GeoPackage Conversion

Preserving field names across a shapefile-to-GeoPackage conversion means defeating the DBF ten-character column-name limit that silently truncates and collides descriptive attribute names before they ever reach the long-name-capable GeoPackage schema. A shapefile's DBF header stores every field name in ten bytes; `population_density` and `population_total` both arrive as `populatio`, and the second write clobbers the first. GeoPackage and GeoParquet impose no such ceiling, so the conversion is an opportunity to restore intent — but only if you carry an explicit field-name mapping instead of trusting the driver to reverse a lossy truncation it cannot undo. This guide is for the data engineers and GIS archivists who need round-trip-safe attribute names when lifting legacy shapefile archives into GeoPackage under the [Schema Mapping & Attribute Validation](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/schema-mapping-attribute-validation/) framework.

## Where the Ten-Character Ceiling Bites

The dBASE III format that backs the shapefile `.dbf` reserves exactly eleven bytes for a field name, one of which is a null terminator, leaving ten usable characters. GDAL enforces this on write by truncating, and — critically — by resolving collisions with numeric suffixes only within a single write session. Convert `parcel_owner_name` and `parcel_owner_id` into a shapefile and you get `parcel_own` and `parcel_o_1`; the suffix is positional, not semantic, so a second export in a different field order produces `parcel_o_1` for a different column. Once names have degraded this way, no downstream tool can recover the originals, because the mapping from long name to truncated stub is many-to-one and unlabeled. GeoPackage stores column names as SQLite identifiers with no practical length limit, which is why it is the right target — but the truncation happens on the shapefile side, so the fix must live in the conversion step, not after it. This is the specific mechanism behind much of the loss catalogued in [handling attribute loss during spatial format conversion](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/schema-mapping-attribute-validation/handling-attribute-loss-during-spatial-format-conversion/).

## The Alias Table Model

The durable fix is a field-name mapping table — an explicit, version-controlled record of `truncated_stub → canonical_name` — captured either from the original data dictionary or from a metadata sidecar carried alongside the shapefile. The conversion applies the table to rename columns to their full form as it writes GeoPackage, and the same table drives round-trip verification:

<svg viewBox="0 0 860 200" role="img" aria-label="Field-name preservation matrix. Three source field names — population_density, population_total, and land_use_code — are shown with their ten-character DBF truncations. population_density and population_total both truncate to populatio and collide, while land_use_code truncates to land_use_c without collision. An alias table maps each truncated stub back to its canonical GeoPackage name, resolving the collision so all three long names are preserved." xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;color:var(--primary);font-family:var(--font-sans)">
  <title>Field-name truncation, collision, and alias restoration</title>
  <desc>A four-column matrix: the canonical source field name, its ten-character DBF truncation, whether that truncation collides with another field, and the GeoPackage name restored from the alias table. Two fields collide on the stub populatio and are separated again by the alias mapping.</desc>
  <rect x="10" y="10" width="840" height="36" fill="currentColor" fill-opacity="0.07"/>
  <rect x="10" y="10" width="840" height="168" fill="none" stroke="currentColor" stroke-width="1.2" stroke-opacity="0.5"/>
  <line x1="260" y1="10" x2="260" y2="178" stroke="currentColor" stroke-width="1" stroke-opacity="0.3"/>
  <line x1="470" y1="10" x2="470" y2="178" stroke="currentColor" stroke-width="1" stroke-opacity="0.3"/>
  <line x1="600" y1="10" x2="600" y2="178" stroke="currentColor" stroke-width="1" stroke-opacity="0.3"/>
  <line x1="10" y1="46" x2="850" y2="46" stroke="currentColor" stroke-width="1" stroke-opacity="0.3"/>
  <line x1="10" y1="90" x2="850" y2="90" stroke="currentColor" stroke-width="1" stroke-opacity="0.3"/>
  <line x1="10" y1="134" x2="850" y2="134" stroke="currentColor" stroke-width="1" stroke-opacity="0.3"/>
  <g text-anchor="start">
    <text x="20" y="32" font-size="11" font-weight="700" fill="currentColor">Source field</text>
    <text x="270" y="32" font-size="11" font-weight="700" fill="currentColor">DBF stub (10 char)</text>
    <text x="480" y="32" font-size="11" font-weight="700" fill="currentColor">Collision</text>
    <text x="610" y="32" font-size="11" font-weight="700" fill="currentColor">Restored (GeoPackage)</text>
    <!-- row 1 -->
    <text x="20" y="73" font-size="10.5" fill="currentColor">population_density</text>
    <text x="270" y="73" font-size="10.5" fill="currentColor">populatio</text>
    <text x="480" y="73" font-size="10.5" font-weight="700" fill="currentColor">yes (!)</text>
    <text x="610" y="73" font-size="10.5" fill="currentColor">population_density</text>
    <!-- row 2 -->
    <text x="20" y="117" font-size="10.5" fill="currentColor">population_total</text>
    <text x="270" y="117" font-size="10.5" fill="currentColor">populatio</text>
    <text x="480" y="117" font-size="10.5" font-weight="700" fill="currentColor">yes (!)</text>
    <text x="610" y="117" font-size="10.5" fill="currentColor">population_total</text>
    <!-- row 3 -->
    <text x="20" y="161" font-size="10.5" fill="currentColor">land_use_code</text>
    <text x="270" y="161" font-size="10.5" fill="currentColor">land_use_c</text>
    <text x="480" y="161" font-size="10.5" fill="currentColor" fill-opacity="0.7">no</text>
    <text x="610" y="161" font-size="10.5" fill="currentColor">land_use_code</text>
  </g>
  <rect x="10" y="46" width="840" height="88" fill="currentColor" fill-opacity="0.09"/>
</svg>

The highlighted band marks the collision: both population fields share the `populatio` stub, so a naive shapefile-to-GeoPackage copy cannot know which restored name belongs to which column. The alias table breaks the ambiguity by keying restoration on something other than the truncated name — position, or better, a stable sidecar written when the shapefile was first created.

## Building and Applying the Mapping

### 1. Capture the canonical names before truncation happens

The only reliable source of full names is upstream of the shapefile. If the archive still holds the originating GeoPackage, PostGIS table, or a documented data dictionary, extract the canonical list there. When only the shapefile survives, write a mapping sidecar the first time a human confirms the intended names, and version it with the data:

```json
{
  "layer": "parcels_region_north",
  "field_map": {
    "populatio":  "population_density",
    "populat_1":  "population_total",
    "land_use_c": "land_use_code",
    "parcel_own": "parcel_owner_name",
    "parcel_o_1": "parcel_owner_id"
  }
}
```

The keys are the exact truncated stubs GDAL produced, including its `_1` collision suffixes; the values are the canonical names. This file is the contract, checked into the pipeline repository next to the dataset manifest.

### 2. Apply the map during conversion

Rename as you write GeoPackage so the long names land in the SQLite schema directly. `ogr2ogr` with an SQL `SELECT ... AS` clause renames per column without a second pass:

```bash
ogr2ogr -f GPKG \
  s3://spatial-archive/parcels/2023/parcels_region_north.gpkg \
  /vsis3/spatial-archive/parcels/2023/parcels_region_north.shp \
  -sql "SELECT populatio AS population_density,
               populat_1 AS population_total,
               land_use_c AS land_use_code,
               parcel_own AS parcel_owner_name,
               parcel_o_1 AS parcel_owner_id,
               GEOMETRY
        FROM parcels_region_north" \
  -nln parcels_region_north
```

For programmatic pipelines that already hold the sidecar, drive the rename from the JSON so the mapping stays single-sourced:

```python
import json
import geopandas as gpd

field_map = json.load(open("parcels_region_north.field_map.json"))["field_map"]

gdf = gpd.read_file("/vsis3/spatial-archive/parcels/2023/parcels_region_north.shp")
gdf = gdf.rename(columns=field_map)

gdf.to_file(
    "/vsis3/spatial-archive/parcels/2023/parcels_region_north.gpkg",
    layer="parcels_region_north",
    driver="GPKG",
)
```

Because GeoPackage preserves these long names cleanly, the same renamed frame flows on into columnar storage without further mapping — the naming discipline established here is what makes a later [GeoParquet migration workflow](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/geoparquet-migration-workflows/) round-trip-safe.

## Verifying the Round Trip

Confirm every canonical name is present and no stub leaked through. List the GeoPackage schema straight from SQLite and check it against the mapping's values:

```bash
ogrinfo -so \
  s3://spatial-archive/parcels/2023/parcels_region_north.gpkg \
  parcels_region_north | grep -E ':' | grep -iv geometry
```

Expected output — full names, no ten-character stubs, no `_1` collision suffixes:

```text
population_density: Real (0.0)
population_total: Real (0.0)
land_use_code: String (0.0)
parcel_owner_name: String (0.0)
parcel_owner_id: Integer64 (0.0)
```

Then run a strict assertion in code that fails if any restored name is missing or any truncated stub survived, which is the round-trip guarantee the pipeline gate depends on:

```python
import json
import fiona

expected = set(json.load(open("parcels_region_north.field_map.json"))["field_map"].values())
with fiona.open("/vsis3/spatial-archive/parcels/2023/parcels_region_north.gpkg") as src:
    actual = set(src.schema["properties"].keys())

missing = expected - actual
leaked = {n for n in actual if len(n) == 10 or n[-2:] in ("_1", "_2")}
assert not missing, f"canonical names missing: {missing}"
assert not leaked, f"truncated stubs leaked into GeoPackage: {leaked}"
```

This paired schema-and-assertion check is the natural sibling of the field-count-and-type diff in [validating attribute schema parity after format conversion](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/schema-mapping-attribute-validation/validating-attribute-schema-parity-after-format-conversion/); run both so name preservation and type parity are certified in one gate.

## Troubleshooting Truncation and Collisions

| Symptom | Cause | Fix |
|---------|-------|-----|
| Two columns map to one `populatio` stub, one is missing | DBF truncation collided the names and the last write won | Recover canonical names from the sidecar or data dictionary and rename with an explicit `SELECT ... AS`, keyed on the `_1`-suffixed stubs |
| Restored name still ten characters long | Rename step skipped or the sidecar key did not match GDAL's actual stub | Print the shapefile's real field list with `ogrinfo -so` and align sidecar keys to the exact stubs, suffixes included |
| `Integer64` field arrives as `Real` after rename | The rename preserved the name but not the type; DBF lacks 64-bit integers | Coerce the type during the GeoPackage write, which supports `Integer64` natively |
| Non-ASCII field name mangled | Shapefile field names outside ASCII depend on `LDID`/encoding | Set `SHAPE_ENCODING=UTF-8` before reading and confirm the sidecar stores the intended Unicode name |

Keep the sidecar and the CRS definition together as the two things that must survive every hop; the projection half of that pairing is enforced by [CRS Synchronization in Pipelines](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/crs-synchronization-in-pipelines/). Descriptive, un-truncated names also make categorical columns self-documenting for the compression stage, where [dictionary encoding for GIS attributes](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/dictionary-encoding-for-gis-attributes/) keys on stable field identities. For the field name rules themselves, the authoritative reference is the [OGC GeoPackage Encoding Standard](https://www.ogc.org/standard/geopackage/).

## Operational Execution Checklist

- [ ] Recover canonical field names from the originating GeoPackage, PostGIS table, or data dictionary before touching the shapefile.
- [ ] Write a version-controlled `field_map` sidecar keyed on GDAL's exact truncated stubs, including `_1` collision suffixes.
- [ ] Apply the rename during the GeoPackage write with `ogr2ogr -sql ... AS` or a `rename(columns=...)` call driven by the sidecar.
- [ ] List the GeoPackage schema with `ogrinfo -so` and confirm no ten-character stub or `_1` suffix survived.
- [ ] Assert every canonical name is present and no truncated stub leaked, failing the pipeline on either.
- [ ] Preserve `Integer64` and other long types explicitly during the write, since renaming does not restore type.
- [ ] Set `SHAPE_ENCODING=UTF-8` so non-ASCII field names round-trip intact.

## Related

- Up: [Schema Mapping & Attribute Validation](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/schema-mapping-attribute-validation/) — the parent reference for field-level mapping across conversions.
- [Validating Attribute Schema Parity After Format Conversion](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/schema-mapping-attribute-validation/validating-attribute-schema-parity-after-format-conversion/) — the sibling gate that detects the truncation and collisions this procedure prevents.
- [Handling Attribute Loss During Spatial Format Conversion](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/schema-mapping-attribute-validation/handling-attribute-loss-during-spatial-format-conversion/) — companion coverage of the broader attribute-loss modes beyond names.
- [When to Use Dictionary Encoding for Categorical GIS Fields](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/dictionary-encoding-for-gis-attributes/when-to-use-dictionary-encoding-for-categorical-gis-fields/) — compression guidance for the well-named categorical fields you preserve.
- [Spatial Archive Cost Modeling](https://www.spatialdataarchival.org/spatial-archive-cost-modeling/) — the cost reference for weighing re-conversion effort against long-term archive maintainability.

_Part of the [Spatial Data Archival](https://www.spatialdataarchival.org/) knowledge base._
