# Handling Attribute Loss During Spatial Format Conversion

Attribute loss during spatial format conversion is a silent failure mode: rows survive, geometries render, and the job exits `0`, yet columns are quietly truncated, retyped, or dropped before the data reaches cold storage. This guide is written for the data engineer, GIS archivist, or cloud architect migrating legacy shapefile, GeoJSON, or PostGIS exports into columnar GeoParquet or FlatGeobuf, and it explains why default converter settings fail here. A bare `ogr2ogr` call infers types from the first feature, truncates DBF field names to 10 characters, coerces `Float → Decimal` and `String → Integer` without warning, and strips coordinate reference system (CRS) and domain metadata that downstream analytics and regulators depend on. The fix is a deterministic profile-map-convert-validate procedure that runs as part of [Schema Mapping & Attribute Validation](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/schema-mapping-attribute-validation/) before any batch is promoted to an archive bucket.

## Attribute-Loss Failure Modes

Each common loss mode maps to a deterministic mitigation:

<svg viewBox="0 0 800 250" role="img" aria-label="Mapping of the three attribute-loss failure modes during spatial format conversion to their deterministic mitigations. A conversion job branches at a failure-mode decision into three paths: DBF 10-character name truncation is mitigated by deterministic aliasing; silent type coercion such as Float to Decimal is mitigated by explicit casts; and CRS and domain metadata stripping is mitigated by a sidecar manifest." xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;color:var(--primary);font-family:var(--font-sans)">
  <title>Each attribute-loss failure mode maps to one deterministic mitigation</title>
  <desc>A conversion job reaches a failure-mode decision that fans out into three rows. Name truncation maps to deterministic aliasing, type coercion maps to explicit casts, and metadata stripping maps to a sidecar manifest.</desc>
  <defs>
    <marker id="attr-loss-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <!-- conversion source -->
  <rect x="12" y="98" width="116" height="54" rx="10" fill="currentColor" fill-opacity="0.1" stroke="currentColor" stroke-opacity="0.6" stroke-width="1.5"/>
  <text x="70" y="130" text-anchor="middle" font-size="13.5" font-weight="700" fill="currentColor">Conversion</text>
  <!-- decision diamond -->
  <path d="M210 88 L268 125 L210 162 L152 125 Z" fill="currentColor" fill-opacity="0.1" stroke="currentColor" stroke-opacity="0.6" stroke-width="1.5"/>
  <text x="210" y="121" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">Failure</text>
  <text x="210" y="136" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">mode?</text>
  <!-- failure-mode boxes (middle column) -->
  <g>
    <rect x="312" y="18" width="196" height="54" rx="9" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-opacity="0.45" stroke-width="1.5"/>
    <text x="328" y="42" font-size="12.5" font-weight="700" fill="currentColor">Name truncation</text>
    <text x="328" y="60" font-size="10.5" fill="currentColor" fill-opacity="0.75">DBF 10-char names collide</text>
  </g>
  <g>
    <rect x="312" y="98" width="196" height="54" rx="9" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-opacity="0.45" stroke-width="1.5"/>
    <text x="328" y="122" font-size="12.5" font-weight="700" fill="currentColor">Type coercion</text>
    <text x="328" y="140" font-size="10.5" fill="currentColor" fill-opacity="0.75">Float&#8594;Decimal inferred</text>
  </g>
  <g>
    <rect x="312" y="178" width="196" height="54" rx="9" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-opacity="0.45" stroke-width="1.5"/>
    <text x="328" y="202" font-size="12.5" font-weight="700" fill="currentColor">Metadata stripping</text>
    <text x="328" y="220" font-size="10.5" fill="currentColor" fill-opacity="0.75">CRS &amp; domains dropped</text>
  </g>
  <!-- mitigation boxes (right column) -->
  <g>
    <rect x="572" y="18" width="216" height="54" rx="9" fill="currentColor" fill-opacity="0.12" stroke="currentColor" stroke-opacity="0.6" stroke-width="1.5"/>
    <text x="588" y="42" font-size="12.5" font-weight="700" fill="currentColor">Deterministic aliasing</text>
    <text x="588" y="60" font-size="10.5" fill="currentColor" fill-opacity="0.75">stable long&#8594;short field map</text>
  </g>
  <g>
    <rect x="572" y="98" width="216" height="54" rx="9" fill="currentColor" fill-opacity="0.12" stroke="currentColor" stroke-opacity="0.6" stroke-width="1.5"/>
    <text x="588" y="122" font-size="12.5" font-weight="700" fill="currentColor">Explicit casts</text>
    <text x="588" y="140" font-size="10.5" fill="currentColor" fill-opacity="0.75">pin every column type</text>
  </g>
  <g>
    <rect x="572" y="178" width="216" height="54" rx="9" fill="currentColor" fill-opacity="0.12" stroke="currentColor" stroke-opacity="0.6" stroke-width="1.5"/>
    <text x="588" y="202" font-size="12.5" font-weight="700" fill="currentColor">Sidecar manifest</text>
    <text x="588" y="220" font-size="10.5" fill="currentColor" fill-opacity="0.75">JSON schema + CRS kept</text>
  </g>
  <!-- connectors -->
  <g stroke="currentColor" fill="none" stroke-width="2">
    <path d="M128 125 H148" stroke-opacity="0.55" marker-end="url(#attr-loss-arrow)"/>
    <path d="M268 125 H290 V45 H310" stroke-opacity="0.45" marker-end="url(#attr-loss-arrow)"/>
    <path d="M268 125 H310" stroke-opacity="0.45" marker-end="url(#attr-loss-arrow)"/>
    <path d="M268 125 H290 V205 H310" stroke-opacity="0.45" marker-end="url(#attr-loss-arrow)"/>
    <path d="M508 45 H570" stroke-opacity="0.5" marker-end="url(#attr-loss-arrow)"/>
    <path d="M508 125 H570" stroke-opacity="0.5" marker-end="url(#attr-loss-arrow)"/>
    <path d="M508 205 H570" stroke-opacity="0.5" marker-end="url(#attr-loss-arrow)"/>
  </g>
