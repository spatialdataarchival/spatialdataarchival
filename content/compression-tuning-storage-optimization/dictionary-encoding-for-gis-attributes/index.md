# Dictionary Encoding for GIS Attributes

Geospatial pipelines routinely ingest high-frequency categorical metadata — jurisdiction codes, land-use classifications, sensor identifiers, and regulatory compliance flags. Stored as raw UTF-8 strings across tens of millions of features, these attributes inflate storage footprints, throttle cold-tier I/O throughput, and complicate archival retention. Dictionary encoding resolves this by mapping each unique string value to a compact integer index, materializing the mapping once per column segment and referencing it repeatedly. Within the [Compression Tuning & Storage Optimization](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/) architecture, it is the foundational entropy-reduction layer for columnar spatial formats — particularly GeoParquet and Arrow-backed pipelines — and the cheapest single change that improves cold-storage density before any page-level codec runs.

## The Failure Mode: String Bloat and Silent Fallback

Two distinct failures motivate this technique. The first is obvious: a `land_use_code` column carrying 40 distinct CORINE values repeated across 50 million parcels stores roughly the same handful of strings 50 million times. Plain UTF-8 storage burns bytes proportional to row count and string length, and the resulting high-entropy pages resist even aggressive Zstandard match-finding. The second failure is subtler and more dangerous in archival workloads: applying dictionary encoding indiscriminately. When a writer dictionary-encodes a high-cardinality field — unique parcel IDs, free-text survey remarks, microsecond timestamps — the dictionary page grows until the engine hits its dictionary size ceiling, silently falls back to plain encoding mid-row-group, and leaves you paying for a populated dictionary page that buys nothing while inflating decode latency on read.

The cost surfaces during cold-to-hot promotion. A dataset that dictionary-encoded cleanly at write time can fall back inconsistently across row groups if cardinality drifts between partitions, producing mixed-encoding files that defeat predicate pushdown and balloon egress when an analyst scans them. The objective of this page is a deterministic, audited encoding decision per column — never an engine default left to chance.

## Prerequisite Context

This technique assumes you have already converted source data out of Shapefile or GeoPackage and into a columnar format; if you have not, run the [GeoParquet Migration Workflows](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/geoparquet-migration-workflows/) pipeline first, because dictionary encoding is a column-chunk property that only exists in Parquet-family layouts. You should also have a working object-storage tiering scheme — the [Hot/Warm/Cold Tier Design for Geospatial Data](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/hotwarmcold-tier-design-for-geospatial-data/) model — so that encoding decisions can be matched to retrieval frequency. Dictionary encoding sits one level below the parent [Compression Tuning & Storage Optimization](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/) strategy: it reduces entropy so that downstream [ZSTD Level Configuration for Spatial Files](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/zstd-level-configuration-for-spatial-files/) has low-entropy integer arrays to compress rather than raw text. Finally, schema stability matters — if attribute taxonomies are still churning, stabilize them through [Schema Mapping & Attribute Validation](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/schema-mapping-attribute-validation/) before committing dictionary mappings to immutable cold storage.

## When Dictionary Encoding Pays Off

Dictionary encoding helps low-cardinality categorical fields but backfires as cardinality or null rates climb:

