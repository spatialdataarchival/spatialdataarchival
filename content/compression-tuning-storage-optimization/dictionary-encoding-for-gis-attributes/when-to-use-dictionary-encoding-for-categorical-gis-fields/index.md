# When to Use Dictionary Encoding for Categorical GIS Fields

Categorical GIS attributes — `land_use_code`, `admin_level`, sensor model IDs, regulatory compliance flags — routinely dominate the metadata overhead of a spatial archive, yet engine defaults make the encoding decision silently and inconsistently across row groups. This page gives data engineers, GIS archivists, and cloud architects a deterministic rule for *when* dictionary encoding earns its keep on a categorical column and when it backfires, plus the exact profiling, writer, and validation commands to enforce that decision per column. Default behaviour fails because writers auto-enable dictionaries up to a size ceiling, then fall back to plain encoding mid-row-group when cardinality drifts — leaving you paying for a populated dictionary page that buys nothing while inflating decode latency on cold retrieval. This procedure sits one level under the parent [Dictionary Encoding for GIS Attributes](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/dictionary-encoding-for-gis-attributes/) decision framework.

## Decision at a Glance

Encode only when cardinality and null rate both stay within budget; otherwise fall back to plain encoding so downstream codecs see clean integer arrays:

<svg viewBox="0 0 720 530" role="img" aria-label="Decision flow for dictionary-encoding a categorical GIS column. Profile the column, then test whether it has 500 or fewer unique values; if not, disable the dictionary and use plain encoding. If it passes, test whether the null rate is under 40 percent; if not, disable the dictionary. If both gates pass, enable dictionary encoding and cap the dictionary page at 1 megabyte." xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;color:var(--primary);font-family:var(--font-sans)">
  <title>When to enable dictionary encoding on a categorical GIS column</title>
  <desc>A top-down flow. Start by profiling the column. First gate: 500 or fewer unique values? If no, disable the dictionary and fall back to plain encoding. If yes, second gate: null rate under 40 percent? If no, fall back to plain encoding. If yes, enable dictionary encoding, then cap the dictionary page at 1 megabyte.</desc>
  <defs>
    <marker id="wt-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <g font-size="13" font-weight="600" text-anchor="middle">
    <!-- A: profile -->
    <rect x="130" y="18" width="200" height="44" rx="10" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-opacity="0.35"/>
    <text x="230" y="45" fill="currentColor">Profile column</text>
    <!-- B: cardinality gate -->
    <polygon points="130,130 230,86 330,130 230,174" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-opacity="0.4"/>
    <text x="230" y="134" fill="currentColor">&#8804; 500 unique values?</text>
    <!-- C: null-rate gate -->
    <polygon points="130,260 230,216 330,260 230,304" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-opacity="0.4"/>
    <text x="230" y="264" fill="currentColor">Null rate &#60; 40%?</text>
    <!-- P: fallback outcome -->
    <rect x="460" y="172" width="220" height="56" rx="10" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-opacity="0.35"/>
    <text x="570" y="195" fill="currentColor">Disable dictionary</text>
    <text x="570" y="215" font-size="12" font-weight="600" fill="currentColor" fill-opacity="0.85">plain encoding + ZSTD</text>
    <!-- D: enable -->
    <rect x="130" y="348" width="200" height="44" rx="10" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-opacity="0.35"/>
    <text x="230" y="375" fill="currentColor">Enable dictionary</text>
    <!-- E: cap -->
    <rect x="118" y="438" width="224" height="56" rx="10" fill="currentColor" fill-opacity="0.12" stroke="currentColor" stroke-opacity="0.6"/>
    <text x="230" y="461" fill="currentColor">Cap dictionary page</text>
    <text x="230" y="481" fill="currentColor">at 1 MB</text>
  </g>
  <g stroke="currentColor" stroke-width="2" stroke-opacity="0.55" fill="none">
    <path d="M230 62 V84" marker-end="url(#wt-arrow)"/>
    <path d="M230 174 V214" marker-end="url(#wt-arrow)"/>
    <path d="M230 304 V344" marker-end="url(#wt-arrow)"/>
    <path d="M230 392 V434" marker-end="url(#wt-arrow)"/>
    <path d="M330 130 H570 V168" marker-end="url(#wt-arrow)"/>
    <path d="M330 260 H570 V232" marker-end="url(#wt-arrow)"/>
  </g>
  <g font-size="12" font-weight="600" fill="currentColor" fill-opacity="0.85" text-anchor="middle">
    <text x="252" y="200">Yes</text>
    <text x="400" y="120">No</text>
    <text x="252" y="330">Yes</text>
    <text x="400" y="250">No</text>
  </g>
