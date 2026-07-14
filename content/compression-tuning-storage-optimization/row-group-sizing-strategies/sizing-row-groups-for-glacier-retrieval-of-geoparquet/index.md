# Sizing Row Groups for Glacier Retrieval of GeoParquet

Cold GeoParquet archives in Glacier and Deep Archive invert the usual row-group logic: the goal is no longer fast query pruning but minimizing restore cost and partial-read amplification when an object must be rehydrated to be read at all. This guide is for cloud architects and GIS archivists aligning row-group and file size with the retrieval economics of archive-class storage. Default columnar writers optimize for warm-tier predicate pushdown and produce thousands of small row groups; in Glacier that layout multiplies per-object restore fees and forces whole-file rehydration to reach a single column. The procedure below sizes row groups and files against restore-request pricing and range-read granularity so a cold spatial archive stays cheap to hold and predictable to retrieve, operating under the [Compression Tuning & Storage Optimization](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/) framework and complementing the query-side analysis in [Benchmarking Row-Group Size Against Spatial Predicate Pushdown](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/row-group-sizing-strategies/benchmarking-row-group-size-against-spatial-predicate-pushdown/).

## Why Cold Retrieval Rewrites the Sizing Rule

In a warm tier, a Parquet reader issues HTTP range requests to fetch only the row groups and column chunks a query needs, so small row groups improve pruning. Archive tiers break that model in two ways. First, a `GLACIER` or `DEEP_ARCHIVE` object is not directly readable — it must be restored in full to a temporary staging copy before any byte, let alone a range, can be read. Restore is billed per object retrieved and per gigabyte, so a dataset fragmented into thousands of tiny files pays thousands of restore requests to reconstruct one region. Second, once restored, the read amplification of a bad row-group layout is paid again on the staged copy: to read three columns of one region you may drag in whole row groups whose other columns you discard.

The sizing rule therefore flips. You want **files large enough** that restore-request count stays low, but **row groups inside them coarse enough** that reading one region's worth of data does not require touching every group — while still fine enough that a restored range read fetches mostly wanted bytes. The sweet spot balances restore-request economics against post-restore read amplification, and it depends on the archive tier's minimum object size and per-request price, not on query latency. Choosing that tier up front is itself an [Object Storage Selection for GIS Archives](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/object-storage-selection-for-gis-archives/) decision.

<svg viewBox="0 0 840 260" role="img" aria-label="Retrieval economics matrix comparing three GeoParquet file and row-group layouts for Glacier restore. Many tiny files at 8 megabytes each with 50 thousand row groups: restore requests very high, read amplification low, footer overhead high, verdict costly to restore. Medium files at 512 megabytes with a 32 megabyte row group: restore requests moderate, read amplification moderate, footer overhead low, verdict balanced and recommended. Few large files at 4 gigabytes with a 128 megabyte row group: restore requests low, read amplification high because a wide row group drags unwanted columns, footer overhead very low, verdict cheap to restore but wasteful to read." xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;color:var(--primary);font-family:var(--font-sans)">
  <title>Glacier retrieval economics across GeoParquet layouts</title>
  <desc>A three-row matrix comparing tiny-file, medium-file, and large-file GeoParquet layouts across restore-request count, post-restore read amplification, footer overhead, and an overall verdict. The medium layout with a 32-megabyte row group inside 512-megabyte files is recommended as the balance between restore cost and read waste.</desc>
  <rect x="10" y="10" width="820" height="34" fill="currentColor" fill-opacity="0.07"/>
  <rect x="10" y="10" width="820" height="238" fill="none" stroke="currentColor" stroke-opacity="0.5" stroke-width="1.2"/>
  <line x1="230" y1="10" x2="230" y2="248" stroke="currentColor" stroke-opacity="0.3"/>
  <line x1="380" y1="10" x2="380" y2="248" stroke="currentColor" stroke-opacity="0.3"/>
  <line x1="530" y1="10" x2="530" y2="248" stroke="currentColor" stroke-opacity="0.3"/>
  <line x1="650" y1="10" x2="650" y2="248" stroke="currentColor" stroke-opacity="0.3"/>
  <line x1="10" y1="44" x2="830" y2="44" stroke="currentColor" stroke-opacity="0.3"/>
  <line x1="10" y1="112" x2="830" y2="112" stroke="currentColor" stroke-opacity="0.3"/>
  <line x1="10" y1="180" x2="830" y2="180" stroke="currentColor" stroke-opacity="0.3"/>
  <g font-size="10.5" font-weight="700" fill="currentColor">
    <text x="20" y="31">Layout</text>
    <text x="240" y="31">Restore reqs</text>
    <text x="390" y="31">Read amp.</text>
    <text x="540" y="31">Footer</text>
    <text x="660" y="31">Verdict</text>
  </g>
  <g font-size="10.5" fill="currentColor">
    <text x="20" y="76" font-weight="600">Tiny files</text>
    <text x="20" y="92" fill-opacity="0.7" font-size="9.5">8 MB &#183; 50k groups</text>
    <text x="240" y="84" font-weight="700">very high</text>
    <text x="390" y="84">low</text>
    <text x="540" y="84">high</text>
    <text x="660" y="84">costly restore</text>
    <text x="20" y="144" font-weight="600">Medium files</text>
    <text x="20" y="160" fill-opacity="0.7" font-size="9.5">512 MB &#183; 32 MB group</text>
    <text x="240" y="152">moderate</text>
    <text x="390" y="152">moderate</text>
    <text x="540" y="152">low</text>
    <text x="660" y="152" font-weight="700">balanced &#8592; pick</text>
    <text x="20" y="212" font-weight="600">Large files</text>
    <text x="20" y="228" fill-opacity="0.7" font-size="9.5">4 GB &#183; 128 MB group</text>
    <text x="240" y="220">low</text>
    <text x="390" y="220" font-weight="700">high</text>
    <text x="540" y="220">very low</text>
    <text x="660" y="220">wasteful read</text>
  </g>
