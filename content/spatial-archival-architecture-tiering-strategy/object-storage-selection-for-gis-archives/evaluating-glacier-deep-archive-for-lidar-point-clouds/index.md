# Evaluating Glacier Deep Archive for LiDAR Point Clouds

Evaluating Glacier Deep Archive for LiDAR point clouds is a decision about whether the cheapest archive class actually fits large LAZ and COPC collections, weighing a roughly twelve-hour restore latency against how often the points must be read, and comparing it honestly against Glacier Instant Retrieval and simply keeping COPC on a warm tier. This guide is for cloud architects and GIS archivists sitting on terabytes of aerial and terrestrial LiDAR who see Deep Archive's sub-penny storage price and want to know the catch before they move a survey there. The catch is that point clouds are not write-once-read-never assets the way scanned paper is: reprocessing campaigns, re-classification, and derivative DEM generation pull the raw points back out on unpredictable schedules, and a Deep Archive restore that blocks a project for half a day plus a retrieval bill can dwarf the storage saved. The right answer depends on object sizing, retrieval cadence, and the analytical half-life of the collection.

## Framing the Decision

There is no single correct class for LiDAR; there is a correct class per collection given its read pattern. The matrix below compares the realistic candidates across the dimensions that actually move the total cost:

<svg viewBox="0 0 860 236" role="img" aria-label="Comparison matrix of four AWS storage classes for LiDAR point clouds. Deep Archive: about 12-hour restore, about 0.00099 dollars per gigabyte-month, 0.02 dollars per gigabyte retrieval plus 180-day minimum, best for decade-long legal-hold LAZ that is never analyzed. Glacier Flexible: 3 to 5 hour standard restore, about 0.0036 dollars, 0.01 dollars retrieval plus 90-day minimum, best for occasional reprocessing campaigns. Glacier Instant Retrieval: millisecond retrieval, about 0.004 dollars, 0.03 dollars retrieval plus 90-day minimum, best for sporadic low-volume COPC reads. COPC on STANDARD-IA warm: millisecond retrieval, about 0.0125 dollars, 0.01 dollars retrieval plus 30-day minimum, best for actively analyzed point clouds." xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;color:var(--primary);font-family:var(--font-sans)">
  <title>LiDAR storage class comparison matrix</title>
  <desc>Four rows — Deep Archive, Glacier Flexible, Glacier Instant Retrieval, and COPC on STANDARD-IA — compared across restore latency, per-gigabyte-month price, retrieval cost with minimum-duration billing, and the LiDAR access pattern each class fits best.</desc>
  <rect x="10" y="10" width="840" height="40" fill="currentColor" opacity="0.07"/>
  <rect x="10" y="10" width="840" height="224" fill="none" stroke="currentColor" stroke-width="1.2" opacity="0.5"/>
  <line x1="150" y1="10" x2="150" y2="234" stroke="currentColor" stroke-width="1" opacity="0.3"/>
  <line x1="300" y1="10" x2="300" y2="234" stroke="currentColor" stroke-width="1" opacity="0.3"/>
  <line x1="420" y1="10" x2="420" y2="234" stroke="currentColor" stroke-width="1" opacity="0.3"/>
  <line x1="600" y1="10" x2="600" y2="234" stroke="currentColor" stroke-width="1" opacity="0.3"/>
  <line x1="10" y1="50" x2="850" y2="50" stroke="currentColor" stroke-width="1" opacity="0.3"/>
  <line x1="10" y1="96" x2="850" y2="96" stroke="currentColor" stroke-width="1" opacity="0.3"/>
  <line x1="10" y1="142" x2="850" y2="142" stroke="currentColor" stroke-width="1" opacity="0.3"/>
  <line x1="10" y1="188" x2="850" y2="188" stroke="currentColor" stroke-width="1" opacity="0.3"/>
  <text x="20" y="35" font-size="11" fill="currentColor" font-weight="600">Class</text>
  <text x="160" y="35" font-size="11" fill="currentColor" font-weight="600">Restore latency</text>
  <text x="310" y="35" font-size="11" fill="currentColor" font-weight="600">$/GB-mo</text>
  <text x="430" y="35" font-size="11" fill="currentColor" font-weight="600">Retrieval + min</text>
  <text x="610" y="35" font-size="11" fill="currentColor" font-weight="600">Best-fit LiDAR use</text>
  <text x="20" y="72" font-size="10.5" fill="currentColor">Deep Archive</text>
  <text x="20" y="87" font-size="8.5" fill="currentColor" opacity="0.7">DEEP_ARCHIVE</text>
  <text x="160" y="79" font-size="10" fill="currentColor">~12 h restore</text>
  <text x="310" y="79" font-size="10" fill="currentColor">~$0.00099</text>
  <text x="430" y="79" font-size="10" fill="currentColor">$0.02/GB + 180d</text>
  <text x="610" y="79" font-size="9.5" fill="currentColor">decade legal-hold LAZ, unread</text>
  <text x="20" y="118" font-size="10.5" fill="currentColor">Glacier Flexible</text>
  <text x="20" y="133" font-size="8.5" fill="currentColor" opacity="0.7">GLACIER</text>
  <text x="160" y="125" font-size="10" fill="currentColor">3&#8211;5 h (std)</text>
  <text x="310" y="125" font-size="10" fill="currentColor">~$0.0036</text>
  <text x="430" y="125" font-size="10" fill="currentColor">$0.01/GB + 90d</text>
  <text x="610" y="125" font-size="9.5" fill="currentColor">occasional reprocessing</text>
  <text x="20" y="164" font-size="10.5" fill="currentColor">Glacier IR</text>
  <text x="20" y="179" font-size="8.5" fill="currentColor" opacity="0.7">GLACIER_IR</text>
  <text x="160" y="171" font-size="10" fill="currentColor">milliseconds</text>
  <text x="310" y="171" font-size="10" fill="currentColor">~$0.004</text>
  <text x="430" y="171" font-size="10" fill="currentColor">$0.03/GB + 90d</text>
  <text x="610" y="171" font-size="9.5" fill="currentColor">sporadic low-volume COPC reads</text>
  <text x="20" y="210" font-size="10.5" fill="currentColor">COPC warm</text>
  <text x="20" y="225" font-size="8.5" fill="currentColor" opacity="0.7">STANDARD_IA</text>
  <text x="160" y="217" font-size="10" fill="currentColor">milliseconds</text>
  <text x="310" y="217" font-size="10" fill="currentColor">~$0.0125</text>
  <text x="430" y="217" font-size="10" fill="currentColor">$0.01/GB + 30d</text>
  <text x="610" y="217" font-size="9.5" fill="currentColor">actively analyzed point clouds</text>