</svg>

## The Encoding Decision: Five Quantitative Gates

Enable dictionary encoding on a categorical field only when **all five** conditions hold simultaneously. A field failing any one criterion should bypass the dictionary and route directly to page-level compression — the entropy-reduction job is then handed to [ZSTD Level Configuration for Spatial Files](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/zstd-level-configuration-for-spatial-files/), which compresses the raw column far more cheaply than a saturated dictionary page would.

| Gate | Operational limit | Failure root-cause | Fallback strategy |
|------|-------------------|--------------------|-------------------|
| **Cardinality-to-volume** | ≤ 500 unique values per 10M rows | Dictionary page exceeds 1 MB, negating columnar gains | Plain encoding + ZSTD level 3 |
| **Average string length** | ≥ 4 characters | Short codes (`Y/N`, `0/1`) compress better via RLE / bit-packing | Direct ZSTD or RLE |
| **Repetition density** | ≥ 60% of non-null values repeat ≥ 3× per row group | Sparse dictionaries waste a 4-byte pointer per row | Numeric surrogate keys |
| **Query access pattern** | `=`, `IN`, `GROUP BY`, dimension joins | Range operators (`>`, `<`, `BETWEEN`) force a full dictionary decode at query time | Leave unencoded; index separately |
| **Format compatibility** | Parquet / GeoParquet v1.0+ | Shapefile and GeoJSON lack native dictionary pages | Pre-serialize to Parquet before archival |

The format gate assumes your data is already columnar; if it still lives in Shapefile or GeoPackage, run the [GeoParquet Migration Workflows](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/geoparquet-migration-workflows/) pipeline first, because dictionary encoding is a column-chunk property that only exists in Parquet-family layouts.

## Step-by-Step Procedure

### Phase 1 — Profile the source column

Run a cardinality, null-rate, and string-length scan before touching any writer configuration. The DuckDB CLI reads GeoParquet in place, so you can profile cold-tier objects without a full load.

```bash
# Profile a categorical column straight from a GeoParquet archive object.
duckdb -c "
SELECT
  land_use_code,
  COUNT(*)                       AS freq,
  AVG(LENGTH(land_use_code))     AS avg_len,
  COUNT(*) FILTER (land_use_code IS NULL) AS nulls
FROM read_parquet('s3://geo-archive/parcels/2024/region_north.parquet')
GROUP BY land_use_code
ORDER BY freq DESC;
"
```

### Phase 2 — Assert the gates in code

Encode the five thresholds as hard assertions so a drifting partition fails the pipeline loudly instead of silently falling back to plain encoding at write time.

```python
import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.parquet as pq

table = pq.read_table("datasets/parcels/2024/region_north.parquet")
col = table.column("land_use_code")

unique_count = len(pc.value_counts(col))
null_pct = pc.sum(pc.is_null(col)).as_py() / len(table) * 100

assert unique_count <= 500, f"Cardinality {unique_count} exceeds dictionary threshold"
assert null_pct < 40, f"Null rate {null_pct:.1f}% triggers fallback encoding"
```

### Phase 3 — Configure the writer per column

Set `use_dictionary` explicitly as a per-column list — never rely on the engine default — and cap the dictionary page so a cardinality leak can never blow past 1 MB and fragment.

```python
import pyarrow.parquet as pq

pq.write_table(
    table,
    "datasets/parcels/2024/region_north.dict.parquet",
    use_dictionary=["land_use_code", "admin_jurisdiction"],  # gated columns only
    dictionary_pagesize_limit=1_048_576,  # 1 MB hard cap on the dictionary page
    data_page_size=1_048_576,
    write_statistics=True,
    compression="zstd",
)
```

For GDAL/OGR pipelines the Parquet driver enables dictionary encoding by default; control layout through row-group sizing instead:

```bash
ogr2ogr -f "Parquet" datasets/parcels/2024/region_north.dict.parquet \
  datasets/parcels/2024/region_north.shp \
  -lco COMPRESSION=ZSTD \
  -lco ROW_GROUP_SIZE=1000000
```

### Phase 4 — Cluster values before the write

