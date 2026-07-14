# Incremental GeoParquet Updates Without a Full Rewrite

Appending or upserting new features into a partitioned GeoParquet archive should touch only the partitions the change lands in — never rewrite the whole dataset. This guide is for data engineers maintaining a live spatial archive on cold storage, where a nightly delta of a few thousand updated parcels must not trigger a multi-terabyte rebuild that re-uploads unchanged partitions, re-pays cold-tier write costs, and blows past every early-deletion penalty. The naive path — read the entire archive into memory, merge the delta, rewrite everything — is exactly what partitioning exists to avoid. The correct path routes each incoming feature to its owning partition by spatial key, rewrites only affected partitions, compacts the small files those writes accumulate, and keeps the `geo` metadata and CRS byte-identical across old and new files so the archive still reads as one coherent dataset. It operates under the [Format Conversion & Pipeline Automation](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/) framework and extends the [GeoParquet Migration Workflows](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/geoparquet-migration-workflows/) reference into the maintenance phase that begins after the initial bulk load.

## The Incremental Update State Machine

An incremental update is not a single write; it is a small pipeline that resolves which partitions a delta touches, rewrites only those, and periodically compacts the fragments that appends leave behind. Modeling it as explicit states keeps a crash from leaving the archive in a torn condition.

<svg viewBox="0 0 880 250" role="img" aria-label="Incremental GeoParquet update state machine. A delta batch enters and is routed by H3 key to affected partitions. Each affected partition is either appended to as a new small file, or upserted by rewriting the single partition. Unaffected partitions are left untouched. A separate compaction state periodically merges the accumulated small files within a partition into one object, preserving the geo metadata. The archive returns to a queryable steady state." xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;color:var(--primary);font-family:var(--font-sans)">
  <title>Incremental update and compaction state machine</title>
  <desc>A delta batch is routed by spatial key to only the affected partitions, which are appended or upserted while unaffected partitions are untouched; a periodic compaction state merges accumulated small files within a partition into a single object, preserving the geo metadata, and returns the archive to a queryable steady state.</desc>
  <defs>
    <marker id="inc-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <g text-anchor="middle">
    <!-- delta -->
    <rect x="12" y="98" width="150" height="60" rx="10" fill="currentColor" fill-opacity="0.06" stroke="currentColor" stroke-opacity="0.5"/>
    <text x="87" y="124" font-size="12.5" font-weight="600" fill="currentColor">Delta batch</text>
    <text x="87" y="142" font-size="10" fill="currentColor" fill-opacity="0.75">new / changed features</text>
    <!-- route -->
    <rect x="212" y="98" width="150" height="60" rx="10" fill="currentColor" fill-opacity="0.06" stroke="currentColor" stroke-opacity="0.5"/>
    <text x="287" y="124" font-size="12.5" font-weight="600" fill="currentColor">Route by</text>
    <text x="287" y="142" font-size="12.5" font-weight="600" fill="currentColor">H3 key</text>
    <!-- append -->
    <rect x="412" y="24" width="176" height="58" rx="10" fill="currentColor" fill-opacity="0.08" stroke="currentColor" stroke-opacity="0.55"/>
    <text x="500" y="48" font-size="12" font-weight="600" fill="currentColor">Append</text>
    <text x="500" y="66" font-size="10" fill="currentColor" fill-opacity="0.75">new small file in partition</text>
    <!-- upsert -->
    <rect x="412" y="98" width="176" height="58" rx="10" fill="currentColor" fill-opacity="0.08" stroke="currentColor" stroke-opacity="0.55"/>
    <text x="500" y="122" font-size="12" font-weight="600" fill="currentColor">Upsert</text>
    <text x="500" y="140" font-size="10" fill="currentColor" fill-opacity="0.75">rewrite one partition</text>
    <!-- untouched -->
    <rect x="412" y="172" width="176" height="58" rx="10" fill="currentColor" fill-opacity="0.03" stroke="currentColor" stroke-opacity="0.32" stroke-dasharray="5 4"/>
    <text x="500" y="196" font-size="12" font-weight="600" fill="currentColor" fill-opacity="0.7">Untouched</text>
    <text x="500" y="214" font-size="10" fill="currentColor" fill-opacity="0.65">unaffected partitions</text>
    <!-- compaction (highlighted) -->
    <rect x="638" y="61" width="176" height="58" rx="10" fill="currentColor" fill-opacity="0.14" stroke="currentColor" stroke-opacity="0.7" stroke-width="1.5"/>
    <text x="726" y="85" font-size="12" font-weight="700" fill="currentColor">Compaction</text>
    <text x="726" y="103" font-size="10" fill="currentColor" fill-opacity="0.8">merge small files &#183; keep geo</text>
    <!-- steady state -->
    <rect x="638" y="135" width="176" height="58" rx="10" fill="currentColor" fill-opacity="0.06" stroke="currentColor" stroke-opacity="0.5"/>
    <text x="726" y="159" font-size="12" font-weight="600" fill="currentColor">Queryable</text>
    <text x="726" y="177" font-size="10" fill="currentColor" fill-opacity="0.75">steady state</text>
  </g>
  <g stroke="currentColor" stroke-width="1.8" fill="none" stroke-opacity="0.55">
    <path d="M162 128 H210" marker-end="url(#inc-arrow)"/>
    <path d="M362 118 C 388 96, 392 60, 410 53" marker-end="url(#inc-arrow)"/>
    <path d="M362 128 H410" marker-end="url(#inc-arrow)"/>
    <path d="M362 138 C 388 160, 392 196, 410 201" marker-end="url(#inc-arrow)" stroke-opacity="0.35"/>
    <path d="M588 53 C 616 60, 620 78, 636 84" marker-end="url(#inc-arrow)"/>
    <path d="M588 127 C 616 118, 620 100, 636 96" marker-end="url(#inc-arrow)"/>
    <path d="M726 119 V133" marker-end="url(#inc-arrow)"/>
  </g>
