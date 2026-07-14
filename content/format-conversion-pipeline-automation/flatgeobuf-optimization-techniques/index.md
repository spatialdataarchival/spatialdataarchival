# FlatGeobuf Optimization Techniques

FlatGeobuf is a cloud-native vector format whose packed spatial index and HTTP range-request model let a client read only the bytes a bounding box touches — but a naively converted `.fgb` artifact silently discards that advantage, ballooning cold-storage cost and turning sub-second map queries into full-file downloads. This page shows data engineers and GIS archivists how to tune indexing, compression, schema, and CRS handling inside the broader [Format Conversion & Pipeline Automation](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/) workflow so that archival `.fgb` files stay small, deterministic, and cheap to serve at scale.

## The Failure Mode: Indexes and Bytes Out of Alignment

The inefficiency this topic solves is subtle because a broken FlatGeobuf file still opens correctly in every reader. Three regressions creep in during automated conversion. First, the packed Hilbert R-tree index is omitted (GDAL builds it by default, but explicit pipeline flags or streaming writers frequently disable it), so a bounding-box query degrades into a sequential scan of the entire object. Second, because FlatGeobuf has no internal codec, teams forget to compress at the storage or transport layer and pay full uncompressed egress on every retrieval. Third, unbounded attribute schemas and implicit reprojection inflate each feature record, multiplying both the per-`GET` byte count and the audit surface. The symptom — retrieval latency that grows linearly with archive size instead of staying flat — only appears once the archive is large enough that a re-conversion is expensive. Catching these at conversion time is the entire point.

## Prerequisite Context

This page assumes you have already converted source data to FlatGeobuf as part of a repeatable pipeline rather than a one-off export, and that the surrounding archival decisions are in place: a target object store and storage class selected, a [retention policy framework](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/retention-policy-frameworks/) governing how long `.fgb` artifacts are held, and a [hot/warm/cold tier design](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/hotwarmcold-tier-design-for-geospatial-data/) that decides which tier serves live web maps versus deep archive. FlatGeobuf is the web-delivery and range-read tier in that design; if your access pattern is analytical (columnar predicate pushdown, vectorized scans), the [GeoParquet Migration Workflows](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/geoparquet-migration-workflows/) pipeline owns that tier and the two formats coexist behind one manifest. This page is a deep-dive under the parent [Format Conversion & Pipeline Automation](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/) topic — start there for the end-to-end conversion architecture.

## How Range Reads Work

The packed spatial index lets a client fetch only the bytes its bounding box needs:

