# Schema Mapping & Attribute Validation in Geospatial Pipelines

In spatial data archival and cold-storage optimization, geometric fidelity is worthless if the attribute table degrades during ingestion. The most expensive failure mode in a conversion pipeline is not a corrupt geometry — those usually throw — but silent attribute drift: a `PROP_ID` widened from `INT32` to a float, an ISO date coerced to an opaque string, or a domain-coded land-use field flattened into free text. None of these raise an error at write time, yet every one of them breaks downstream query reproducibility, inflates cold-storage bills with un-encodable columns, and guarantees an audit failure months later when nobody can reconstruct the transformation. Schema mapping and attribute validation are the control plane that makes attribute translation deterministic, and this guide shows data engineers, GIS archivists, and compliance teams how to build that control plane so legacy shapefiles, GeoJSON, and proprietary geodatabases land in columnar archives without losing a single field's meaning.

## Prerequisite Context

This page assumes you already run an orchestrated [Format Conversion & Pipeline Automation](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/) workflow — event-driven workers that pick up source objects, validate them, convert, and write to immutable storage. Schema mapping sits between the validate and convert stages of that pipeline; it is not a standalone job. Before applying anything here you should have: a target format chosen (this guide assumes [GeoParquet migration](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/geoparquet-migration-workflows/) for columnar archives, with [FlatGeobuf optimization](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/flatgeobuf-optimization-techniques/) as the streaming alternative); a working dead-letter path for rejected records; and a destination bucket with a lifecycle policy that will eventually tier these objects down. Coordinate-system handling is treated as a sibling concern — datum and projection integrity belong to [CRS synchronization in pipelines](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/crs-synchronization-in-pipelines/) — but the two stages share the same validation gate, so this page references CRS checks where they intersect attribute logic.

## Validation Gate

Records pass type, null, geometry, and CRS checks before reaching the target schema:

<svg viewBox="0 0 800 250" role="img" aria-label="Ordered validation gate: a source record is checked cheapest-first. It must pass a type and null check, then a geometry and CRS check, before it is written to the target schema. Failing either check routes the record to the dead-letter queue rather than dropping it." xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;color:var(--primary);font-family:var(--font-sans)">
  <title>Two-stage validation gate, ordered cheapest check first, with a shared dead-letter route</title>
  <desc>A source record passes a type-and-null check, then a geometry-and-CRS check, then is written to the target schema. A No from either decision routes the record down to a shared dead-letter queue.</desc>
  <defs>
    <marker id="smv-gate-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <g font-size="12.5" text-anchor="middle">
    <!-- source -->
    <rect x="12" y="44" width="120" height="56" rx="10" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-opacity="0.5" stroke-width="1.5"/>
    <text x="72" y="77" font-weight="700" fill="currentColor">Source record</text>
    <!-- diamond 1 -->
    <path d="M230 36 L298 72 L230 108 L162 72 Z" fill="currentColor" fill-opacity="0.1" stroke="currentColor" stroke-opacity="0.6" stroke-width="1.5"/>
    <text x="230" y="68" font-weight="700" fill="currentColor">Type + null</text>
    <text x="230" y="84" font-weight="700" fill="currentColor">valid?</text>
    <!-- diamond 2 -->
    <path d="M440 36 L508 72 L440 108 L372 72 Z" fill="currentColor" fill-opacity="0.1" stroke="currentColor" stroke-opacity="0.6" stroke-width="1.5"/>
    <text x="440" y="68" font-weight="700" fill="currentColor">Geometry +</text>
    <text x="440" y="84" font-weight="700" fill="currentColor">CRS valid?</text>
    <!-- write -->
    <rect x="560" y="44" width="180" height="56" rx="10" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-opacity="0.5" stroke-width="1.5"/>
    <text x="650" y="70" font-weight="700" fill="currentColor">Write to</text>
    <text x="650" y="87" font-weight="700" fill="currentColor">target schema</text>
    <!-- DLQ -->
    <rect x="300" y="176" width="220" height="54" rx="10" fill="currentColor" fill-opacity="0.12" stroke="currentColor" stroke-opacity="0.65" stroke-width="1.5"/>
    <text x="410" y="200" font-weight="700" fill="currentColor">Reject &#8594; dead-letter queue</text>
    <text x="410" y="217" font-size="10.5" fill="currentColor" fill-opacity="0.75">diagnostic payload preserved</text>
  </g>
  <!-- connectors -->
  <g stroke="currentColor" fill="none" stroke-width="2">
    <path d="M132 72 H160" stroke-opacity="0.55" marker-end="url(#smv-gate-arrow)"/>
    <path d="M298 72 H370" stroke-opacity="0.55" marker-end="url(#smv-gate-arrow)"/>
    <path d="M508 72 H558" stroke-opacity="0.55" marker-end="url(#smv-gate-arrow)"/>
    <path d="M230 108 V203 H298" stroke-opacity="0.45" marker-end="url(#smv-gate-arrow)"/>
    <path d="M440 108 V174" stroke-opacity="0.45" marker-end="url(#smv-gate-arrow)"/>
  </g>
  <g font-size="11" text-anchor="middle" font-weight="700" fill="currentColor">
    <text x="334" y="64" fill-opacity="0.8">Yes</text>
    <text x="533" y="64" fill-opacity="0.8">Yes</text>
    <text x="214" y="150" fill-opacity="0.8">No</text>
    <text x="456" y="150" fill-opacity="0.8">No</text>
  </g>
