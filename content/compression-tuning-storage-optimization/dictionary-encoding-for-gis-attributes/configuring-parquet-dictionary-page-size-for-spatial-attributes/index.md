# Configuring Parquet Dictionary Page Size for Spatial Attributes

High-cardinality spatial attribute columns — H3 cell IDs, tile keys, gazetteer place names — routinely overflow Parquet's default dictionary page budget and fall back to PLAIN encoding partway through a column chunk, silently erasing the compression you expected. This guide is for data engineers tuning the pyarrow and GDAL Parquet writers so that fallback happens by design, never by accident. The default `dictionary_pagesize_limit` of 1 MiB was chosen for narrow analytics columns, not for the wide, semi-repetitive string attributes typical of a spatial archive; left unchanged, it caps the dictionary long before it has captured the column's real value set. Below is the exact configuration and verification loop that keeps intentional columns dictionary-encoded end to end, extending the measurement discipline in [Measuring Dictionary Encoding Ratios for GIS Attribute Columns](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/dictionary-encoding-for-gis-attributes/measuring-dictionary-encoding-ratios-for-gis-attribute-columns/) within the [Compression Tuning & Storage Optimization](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/) framework.

## Why the Dictionary Falls Back

When a Parquet writer dictionary-encodes a column chunk, it accumulates distinct values into an in-memory dictionary page. That page has a hard byte ceiling set by `dictionary_pagesize_limit`. The moment the growing dictionary would exceed the ceiling, the writer stops adding new entries, abandons dictionary encoding for the **remainder of that column chunk**, and re-emits the already-buffered rows plus everything after as PLAIN. The result is a column that is dictionary-encoded for its first slice and PLAIN for the rest — usually reported in the footer as `PLAIN` only, because the fallback dominates.

For spatial attributes this bites hard. A `h3_cell` column at H3 resolution 8 can hold tens of thousands of distinct 15-character hex strings inside a single large row group; the dictionary page fills, the writer falls back, and the archive stores full 15-byte strings instead of two-byte indices. The fix is not to disable the ceiling but to size it against the column's real cardinality, or to reshape the write so each column chunk sees a value set that fits.

<svg viewBox="0 0 820 300" role="img" aria-label="Dictionary encoding fallback state machine. Start at build dictionary. From build dictionary, if a new distinct value fits within the dictionary page size limit, add entry and remain dictionary encoded. If the next value would exceed the limit, transition to fallback, which abandons dictionary encoding and re-emits the whole column chunk as plain. Raising the dictionary page size limit widens the window so the column stays in the dictionary encoded state." xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;color:var(--primary);font-family:var(--font-sans)">
  <title>Dictionary page-size fallback state machine</title>
  <desc>Two states connected by a threshold decision. The writer builds a dictionary and stays dictionary-encoded while distinct values fit within dictionary_pagesize_limit; when a new value would exceed the limit it transitions irreversibly to a PLAIN fallback for the rest of the column chunk. Raising the limit keeps the writer in the dictionary-encoded state longer.</desc>
  <defs>
    <marker id="ds-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <!-- state: dictionary encoded -->
  <rect x="40" y="40" width="240" height="96" rx="12" fill="currentColor" fill-opacity="0.09" stroke="currentColor" stroke-opacity="0.6" stroke-width="1.5"/>
  <text x="160" y="80" text-anchor="middle" font-size="14" font-weight="700" fill="currentColor">DICTIONARY-ENCODED</text>
  <text x="160" y="102" text-anchor="middle" font-size="10.5" fill="currentColor" fill-opacity="0.8">indices + growing dictionary page</text>
  <text x="160" y="118" text-anchor="middle" font-size="10.5" fill="currentColor" fill-opacity="0.8">two bytes per value</text>
  <!-- self loop add entry -->
  <path d="M70 40 C60 6 260 6 250 40" fill="none" stroke="currentColor" stroke-opacity="0.5" stroke-width="1.8" marker-end="url(#ds-arrow)"/>
  <text x="160" y="20" text-anchor="middle" font-size="10" fill="currentColor" fill-opacity="0.85">new value fits &#8594; add entry</text>
  <!-- decision diamond -->
  <path d="M500 88 L560 48 L620 88 L560 128 z" fill="currentColor" fill-opacity="0.06" stroke="currentColor" stroke-opacity="0.6" stroke-width="1.5"/>
  <text x="560" y="84" text-anchor="middle" font-size="10.5" font-weight="600" fill="currentColor">dict page</text>
  <text x="560" y="99" text-anchor="middle" font-size="10.5" font-weight="600" fill="currentColor">&gt; limit?</text>
  <!-- arrow build to decision -->
  <path d="M280 88 H498" fill="none" stroke="currentColor" stroke-opacity="0.5" stroke-width="1.8" marker-end="url(#ds-arrow)"/>
  <text x="388" y="80" text-anchor="middle" font-size="10" fill="currentColor" fill-opacity="0.85">next value</text>
  <!-- state: plain fallback -->
  <rect x="440" y="196" width="300" height="88" rx="12" fill="currentColor" fill-opacity="0.13" stroke="currentColor" stroke-opacity="0.7" stroke-width="1.5"/>
  <text x="590" y="232" text-anchor="middle" font-size="14" font-weight="700" fill="currentColor">PLAIN FALLBACK</text>
  <text x="590" y="254" text-anchor="middle" font-size="10.5" fill="currentColor" fill-opacity="0.85">whole column chunk re-emitted PLAIN</text>
  <text x="590" y="270" text-anchor="middle" font-size="10.5" fill="currentColor" fill-opacity="0.85">full-width strings on disk</text>
  <!-- arrow decision yes to fallback -->
  <path d="M560 128 V194" fill="none" stroke="currentColor" stroke-opacity="0.6" stroke-width="1.8" marker-end="url(#ds-arrow)"/>
  <text x="576" y="164" font-size="10" font-weight="700" fill="currentColor">yes</text>
  <!-- arrow decision no back to build -->
  <path d="M500 100 C360 150 300 150 220 138" fill="none" stroke="currentColor" stroke-opacity="0.45" stroke-width="1.8" marker-end="url(#ds-arrow)"/>
  <text x="360" y="150" text-anchor="middle" font-size="10" fill="currentColor" fill-opacity="0.85">no &#183; raise limit widens this path</text>