<svg viewBox="0 0 780 332" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="A bounding-box query first reads the packed Hilbert index to resolve which byte ranges hold matching features, then issues HTTP Range GETs that transfer only those contiguous ranges of the FlatGeobuf file while the rest of the feature records are never downloaded.">
  <title>Range Reads Driven by the Packed Hilbert Index</title>
  <desc>Left column: three stacked stages — a client bounding-box query, reading the packed Hilbert index, then issuing HTTP Range GETs. Right side: a vertical map of the .fgb file split into a header, the packed Hilbert index, and a band of Hilbert-ordered feature records; an arrow from the index-read stage points at the index segment, and an arrow from the range-GET stage points at a small highlighted block of contiguous feature records labelled as the only bytes transferred, while the remaining feature blocks are faded as never transferred.</desc>
  <defs>
    <marker id="fgb-arr" markerWidth="9" markerHeight="9" refX="6.5" refY="3" orient="auto">
      <path d="M0,0 L0,6 L8,3 z" fill="currentColor"/>
    </marker>
  </defs>
  <rect x="16" y="44" width="200" height="56" rx="7" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="116" y="68" text-anchor="middle" font-size="12" fill="currentColor" font-family="sans-serif">Client bbox query</text>
  <text x="116" y="85" text-anchor="middle" font-size="9.5" fill="currentColor" font-family="sans-serif" opacity=".75">extent to fetch</text>
  <rect x="16" y="146" width="200" height="56" rx="7" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="116" y="170" text-anchor="middle" font-size="12" fill="currentColor" font-family="sans-serif">Read packed Hilbert index</text>
  <text x="116" y="187" text-anchor="middle" font-size="9.5" fill="currentColor" font-family="sans-serif" opacity=".75">resolve matching offsets</text>
  <rect x="16" y="248" width="200" height="56" rx="7" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="116" y="272" text-anchor="middle" font-size="12" fill="currentColor" font-family="sans-serif">HTTP Range GETs</text>
  <text x="116" y="289" text-anchor="middle" font-size="9.5" fill="currentColor" font-family="sans-serif" opacity=".75">only matching ranges</text>
  <line x1="116" y1="100" x2="116" y2="144" stroke="currentColor" stroke-width="1.5" marker-end="url(#fgb-arr)"/>
  <line x1="116" y1="202" x2="116" y2="246" stroke="currentColor" stroke-width="1.5" marker-end="url(#fgb-arr)"/>
  <text x="660" y="24" text-anchor="middle" font-size="10.5" fill="currentColor" font-family="sans-serif" font-weight="bold" opacity=".85">pipeline_north.fgb</text>
  <rect x="560" y="34" width="200" height="24" rx="4" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="660" y="50" text-anchor="middle" font-size="10" fill="currentColor" font-family="sans-serif" opacity=".75">Header</text>
  <rect x="560" y="60" width="200" height="40" rx="4" fill="none" stroke="currentColor" stroke-width="2.2"/>
  <text x="660" y="78" text-anchor="middle" font-size="11" fill="currentColor" font-family="sans-serif">Packed Hilbert Index</text>
  <text x="660" y="93" text-anchor="middle" font-size="9" fill="currentColor" font-family="sans-serif" opacity=".75">feature byte offsets</text>
  <rect x="560" y="104" width="200" height="208" rx="4" fill="none" stroke="currentColor" stroke-width="1.2" opacity=".55"/>
  <line x1="560" y1="130" x2="760" y2="130" stroke="currentColor" stroke-width="1" opacity=".4"/>
  <line x1="560" y1="156" x2="760" y2="156" stroke="currentColor" stroke-width="1" opacity=".4"/>
  <line x1="560" y1="234" x2="760" y2="234" stroke="currentColor" stroke-width="1" opacity=".4"/>
  <line x1="560" y1="260" x2="760" y2="260" stroke="currentColor" stroke-width="1" opacity=".4"/>
  <line x1="560" y1="286" x2="760" y2="286" stroke="currentColor" stroke-width="1" opacity=".4"/>
  <rect x="560" y="182" width="200" height="52" rx="4" fill="currentColor" fill-opacity=".14" stroke="currentColor" stroke-width="1.8"/>
  <text x="660" y="203" text-anchor="middle" font-size="10" fill="currentColor" font-family="sans-serif">matching features</text>
  <text x="660" y="218" text-anchor="middle" font-size="9" fill="currentColor" font-family="sans-serif" opacity=".8">one contiguous range</text>
  <text x="660" y="123" text-anchor="middle" font-size="9" fill="currentColor" font-family="sans-serif" opacity=".5">feature records — never transferred</text>
  <text x="660" y="305" text-anchor="middle" font-size="9" fill="currentColor" font-family="sans-serif" opacity=".5">Hilbert-ordered, spatially adjacent</text>
  <path d="M216,168 C300,168 470,80 558,80" fill="none" stroke="currentColor" stroke-width="1.5" marker-end="url(#fgb-arr)"/>
  <path d="M216,276 C320,276 470,208 558,208" fill="none" stroke="currentColor" stroke-width="1.5" marker-end="url(#fgb-arr)"/>
</svg>

## Concept & Design Decisions

Every optimization decision for an archival `.fgb` file reduces to four levers: whether to pack the spatial index, how to compress, how wide to let the schema grow, and which CRS to freeze.

**Spatial index packing.** Retrieval performance is governed by the packed Hilbert R-tree. Enabling it clusters features along a Hilbert space-filling curve so that spatially adjacent geometries sit adjacent on disk, minimizing the number of distinct byte ranges a bounding-box query must request. This matters most for anisotropic datasets — linear infrastructure corridors, coastal transects, pipeline networks — where a small geographic window can otherwise scatter across the whole file. The trade-off is concrete: Hilbert packing adds roughly 15–25% write-time CPU but cuts cold-storage random-access latency by up to ~60%. The decision rule: enable the index for any dataset that will be queried by extent (web maps, tile servers, point lookups); disable it (`SPATIAL_INDEX=NO`) only for archives that are exclusively read as bulk sequential scans or compliance exports, where the index adds 8–12 MB of dead weight per 1M features.