<svg viewBox="0 0 720 500" role="img" aria-label="Decision tree for dictionary encoding a categorical GIS field. If the field is low cardinality and not high null rate, dictionary encode it for smaller pages and fast equality scans. If it is high cardinality, or low cardinality but high null rate, fall back to plain encoding plus ZSTD." xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;color:var(--primary);font-family:var(--font-sans)">
  <title>When to dictionary-encode a categorical GIS field</title>
  <desc>A top-down decision tree. Start at a categorical GIS field. First test low cardinality: if no, use plain encoding plus ZSTD. If yes, test high null rate: if yes, use plain encoding plus ZSTD; if no, dictionary encode, which yields smaller pages and fast equality scans.</desc>
  <defs>
    <marker id="de-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <g font-size="13" font-weight="600" text-anchor="middle">
    <!-- A: start -->
    <rect x="140" y="18" width="200" height="44" rx="10" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-opacity="0.35"/>
    <text x="240" y="45" fill="currentColor">Categorical GIS field</text>
    <!-- B: low cardinality? -->
    <polygon points="140,130 240,88 340,130 240,172" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-opacity="0.4"/>
    <text x="240" y="134" fill="currentColor">Low cardinality?</text>
    <!-- P: plain encoding outcome -->
    <rect x="460" y="108" width="200" height="44" rx="10" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-opacity="0.35"/>
    <text x="560" y="135" fill="currentColor">Plain encoding + ZSTD</text>
    <!-- C: high null rate? -->
    <polygon points="140,250 240,208 340,250 240,292" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-opacity="0.4"/>
    <text x="240" y="254" fill="currentColor">High null rate?</text>
    <!-- D: dictionary encode -->
    <rect x="140" y="338" width="200" height="44" rx="10" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-opacity="0.35"/>
    <text x="240" y="365" fill="currentColor">Dictionary encode</text>
    <!-- G: positive outcome -->
    <rect x="118" y="428" width="244" height="56" rx="10" fill="currentColor" fill-opacity="0.12" stroke="currentColor" stroke-opacity="0.6"/>
    <text x="240" y="451" fill="currentColor">Smaller pages,</text>
    <text x="240" y="471" fill="currentColor">fast equality scans</text>
  </g>
  <g stroke="currentColor" stroke-width="2" stroke-opacity="0.55" fill="none">
    <path d="M240 62 V84" marker-end="url(#de-arrow)"/>
    <path d="M240 172 V204" marker-end="url(#de-arrow)"/>
    <path d="M340 130 H456" marker-end="url(#de-arrow)"/>
    <path d="M240 292 V334" marker-end="url(#de-arrow)"/>
    <path d="M340 250 H560 V156" marker-end="url(#de-arrow)"/>
    <path d="M240 382 V424" marker-end="url(#de-arrow)"/>
  </g>
  <g font-size="12" font-weight="600" fill="currentColor" fill-opacity="0.85" text-anchor="middle">
    <text x="262" y="194">Yes</text>
    <text x="398" y="120">No</text>
    <text x="262" y="316">No</text>
    <text x="452" y="242">Yes</text>
  </g>
</svg>

## Concept & Design Decisions

Dictionary encoding operates at the **column-chunk level** in Parquet-family formats. Every row group holds an independent dictionary page per encoded column, so encoding efficiency is tightly coupled to how you partition and size chunks — a point that directly couples this decision to [Row Group Sizing Strategies](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/row-group-sizing-strategies/). The encoded values resolve to the `RLE_DICTIONARY` encoding in the column-chunk metadata, where dictionary indices are run-length and bit-pack encoded; this is why a near-constant `admin_level` column collapses to a few bytes per page.

The governing parameter is **cardinality ratio** — distinct values divided by the row count inside a single row group. Use these thresholds as defaults and tune against measured page sizes:

- **Ratio below ~1%** (e.g. CRS EPSG codes, land-use classes, sensor model IDs): always dictionary encode. Indices are tiny and equality predicates (`WHERE land_use_code = 'A21'`) become integer comparisons.
- **Ratio 1–15%** (e.g. municipality names, acquisition platform tags): dictionary encode only when the field is queried with equality or `IN` filters; otherwise the dictionary page overhead may exceed the savings.
- **Ratio above ~15%** (e.g. parcel IDs, vertex-level timestamps, free text): bypass dictionary encoding and let the page codec handle it. Forcing a dictionary here triggers fallback and wastes a populated page.

Null handling is a second axis. Parquet stores nulls in a separate definition-level stream, so a column that is 95% null carries almost no dictionary indices regardless of the non-null cardinality — but if the non-null subset is itself high-cardinality, the small populated portion still bloats the dictionary. Score both `null_rate` and non-null cardinality, not cardinality alone.

The final design choice is **segment alignment**. Because dictionaries are per row group, align row-group boundaries with natural spatial or temporal partitions so that categorical values stay homogeneous within a segment. Partitioning by administrative boundary or acquisition date concentrates identical jurisdiction codes and sensor IDs into contiguous blocks, shrinking the per-segment dictionary and improving partition pruning. Misalignment forces the same value into many adjacent dictionaries, multiplying overhead — the inverse of the gain you are chasing.

