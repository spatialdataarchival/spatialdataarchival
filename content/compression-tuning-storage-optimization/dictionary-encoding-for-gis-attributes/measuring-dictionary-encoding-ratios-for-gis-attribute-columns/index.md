# Measuring Dictionary Encoding Ratios for GIS Attribute Columns

Quantifying the exact byte savings dictionary encoding delivers on each categorical GIS attribute — land-use codes, administrative names, sensor identifiers — is the only defensible way to decide which columns to encode and which to leave in PLAIN. This guide is for data engineers and GIS archivists who need per-column, evidence-backed numbers rather than a blanket `use_dictionary=True`. Default writer settings apply dictionary encoding opportunistically and report nothing back, so an archive can carry columns whose dictionaries cost more than they save while genuinely repetitive columns silently fall back. The procedure below reads the actual encoded and uncompressed sizes out of Parquet column-chunk metadata, computes a true per-column ratio and cardinality profile, and turns those numbers into a keep-or-drop decision under the [Compression Tuning & Storage Optimization](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/) framework, extending the qualitative rules in [When to Use Dictionary Encoding for Categorical GIS Fields](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/dictionary-encoding-for-gis-attributes/when-to-use-dictionary-encoding-for-categorical-gis-fields/) with hard measurement.

## What the Ratio Actually Measures

Dictionary encoding replaces each value in a column with a small integer index into a per-column-chunk dictionary of distinct values. The saving is real only when the average value is wider than its index and the value repeats often. For a land-use column of 4 million rows holding roughly 40 distinct codes, each ~12-byte string collapses to a single-byte RLE-packed index plus a 40-entry dictionary — a large win. For a parcel-ID column where every value is unique, the dictionary grows to the full column, the indices are as wide as the pointers, and you pay dictionary overhead for zero repetition.

The number that matters is the **encoded-to-plain ratio**: the on-disk dictionary-encoded size (dictionary page plus data pages) divided by what the same column would occupy under PLAIN encoding, both measured before the page-level codec (ZSTD, Snappy) runs. Measuring pre-codec isolates the encoding decision from the compression decision covered in [ZSTD Level Configuration for Spatial Files](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/zstd-level-configuration-for-spatial-files/); the two stack, but they are tuned independently.

