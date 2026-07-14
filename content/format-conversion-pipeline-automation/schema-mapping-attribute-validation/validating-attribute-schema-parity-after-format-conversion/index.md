# Validating Attribute Schema Parity After Format Conversion

Attribute schema parity validation is the automated gate that proves a converted GeoParquet dataset carries the same field names, types, and column count as its source shapefile or GeoPackage — and fails the pipeline when it does not. Format conversion silently mutates schemas: DBF truncates field names to ten characters, coerces 64-bit integers to floats, and drops columns that exceed driver limits without raising an error. A pipeline that trusts an exit code of zero will publish an archive that looks complete but has lost a survey identifier or rounded a parcel area. This guide is for the data engineers and GIS archivists who need a deterministic parity diff — one that compares source and target schemas field by field, classifies every difference, and blocks promotion on mismatch — under the [Schema Mapping & Attribute Validation](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/schema-mapping-attribute-validation/) framework rather than trusting the converter's own warnings.

## Why Successful Conversion Still Loses Attributes

The failure mode is asymmetric: `ogr2ogr` reports success while quietly reshaping the attribute table. Three mechanisms account for nearly every silent loss. First, the DBF format underlying shapefiles caps field names at ten bytes, so `population_density` and `population_count` both collapse toward `populatio` and one overwrites the other. Second, DBF has no native 64-bit integer or boolean type, so wide identifiers become `float64` and lose their least-significant digits past 2^53. Third, drivers apply column limits and encoding substitutions per feature layer, dropping or renaming fields when a target format is stricter than the source. Parity validation exists precisely because none of these raise a non-zero exit. The companion procedure on [handling attribute loss during spatial format conversion](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/schema-mapping-attribute-validation/handling-attribute-loss-during-spatial-format-conversion/) covers preventing the loss; this page covers proving it did not happen.

## The Parity Diff Model

A parity check reduces both schemas to a canonical descriptor — an ordered set of `(name, logical_type, nullability)` tuples plus a field count — and diffs them. Every difference is classified so the gate can distinguish a benign, expected coercion from a data-destroying one:

<svg viewBox="0 0 900 300" role="img" aria-label="Attribute schema parity diff. A source schema column of four fields (parcel_id int64, area_ha float64, land_use string, is_zoned bool) and a converted GeoParquet schema column feed a comparator. Three verdict rows result: parcel_id matches with a pass, area_ha matches with a pass, and a highlighted fail row where source field population_density truncated to populatio in the target, flagged as a name-truncation mismatch that fails the gate." xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;color:var(--primary);font-family:var(--font-sans)">
  <title>Attribute schema parity diff and gate</title>
  <desc>Two schema descriptors — the source shapefile schema and the converted GeoParquet schema — are normalized to (name, type, count) tuples and compared field by field. Each field produces a verdict: match passes, a coerced type is reviewed, and a truncated or dropped name fails the gate before promotion.</desc>
  <defs>
    <marker id="par-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <!-- source schema -->
  <g text-anchor="middle">
    <rect x="14" y="40" width="200" height="220" rx="10" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-opacity="0.5"/>
    <text x="114" y="62" font-size="12.5" font-weight="700" fill="currentColor">Source schema</text>
    <text x="114" y="78" font-size="9.5" fill="currentColor" fill-opacity="0.7">shapefile / GPKG</text>
  </g>
  <g text-anchor="start">
    <text x="30" y="108" font-size="11" fill="currentColor">parcel_id &#183; int64</text>
    <text x="30" y="140" font-size="11" fill="currentColor">area_ha &#183; float64</text>
    <text x="30" y="172" font-size="11" fill="currentColor">land_use &#183; string</text>
    <text x="30" y="204" font-size="11" fill="currentColor">is_zoned &#183; bool</text>
    <text x="30" y="236" font-size="11" fill="currentColor">population_density</text>
  </g>
  <!-- comparator -->
  <g text-anchor="middle">
    <rect x="360" y="118" width="120" height="64" rx="10" fill="currentColor" fill-opacity="0.13" stroke="currentColor" stroke-opacity="0.7" stroke-width="1.5"/>
    <text x="420" y="146" font-size="12.5" font-weight="700" fill="currentColor">Parity</text>
    <text x="420" y="164" font-size="12.5" font-weight="700" fill="currentColor">comparator</text>
  </g>
  <!-- converted schema -->
  <g text-anchor="middle">
    <rect x="626" y="40" width="200" height="220" rx="10" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-opacity="0.5"/>
    <text x="726" y="62" font-size="12.5" font-weight="700" fill="currentColor">Converted schema</text>
    <text x="726" y="78" font-size="9.5" fill="currentColor" fill-opacity="0.7">GeoParquet</text>
  </g>
  <g text-anchor="start">
    <text x="642" y="108" font-size="11" fill="currentColor">parcel_id &#183; int64</text>
    <text x="642" y="140" font-size="11" fill="currentColor">area_ha &#183; double</text>
    <text x="642" y="172" font-size="11" fill="currentColor">land_use &#183; string</text>
    <text x="642" y="204" font-size="11" fill="currentColor">is_zoned &#183; bool</text>
    <text x="642" y="236" font-size="11" fill="currentColor" font-weight="700">populatio (!)</text>
  </g>
  <!-- arrows into comparator -->
  <g stroke="currentColor" stroke-width="1.8" fill="none" stroke-opacity="0.55">
    <path d="M216 150 H358" marker-end="url(#par-arrow)"/>
    <path d="M624 150 H482" marker-end="url(#par-arrow)"/>
  </g>
  <!-- verdicts -->
  <g text-anchor="middle">
    <rect x="320" y="220" width="240" height="30" rx="7" fill="currentColor" fill-opacity="0.04" stroke="currentColor" stroke-opacity="0.3"/>
    <text x="440" y="240" font-size="10.5" fill="currentColor" fill-opacity="0.85">3 fields &#8594; PASS (type coercion audited)</text>
    <rect x="320" y="256" width="240" height="32" rx="7" fill="currentColor" fill-opacity="0.14" stroke="currentColor" stroke-opacity="0.75" stroke-width="1.5"/>
    <text x="440" y="277" font-size="10.5" font-weight="700" fill="currentColor">population_density &#8594; FAIL (truncated)</text>
  </g>