<svg viewBox="0 0 1080 470" role="img" aria-label="Side-by-side comparison of a 50-million-row land_use_code column. On the left, plain UTF-8 stores the full string in every row, producing high-entropy pages that ZSTD compresses only modestly. On the right, dictionary encoding stores 40 distinct strings once in a dictionary page and replaces each row with a small integer index, producing low-entropy arrays that ZSTD compresses by 70 to 85 percent." xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;color:var(--primary);font-family:var(--font-sans)">
  <title>Plain UTF-8 column vs dictionary-encoded column</title>
  <desc>Left panel: a land_use_code column where every one of 50 million rows stores the full UTF-8 string, yielding high-entropy pages and only a modest ZSTD gain. Right panel: the same column stored once as a 40-entry dictionary page plus an RLE_DICTIONARY array of small integer indices, yielding low-entropy data and a 70 to 85 percent ZSTD reduction.</desc>
  <defs>
    <marker id="dc-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <!-- ===== LEFT: plain UTF-8 ===== -->
  <rect x="20" y="20" width="480" height="430" rx="12" fill="currentColor" fill-opacity="0.03" stroke="currentColor" stroke-opacity="0.3"/>
  <text x="40" y="50" font-size="15" font-weight="700" fill="currentColor">Plain UTF-8 column page</text>
  <text x="40" y="72" font-size="12.5" fill="currentColor" fill-opacity="0.8"><tspan font-family="var(--font-mono)">land_use_code</tspan> &#183; 50M rows</text>
  <g font-size="13" font-weight="600" font-family="var(--font-mono)" text-anchor="middle">
    <rect x="60" y="90" width="130" height="30" rx="6" fill="currentColor" fill-opacity="0.07" stroke="currentColor" stroke-opacity="0.3"/><text x="125" y="110" fill="currentColor">"A21"</text>
    <rect x="60" y="128" width="130" height="30" rx="6" fill="currentColor" fill-opacity="0.07" stroke="currentColor" stroke-opacity="0.3"/><text x="125" y="148" fill="currentColor">"B14"</text>
    <rect x="60" y="166" width="130" height="30" rx="6" fill="currentColor" fill-opacity="0.07" stroke="currentColor" stroke-opacity="0.3"/><text x="125" y="186" fill="currentColor">"A21"</text>
    <rect x="60" y="204" width="130" height="30" rx="6" fill="currentColor" fill-opacity="0.07" stroke="currentColor" stroke-opacity="0.3"/><text x="125" y="224" fill="currentColor">"C03"</text>
    <rect x="60" y="242" width="130" height="30" rx="6" fill="currentColor" fill-opacity="0.07" stroke="currentColor" stroke-opacity="0.3"/><text x="125" y="262" fill="currentColor">"A21"</text>
  </g>
  <text x="125" y="296" font-size="12" text-anchor="middle" fill="currentColor" fill-opacity="0.7">&#8230; 50M strings</text>
  <g font-size="12.5" fill="currentColor" fill-opacity="0.85">
    <text x="220" y="150">Full string</text>
    <text x="220" y="168">stored verbatim</text>
    <text x="220" y="186">in every row.</text>
    <text x="220" y="224">High-entropy</text>
    <text x="220" y="242">pages resist</text>
    <text x="220" y="260">match-finding.</text>
  </g>
  <rect x="40" y="370" width="440" height="56" rx="10" fill="currentColor" fill-opacity="0.06" stroke="currentColor" stroke-opacity="0.4"/>
  <text x="260" y="394" font-size="13" font-weight="700" text-anchor="middle" fill="currentColor">ZSTD</text>
  <text x="260" y="414" font-size="12" text-anchor="middle" fill="currentColor" fill-opacity="0.85">few long matches &#8594; modest gain</text>
  <path d="M125 326 V366" stroke="currentColor" stroke-width="2" stroke-opacity="0.55" fill="none" marker-end="url(#dc-arrow)"/>
  <!-- ===== RIGHT: dictionary encoded ===== -->
  <rect x="580" y="20" width="480" height="430" rx="12" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-opacity="0.45"/>
  <text x="600" y="50" font-size="15" font-weight="700" fill="currentColor">Dictionary-encoded column</text>
  <text x="600" y="72" font-size="12.5" fill="currentColor" fill-opacity="0.8">encoding = <tspan font-family="var(--font-mono)">RLE_DICTIONARY</tspan></text>
  <!-- dictionary page -->
  <rect x="600" y="88" width="200" height="148" rx="10" fill="currentColor" fill-opacity="0.04" stroke="currentColor" stroke-opacity="0.4"/>
  <text x="700" y="108" font-size="12.5" font-weight="700" text-anchor="middle" fill="currentColor">Dictionary page</text>
  <g font-size="12.5" font-weight="600" font-family="var(--font-mono)" text-anchor="middle" fill="currentColor">
    <text x="700" y="132">0 &#8594; "A21"</text>
    <text x="700" y="154">1 &#8594; "B14"</text>
    <text x="700" y="176">2 &#8594; "C03"</text>
  </g>
  <text x="700" y="200" font-size="11.5" text-anchor="middle" fill="currentColor" fill-opacity="0.75">&#8230; 40 entries</text>
  <text x="700" y="220" font-size="11.5" text-anchor="middle" fill="currentColor" fill-opacity="0.75">stored once</text>
  <!-- index array -->
  <text x="830" y="108" font-size="12.5" font-weight="700" text-anchor="middle" fill="currentColor">Index array</text>
  <g font-size="13" font-weight="700" font-family="var(--font-mono)" text-anchor="middle">
    <rect x="820" y="120" width="36" height="32" rx="6" fill="currentColor" fill-opacity="0.1" stroke="currentColor" stroke-opacity="0.35"/><text x="838" y="141" fill="currentColor">0</text>
    <rect x="862" y="120" width="36" height="32" rx="6" fill="currentColor" fill-opacity="0.1" stroke="currentColor" stroke-opacity="0.35"/><text x="880" y="141" fill="currentColor">1</text>
    <rect x="904" y="120" width="36" height="32" rx="6" fill="currentColor" fill-opacity="0.1" stroke="currentColor" stroke-opacity="0.35"/><text x="922" y="141" fill="currentColor">0</text>
    <rect x="946" y="120" width="36" height="32" rx="6" fill="currentColor" fill-opacity="0.1" stroke="currentColor" stroke-opacity="0.35"/><text x="964" y="141" fill="currentColor">2</text>
    <rect x="988" y="120" width="36" height="32" rx="6" fill="currentColor" fill-opacity="0.1" stroke="currentColor" stroke-opacity="0.35"/><text x="1006" y="141" fill="currentColor">0</text>
  </g>
  <text x="922" y="178" font-size="12" text-anchor="middle" fill="currentColor" fill-opacity="0.8">small ints, RLE + bit-packed</text>
  <text x="922" y="210" font-size="12" text-anchor="middle" fill="currentColor" fill-opacity="0.85">one index per row,</text>
  <text x="922" y="228" font-size="12" text-anchor="middle" fill="currentColor" fill-opacity="0.85">not one string</text>
  <!-- ZSTD bar -->
  <rect x="600" y="370" width="440" height="56" rx="10" fill="currentColor" fill-opacity="0.14" stroke="currentColor" stroke-opacity="0.6"/>
  <text x="820" y="394" font-size="13" font-weight="700" text-anchor="middle" fill="currentColor">ZSTD</text>
  <text x="820" y="414" font-size="12" text-anchor="middle" fill="currentColor" fill-opacity="0.9">low-entropy ints &#8594; &#8722;70 to &#8722;85% vs plain</text>
  <path d="M700 236 V300 H820 V366" stroke="currentColor" stroke-width="2" stroke-opacity="0.55" fill="none"/>
  <path d="M922 244 V300 H820" stroke="currentColor" stroke-width="2" stroke-opacity="0.55" fill="none"/>
  <path d="M820 300 V366" stroke="currentColor" stroke-width="2" stroke-opacity="0.55" fill="none" marker-end="url(#dc-arrow)"/>
  <text x="820" y="330" font-size="11.5" text-anchor="middle" fill="currentColor" fill-opacity="0.7">dictionary + indices</text>