<svg viewBox="0 0 860 250" role="img" aria-label="Per-column dictionary measurement matrix for four GIS attribute columns. land_use_code: cardinality 40, plain 46 megabytes, dictionary 5 megabytes, ratio 0.11, decision encode. admin_name: cardinality 3100, plain 88 megabytes, dictionary 19 megabytes, ratio 0.22, decision encode. sensor_id: cardinality 210000, plain 64 megabytes, dictionary 61 megabytes, ratio 0.95, decision borderline review. parcel_uid: cardinality 4000000, plain 120 megabytes, dictionary 138 megabytes, ratio 1.15, decision leave plain." xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;color:var(--primary);font-family:var(--font-sans)">
  <title>Per-column dictionary encoding measurement matrix</title>
  <desc>A four-row table comparing GIS attribute columns across cardinality, plain size, dictionary-encoded size, encoded-to-plain ratio, and the resulting encode decision. Low-cardinality categorical columns show ratios well below one and are encoded; high-cardinality identifier columns show ratios at or above one and are left in plain encoding.</desc>
  <rect x="10" y="10" width="840" height="34" fill="currentColor" fill-opacity="0.07"/>
  <rect x="10" y="10" width="840" height="226" fill="none" stroke="currentColor" stroke-opacity="0.5" stroke-width="1.2"/>
  <line x1="190" y1="10" x2="190" y2="236" stroke="currentColor" stroke-opacity="0.3"/>
  <line x1="330" y1="10" x2="330" y2="236" stroke="currentColor" stroke-opacity="0.3"/>
  <line x1="460" y1="10" x2="460" y2="236" stroke="currentColor" stroke-opacity="0.3"/>
  <line x1="600" y1="10" x2="600" y2="236" stroke="currentColor" stroke-opacity="0.3"/>
  <line x1="700" y1="10" x2="700" y2="236" stroke="currentColor" stroke-opacity="0.3"/>
  <line x1="10" y1="44" x2="850" y2="44" stroke="currentColor" stroke-opacity="0.3"/>
  <line x1="10" y1="92" x2="850" y2="92" stroke="currentColor" stroke-opacity="0.3"/>
  <line x1="10" y1="140" x2="850" y2="140" stroke="currentColor" stroke-opacity="0.3"/>
  <line x1="10" y1="188" x2="850" y2="188" stroke="currentColor" stroke-opacity="0.3"/>
  <g font-size="10.5" font-weight="700" fill="currentColor">
    <text x="20" y="31">Column</text>
    <text x="200" y="31">Cardinality</text>
    <text x="340" y="31">PLAIN</text>
    <text x="470" y="31">Dict size</text>
    <text x="610" y="31">Ratio</text>
    <text x="710" y="31">Decision</text>
  </g>
  <g font-size="10.5" fill="currentColor">
    <text x="20" y="72" font-weight="600">land_use_code</text>
    <text x="200" y="72">40</text>
    <text x="340" y="72">46 MB</text>
    <text x="470" y="72">5 MB</text>
    <text x="610" y="72" font-weight="700">0.11</text>
    <text x="710" y="72">encode</text>
    <text x="20" y="120" font-weight="600">admin_name</text>
    <text x="200" y="120">3,100</text>
    <text x="340" y="120">88 MB</text>
    <text x="470" y="120">19 MB</text>
    <text x="610" y="120" font-weight="700">0.22</text>
    <text x="710" y="120">encode</text>
    <text x="20" y="168" font-weight="600">sensor_id</text>
    <text x="200" y="168">210,000</text>
    <text x="340" y="168">64 MB</text>
    <text x="470" y="168">61 MB</text>
    <text x="610" y="168" font-weight="700">0.95</text>
    <text x="710" y="168" fill-opacity="0.8">review</text>
    <text x="20" y="216" font-weight="600">parcel_uid</text>
    <text x="200" y="216">4,000,000</text>
    <text x="340" y="216">120 MB</text>
    <text x="470" y="216">138 MB</text>
    <text x="610" y="216" font-weight="700">1.15</text>
    <text x="710" y="216">leave PLAIN</text>
  </g>
</svg>

## Step-by-Step Measurement Procedure

### 1. Write two probe copies of the sample

To get a true PLAIN baseline you must disable dictionary encoding explicitly for one write, because pyarrow defaults to dictionary-on. Take a representative row-group-sized sample (not the whole archive) so the probe is fast and the cardinalities match production.

```python
import pyarrow.parquet as pq
import pyarrow.dataset as ds

sample = ds.dataset("s3://spatial-archive/parcels/2023/", format="parquet")
tbl = sample.head(2_000_000)  # one row-group-scale representative slice

# Probe A: dictionary encoding forced ON, codec OFF to isolate encoding
pq.write_table(tbl, "/tmp/probe_dict.parquet",
               use_dictionary=True, compression="none",
               row_group_size=2_000_000)

# Probe B: PLAIN baseline, codec OFF
pq.write_table(tbl, "/tmp/probe_plain.parquet",
               use_dictionary=False, compression="none",
               row_group_size=2_000_000)
```

Turning the codec off for both probes is deliberate: ZSTD can mask a bad dictionary by compressing the redundant indices anyway, so measuring pre-codec exposes the encoding decision cleanly.

### 2. Read encoded sizes from column-chunk metadata

Parquet records `total_compressed_size`, `total_uncompressed_size`, and the encoding list for every column chunk in the footer. Iterate the row groups and pull them per column.