</svg>

## Step-by-Step Sizing Procedure

### 1. Derive the target file size from restore-request economics

Start from the tier's per-request restore price and your acceptable restore cost for a full-region rehydration. If a region holds 200 GB and restore requests dominate at small file sizes, target a file size that keeps the object count in the low thousands, not the hundreds of thousands.

```python
region_bytes   = 200 * 1024**3          # 200 GB region
per_request_usd = 0.05 / 1000           # illustrative per-object restore request price
budget_usd      = 2.00                  # acceptable restore-request spend per region

max_objects   = budget_usd / per_request_usd            # ~40,000 objects allowed
min_file_size = region_bytes / max_objects              # bytes/object floor
print(f"floor file size ~ {min_file_size/1024**2:.0f} MB")  # ~ 5 MB floor from requests alone
# but read-amplification and footer overhead push the practical target far higher:
target_file = 512 * 1024**2             # 512 MB balances requests, amplification, footer
```

Restore-request cost sets only a floor; read amplification and footer overhead pull the practical target up to hundreds of megabytes per file. Pair this with the tier's minimum-object-size and early-deletion rules, since a too-small file also trips [Hot/Warm/Cold Tier Design for Geospatial Data](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/hotwarmcold-tier-design-for-geospatial-data/) minimum-billing penalties.

### 2. Write coarse row groups sized to the restored range read

Inside those files, size row groups so one restored range read pulls a useful, self-contained slice — coarse enough to keep the footer small, fine enough that a single region's read does not amplify across the whole file.

```python
import pyarrow.parquet as pq
import pyarrow.dataset as ds

src = ds.dataset("s3://spatial-archive/lidar-derived/2019/", format="parquet").to_table()

pq.write_table(
    src,
    "s3://spatial-archive/cold/lidar-derived/2019/region_north.parquet",
    row_group_size=2_000_000,          # coarse: ~32 MB ZSTD groups, not sub-MB
    compression="zstd",
    compression_level=12,              # cold tier: spend CPU once, store forever
    data_page_size=2 * 1024 * 1024,
    write_statistics=True,
    write_page_index=True,             # keeps range reads precise on the restored copy
)
```

The high `compression_level` is appropriate here because a cold archive is written once and held for years; the entropy-versus-CPU trade-off is worked through in [Tuning ZSTD Compression for GeoParquet Archives](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/zstd-level-configuration-for-spatial-files/tuning-zstd-compression-for-geoparquet-archives/). `write_page_index=True` matters after restore: it lets a reader range-read within a coarse row group instead of scanning it whole.

### 3. Restore only the objects a region needs, then range-read

When a query arrives, restore the minimal object set for the target region before reading. Scope the restore by prefix so you never rehydrate the whole archive.

```bash
# Restore just the north-region cold objects for a bounded window
aws s3api restore-object \
  --bucket spatial-archive \
  --key cold/lidar-derived/2019/region_north.parquet \
  --restore-request '{"Days":3,"GlacierJobParameters":{"Tier":"Standard"}}'

# Poll until the object is readable, then range-read the wanted columns
aws s3api head-object --bucket spatial-archive \
  --key cold/lidar-derived/2019/region_north.parquet \
  --query 'Restore'
```