**Compression layer.** FlatGeobuf's on-disk layout is uncompressed binary tuned for range reads, so compression is an external decision, not a creation option. Compress at the object-store tier (store the object ZSTD-compressed) or at the transport tier (serve it gzip/Brotli over HTTP). For tuning the codec level itself, the same logic from [ZSTD Level Configuration for Spatial Files](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/zstd-level-configuration-for-spatial-files/) applies: level 9 typically yields ~40% better ratios than level 3 with negligible decompression cost on modern x86/ARM silicon. When attribute payloads are highly repetitive, [dictionary encoding for GIS attributes](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/dictionary-encoding-for-gis-attributes/) at the storage layer compounds the savings.

**Schema width.** Strip every column not required for delivery or compliance. A narrower schema shrinks each feature record, which directly lowers the byte count of every range read and reduces the breach surface a data subject access request must reason about. Push column selection into the conversion step rather than post-processing.

**CRS freeze.** Declare the target CRS explicitly so the pipeline cannot silently reproject. A single drifting EPSG code across partitions breaks spatial joins and invalidates extent-based audits; this is handled rigorously in [CRS Synchronization in Pipelines](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/crs-synchronization-in-pipelines/).

## Implementation

The following GDAL conversions encode all four decisions. Build the index, freeze the CRS, and prune the schema in a single deterministic `ogr2ogr` pass over a real archival corridor dataset, then compress the artifact at the storage layer.

```bash
# Convert an infrastructure-corridor shapefile to an indexed, schema-pruned,
# CRS-frozen FlatGeobuf archive.
#   -t_srs        : freeze the output CRS so no implicit reprojection occurs
#   SPATIAL_INDEX : pack the Hilbert R-tree for bounding-box range reads
#   -sql          : allowlist only delivery/compliance columns (prunes payload)
ogr2ogr -f FlatGeobuf \
  datasets/corridors/2023/pipeline_north.fgb \
  datasets/corridors/2023/pipeline_north.shp \
  -t_srs EPSG:4326 \
  -lco SPATIAL_INDEX=YES \
  -sql "SELECT id, status, recorded_at FROM pipeline_north"
```

```bash
# FlatGeobuf has no internal codec — compress the immutable object at the
# storage/transport layer before it lands in cold storage.
zstd -9 datasets/corridors/2023/pipeline_north.fgb \
  -o datasets/corridors/2023/pipeline_north.fgb.zst
```

For purely sequential archives where the index is dead weight, invert the index flag while keeping the same CRS and schema discipline:

```bash
# Bulk compliance-export variant: drop the index, keep CRS + schema controls.
ogr2ogr -f FlatGeobuf \
  exports/compliance/2023/parcels_bulk.fgb \
  datasets/parcels/2023/parcels.gpkg \
  -t_srs EPSG:4326 \
  -lco SPATIAL_INDEX=NO \
  -sql "SELECT parcel_id, owner_class, assessed_at FROM parcels"
```

To keep web delivery and analytics aligned, record a dual-format manifest at write time so the router sends map traffic to the `.fgb` and analytical traffic to its [GeoParquet](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/geoparquet-migration-workflows/) twin without re-deriving either.

## Validation Gate

Never promote a converted artifact to immutable storage on faith — confirm the index is present and the geometry/feature counts survived the conversion. `ogrinfo` reports both:

```bash
ogrinfo -so datasets/corridors/2023/pipeline_north.fgb pipeline_north
```

Expected output (the index line is the gate — `Spatial Index: YES` must appear):

```
INFO: Open of `datasets/corridors/2023/pipeline_north.fgb'
      using driver `FlatGeobuf' successful.

Layer name: pipeline_north
Geometry: Line String
Feature Count: 1048576
Extent: (-124.482003, 32.528832) - (-114.131211, 42.009518)
Spatial Index: YES
Layer SRS WKT: GEOGCRS["WGS 84", ...]
```

Then prove the index actually serves range reads by querying a known extent and confirming a tiny subset returns:

```bash
# A small window over a 1M-feature corridor must return far fewer features.
ogrinfo -spat -120.0 36.0 -119.5 36.5 \
  -ro datasets/corridors/2023/pipeline_north.fgb pipeline_north \
  -sql "SELECT COUNT(*) FROM pipeline_north"
```

**Most common failure — `Spatial Index: NO` on a file you meant to index.** Root cause is almost always a streaming or append writer (or a default-overriding `-lco SPATIAL_INDEX=NO` left in a pipeline template) that emitted features without buffering them for the Hilbert sort, since the packed index can only be built once the full extent is known. Re-run the conversion as a single batched `ogr2ogr` pass with `SPATIAL_INDEX=YES`; do not attempt to retrofit an index onto the existing object.