</svg>

## Restore Latency Against Analytical Need

The first filter is blunt: can the workflow tolerate a half-day wait? Deep Archive's standard retrieval returns objects in roughly twelve hours, and bulk retrieval can stretch toward forty-eight. For a legal-hold survey that will only ever be produced in response to a discovery request, that is irrelevant — nobody is blocked. For a raw point cloud that feeds a quarterly DEM refresh or an on-demand re-classification, twelve hours is a hard stop that stalls an entire pipeline. Measure the real read cadence first, ideally from the same access telemetry you would use for [Setting Lifecycle Transition Thresholds from Query Telemetry](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/hotwarmcold-tier-design-for-geospatial-data/setting-lifecycle-transition-thresholds-from-query-telemetry/); if a prefix shows any read within the last analytical cycle, it is not a Deep Archive candidate yet.

The COPC format complicates the picture in a useful way. A Cloud-Optimized Point Cloud supports HTTP range reads, so an analyst can pull a single octree node — one small spatial window — without downloading the whole tile. That advantage evaporates the instant the object sits in Deep Archive or Glacier Flexible, because the object must be fully restored before any byte is readable. Deep Archive throws away the entire benefit of having converted to COPC. If a collection is stored as COPC specifically so it can be windowed on demand, its natural homes are Glacier IR or a warm tier, never Deep Archive.