</svg>

The three properties that make this safe are: partition isolation (a write to `h3_cell=A` never opens `h3_cell=B`), metadata invariance (every new file carries the identical `geo` block and CRS), and atomic promotion (readers see either the old or the new partition, never a half-written mix).

## Routing a Delta to Its Affected Partitions

Resolve the target partition of every incoming feature exactly the way the archive was originally keyed — derive the H3 cell from the centroid in EPSG:4326 — so the delta lands in the same directory a full rebuild would place it. Group the delta by cell first, so each partition is opened once. This is the maintenance-time counterpart to [partitioning by H3 spatial index](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/geoparquet-migration-workflows/partitioning-geoparquet-by-h3-spatial-index/), and it must use the same pinned resolution recorded in the archive manifest.

```python
import h3
import geopandas

H3_RES = 4  # MUST match the resolution pinned when the archive was created

def affected_partitions(delta_path: str) -> dict:
    delta = geopandas.read_parquet(delta_path)
    c = delta.geometry.to_crs(4326).centroid
    delta["h3_cell"] = [h3.latlng_to_cell(p.y, p.x, H3_RES) for p in c]
    # One group per partition; only these directories will be touched.
    groups = {cell: part for cell, part in delta.groupby("h3_cell")}
    print(f"delta touches {len(groups)} of many partitions")
    return groups
```

For an append-only archive — new observations that never revise a prior feature — you can stop here and write each group as a fresh file in its partition. For an archive with corrections, you need upsert semantics, covered next.

## Append Versus Upsert Semantics

An **append** writes the delta group as an additional file inside the partition directory (`part-0007.parquet` alongside `part-0000.parquet`), leaving existing files untouched. It is the cheapest operation on cold storage because it uploads only new bytes, but it accumulates small files that compaction must later merge. An **upsert** replaces or updates existing features keyed by a stable feature ID; it must read the current partition, merge on the key, and rewrite that one partition atomically.

```python
import pyarrow.parquet as pq
import pyarrow as pa
import pandas as pd
import json, os, uuid

def upsert_partition(part_dir: str, delta_group, key: str, geo_bytes: bytes):
    existing_files = [os.path.join(part_dir, f)
                      for f in os.listdir(part_dir) if f.endswith(".parquet")]
    current = pq.read_table(existing_files).to_pandas() if existing_files else pd.DataFrame()

    merged = (pd.concat([current, delta_group])
                .drop_duplicates(subset=key, keep="last")   # delta wins on key collision
                .reset_index(drop=True))

    table = pa.Table.from_pandas(merged, preserve_index=False)
    # Reattach the archive's exact geo metadata — never regenerate it from scratch.
    table = table.replace_schema_metadata({b"geo": geo_bytes})

    # Write to a temp object, then atomically swap so readers never see a torn partition.
    tmp = os.path.join(part_dir, f".tmp-{uuid.uuid4().hex}.parquet")
    pq.write_table(table, tmp, compression="zstd", compression_level=3,
                   row_group_size=100_000)
    os.replace(tmp, os.path.join(part_dir, "part-0000.parquet"))  # atomic rename
    for f in existing_files:                                       # drop superseded fragments
        if os.path.basename(f) != "part-0000.parquet":
            os.remove(f)
```

The critical line is `replace_schema_metadata({b"geo": geo_bytes})`: reuse the byte-identical `geo` block read from the archive, do not rebuild it. A regenerated block can reorder JSON keys, drop a `geometry_types` entry the delta happened not to contain, or shift the CRS string — any of which makes the partition inconsistent with its siblings. Read the canonical block once from an existing file and reapply it verbatim, the same CRS-integrity discipline enforced in [CRS Synchronization in Pipelines](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/crs-synchronization-in-pipelines/).

## Compacting Accumulated Small Files

Appends leave a partition holding many small files, which inflates the footer-read overhead of every query and multiplies per-object costs on cold storage. Compaction merges them back into one right-sized object per partition. Run it on a threshold — when a partition exceeds a small-file count — not on every write, so compaction cost stays amortized.