```python
import pyarrow.parquet as pq

def column_sizes(path):
    md = pq.ParquetFile(path).metadata
    out = {}
    for rg in range(md.num_row_groups):
        for c in range(md.num_columns):
            col = md.row_group(rg).column(c)
            name = col.path_in_schema
            enc = tuple(col.encodings)
            agg = out.setdefault(name, {"bytes": 0, "encodings": set()})
            agg["bytes"] += col.total_uncompressed_size  # codec off, so == on-disk
            agg["encodings"].update(enc)
    return out

dict_sizes  = column_sizes("/tmp/probe_dict.parquet")
plain_sizes = column_sizes("/tmp/probe_plain.parquet")
```

With the codec off, `total_uncompressed_size` equals the bytes actually written, so it is the honest encoded footprint including the dictionary page.

### 3. Compute cardinality and the per-column ratio

Pair the byte figures with distinct-value counts. Use DuckDB for the cardinality pass so you never materialize the whole column in Python memory.

```python
import duckdb

card = dict(duckdb.sql("""
    SELECT column_name, approx_count_distinct(v) AS ndv FROM (
        SELECT 'land_use_code' AS column_name, land_use_code::VARCHAR AS v
          FROM read_parquet('s3://spatial-archive/parcels/2023/*.parquet')
        UNION ALL SELECT 'admin_name', admin_name FROM read_parquet('s3://spatial-archive/parcels/2023/*.parquet')
        UNION ALL SELECT 'sensor_id',  sensor_id::VARCHAR FROM read_parquet('s3://spatial-archive/parcels/2023/*.parquet')
    ) GROUP BY column_name
""").fetchall())

for name in dict_sizes:
    d = dict_sizes[name]["bytes"]
    p = plain_sizes[name]["bytes"]
    ratio = d / p if p else 1.0
    enc = "DICT" if "RLE_DICTIONARY" in dict_sizes[name]["encodings"] else "PLAIN(fell back)"
    print(f"{name:16s} ndv={card.get(name,'—'):>10} ratio={ratio:5.2f}  {enc}")
```

A ratio near `0.1`–`0.3` is a clear encode; a ratio at or above `1.0` means the dictionary is pure overhead and the column should stay PLAIN. Watch the encoding flag: if a column you forced to `use_dictionary=True` still reports `PLAIN`, the writer hit the dictionary page-size ceiling and fell back mid-chunk — the failure mode addressed in [Configuring Parquet Dictionary Page Size for Spatial Attributes](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/dictionary-encoding-for-gis-attributes/configuring-parquet-dictionary-page-size-for-spatial-attributes/).

## Interpreting the Ratio in Context

A raw ratio is necessary but not sufficient — three spatial-specific factors decide whether a low ratio is truly worth acting on. First, the dictionary is per-column-chunk, so cardinality is measured at row-group scale, not archive scale. A `district_name` column with 3,100 distinct values nationwide might present only 40 distinct values inside a single region-partitioned row group; that local cardinality is what the encoder sees, and it can make a column that looks marginal archive-wide an easy win per chunk. Always measure on a slice matching your production row-group size, which is why the probes above use a row-group-scale sample rather than a random scatter of rows.

Second, physical sort order changes the ratio for the run-length side of the encoding. Dictionary indices are further compressed with RLE, so a column sorted or clustered such that identical codes sit contiguously packs far tighter than the same column in random ingest order. If your archive applies a Hilbert or H3 sort before writing — as most spatially partitioned pipelines do — categorical attributes that correlate with location (soil class, zoning code, sensor platform) inherit that locality and their measured ratio improves accordingly. Measure after the sort you actually ship, not before.

Third, a favorable ratio still carries a decode cost at read time: every scan of a dictionary-encoded column reconstructs values through an indirection the reader must resolve. For a cold archive read rarely, that cost is irrelevant against the storage saving; for a hot vector index scanned on every request, a marginal 0.85 ratio may not justify the per-query overhead. Weigh the ratio against access frequency, not in isolation — the same discipline that governs tier placement across the archive.