</svg>

## Step-by-Step Configuration Procedure

### 1. Size the ceiling against measured cardinality

Estimate the dictionary footprint per column chunk: `distinct_values × (avg_value_bytes + index_overhead)`. For an `h3_cell` column with 60,000 distinct values at 15 bytes each, budget roughly `60000 × 18 ≈ 1.08 MB` — already over the 1 MiB default. Set the limit with headroom.

```python
import pyarrow as pa
import pyarrow.parquet as pq
import pyarrow.dataset as ds

tbl = ds.dataset("s3://spatial-archive/features/2023/", format="parquet").to_table()

pq.write_table(
    tbl,
    "s3://spatial-archive/features/2023/tuned.parquet",
    use_dictionary=["h3_cell", "tile_key", "place_name"],  # target only wide categoricals
    dictionary_pagesize_limit=4 * 1024 * 1024,             # 4 MiB, up from 1 MiB default
    data_page_size=1 * 1024 * 1024,
    compression="zstd",
    compression_level=6,
    row_group_size=1_000_000,                              # smaller chunks = smaller per-chunk dict
    write_statistics=True,
)
```

`use_dictionary` accepts a column list, so you enable it precisely where measurement said it pays and leave true identifier columns in PLAIN. Note the interaction with `row_group_size`: a smaller row group means each column chunk sees fewer rows and therefore fewer distinct values, which can keep a borderline column under the ceiling without raising the limit at all — a trade-off that couples this decision to [Calculating Optimal Row-Group Size for Spatial Queries](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/row-group-sizing-strategies/calculating-optimal-row-group-size-for-spatial-queries/).

### 2. Configure the same limit through the GDAL writer

Pipelines built on `ogr2ogr` expose the ceiling through a layer-creation option, so CLI conversions get the same protection as the Python path.

```bash
ogr2ogr -f Parquet features_tuned.parquet features.gpkg \
  -lco COMPRESSION=ZSTD \
  -lco COMPRESSION_LEVEL=6 \
  -lco ROW_GROUP_SIZE=1000000 \
  -lco "PARQUET_DICTIONARY_PAGE_SIZE_LIMIT=4194304" \
  -progress
```