Dictionary efficiency decays when a row group spans heterogeneous spatial partitions, because the same values get re-materialized in every group. Sort by the categorical key so each row group holds contiguous values and the dictionary stays compact. Pick the row count with the formula in [Calculating Optimal Row Group Size for Spatial Queries](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/row-group-sizing-strategies/calculating-optimal-row-group-size-for-spatial-queries/) so groups land in the 128–256 MB band without straddling a partition.

```python
# Contiguous categorical runs keep one dictionary per row group, not many.
table = table.sort_by("land_use_code")
```

## Validation & Verification

Confirm the dictionary was actually written, sits under the 1 MB cap, and that integer pointers replaced the bulk of the original string bytes before promoting the file to an archival tier.

```python
import pyarrow.parquet as pq

meta = pq.read_metadata("datasets/parcels/2024/region_north.dict.parquet")
for rg in range(meta.num_row_groups):
    col = meta.row_group(rg).column(0)  # land_use_code
    dpo = col.dictionary_page_offset
    # The dictionary page sits between its own offset and the first data page,
    # so its on-disk size is the difference of the two offsets.
    dict_size = (col.data_page_offset - dpo) if dpo is not None else 0
    overhead = dict_size / col.total_compressed_size
    print(f"RG {rg}: dict {dict_size/1024:.1f} KiB, overhead {overhead:.1%}")
    assert dict_size <= 1_048_576, f"RG {rg} dictionary page exceeds 1 MB cap"
```

Annotated expected output for a healthy low-cardinality column:

```
RG 0: dict 3.2 KiB, overhead 1.4%   # dictionary well under cap, pointers dominate
RG 1: dict 3.1 KiB, overhead 1.3%   # consistent across groups → no mid-file fallback
```

Dictionary overhead climbing above roughly 10% of compressed column size, or sizes that differ wildly between row groups, signals cardinality drift and a partial fallback — re-profile that partition before archiving.

## Troubleshooting

| Symptom | Root cause | Fix |
|---------|------------|-----|
| **Storage grows after encoding** | High-cardinality leak or string-length variance > 32 chars saturates the dictionary | Drop the column to `use_dictionary=False`; let ZSTD level 4 handle it |
| **Query latency spikes on range filters** | `>`, `<`, `BETWEEN` predicates force a full dictionary decode at runtime | Materialize a numeric sort key; keep the string column unencoded |
| **Cold-retrieval timeouts** | Dictionary pages fragmented across row groups that straddle spatial partitions | Increase `row_group_size`; sort by the categorical key and coalesce partitions before the write |

High-cardinality identifiers, UUIDs, free-text survey notes, and already-numeric classification codes consistently fail the gates and should never be dictionary-encoded; they belong with direct ZSTD compression. Before committing mappings to immutable cold storage, stabilize attribute taxonomies through [Schema Mapping & Attribute Validation](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/schema-mapping-attribute-validation/) so the dictionary you freeze still matches the data a year later.

## Operational Execution Checklist

- [ ] Profile cardinality, null rate, and average string length per candidate column
- [ ] Confirm all five gates pass before enabling the dictionary
- [ ] Set `use_dictionary` as an explicit per-column list, never the engine default
- [ ] Cap `dictionary_pagesize_limit` at 1 MB on every write
- [ ] Sort by the categorical key and size row groups to the 128–256 MB band
- [ ] Verify dictionary page size and overhead per row group post-write
- [ ] Record the encoding decision and chosen parameters in the dataset manifest

## Related

- [Dictionary Encoding for GIS Attributes](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/dictionary-encoding-for-gis-attributes/) — the parent decision framework this procedure implements, covering the string-bloat and silent-fallback failure modes in depth.
- [Calculating Optimal Row Group Size for Spatial Queries](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/row-group-sizing-strategies/calculating-optimal-row-group-size-for-spatial-queries/) — sibling procedure for sizing the row groups that bound dictionary scope.
- [Tuning ZSTD Compression for GeoParquet Archives](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/zstd-level-configuration-for-spatial-files/tuning-zstd-compression-for-geoparquet-archives/) — the page-level codec that compresses the integer pointers a dictionary produces.
- [GeoParquet Migration Workflows](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/geoparquet-migration-workflows/) — the companion conversion step from the format guides that moves Shapefile/GeoPackage sources into a format that supports dictionary pages.

Up one level: [Dictionary Encoding for GIS Attributes](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/dictionary-encoding-for-gis-attributes/) · [Compression Tuning & Storage Optimization](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/)