## Validation & Verification

Confirm the encoding actually chosen per column with the standalone `parquet-tools` reader, which prints the encoding list straight from the footer without your own metadata code in the loop.

```bash
parquet-tools inspect /tmp/probe_dict.parquet | grep -E 'path_in_schema|encodings'
```

Expected output — categorical columns must list `RLE_DICTIONARY`; the identifier column must show it fell back to `PLAIN`:

```text
path_in_schema: land_use_code
encodings:      ['PLAIN', 'RLE', 'RLE_DICTIONARY']
path_in_schema: admin_name
encodings:      ['PLAIN', 'RLE', 'RLE_DICTIONARY']
path_in_schema: parcel_uid
encodings:      ['PLAIN']
```

The `PLAIN` that appears alongside `RLE_DICTIONARY` is the dictionary page's own encoding, not a fallback — presence of `RLE_DICTIONARY` in the list is the signal that data pages were dictionary-encoded. A column showing only `PLAIN` was never dictionary-encoded at all. Cross-check the ratios against the [Apache Parquet encodings specification](https://parquet.apache.org/docs/file-format/data-pages/encodings/) so the numbers you report map to documented behavior.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Column forced on still reports `PLAIN` only | Dictionary exceeded `dictionary_pagesize_limit` and the writer fell back for the whole chunk | Raise the limit or accept PLAIN; see the page-size configuration guide |
| Ratio ≈ 1.0 on a text column you expected to shrink | High real cardinality (free-text or per-feature identifiers), not categorical | Leave PLAIN; dictionary indices are as wide as the values |
| Ratio worse when measured on full archive than on sample | Cardinality grows with scale — codes concatenated with region suffixes | Split the composite column or measure on a full-scale sample, not `head()` |
| Dictionary size larger than PLAIN | Values shorter than the index width (e.g. single-char flags) | Encode as a narrow native type instead of dictionary-encoding strings |

## Operational Execution Checklist

- [ ] Take a row-group-scale representative sample, not `head(1000)`, so probe cardinalities match production.
- [ ] Write both a `use_dictionary=True` and a `use_dictionary=False` probe with `compression="none"` to isolate encoding from codec.
- [ ] Read `total_uncompressed_size` and the encoding list per column chunk from the Parquet footer.
- [ ] Compute per-column encoded-to-plain ratio and pair it with an `approx_count_distinct` cardinality.
- [ ] Flag any column that reports only `PLAIN` despite being forced on as a dictionary-page fallback.
- [ ] Mark columns with ratio ≥ 1.0 as leave-PLAIN and record the decision in the archive schema doc.
- [ ] Re-run the measurement whenever attribute schemas or value distributions change materially.

## Related

- Up: [Dictionary Encoding for GIS Attributes](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/dictionary-encoding-for-gis-attributes/) — the parent reference for choosing and configuring dictionary encoding on spatial attribute tables.
- [Configuring Parquet Dictionary Page Size for Spatial Attributes](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/dictionary-encoding-for-gis-attributes/configuring-parquet-dictionary-page-size-for-spatial-attributes/) — the sibling procedure for stopping high-cardinality columns from silently falling back to PLAIN.
- [When to Use Dictionary Encoding for Categorical GIS Fields](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/dictionary-encoding-for-gis-attributes/when-to-use-dictionary-encoding-for-categorical-gis-fields/) — the qualitative decision rules that the ratios here make quantitative.
- [Converting Legacy Shapefiles to GeoParquet at Scale](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/geoparquet-migration-workflows/converting-legacy-shapefiles-to-geoparquet-at-scale/) — the conversion pipeline that produces the columnar attribute tables you are measuring.
- [Spatial Archive Cost Modeling](https://www.spatialdataarchival.org/spatial-archive-cost-modeling/) — translating the measured byte savings into stored-gigabyte cost across tiers.

_Part of the [Spatial Data Archival](https://www.spatialdataarchival.org/) knowledge base._