Keep the GDAL and pyarrow limits identical so an archive written by two different tools reads back with consistent encoding. Confirm the option name against the [GDAL Parquet driver documentation](https://gdal.org/drivers/vector/parquet.html) for your installed GDAL version, as layer-creation options are version-gated.

### 3. Force a full-column dictionary where cardinality is stable

For columns whose value set is closed and known — a fixed land-cover legend, a national admin roster — you can pin the dictionary so the writer never fallbacks even under a large row group, by keeping the row group small enough that the closed set always fits.

```python
# Closed-vocabulary column: cap row group so its full dictionary always fits the ceiling
pq.write_table(
    tbl.select(["land_cover_class", "geometry"]),
    "legend_bound.parquet",
    use_dictionary=["land_cover_class"],
    dictionary_pagesize_limit=2 * 1024 * 1024,
    row_group_size=500_000,
    compression="zstd",
)
```

## Balancing the Ceiling Against Row-Group Size and Memory

Two knobs move the same fallback boundary, and choosing between them is the crux of tuning this well. Raising `dictionary_pagesize_limit` lets a single column chunk hold a bigger dictionary, which keeps a high-cardinality column encoded even in a large row group — at the cost of writer memory, because every actively written column keeps its dictionary page resident. Lowering `row_group_size` shrinks the number of rows, and therefore the number of distinct values, each chunk must absorb, so the same column fits under a smaller ceiling — at the cost of more row groups, larger footers, and the pruning trade-offs weighed in [Benchmarking Row-Group Size Against Spatial Predicate Pushdown](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/row-group-sizing-strategies/benchmarking-row-group-size-against-spatial-predicate-pushdown/).

For spatial archives the row-group lever is usually the better first move, because spatial data is rarely uniform. A `tile_key` column in a dense metropolitan partition carries far more distinct values per thousand rows than the same column over open ocean or unpopulated terrain. Sizing the row group so the densest realistic chunk stays under the ceiling protects every partition without inflating the limit globally and paying that memory cost on sparse chunks that never needed it. When the densest chunk still overflows even a small row group, only then raise the ceiling, and raise it to a measured multiple of the estimate rather than an arbitrary large value — an oversized limit wastes memory on every column, not just the one that needed it.

There is one case where you want the opposite: a closed-vocabulary column whose full dictionary is small and fixed. Pin a limit comfortably above its known dictionary size and let the row group grow, so the column stays dictionary-encoded across large chunks with no memory concern. The distinction is cardinality growth: bounded vocabularies tolerate big row groups, unbounded identifiers do not.

## Validation & Verification

Verify that every targeted column reports `RLE_DICTIONARY` across **all** row groups, not just the first — a partial fallback shows up as some chunks dictionary-encoded and some PLAIN.

```python
import pyarrow.parquet as pq

md = pq.ParquetFile("features_tuned.parquet").metadata
target = "h3_cell"
ci = md.schema.names.index(target)
for rg in range(md.num_row_groups):
    enc = md.row_group(rg).column(ci).encodings
    ok = "RLE_DICTIONARY" in enc
    print(f"row_group {rg}: {'DICT' if ok else 'FELL BACK'}  {tuple(enc)}")
```

Expected output — every row group must report `DICT`; a single `FELL BACK` line means the ceiling is still too low for that chunk:

```text
row_group 0: DICT  ('PLAIN', 'RLE', 'RLE_DICTIONARY')
row_group 1: DICT  ('PLAIN', 'RLE', 'RLE_DICTIONARY')
row_group 2: DICT  ('PLAIN', 'RLE', 'RLE_DICTIONARY')
```

## Troubleshooting

- **A later row group falls back while earlier ones held.** That chunk's local cardinality spiked — a dense urban tile packs more distinct `h3_cell` values than a rural one. Either raise `dictionary_pagesize_limit` further or reduce `row_group_size` so every chunk stays under budget.
- **Dictionary holds but the file barely shrank.** The column's values are near-unique; dictionary encoding is not the lever. Re-measure with the ratio procedure and consider leaving it PLAIN so you stop paying dictionary-build cost.
- **Raising the limit blew up writer memory.** The dictionary page lives in memory per active column chunk; a 32 MiB limit across many parallel columns multiplies fast. Cap the limit and lower `row_group_size` together rather than pushing the ceiling alone.

## Operational Execution Checklist

- [ ] Estimate per-chunk dictionary bytes as `distinct × (avg_value_bytes + index_overhead)` before setting the ceiling.
- [ ] Enable `use_dictionary` as an explicit column list, not a global boolean, targeting only wide categoricals.
- [ ] Set `dictionary_pagesize_limit` with headroom above the estimate and mirror it in the GDAL `-lco` option.
- [ ] Tune `row_group_size` down as an alternative to raising the ceiling when memory is constrained.
- [ ] Verify `RLE_DICTIONARY` appears in every row group's encoding list, not just row group 0.
- [ ] Keep pyarrow and GDAL limits identical so multi-tool archives read back consistently.
- [ ] Re-check after any change that increases per-chunk cardinality (denser tiles, composite keys).

## Related

- Up: [Dictionary Encoding for GIS Attributes](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/dictionary-encoding-for-gis-attributes/) — the parent reference for applying dictionary encoding across spatial attribute tables.
- [Measuring Dictionary Encoding Ratios for GIS Attribute Columns](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/dictionary-encoding-for-gis-attributes/measuring-dictionary-encoding-ratios-for-gis-attribute-columns/) — the sibling procedure that tells you which columns are worth protecting from fallback.
- [When to Use Dictionary Encoding for Categorical GIS Fields](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/dictionary-encoding-for-gis-attributes/when-to-use-dictionary-encoding-for-categorical-gis-fields/) — the decision rules for which attribute types belong on the dictionary path at all.
- [Tuning ZSTD Compression for GeoParquet Archives](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/zstd-level-configuration-for-spatial-files/tuning-zstd-compression-for-geoparquet-archives/) — the codec layer that stacks on top of the encoding decisions here.
- [Converting Legacy Shapefiles to GeoParquet at Scale](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/geoparquet-migration-workflows/converting-legacy-shapefiles-to-geoparquet-at-scale/) — the upstream conversion that determines a column's initial cardinality and width.

_Part of the [Spatial Data Archival](https://www.spatialdataarchival.org/) knowledge base._