`Tier: Standard` restore trades cost for a few hours of latency, acceptable for archival access. Reference the [AWS S3 restore documentation](https://docs.aws.amazon.com/AmazonS3/latest/userguide/restoring-objects.html) for the exact retrieval-tier pricing and completion-time envelopes per storage class.

## Modeling the Restore-Versus-Read Trade-off

The three-layout matrix above compresses a genuine optimization that is worth making explicit before committing an archive to cold storage, because the layout is expensive to change once petabytes are transitioned. Two costs pull in opposite directions as file size changes. Restore-request cost falls as files grow, because rehydrating a region means retrieving fewer, larger objects and the per-request charge dominates at the small end — a region shattered into 8 MB files pays tens of thousands of restore requests where the same region in 512 MB files pays a few hundred. Read-amplification cost rises as files grow, because a coarse row group inside a very large file drags in every column of a wide swath of rows to satisfy a read that wanted three columns of one region, and there is no second range-read pass to recover after restore — you paid to stage the whole object.

The minimum of that combined curve is broad, not sharp, which is good news: any file size in the low hundreds of megabytes lands near-optimal for most archives, so precise tuning matters less than avoiding the extremes. The tiny-file extreme is the more expensive mistake in practice, because restore-request charges are billed per object with no relief, whereas read amplification on a moderately oversized file only wastes staged-copy bytes you were restoring anyway. When uncertain, err toward the larger file. The one hard floor underneath all of this is the tier's own minimum object size and minimum-duration billing: a file below the archive class's minimum bills as if it were that minimum, so sub-threshold files inflate cost on both the storage and the restore side simultaneously.

Row-group size then operates as a second-order correction inside whatever file size you choose. Coarser groups shrink the footer and reduce the number of statistics the reader decodes after restore; finer groups, paired with a written page index, let a post-restore range read fetch mostly wanted bytes and hold read amplification down. The page index is the detail that makes a coarse row group tolerable — without it, reading any part of a 128 MB group means scanning the whole group even on the restored copy. This is the lever that lets you keep files large for restore economics while keeping post-restore reads precise, and it is the reason cold-archive writes should always enable it. Feed the resulting restore-request and gigabyte-retrieval figures into your [Spatial Archive Cost Modeling](https://www.spatialdataarchival.org/spatial-archive-cost-modeling/) worksheet so the layout decision is defended by numbers, not intuition.

## Validation & Verification

Confirm the written layout matches the target: file size in the hundreds of megabytes and row groups in the tens of megabytes, not thousands of sub-megabyte groups.

```bash
duckdb -c "
  SELECT
    round(sum(total_compressed_size)/1024/1024, 1) AS file_mb,
    count(DISTINCT row_group_id)                    AS row_groups,
    round(avg(total_compressed_size)/1024/1024, 1)  AS avg_group_mb
  FROM parquet_metadata('region_north.parquet');
"
```

Expected output — a few dozen coarse groups inside a mid-size file, not thousands of tiny ones:

```text
┌─────────┬────────────┬──────────────┐
│ file_mb │ row_groups │ avg_group_mb │
│  512.4  │     16     │     32.0     │
└─────────┴────────────┴──────────────┘
```

`row_groups = 16` at `avg_group_mb = 32` confirms the coarse layout. If `row_groups` runs into the thousands, the writer ignored `row_group_size` because the input was already chunked — reconsolidate before archiving.

## Troubleshooting

- **Restore bill dominated by request count, not gigabytes.** The region is fragmented into thousands of small objects. Reconsolidate into larger files before transitioning to the archive class; the per-request charge scales with object count, not size.
- **Restore is cheap but reads drag whole files.** Row groups are too coarse for the query granularity, or the page index is missing. Rewrite with `write_page_index=True` and a moderate `row_group_size` so post-restore range reads stay precise.
- **Objects bounce out of the archive tier and re-bill minimum duration.** A lifecycle rule transitioned files below the tier's minimum object size or age. Align file size and transition timing with the tier's minimum-duration policy before enabling the rule.

## Operational Execution Checklist

- [ ] Derive a file-size floor from per-request restore price, then raise it for read amplification and footer overhead.
- [ ] Target hundreds of megabytes per file so restore-request count stays in the low thousands per region.
- [ ] Write coarse row groups (tens of megabytes) with `write_page_index=True` for precise post-restore range reads.
- [ ] Use a high ZSTD level appropriate to write-once, hold-for-years cold storage.
- [ ] Scope restore requests by region prefix; never rehydrate the whole archive for one query.
- [ ] Verify file size and row-group count with `parquet_metadata` before transitioning to the archive class.
- [ ] Check file size and transition timing against the tier's minimum-object-size and early-deletion rules.

## Related

- Up: [Row-Group Sizing Strategies](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/row-group-sizing-strategies/) — the parent reference balancing row-group size across query and retrieval goals.
- [Benchmarking Row-Group Size Against Spatial Predicate Pushdown](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/row-group-sizing-strategies/benchmarking-row-group-size-against-spatial-predicate-pushdown/) — the sibling guide sizing row groups for warm-tier query pruning rather than cold restore.
- [Calculating Optimal Row-Group Size for Spatial Queries](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/row-group-sizing-strategies/calculating-optimal-row-group-size-for-spatial-queries/) — the base analytical model this cold-tier procedure adapts for retrieval economics.
- [Object Storage Selection for GIS Archives](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/object-storage-selection-for-gis-archives/) — choosing the archive-class substrate whose restore pricing drives file size here.
- [Spatial Archive Cost Modeling](https://www.spatialdataarchival.org/spatial-archive-cost-modeling/) — the cost reference for modeling restore-request and gigabyte-retrieval spend against layout.

_Part of the [Spatial Data Archival](https://www.spatialdataarchival.org/) knowledge base._