</svg>

## Implementation

Pin dictionary encoding explicitly at the writer layer for every engine in the pipeline. Engine defaults differ and silently override implicit settings, producing inconsistent archival footprints across jobs.

**PyArrow / GeoParquet writer** — enable globally, or pass an explicit column list so high-cardinality fields are never accidentally encoded:

```python
import pyarrow as pa
import pyarrow.parquet as pq

# Cast low-cardinality columns to dictionary type so encoding is deterministic,
# not left to the writer's heuristic dictionary-size cutoff.
table = table.set_column(
    table.schema.get_field_index("land_use_code"),
    "land_use_code",
    table.column("land_use_code").dictionary_encode(),
)

pq.write_table(
    table,
    "s3://gis-cold-archive/parcels/2024/region_north.parquet",
    compression="zstd",
    compression_level=11,
    use_dictionary=["land_use_code", "admin_level", "sensor_id"],  # explicit allow-list
    dictionary_pagesize_limit=1 << 20,   # 1 MiB cap; forces clean fallback, not silent bloat
    row_group_size=200_000,              # align with spatial partition granularity
    write_statistics=True,
)
```

**GDAL / OGR Parquet driver** — the driver enables dictionary encoding by default; pin row-group size and codec so the archival footprint is reproducible:

```bash
ogr2ogr \
  -f Parquet \
  /vsis3/gis-cold-archive/parcels/2024/region_north.parquet \
  datasets/vector/parcels_region_north.gpkg \
  -lco COMPRESSION=ZSTD \
  -lco COMPRESSION_LEVEL=11 \
  -lco ROW_GROUP_SIZE=200000
```