## Object Sizing and Retrieval Economics

LiDAR archives fail Deep Archive economics through fragmentation. A single flight line tiled into thousands of small `.laz` files incurs a per-object overhead and a per-request retrieval charge on every restore, and Deep Archive bills a 180-day minimum duration on each object regardless of size. A collection of many small tiles restored together generates thousands of retrieval requests and, if any tile is deleted or overwritten before 180 days, a full early-deletion charge per object.

Consolidate before you cold-tier. Merge per-swath tiles into larger aggregated objects sized in the hundreds of megabytes to low gigabytes so the per-object overhead amortizes:
```bash
# Merge per-swath tiles into a single archive-grade LAZ before cold transition
pdal merge \
  s3://spatial-archive/lidar/2023/region_north/swath_*.laz \
  s3://spatial-archive/lidar/2023/region_north_merged.laz \
  --writers.las.compression=true

# Then transition the consolidated object, not the fragments
aws s3api copy-object \
  --bucket spatial-archive \
  --key lidar/2023/region_north_merged.laz \
  --copy-source spatial-archive/lidar/2023/region_north_merged.laz \
  --storage-class DEEP_ARCHIVE --metadata-directive COPY
```
Fewer, larger objects turn a punishing per-request restore into a handful of large transfers, and they make the 180-day minimum a rounding error rather than a repeated penalty. Compression choice compounds this: LAZ is already entropy-coded, so layering additional container compression buys little, but for the derivative GeoParquet and raster products the tuning in [ZSTD Level Configuration for Spatial Files](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/zstd-level-configuration-for-spatial-files/) still moves the stored footprint. Price the full picture — storage plus restores plus request charges — with [Spatial Archive Cost Modeling](https://www.spatialdataarchival.org/spatial-archive-cost-modeling/) rather than comparing the headline per-gigabyte number alone.

## Recommendation by Scenario

- **Raw LAZ under regulatory hold, no analytical reads expected for years** — Deep Archive wins decisively once tiles are consolidated into large objects. The twelve-hour restore is acceptable because production is rare and deadline-driven, not interactive.
- **Point clouds reprocessed on a quarterly or annual campaign** — Glacier Flexible is the balance point: three-to-five-hour restores fit a planned campaign, and per-gigabyte storage is a fraction of warm without Deep Archive's minimum-duration rigidity.
- **COPC read sporadically for windowed analysis** — Glacier IR keeps millisecond range reads alive at near-Glacier storage cost; Deep Archive would defeat the format's entire purpose.
- **Actively analyzed collections feeding live derivatives** — keep COPC on STANDARD-IA warm. The storage premium is real but smaller than the retrieval fees and stalls that cold-tiering an active collection would generate.

The substrate decision underneath these classes — integrity APIs, egress pricing, and multipart thresholds — is itself a choice covered in [Object Storage Selection for GIS Archives](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/object-storage-selection-for-gis-archives/), and the same LiDAR that suits Deep Archive on one provider may price differently on another.

A subtlety that trips up first-time Deep Archive adopters is that restore is not free storage relief: the restored copy lives in a temporary bucket location and bills at the reduced-redundancy retrieval tier for its requested lifetime, on top of the retrieval charge, while the underlying object keeps accruing its Deep Archive rate. Restore only what a campaign genuinely needs, scope the restore `Days` to the campaign window rather than a generous default, and let the temporary copy expire on schedule. Treating a restore as a project-scoped, time-boxed event rather than a permanent un-archiving is what keeps the class economical.

## Verifying a Restore Path Before You Commit

Never move a collection to Deep Archive without proving you can get it back within the window your operations assume. Initiate a test restore and confirm the timing and the restored-copy expiry.

```bash
aws s3api restore-object --bucket spatial-archive \
  --key lidar/2023/region_north_merged.laz \
  --restore-request '{"Days":7,"GlacierJobParameters":{"Tier":"Standard"}}'

aws s3api head-object --bucket spatial-archive \
  --key lidar/2023/region_north_merged.laz \
  --query "{restore:Restore, class:StorageClass}"
```

Expected output while the restore is in progress, then once complete:
```text
{
  "restore": "ongoing-request=\"true\"",
  "class": "DEEP_ARCHIVE"
}
# ~12 hours later:
{
  "restore": "ongoing-request=\"false\", expiry-date=\"Wed, 22 Jul 2026 00:00:00 GMT\"",
  "class": "DEEP_ARCHIVE"
}
```
The `ongoing-request=\"false\"` with a populated `expiry-date` confirms a temporary readable copy now exists; the underlying class stays `DEEP_ARCHIVE`. If the restore has not completed within your operational SLA, the collection is mis-tiered for its read pattern.

## Diagnosing Mis-Tiered LiDAR

| Symptom | Root Cause | Resolution |
|---------|------------|------------|
| Restore bill dwarfs the storage saving | Thousands of small tiles each charged a retrieval request | Consolidate swaths into large objects before transition; restore in bulk |
| COPC range reads fail after cold-tiering | Object must be fully restored before any byte is readable | Move COPC to Glacier IR or keep on warm; reserve Deep Archive for opaque LAZ |
| Early-deletion charges on re-processed tiles | Objects overwritten before the 180-day minimum | Stage reprocessing on warm; only cold-tier stabilized, final collections |
| Project stalls half a day on data pull | Deep Archive restore latency on an actively analyzed collection | Re-tier to warm; the storage premium is less than the stall cost |

## Operational Execution Checklist

- [ ] Measure the collection's real read cadence from access telemetry before assuming it is cold.
- [ ] Consolidate per-swath tiles into large aggregated objects so per-request and minimum-duration costs amortize.
- [ ] Keep any collection stored as COPC for windowed reads out of Deep Archive and Glacier Flexible.
- [ ] Model storage plus restore plus request charges together, not the headline per-gigabyte price alone.
- [ ] Run a timed test restore and confirm it completes inside your operational SLA before committing the collection.
- [ ] Cold-tier only stabilized, final point clouds; stage active reprocessing on warm to avoid early-deletion penalties.
- [ ] Match the class to the scenario: Deep Archive for unread legal-hold LAZ, Glacier IR for sporadic COPC, warm for active analysis.

## Related

- Up: [Object Storage Selection for GIS Archives](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/object-storage-selection-for-gis-archives/) — the parent reference for matching spatial workloads to a storage substrate.
- [AWS S3 vs Azure Blob for GIS Cold Storage](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/object-storage-selection-for-gis-archives/aws-s3-vs-azure-blob-for-gis-cold-storage/) — cross-provider comparison of the cold classes evaluated here.
- [Setting Lifecycle Transition Thresholds from Query Telemetry](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/hotwarmcold-tier-design-for-geospatial-data/setting-lifecycle-transition-thresholds-from-query-telemetry/) — deriving the read cadence that decides whether LiDAR is truly cold.
- [Tuning ZSTD Compression for GeoParquet Archives](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/zstd-level-configuration-for-spatial-files/tuning-zstd-compression-for-geoparquet-archives/) — compression tuning for the derivative products these point clouds generate.
- [Spatial Archive Cost Modeling](https://www.spatialdataarchival.org/spatial-archive-cost-modeling/) — pricing storage, restore, and request charges as one total rather than a per-gigabyte headline.

_Part of the [Spatial Data Archival](https://www.spatialdataarchival.org/) knowledge base._