</svg>

The classifier maps each field difference to one of four verdicts. An exact match on name and logical type passes. A tolerated coercion — `int64` widened to a Parquet `INT64`, DBF `Real` mapped to `double` — passes but is written to an audit record so the change is never invisible. A name change, including truncation and case folding, fails hard. A field present in the source but absent in the target fails hard and is the single most important case to catch, because it is the one no converter warns about.

## Building the Parity Gate

### 1. Extract the source descriptor deterministically

Read the source schema without loading geometry so the check is fast even on large layers. `ogrinfo` emits a stable JSON field list for shapefiles and GeoPackages alike:

```bash
ogrinfo -ro -json -so \
  s3://spatial-archive/parcels/2023/parcels_region_north.gpkg parcels \
  | jq '{count: (.layers[0].fields | length),
         fields: [.layers[0].fields[] | {name: .name, type: .type}]}' \
  > /tmp/source_schema.json
```

The `-so` (summary-only) flag skips per-feature reads, and `jq` reduces the output to the canonical `count` plus a `(name, type)` array. Capture this descriptor from the raw source before conversion so a corrupted intermediate cannot poison the baseline.

### 2. Extract the converted descriptor from Parquet metadata

The GeoParquet writer records the Arrow schema in the file footer; read it without scanning row groups:

```python
import pyarrow.parquet as pq

pf = pq.ParquetFile("s3://spatial-archive/parcels/2023/parcels_region_north.parquet")
schema = pf.schema_arrow

converted = {
    "count": sum(1 for f in schema if f.name != "geometry"),
    "fields": [
        {"name": f.name, "type": str(f.type)}
        for f in schema
        if f.name != "geometry"
    ],
}
```

Exclude the primary `geometry` column from the attribute count so the comparison is apples-to-apples with the DBF field list, which never includes geometry as an attribute.

### 3. Normalize and diff

Both descriptors pass through the same normalizer before comparison. Normalization lowercases names, maps driver-specific type spellings to a shared logical vocabulary, and sorts by name so field ordering never causes a false mismatch:

```python
import json

TYPE_ALIASES = {
    "Integer64": "int64", "int64": "int64",
    "Integer": "int32", "int32": "int32",
    "Real": "double", "double": "double", "float": "double",
    "String": "string", "large_string": "string",
    "Date": "date32", "DateTime": "timestamp[us]",
}

def normalize(desc):
    out = {}
    for f in desc["fields"]:
        key = f["name"].lower()
        out[key] = TYPE_ALIASES.get(f["type"], f["type"])
    return out, desc["count"]

src = json.load(open("/tmp/source_schema.json"))
src_fields, src_count = normalize(src)
dst_fields, dst_count = normalize(converted)

missing = sorted(set(src_fields) - set(dst_fields))   # dropped or renamed
extra   = sorted(set(dst_fields) - set(src_fields))    # unexpected additions
coerced = sorted(
    n for n in src_fields.keys() & dst_fields.keys()
    if src_fields[n] != dst_fields[n]
)

report = {
    "count_match": src_count == dst_count,
    "missing_fields": missing,
    "extra_fields": extra,
    "coerced_types": {n: [src_fields[n], dst_fields[n]] for n in coerced},
}
print(json.dumps(report, indent=2))

fatal = bool(missing) or bool(extra) or not report["count_match"]
raise SystemExit(1 if fatal else 0)
```