## Cost & Performance Trade-offs

The levers above translate directly into object-storage economics, where every `GET` carries a fixed request charge plus per-byte egress.

| Decision | Storage / CPU impact | Retrieval impact |
| --- | --- | --- |
| Hilbert index ON | +15–25% write CPU; +8–12 MB / 1M features | Up to ~60% lower random-access latency; far fewer ranged `GET`s |
| Hilbert index OFF | Smallest file; minimal write CPU | Full-scan reads — only acceptable for sequential/bulk access |
| ZSTD level 3 (storage) | Low CPU | Baseline ratio |
| ZSTD level 9 (storage) | Higher CPU | ~40% smaller objects → lower egress per read |
| Schema pruning (`-sql`) | Smaller records, lower write cost | Fewer bytes per ranged read; smaller audit surface |

The economic crossover to watch: once a dataset exceeds ~50 GB or is queried analytically at high frequency, the fixed per-`GET` cost of range-reading FlatGeobuf is outpaced by columnar predicate pushdown, and the analytical tier should move to GeoParquet while FlatGeobuf retains web delivery. Validating these numbers against your own access logs before committing to immutable storage is cheaper than re-converting a cold archive later.

## Failure Modes & Edge Cases

- **Index omitted by a streaming writer.** As in the validation gate above, append/stream paths cannot build the packed Hilbert index because it requires the full extent up front. Always materialize the layer in a single batched conversion when the index is required.
- **CRS metadata loss on conversion.** Without an explicit `-t_srs`, GDAL may carry forward an ambiguous or missing `.prj` and downstream consumers silently assume EPSG:4326. Quarantine inputs with undeclared CRS and resolve them through [CRS Synchronization in Pipelines](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/crs-synchronization-in-pipelines/) before serialization.
- **Schema drift on upstream column additions.** When a provider adds fields, an unguarded `SELECT *` re-widens the archive and breaks the deterministic deserialization contract. Route new columns to a staging layer, validate them against the allowlist in [Schema Mapping & Attribute Validation](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/schema-mapping-attribute-validation/), and merge into the archival manifest only after approval.
- **Compression block size vs. range-read granularity.** Compressing a whole `.fgb` as one ZSTD frame forces a full-object decompress on any range read, defeating the index. For range-served objects, prefer transport-layer encoding or block-aligned compression so partial reads stay partial; reserve whole-file `zstd -9` for cold, sequentially-read archives.

## Operational Execution Checklist

- [ ] Enable the packed Hilbert spatial index (`-lco SPATIAL_INDEX=YES`) for any extent-queried archive
- [ ] Compress `.fgb` at the storage/transport layer — FlatGeobuf has no internal codec
- [ ] Prune attributes to a compliance allowlist via an explicit `-sql` column list
- [ ] Declare the target CRS with `-t_srs`; quarantine inputs with undeclared CRS
- [ ] Gate every artifact on `ogrinfo -so` showing `Spatial Index: YES` and correct feature count
- [ ] Generate a dual-format manifest routing web delivery to FlatGeobuf and analytics to GeoParquet
- [ ] Automate post-conversion validation and per-`GET` cost tracking in CI/CD

Consult the [GDAL FlatGeobuf driver documentation](https://gdal.org/drivers/vector/flatgeobuf.html) for the full list of creation options and known limitations, and the [ZSTD reference](https://facebook.github.io/zstd/) for level tuning and dictionary training.

## Related

- [Format Conversion & Pipeline Automation](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/) — the parent topic covering the end-to-end conversion and pipeline architecture this page sits within.
- [GeoParquet Migration Workflows](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/geoparquet-migration-workflows/) — the columnar analytical counterpart to FlatGeobuf, paired behind a dual-format manifest.
- [CRS Synchronization in Pipelines](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/crs-synchronization-in-pipelines/) — enforce a single coordinate reference system so `.fgb` extents and joins stay valid.
- [Schema Mapping & Attribute Validation](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/schema-mapping-attribute-validation/) — field-level allowlists and type checks that keep pruned schemas deterministic.
- [Optimizing FlatGeobuf for Web Mapping Archives](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/flatgeobuf-optimization-techniques/optimizing-flatgeobuf-for-web-mapping-archives/) — applying these techniques to public and internal mapping portals.
- [ZSTD Level Configuration for Spatial Files](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/zstd-level-configuration-for-spatial-files/) — tuning the codec level used when compressing `.fgb` objects at rest.