</svg>

Attribute loss originates at three deterministic points. Shapefile DBF restricts field names to 10 ASCII characters and caps numeric precision at 18 digits, so long names collide and silently merge. GeoJSON carries no strict typing, forcing converters to infer each column's type from the first row. When the target is GeoParquet or FlatGeobuf, unhandled null semantics, mixed-type arrays, and an unregistered CRS trigger silent column drops during serialization. The procedure below closes all three gaps in order.

## Step-by-Step Procedure

### Phase 1 — Profile the source schema

Dump the exact source schema first so every later step has a baseline for parity. Use GDAL/OGR for shapefiles and DuckDB's spatial extension for GeoJSON or PostGIS exports.

```bash
# Shapefile: field names, types, widths, and CRS in one pass
ogrinfo -al -so archives/parcels/2021/county_travis.shp

# GeoJSON / PostGIS dump: ST_Read exposes the inferred column types
duckdb -c "INSTALL spatial; LOAD spatial; \
  DESCRIBE SELECT * FROM ST_Read('archives/zoning/2021/austin_zoning.geojson');"
```

### Phase 2 — Build an explicit cast and alias map

Reject implicit promotions and pin every column to a target type in a YAML manifest. Where the target (or any round-trip through DBF) imposes a name-length limit, derive a deterministic alias so the same long name always maps to the same short column. Cross-reference target types against the [Apache Parquet type system](https://parquet.apache.org/docs/file-format/types/).

```python
# scripts/build_schema_map.py
import hashlib

def alias_field(name: str, max_len: int = 64) -> str:
    """Stable, collision-resistant alias for over-length field names."""
    if len(name) <= max_len:
        return name
    digest = hashlib.md5(name.encode()).hexdigest()[:8]
    return f"{name[:max_len - 12]}_{digest}"

# Explicit cast rules — no String->Integer or Float->Decimal inference
CAST_MAP = {
    "parcel_id":           "BIGINT",
    "assessed_valuation":  "DOUBLE",   # never coerce to DECIMAL silently
    "zoning_designation":  "VARCHAR",
    "last_inspection_date": "DATE",
}
```

### Phase 3 — Set null-tolerance and CRS gates

Apply two pre-conversion thresholds. A column above 15% nulls in the source must be declared `NULLABLE` in the target schema; a column above 85% nulls is dropped before conversion to keep the cold-storage footprint small. Missing `EPSG` codes or WKT strings cause geometry columns to be dropped on write, so confirm CRS presence before continuing — the standardized projection handling lives in [Automating CRS Transformations in ETL Pipelines](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/crs-synchronization-in-pipelines/automating-crs-transformations-in-etl-pipelines/).

```bash
# Fail fast if the source has no spatial reference attached
ogrinfo -so archives/parcels/2021/county_travis.shp | grep -i "srs\|epsg" \
  || { echo "FATAL: no CRS on source — aborting conversion"; exit 1; }
```

### Phase 4 — Convert with explicit casts (GDAL/OGR)

Disable automatic type promotion and force UTF-8 across all vector drivers. Carry every column through an explicit `CAST` so nothing is inferred at write time.

```bash
ogr2ogr -f "Parquet" \
  archives/parcels/2021/county_travis.parquet \
  archives/parcels/2021/county_travis.shp \
  --config SHAPE_ENCODING UTF-8 \
  -dialect SQLITE \
  -lco GEOMETRY_NAME=geometry \
  -lco COMPRESSION=ZSTD \
  -nln parcels_2021 \
  -sql "SELECT CAST(parcel_id AS INTEGER)         AS parcel_id,
               CAST(assessed_valuation AS REAL)   AS assessed_valuation,
               CAST(zoning_designation AS TEXT)   AS zoning_designation,
               geometry
        FROM county_travis"
```

### Phase 5 — Convert with strict schema (DuckDB / PyArrow)

For cloud-native batches, register column types before the write so the inference engine is never consulted. This path also lets you emit the partition tree directly to an archive prefix.

```python
import duckdb

con = duckdb.connect()
con.execute("INSTALL spatial; LOAD spatial;")

query = """
    SELECT
        CAST(parcel_id AS BIGINT)            AS parcel_id,
        CAST(assessed_valuation AS DOUBLE)   AS assessed_valuation,
        CAST(zoning_designation AS VARCHAR)  AS zoning_designation,
        geom
    FROM ST_Read('archives/parcels/2021/county_travis.shp')
"""

# Strict schema + GeoParquet-compliant ZSTD write
con.execute(f"""
    COPY ({query})
    TO 'archives/parcels/2021/county_travis.parquet'
    (FORMAT PARQUET, COMPRESSION ZSTD)
""")
```

The orchestration that makes these jobs idempotent and rolls them back on a schema mismatch is covered under [Format Conversion & Pipeline Automation](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/). Picking the ZSTD level that balances archive footprint against cold-retrieval CPU is covered in [Tuning ZSTD Compression for GeoParquet Archives](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/zstd-level-configuration-for-spatial-files/tuning-zstd-compression-for-geoparquet-archives/).

### Phase 6 — Write a sidecar manifest

Persist the resolved schema, row statistics, and CRS as a JSON sidecar next to the object so any deprecated attribute can be reconstructed during retrieval, and map regulator-required fields that fail target validation into a `legacy_metadata` JSON column rather than discarding them.

```bash
duckdb -json -c "DESCRIBE SELECT * FROM \
  read_parquet('archives/parcels/2021/county_travis.parquet');" \
  > archives/parcels/2021/county_travis.schema.json
```

## Validation & Verification

Validate immediately after the write, before the object is promoted to a colder tier. Run a four-check sequence and treat any mismatch as a hard failure.

**1. Row parity** — source feature count must equal target row count exactly:

```bash
src_rows=$(ogrinfo -ro -al -so archives/parcels/2021/county_travis.shp \
  | grep "Feature Count:" | awk '{print $NF}')
tgt_rows=$(duckdb -noheader -list -c \
  "SELECT count(*) FROM read_parquet('archives/parcels/2021/county_travis.parquet');")
[ "$src_rows" -eq "$tgt_rows" ] \
  && echo "OK parity: $tgt_rows rows" \
  || echo "ROW COUNT MISMATCH: $src_rows vs $tgt_rows"
```

Expected output — the counts match and parity is confirmed:

```text
OK parity: 412877 rows
```

**2. Schema delta and null drift** — `SUMMARIZE` reports per-column type and null percentage in one pass, surfacing any unexpected promotion or injected null:

```sql
SUMMARIZE SELECT * FROM read_parquet('archives/parcels/2021/county_travis.parquet');
```

Confirm `parcel_id` is `BIGINT` (not the `DECIMAL` an inference engine would have chosen) and that `null_percentage` matches the source profile from Phase 1.

**3. Geometry integrity** — the geometry column is stored as WKB, so decode it before validating:

```bash
duckdb -c "INSTALL spatial; LOAD spatial; \
  SELECT count(*) AS invalid FROM read_parquet('archives/parcels/2021/county_travis.parquet') \
  WHERE NOT ST_IsValid(ST_GeomFromWKB(geom));"
```

Expected output — zero invalid geometries survived serialization:

```text
┌─────────┐
│ invalid │
│  int64  │
├─────────┤
│    0    │
└─────────┘
```

**4. Checksum ledger** — generate SHA-256 hashes for the source and target and append them to an immutable ledger governed by your [Retention Policy Frameworks](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/retention-policy-frameworks/), so any later schema drift detected on retrieval can trigger a rollback to the last verified manifest.

## Troubleshooting

| Symptom | Root cause | Fix |
|---------|------------|-----|
| Two source columns collapse into one in the target | DBF 10-char name truncation merged `land_use_code` and `land_use_class` to `land_use_c` | Apply `alias_field()` from Phase 2 and write the long→short map into the sidecar manifest before converting |
| `assessed_valuation` arrives as `DECIMAL`, breaking downstream joins | Implicit `Float → Decimal` promotion during type inference | Pin the column with an explicit `CAST(... AS DOUBLE)` and reject any job whose `SUMMARIZE` type differs from the cast map |
| Geometry column missing from the output entirely | Source had no `.prj` / EPSG, so the writer dropped the geometry on serialization | Enforce the Phase 3 CRS gate; inject an explicit `EPSG` before write and re-run |
| Row count matches but a text column is all nulls | Mixed-type GeoJSON column inferred from a numeric first row, nulling later string values | Force `CAST(col AS VARCHAR)` at read time instead of trusting first-row inference |

## Operational Execution Checklist

- [ ] Dump and archive the source schema (`ogrinfo -so` or DuckDB `DESCRIBE`) as the parity baseline.
- [ ] Build an explicit cast map and deterministic alias table; reject all implicit type promotions.
- [ ] Apply the 15% `NULLABLE` and 85% drop thresholds, and fail fast when the source carries no CRS.
- [ ] Convert with explicit `CAST` statements via GDAL/OGR or DuckDB — never first-row inference.
- [ ] Reconcile source-to-target row parity and confirm types with `SUMMARIZE`.
- [ ] Decode WKB and confirm zero invalid geometries post-conversion.
- [ ] Write the JSON sidecar manifest and record source/target SHA-256 hashes in the compliance ledger.

## Related

- Up: [Schema Mapping & Attribute Validation](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/schema-mapping-attribute-validation/) — the parent reference for field-level parity rules this procedure enforces.
- [Converting Legacy Shapefiles to GeoParquet at Scale](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/geoparquet-migration-workflows/converting-legacy-shapefiles-to-geoparquet-at-scale/) — companion workflow that applies these cast and alias maps across terabyte-scale batches.
- [Automating CRS Transformations in ETL Pipelines](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/crs-synchronization-in-pipelines/automating-crs-transformations-in-etl-pipelines/) — deterministic projection handling for the CRS gate in Phase 3.
- [Tuning ZSTD Compression for GeoParquet Archives](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/zstd-level-configuration-for-spatial-files/tuning-zstd-compression-for-geoparquet-archives/) — companion guidance on the compression level applied during the Phase 4 and 5 writes.