The exit code is the contract: any missing field, unexpected field, or count mismatch is fatal, while a coercion is reported and allowed. Truncation surfaces as a `missing_fields` entry (`population_density`) paired with an `extra_fields` entry (`populatio`), which is exactly the fingerprint of a DBF name collision. Preventing that truncation in the first place is covered under [preserving field names across shapefile to GeoPackage conversion](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/schema-mapping-attribute-validation/preserving-field-names-across-shapefile-to-geopackage-conversion/).

## Confirming the Gate Fires

Run the gate against a known-good pair and inspect the report. A clean parity check on a dataset whose only difference is the audited `Real` → `double` coercion should read:

```json
{
  "count_match": true,
  "missing_fields": [],
  "extra_fields": [],
  "coerced_types": {
    "area_ha": ["double", "double"]
  }
}
```

Then run a DuckDB cross-check that counts non-null values per column on both sides, catching the rarer case where a field survives structurally but its values were nulled during coercion:

```bash
duckdb -c "
  SELECT 'parcel_id' AS field, count(parcel_id) AS non_null
  FROM read_parquet('s3://spatial-archive/parcels/2023/parcels_region_north.parquet')"
```

Expected output — the non-null count must equal the source feature count when the field has no legitimate nulls:

```text
┌───────────┬──────────┐
│   field   │ non_null │
│  varchar  │  int64   │
├───────────┼──────────┤
│ parcel_id │  318204  │
└───────────┴──────────┘
```

A non-null count below the source feature count on an identifier column means values were dropped even though the column exists — a failure the structural diff alone cannot see.

## Troubleshooting Parity Failures

| Symptom | Cause | Fix |
|---------|-------|-----|
| `missing_fields` and `extra_fields` both list one entry with a shared prefix | DBF ten-character truncation renamed the field on write | Apply an explicit field-name mapping before conversion and re-run; never let the driver auto-truncate |
| `count_match` false, target has fewer fields | Driver silently dropped a column exceeding a format limit or with an unsupported type | Coerce the offending type ahead of conversion and add the field to an explicit `-select` list |
| `coerced_types` shows `int64 → double` on an ID column | DBF has no 64-bit integer; the ID was widened and may lose precision past 2^53 | Store the identifier as a string, or convert via GeoPackage/GeoParquet which preserve `int64` natively |
| Parity passes but non-null counts differ | Values coerced to null on type mismatch (dates, booleans) | Fix the source encoding, re-convert, and re-run the DuckDB non-null cross-check |

Wire the gate into the same job that promotes staging output to the canonical archive prefix, so a non-zero exit blocks promotion. Because CRS metadata is a schema invariant that travels alongside the attribute schema, run this parity gate immediately after the projection assertions in [CRS Synchronization in Pipelines](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/crs-synchronization-in-pipelines/) so a single validation stage certifies both attribute and reference-system fidelity. Low-cardinality categorical fields that survive parity are also the best candidates for [dictionary encoding for GIS attributes](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/dictionary-encoding-for-gis-attributes/), so record the parity report's field list where the compression stage can consume it.

## Operational Execution Checklist

- [ ] Capture the source `(name, type, count)` descriptor from the raw shapefile or GeoPackage before any conversion runs.
- [ ] Extract the converted descriptor from the Parquet footer without scanning row groups, excluding the `geometry` column.
- [ ] Normalize both sides — lowercase names, alias driver-specific type spellings, sort by name — before diffing.
- [ ] Treat any `missing_fields`, `extra_fields`, or count mismatch as fatal; allow type coercions only with an audit record.
- [ ] Run the DuckDB per-column non-null cross-check to catch values nulled during coercion.
- [ ] Fail the promotion job on a non-zero gate exit so torn schemas never reach the canonical archive prefix.
- [ ] Persist every parity report to the compliance ledger alongside the dataset's checksum.

## Related

- Up: [Schema Mapping & Attribute Validation](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/schema-mapping-attribute-validation/) — the parent reference for field-level mapping and validation across conversions.
- [Preserving Field Names Across Shapefile to GeoPackage Conversion](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/schema-mapping-attribute-validation/preserving-field-names-across-shapefile-to-geopackage-conversion/) — the sibling procedure that prevents the DBF truncation this gate detects.
- [Handling Attribute Loss During Spatial Format Conversion](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/schema-mapping-attribute-validation/handling-attribute-loss-during-spatial-format-conversion/) — companion mitigation for the dropped fields a parity diff surfaces.
- [When to Use Dictionary Encoding for Categorical GIS Fields](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/dictionary-encoding-for-gis-attributes/when-to-use-dictionary-encoding-for-categorical-gis-fields/) — compression guidance for the categorical fields that pass parity.
- [Spatial Archive Cost Modeling](https://www.spatialdataarchival.org/spatial-archive-cost-modeling/) — the cost reference for how re-conversion and validation compute factor into archive economics.

_Part of the [Spatial Data Archival](https://www.spatialdataarchival.org/) knowledge base._