**Apache Spark / Delta Lake** — disable the dictionary fallback so a cardinality breach raises rather than silently degrading to plain encoding; this is the configuration that makes compliance audits meaningful:

```python
spark.conf.set("spark.sql.parquet.dictionary.enabled", "true")
# Force explicit handling of cardinality breaches instead of silent plain-encoding:
spark.conf.set("spark.sql.parquet.dictionary.fallback.enabled", "false")
# Keep Arrow vectorized serialization so dictionary structures survive the write path:
spark.conf.set("spark.sql.execution.arrow.pyspark.enabled", "true")

(df.repartition("admin_boundary")              # cluster identical jurisdiction codes
   .write
   .option("compression", "zstd")
   .option("parquet.compression.codec.zstd.level", "11")
   .mode("overwrite")
   .parquet("s3://gis-cold-archive/parcels/2024/"))
```

**Polars / Dask** — pre-cast categorical columns so serialization is dictionary-aware and avoids runtime type coercion:

```python
import polars as pl

df = pl.scan_parquet("datasets/vector/parcels_staging/*.parquet").with_columns(
    pl.col("land_use_code").cast(pl.Categorical),
    pl.col("sensor_id").cast(pl.Categorical),
)
df.sink_parquet(
    "datasets/vector/parcels_encoded.parquet",
    compression="zstd",
    compression_level=11,
    row_group_size=200_000,
)
```

## Validation Gate

Never trust the writer's intent — verify the encoding actually landed in the file metadata before promoting to cold storage. Inspect the column-chunk encodings and confirm they resolve to `RLE_DICTIONARY`:

```bash
parquet-tools inspect \
  /vsis3/gis-cold-archive/parcels/2024/region_north.parquet \
  | grep -A2 -E 'land_use_code|admin_level|sensor_id'
```

Expected output for a correctly encoded column:

```
column: land_use_code
  encodings: RLE_DICTIONARY, PLAIN, RLE
  compression: ZSTD
```

A scripted gate over PyArrow metadata makes this enforceable in CI:

```python
import pyarrow.parquet as pq

meta = pq.read_metadata("s3://gis-cold-archive/parcels/2024/region_north.parquet")
for rg in range(meta.num_row_groups):
    col = meta.row_group(rg).column(
        meta.schema.names.index("land_use_code"))
    assert "RLE_DICTIONARY" in col.encodings, \
        f"row group {rg}: dictionary fallback occurred — cardinality breach"
print("all row groups dictionary-encoded")
```

**Most common failure:** the column reports only `PLAIN` encoding despite `use_dictionary` being set. Root cause is almost always a cardinality breach — the distinct-value count exceeded the writer's `dictionary_pagesize_limit` inside that row group, so it fell back to plain encoding for the remainder. Confirm by running a distinct count per row group; if the ratio exceeds ~15%, the field does not belong in the dictionary allow-list. The second most common cause is row groups sized far larger than the spatial partition, which sweeps heterogeneous categorical values into one segment and inflates the distinct count past the limit — re-align row-group size to the partition before blaming the data.

## Cost & Performance Trade-offs

The decision is a three-way trade between storage footprint, write CPU, and decode latency. Indicative figures for a 50-million-row vector archive, ZSTD level 11, 200k-row groups:

| Field profile | Cardinality ratio | Encoding choice | Storage vs plain | Decode latency / 10k rows | Notes |
|---------------|-------------------|-----------------|------------------|---------------------------|-------|
| `land_use_code` (40 values) | <0.01% | Dictionary | -70 to -85% | <40 ms | Ideal; fast equality scans |
| `admin_level` (12 values) | <0.01% | Dictionary | -75% | <40 ms | Near-constant per partition |
| `municipality` (8k values) | ~3% | Dictionary (if filtered) | -30 to -45% | ~80 ms | Worth it only with equality/IN predicates |
| `acquisition_ts` (per-second) | ~12% | Dictionary, conditional | -5 to -15% | ~150 ms | Marginal; consider delta encoding instead |
| `parcel_id` (unique) | 100% | Plain + ZSTD | 0% (or worse) | >200 ms if forced | Never dictionary; triggers fallback |
| `survey_remarks` (free text) | ~90% | Plain + ZSTD | negative if forced | >250 ms if forced | Dictionary page bloat, no gain |

The asymmetry to internalize: dictionary encoding's write-CPU cost is modest (a hash-table build per segment), but a *wrong* encoding decision on a high-cardinality column costs on both ends — a wasted dictionary page at write and elevated decode latency at every read for the archive's entire retention life. In cold tiers where data may sit for years and be scanned rarely, that read penalty is paid precisely when egress is most expensive.

## Failure Modes & Edge Cases

- **Cross-segment dictionary duplication.** Oversized row groups dilute encoding efficiency; undersized groups multiply the per-segment dictionary. Both inflate cold-tier CPU during retrieval and raise egress cost. Align boundaries to spatial/temporal partitions and verify with a metadata scan before promotion — this is the single most impactful tuning lever and is shared with [Row Group Sizing Strategies](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/row-group-sizing-strategies/).
- **Taxonomy revision breaks forward joins.** When a land-use or jurisdiction taxonomy is revised (codes deprecated, merged, or renumbered), a new dictionary mapping is materialized but historical archives keep the old one. Without a versioned mapping registry, joins across vintages silently mismatch. Maintain an immutable, versioned dictionary registry alongside spatial extents and enforce schema-evolution checks.
- **Corrupted dictionary page invalidates the whole row group.** A dictionary page is the decode key for every index in its segment; a single corrupted page during a tier transition zeroes out the entire row group and surfaces as a data-loss event on cold-to-hot promotion. Write CRC32 or xxHash checksums on dictionary pages at archival time and verify on retrieval. This keeps categorical provenance auditable across multi-year lifecycles, satisfying INSPIRE and FGDC metadata retention expectations.
- **High null rate masking high cardinality.** A column that is 95% null can pass a naive cardinality gate (few non-null distinct values relative to total rows) while its small populated subset is itself high-cardinality, bloating the dictionary on the rows that exist. Score `null_rate` and non-null distinct count separately.

## Operational Execution Checklist

- [ ] Profile each categorical column for distinct-value ratio **and** null rate per row group, not over the whole file.
- [ ] Build an explicit dictionary allow-list; never rely on the writer's implicit heuristic for archival data.
- [ ] Cap `dictionary_pagesize_limit` so cardinality breaches fall back cleanly instead of silently mid-segment.
- [ ] Align row-group boundaries with spatial/temporal partitions to keep categorical values homogeneous.
- [ ] Assert `RLE_DICTIONARY` in column-chunk metadata in CI before any cold-tier promotion.
- [ ] Pair encoding with an appropriate [ZSTD level](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/zstd-level-configuration-for-spatial-files/) (3–5 for active tiers, 10+ for static archive).
- [ ] Checksum dictionary pages on write and verify on retrieval across tier transitions.
- [ ] Version every dictionary mapping in an immutable registry alongside spatial extents.

## Related

- [When to Use Dictionary Encoding for Categorical GIS Fields](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/dictionary-encoding-for-gis-attributes/when-to-use-dictionary-encoding-for-categorical-gis-fields/) — the precise cardinality thresholds, field-selection criteria, and fallback mitigation behind the decision above.
- [ZSTD Level Configuration for Spatial Files](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/zstd-level-configuration-for-spatial-files/) — the page-level codec that compresses the low-entropy integer arrays dictionary encoding produces.
- [Row Group Sizing Strategies](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/row-group-sizing-strategies/) — segment sizing governs per-row-group dictionary overhead and partition pruning.
- [GeoParquet Migration Workflows](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/geoparquet-migration-workflows/) — the companion conversion step that produces the columnar files dictionary encoding operates on.
- Up one level: [Compression Tuning & Storage Optimization](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/) — the parent strategy coordinating encoding, compression, partitioning, and indexing.