</svg>

The gate is deliberately ordered cheapest-check-first: attribute type and null constraints are evaluated against the registry before any geometry parsing, because rejecting a malformed batch on a string-length rule costs microseconds, while parsing WKB to discover the same batch is unusable costs orders of magnitude more. Anything that fails either gate is routed to the dead-letter queue with its diagnostic payload intact, never silently dropped.

## Concept & Design Decisions: Canonical Schema Contracts & Type Coercion

A production mapping strategy requires an explicit contract between source and target schemas. Maintain a centralized schema registry that defines canonical field names, physical types, nullability constraints, and domain-specific validation rules — and version it alongside your pipeline code so a contract change is a reviewable diff, not a silent runtime surprise.

The single most important design decision is to prefer explicit type coercion over implicit casting. Converting a string-encoded date to a `TIMESTAMP[ns]` column in an Arrow-backed format demands strict ISO 8601 validation *before* type promotion; the alternative — letting the writer infer the type from the first non-null value — produces partitions whose schemas disagree, which Parquet readers reject at scan time. Reference the [Apache Arrow Schema API](https://arrow.apache.org/docs/python/generated/pyarrow.Schema.html) for strict type-equality semantics and the memory-layout guarantees that make a coerced column safe to concatenate across batches.

Build the registry around a two-tier validation model:

- **Pre-flight validation** inspects each source schema against the registry *before* batch execution. Use `ogrinfo -json -so datasets/parcels/raw/county_2019.shp` or a programmatic schema diff to detect missing mandatory fields, unexpected type widening, or precision truncation. Fail fast on drift so a corrupted batch never enters the conversion stage.
- **Post-conversion audit** verifies row counts, null distributions, and cryptographic checksums of the non-geometric attributes after the write. Persist the audit manifest as a sidecar object next to the archived data so lineage and retention evidence travel with the dataset.

Choose your strictness deliberately, because it is a real trade-off. Strict validation halts the pipeline on any schema mismatch, which demands either an automated evolution handler or a manual triage queue. Lenient validation preserves throughput but accepts silent degradation. For archival workloads — write-once, read-rarely, audited-eventually — strict validation paired with an automated schema-evolution path is the correct baseline. Velocity is cheap to recover; a corrupted decade-old archive is not.

A few field-level rules that repeatedly matter for spatial attribute tables:

- **Reserved-word and casing normalization.** Coerce field names to `snake_case` and strip characters that legacy DBF headers tolerate but analytical engines do not. A column named `Shape_Area` and another named `SHAPE_AREA` must not survive as two columns.
- **Domain enforcement for coded fields.** Land-use, zoning, and classification codes belong in a constrained domain. Validate against the allowed set and reject out-of-domain values rather than letting them pollute a dictionary-encoded column.
- **Precision capping.** Numeric attributes carried from survey systems often arrive at `float64` when `float32` or a scaled integer is exact and far smaller. Cap precision intentionally — never let the writer widen on your behalf.

## Implementation: Declarative Mapping Manifests

Deploy schema mapping as declarative manifests rather than logic embedded in pipeline code. A YAML or JSON manifest specifies field-level rules, coercion targets, and validation constraints, which makes the contract reviewable, versionable, and hot-swappable without redeploying the pipeline.

```yaml
# config/mapping/parcels_v3.yaml — applied by the convert worker per source object
schema_version: 3
source_format: "ESRI Shapefile"
target_format: "GeoParquet"
on_unmapped_source_field: "REJECT"   # never silently drop a column
mapping_rules:
  - source_field: "PROP_ID"
    target_field: "property_id"
    type: "INT64"
    nullable: false
    validators:
      - range: [1000, 9999999]
    fallback: "REJECT"               # route whole record to DLQ
  - source_field: "ACQ_DATE"
    target_field: "acquisition_timestamp"
    type: "TIMESTAMP[ns]"
    nullable: true
    validators:
      - format: "ISO8601"
    fallback: "NULL"                 # log the coercion, keep the record
  - source_field: "LU_CODE"
    target_field: "land_use_code"
    type: "STRING"
    nullable: false
    validators:
      - domain: ["RES", "COM", "IND", "AGR", "PUB"]
    fallback: "REJECT"
```

The convert worker loads the manifest, validates each record against it at the partition level, and emits both the GeoParquet output and a per-batch audit record. Enforcing constraints partition-by-partition rather than loading the full source into memory is what keeps large-batch conversions from triggering OOM kills on a worker:

```python
# convert_worker.py — partition-level mapping + validation
import pyarrow as pa
import pyarrow.parquet as pq
import yaml
from osgeo import ogr

cfg = yaml.safe_load(open("config/mapping/parcels_v3.yaml"))
rules = {r["source_field"]: r for r in cfg["mapping_rules"]}

def coerce_batch(batch: pa.RecordBatch) -> pa.RecordBatch:
    cols, names = [], []
    for src, rule in rules.items():
        if src not in batch.schema.names:        # missing mandatory field
            raise SchemaDriftError(f"missing source field {src}")
        col = batch.column(src)
        # explicit cast — raises on overflow/precision loss instead of truncating
        col = col.cast(pa.type_for_alias(rule["type"].lower().split("[")[0]),
                       safe=True)
        cols.append(col); names.append(rule["target_field"])
    return pa.RecordBatch.from_arrays(cols, names=names)

# Records that fail coercion route to the DLQ with their diagnostic payload,
# rather than aborting the whole object — see Handling Attribute Loss below.
```

When mapping encounters an unresolvable type mismatch or a missing critical attribute, the pipeline must route to the [Handling Attribute Loss During Spatial Format Conversion](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/schema-mapping-attribute-validation/handling-attribute-loss-during-spatial-format-conversion/) procedure rather than dropping columns silently. That preserves lineage and gives compliance teams an explicit, queryable record of every transformation deviation.

<svg viewBox="0 0 820 350" role="img" aria-label="Layered mapping architecture: one versioned schema registry governs three pipeline stages. Its contract feeds a pre-flight schema diff, a partition-level coercion stage, and a post-conversion audit manifest. Records that fail coercion branch down to a dead-letter queue, while audited output lands in an immutable archive with a sidecar manifest." xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;color:var(--primary);font-family:var(--font-sans)">
  <title>One versioned schema registry governs pre-flight diff, partition coercion, and post-conversion audit</title>
  <desc>A schema registry contract feeds three stages: pre-flight schema diff, partition-level coercion, and post-conversion audit manifest. The coercion stage branches failed records to a dead-letter queue; the audit stage emits an immutable archive plus a sidecar manifest.</desc>
  <defs>
    <marker id="smv-arch-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <!-- registry (governing layer) -->
  <rect x="250" y="16" width="320" height="58" rx="10" fill="currentColor" fill-opacity="0.12" stroke="currentColor" stroke-opacity="0.65" stroke-width="1.5"/>
  <text x="410" y="42" text-anchor="middle" font-size="13.5" font-weight="700" fill="currentColor">Versioned schema registry</text>
  <text x="410" y="60" text-anchor="middle" font-size="10.5" fill="currentColor" fill-opacity="0.78">canonical name &#183; type &#183; nullability &#183; domain</text>
  <!-- three stages -->
  <g>
    <rect x="24" y="148" width="232" height="74" rx="10" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-opacity="0.5" stroke-width="1.5"/>
    <text x="140" y="180" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">Pre-flight schema diff</text>
    <text x="140" y="199" text-anchor="middle" font-size="10.5" fill="currentColor" fill-opacity="0.75">detect drift before CPU</text>
    <text x="140" y="213" text-anchor="middle" font-size="10.5" fill="currentColor" fill-opacity="0.75">is spent converting</text>
  </g>
  <g>
    <rect x="294" y="148" width="232" height="74" rx="10" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-opacity="0.5" stroke-width="1.5"/>
    <text x="410" y="180" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">Partition-level coercion</text>
    <text x="410" y="199" text-anchor="middle" font-size="10.5" fill="currentColor" fill-opacity="0.75">explicit safe casts,</text>
    <text x="410" y="213" text-anchor="middle" font-size="10.5" fill="currentColor" fill-opacity="0.75">batch by batch</text>
  </g>
  <g>
    <rect x="564" y="148" width="232" height="74" rx="10" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-opacity="0.5" stroke-width="1.5"/>
    <text x="680" y="180" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">Post-conversion audit</text>
    <text x="680" y="199" text-anchor="middle" font-size="10.5" fill="currentColor" fill-opacity="0.75">row counts, null ratios,</text>
    <text x="680" y="213" text-anchor="middle" font-size="10.5" fill="currentColor" fill-opacity="0.75">per-column types</text>
  </g>
  <!-- DLQ + archive -->
  <rect x="294" y="278" width="232" height="56" rx="10" fill="currentColor" fill-opacity="0.12" stroke="currentColor" stroke-opacity="0.65" stroke-width="1.5"/>
  <text x="410" y="302" text-anchor="middle" font-size="12.5" font-weight="700" fill="currentColor">Dead-letter queue</text>
  <text x="410" y="320" text-anchor="middle" font-size="10.5" fill="currentColor" fill-opacity="0.75">failed coercion + payload</text>
  <rect x="564" y="278" width="232" height="56" rx="10" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-opacity="0.5" stroke-width="1.5"/>
  <text x="680" y="302" text-anchor="middle" font-size="12.5" font-weight="700" fill="currentColor">Immutable archive</text>
  <text x="680" y="320" text-anchor="middle" font-size="10.5" fill="currentColor" fill-opacity="0.75">+ audit sidecar manifest</text>
  <!-- registry governs each stage (dashed contract feeds) -->
  <g stroke="currentColor" fill="none" stroke-width="1.6" stroke-dasharray="5 4" stroke-opacity="0.5">
    <path d="M300 74 C300 120 140 110 140 146" marker-end="url(#smv-arch-arrow)"/>
    <path d="M410 74 V146" marker-end="url(#smv-arch-arrow)"/>
    <path d="M520 74 C520 120 680 110 680 146" marker-end="url(#smv-arch-arrow)"/>
  </g>
  <!-- pipeline flow -->
  <g stroke="currentColor" fill="none" stroke-width="2" stroke-opacity="0.55">
    <path d="M256 185 H292" marker-end="url(#smv-arch-arrow)"/>
    <path d="M526 185 H562" marker-end="url(#smv-arch-arrow)"/>
    <path d="M410 222 V276" stroke-opacity="0.45" marker-end="url(#smv-arch-arrow)"/>
    <path d="M680 222 V276" marker-end="url(#smv-arch-arrow)"/>
  </g>
  <g font-size="10.5" text-anchor="middle" font-weight="700" fill="currentColor">
    <text x="274" y="178" fill-opacity="0.8">pass</text>
    <text x="544" y="178" fill-opacity="0.8">written</text>
    <text x="452" y="252" fill-opacity="0.8">reject</text>
  </g>
</svg>

## Validation Gate: Confirming the Mapping Worked

Pre-flight validation is the command that decides whether a batch is even allowed to run. Diff the source schema against the registry before conversion:

```bash
# Pre-flight: does the source match the contract before we spend CPU converting it?
ogrinfo -json -so datasets/parcels/raw/county_2019.shp county_2019 \
  | python3 tools/schema_diff.py --contract config/mapping/parcels_v3.yaml
```

Expected output on a clean source:

```text
PASS  fields=42 mapped=42 unmapped=0 type_mismatches=0
PASS  mandatory fields present: property_id, land_use_code
OK    proceeding to conversion
```

After the write, audit the target object to confirm no attribute degraded:

```bash
# Post-conversion: row count, null ratios, and per-column physical types
python3 -c "import pyarrow.parquet as pq; \
  m = pq.read_metadata('datasets/parcels/geoparquet/county_2019.parquet'); \
  print('rows', m.num_rows); print(m.schema)"
```

Expected output confirms the coerced types landed and the geometry column survived:

```text
rows 184213
property_id: int64 not null
acquisition_timestamp: timestamp[ns]
land_use_code: string not null
geometry: binary  -- WKB, GeoParquet 'geo' metadata present
```

**Most common failure — root cause.** A pre-flight that reports `type_mismatches=1` on a field that "looks fine" is almost always a DBF width artifact: ESRI shapefiles store every numeric attribute as a width/precision pair in the `.dbf` header, so an integer ID can arrive declared as `Real(10,0)` and OGR surfaces it as a float. The fix is to assert the registry type explicitly in the manifest (`type: INT64`) and let the `safe=True` cast fail loudly on any value that is not actually integral — never relax the contract to match the source.

## Cost & Performance Trade-offs

Strictness has a measurable cost in pipeline throughput, and laxity has a larger cost in storage and rework. Quantify it before choosing a posture:

| Validation posture | Throughput impact | Storage / downstream impact | When it is the right call |
|---|---|---|---|
| Strict (reject on any drift) | ~5–12% slower per batch from pre-flight diffing | Smallest archive; types stay dictionary- and run-length-encodable | Archival, compliance-bound, multi-year retention |
| Coerce-with-fallback (NULL on soft failures) | Negligible | Slightly larger; null bitmaps add ~1 bit/row/column | Mixed-quality legacy backfills |
| Lenient (writer infers types) | Fastest ingest | Largest; mixed-type columns defeat encoding, force full scans | Throwaway / staging only, never the archive |

The downstream multiplier is the part teams underestimate. A single field that lands as `string` instead of an enumerable `land_use_code` defeats dictionary encoding, which is precisely what [ZSTD level configuration for spatial files](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/zstd-level-configuration-for-spatial-files/) and [dictionary encoding for GIS attributes](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/dictionary-encoding-for-gis-attributes/) rely on to keep cold-storage footprints small. A mistyped attribute can inflate a column's on-disk size by 4–10× and force full-table scans on what should be a predicate-pushdown query — a cost paid on every read for the life of the archive, dwarfing the one-time validation overhead. Aligning mapping rules with the encoding strategy of the target format is therefore not an optimization, it is a prerequisite for the storage economics of the whole archive.

## Failure Modes & Edge Cases

- **Silent precision truncation on reprojection-adjacent fields.** Pipelines that compute area or length attributes after a coordinate transform can write those values before the geometry's CRS is finalized, capturing measurements in the wrong units. Validate computed numeric attributes *after* the geometry stage, and treat unit metadata as part of the contract.
- **DBF 10-character field-name truncation collisions.** Two source fields whose names differ only after the 10th character (`parcel_area_acres`, `parcel_area_acreage`) collapse to the same truncated DBF header and silently overwrite each other. Detect this in pre-flight by checking for duplicate truncated keys, not just duplicate full names.
- **Null-vs-sentinel ambiguity.** Legacy systems encode "no value" as `-9999`, `0`, or an empty string interchangeably. A range validator that accepts `0` will happily store a sentinel as real data. Define per-field null sentinels in the registry and normalize them to true nulls before the range check runs.
- **Mixed-geometry source layers.** A single shapefile layer carrying both `POLYGON` and `MULTIPOLYGON` features will pass attribute validation but produce a target with an inconsistent geometry type unless you promote everything to the multi-variant during mapping. Coordinate this with the geometry checks so the attribute gate and geometry gate agree on what a valid record is.

## Operational Execution Checklist

- [ ] Schema registry exists, is version-controlled, and defines canonical name, type, nullability, and domain for every archived field
- [ ] Mapping manifest sets `on_unmapped_source_field: REJECT` so no column is ever dropped silently
- [ ] Pre-flight schema diff runs against the contract before any conversion CPU is spent
- [ ] All type changes use explicit `safe=True` casts that fail on overflow or precision loss
- [ ] Coded/domain fields are validated against an allowed set, not stored as free text
- [ ] Null sentinels (`-9999`, empty string) normalized to true nulls before range checks
- [ ] Records failing coercion route to the dead-letter queue with diagnostic payloads, never dropped
- [ ] Post-conversion audit verifies row counts, null ratios, and per-column physical types
- [ ] Audit manifest and schema version persisted as a sidecar object next to the archived data
- [ ] Mapping rules aligned with the target format's dictionary/ZSTD encoding strategy
- [ ] Retention lifecycle on manifests matches the lifecycle of the geospatial data they describe

## Related

- Up to the parent: [Format Conversion & Pipeline Automation](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/) — the orchestration layer this validation gate plugs into.
- [Handling Attribute Loss During Spatial Format Conversion](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/schema-mapping-attribute-validation/handling-attribute-loss-during-spatial-format-conversion/) — the procedure for records that fail coercion or carry unmappable fields.
- [GeoParquet Migration Workflows](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/geoparquet-migration-workflows/) — the columnar target most mapping contracts on this site emit to.
- [CRS Synchronization in Pipelines](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/crs-synchronization-in-pipelines/) — the sibling stage that owns datum and projection integrity at the shared validation gate.
- [ZSTD Level Configuration for Spatial Files](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/zstd-level-configuration-for-spatial-files/) — the reason correct attribute typing matters for cold-storage cost.