```bash
# Compact any partition holding more than 8 files into a single object.
for dir in $(aws s3 ls s3://spatial-archive/parcels/ --recursive \
             | awk '{print $4}' | grep -oP 'h3_cell=[^/]+' | sort -u); do
  n=$(aws s3 ls "s3://spatial-archive/parcels/$dir/" | grep -c '\.parquet$')
  if [ "$n" -gt 8 ]; then
    duckdb -c "
      COPY (SELECT * FROM read_parquet('s3://spatial-archive/parcels/$dir/*.parquet'))
      TO 's3://spatial-archive/parcels/$dir/compacted.parquet'
      (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 100000);"
    echo "compacted $dir ($n files -> 1)"
  fi
done
```

Compaction must preserve the `geo` metadata; DuckDB's Parquet writer does not carry through arbitrary key-value metadata, so for archives where the reader depends on the embedded `geo` block, compact with pyarrow (which lets you reattach the block) rather than a raw `COPY`. Size the compacted output with the same row-group and compression settings the archive uses so a compacted partition is indistinguishable from an originally written one — the [ZSTD Level Configuration for Spatial Files](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/zstd-level-configuration-for-spatial-files/) reference covers matching the level so compaction does not silently change the compression ratio of touched partitions.

## Verifying Consistency After an Update

After an incremental run, confirm two things: the touched partitions carry the same `geo` metadata as untouched ones, and the total row count changed by exactly the expected delta. Diff the `geo` block across a touched and an untouched partition.

```bash
python -c "
import pyarrow.parquet as pq, json
a = json.loads(pq.read_table('s3://spatial-archive/parcels/h3_cell=8428309ffffffff/part-0000.parquet').schema.metadata[b'geo'])
b = json.loads(pq.read_table('s3://spatial-archive/parcels/h3_cell=842830bffffffff/part-0000.parquet').schema.metadata[b'geo'])
print('geo consistent:', a == b)
print('crs:', a['columns']['geometry']['crs'])"
```

Expected output — the `geo` blocks must be identical and the CRS unchanged:

```text
geo consistent: True
crs: EPSG:4326
```

Then reconcile the count. A pre-update baseline of 4,821,736 features plus a delta of 12,400 appends should read back as exactly 4,834,136; an upsert delta changes the count only by net new keys. If `geo consistent` is `False`, a writer regenerated the metadata instead of reusing it, and downstream readers may treat the archive as two incompatible schemas.

## Troubleshooting Incremental Writes

| Symptom | Cause | Fix |
|---------|-------|-----|
| Reader reports two conflicting schemas across partitions | A writer regenerated the `geo` block instead of reusing the canonical bytes | Read `geo` once from an existing file and reapply verbatim on every write and compaction |
| Query latency climbs after weeks of appends | Small files accumulated; footer-read and per-object overhead dominate | Run threshold-based compaction to merge partitions exceeding the small-file count |
| Delta features land in the wrong partition | Update job used a different H3 resolution than the archive was built with | Pin `H3_RES` from the archive manifest; derive keys from EPSG:4326 centroids |
| Full-archive rewrite triggered by a tiny delta | Update path reads and rewrites all partitions instead of routing by key | Group the delta by cell first and open only the partitions it touches |

## Operational Execution Checklist

- [ ] Route every delta feature to its partition using the exact `H3_RES` pinned in the archive manifest and EPSG:4326 centroids.
- [ ] Choose append (new observations) or upsert (corrections on a stable feature key) per dataset and apply it consistently.
- [ ] Read the canonical `geo` block from an existing file and reapply it byte-identically on every write — never regenerate it.
- [ ] Write to a temp object and atomically swap so readers never observe a torn partition mid-update.
- [ ] Run threshold-based compaction to merge partitions that exceed the small-file count, preserving `geo` metadata and compression settings.
- [ ] Verify post-update that touched and untouched partitions share an identical `geo` block and CRS.
- [ ] Reconcile the archive row count against the pre-update baseline plus the net delta.

## Related

- Up: [GeoParquet Migration Workflows](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/geoparquet-migration-workflows/) — the parent reference for the partitioning and metadata invariants incremental writes must preserve.
- [Partitioning GeoParquet by H3 Spatial Index](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/geoparquet-migration-workflows/partitioning-geoparquet-by-h3-spatial-index/) — the keying scheme a delta must reuse to land features in the right partition.
- [Writing GeoParquet Bounding-Box Metadata for Predicate Pushdown](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/geoparquet-migration-workflows/writing-geoparquet-bbox-covering-metadata-for-predicate-pushdown/) — regenerating bbox coverings and statistics on the partitions an update rewrites.
- [Tuning ZSTD Compression for GeoParquet Archives](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/zstd-level-configuration-for-spatial-files/tuning-zstd-compression-for-geoparquet-archives/) — matching the compression level so compacted partitions stay consistent with originals.
- [Implementing Lifecycle Rules for Shapefile Archives](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/retention-policy-frameworks/implementing-lifecycle-rules-for-shapefile-archives/) — why early-deletion penalties on cold tiers make touching only affected partitions a cost imperative.
- [Spatial Archive Cost Modeling](https://www.spatialdataarchival.org/spatial-archive-cost-modeling/) — the per-object write and early-deletion math that rules out full rewrites on cold storage.

_Part of the [Spatial Data Archival](https://www.spatialdataarchival.org/) knowledge base._
