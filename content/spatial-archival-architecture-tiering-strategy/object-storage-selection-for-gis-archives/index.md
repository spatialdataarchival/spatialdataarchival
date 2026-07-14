# Object Storage Selection for GIS Archives

Choosing the wrong storage class is the most expensive mistake in a geospatial archive, because the cost only surfaces months later — as a restore bill, an early-deletion penalty, or a pipeline that misses its SLA waiting on a rehydration that takes twelve hours. GIS archives are not uniform: a single bucket can hold multi-spectral raster mosaics read weekly by tile servers, LiDAR point clouds touched once a quarter, decade-old compliance shapefiles that may never be read again, and provenance logs that must be both immutable and instantly auditable. This page maps each of those access profiles to the correct object-storage class on AWS S3 and Azure Blob, encodes the mapping as version-controlled lifecycle policy, and proves it with runnable validation — so the storage substrate beneath your [Spatial Archival Architecture & Tiering Strategy](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/) is chosen by measured access pattern rather than by default.

## The Failure Mode: Storage-Class Misalignment

The specific inefficiency this topic solves is *storage-class misalignment* — provisioning a storage tier from how an asset was ingested instead of how it will be retrieved. Three patterns recur in spatial archives, and each one is paid for at the worst possible time.

The first is **retrieval-fee shock**. Cold and archive classes (S3 Glacier Flexible Retrieval, Glacier Deep Archive, Azure Archive) cut per-GB storage cost by 60–80%, but they bill a per-GB and per-request *retrieval* fee and impose a rehydration delay measured in minutes to hours. Route a frequently re-queried orthomosaic into Deep Archive and every cache miss becomes a paid restore plus a multi-hour wait — a "cheap" tier that quietly costs more than Standard.

The second is **early-deletion penalty leakage**. Every cold class carries a minimum storage duration: 30 days for S3 Standard-IA, 90 days for Glacier Flexible, 180 days for Deep Archive and Azure Archive. Delete, overwrite, or re-tier an object before its clock expires and you are billed for the remaining days anyway. Spatial pipelines that re-process and replace derivatives on a short cadence bleed money here invisibly.

The third is **minimum-billable-size waste**. S3 Standard-IA and Glacier classes bill a 128 KB minimum object size regardless of the real payload. A directory of split shapefile sidecars (`.shp`, `.shx`, `.dbf`, `.prj`) or thousands of small tiled GeoTIFFs is charged as if every fragment were 128 KB, inflating a cold archive's cost by an order of magnitude.

Correct selection removes all three by treating the storage class as a *computed function of retrieval urgency, object size, and minimum-duration economics* — decided per prefix, enforced in code, and revisited as access telemetry shifts.

## Choosing a Storage Class

Pick the storage class from how quickly the data must come back, then validate that decision against object size and minimum-duration billing before committing it to a lifecycle rule:

<svg viewBox="0 0 760 270" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Decision flow for selecting a storage class. An asset enters a single decision gate on retrieval urgency, which branches three ways: frequent reads route to S3 Standard or Standard-IA; rare reads where minutes of latency are acceptable route to Glacier Instant or Flexible Retrieval; rare reads where hours of latency are acceptable route to Deep Archive.">
  <title>Storage-Class Selection by Retrieval Urgency</title>
  <desc>A top-down flowchart. A single Asset node feeds a diamond decision node labelled Retrieval urgency, which splits into three outcomes. The Frequent branch points to Standard / Standard-IA, the Rare-minutes-OK branch points to Glacier Instant / Flexible, and the Rare-hours-OK branch points to Deep Archive.</desc>
  <defs>
    <marker id="oss-arr" markerWidth="9" markerHeight="9" refX="6" refY="3" orient="auto">
      <path d="M0,0 L0,6 L8,3 z" fill="currentColor"/>
    </marker>
  </defs>
  <rect x="300" y="10" width="160" height="40" rx="6" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="380" y="35" text-anchor="middle" font-size="13" font-family="sans-serif" fill="currentColor">Asset</text>
  <polygon points="380,70 488,108 380,146 272,108" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="380" y="105" text-anchor="middle" font-size="11" font-family="sans-serif" fill="currentColor">Retrieval</text>
  <text x="380" y="120" text-anchor="middle" font-size="11" font-family="sans-serif" fill="currentColor">urgency</text>
  <line x1="380" y1="50" x2="380" y2="69" stroke="currentColor" stroke-width="1.5" marker-end="url(#oss-arr)"/>
  <path d="M300,118 C200,140 140,170 140,199" fill="none" stroke="currentColor" stroke-width="1.5" marker-end="url(#oss-arr)"/>
  <line x1="380" y1="146" x2="380" y2="199" stroke="currentColor" stroke-width="1.5" marker-end="url(#oss-arr)"/>
  <path d="M460,118 C560,140 620,170 620,199" fill="none" stroke="currentColor" stroke-width="1.5" marker-end="url(#oss-arr)"/>
  <text x="178" y="168" text-anchor="middle" font-size="10" font-family="sans-serif" fill="currentColor" opacity="0.8">Frequent</text>
  <text x="380" y="176" text-anchor="middle" font-size="10" font-family="sans-serif" fill="currentColor" opacity="0.8">Rare, minutes OK</text>
  <text x="582" y="168" text-anchor="middle" font-size="10" font-family="sans-serif" fill="currentColor" opacity="0.8">Rare, hours OK</text>
  <rect x="30" y="200" width="220" height="54" rx="6" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-width="1.5"/>
  <text x="140" y="224" text-anchor="middle" font-size="12" font-family="sans-serif" fill="currentColor">Standard /</text>
  <text x="140" y="240" text-anchor="middle" font-size="12" font-family="sans-serif" fill="currentColor">Standard-IA</text>
  <rect x="270" y="200" width="220" height="54" rx="6" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-width="1.5"/>
  <text x="380" y="224" text-anchor="middle" font-size="12" font-family="sans-serif" fill="currentColor">Glacier Instant /</text>
  <text x="380" y="240" text-anchor="middle" font-size="12" font-family="sans-serif" fill="currentColor">Flexible</text>
  <rect x="510" y="200" width="220" height="54" rx="6" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-width="1.5"/>
  <text x="620" y="232" text-anchor="middle" font-size="12" font-family="sans-serif" fill="currentColor">Deep Archive</text>
</svg>

## Prerequisite Context

This page assumes the upstream decisions are already in place. You should have completed the [Hot/Warm/Cold Tier Design for Geospatial Data](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/hotwarmcold-tier-design-for-geospatial-data/), which defines *when* an asset transitions; this page defines *what substrate it lands on*. Assets should already be consolidated into archive-friendly container formats — the [GeoParquet Migration Workflows](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/geoparquet-migration-workflows/) for vector collections and Cloud-Optimized GeoTIFF for raster — so that one object maps to one logical asset rather than a swarm of small sidecars. A retention model from the [Retention Policy Frameworks](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/retention-policy-frameworks/) should declare which prefixes are compliance-bound, because legal holds override every lifecycle transition described below. With those in hand, storage-class selection becomes a mechanical mapping rather than a guess.

## Concept & Design Decisions

Map each spatial access profile to a class with explicit thresholds. The numbers below are the decision boundaries, not arbitrary defaults.

- **Active raster and live vector tiles** → S3 Standard / Azure Hot. Sub-100 ms time-to-first-byte, no retrieval fee, no minimum duration. Pay the high per-GB rate only while range-request reads from tile servers and ETL jobs are frequent.
- **Quarterly-access derivatives and superseded basemaps** → S3 Standard-IA / Azure Cool. ~40% cheaper storage, instant reads, but a per-GB retrieval fee, a 128 KB minimum billable size (S3), and a 30-day minimum duration. Only send objects here once read frequency drops below roughly once per month and the object is comfortably larger than 128 KB.
- **Compliance archives needing fast retrieval** → S3 Glacier Instant Retrieval / Azure Cold. Millisecond reads at archive prices, 90-day minimum duration. Ideal for audit-reachable LiDAR and historical imagery that must be producible within an SLA but is almost never read.
- **Rarely read, hours-tolerable** → S3 Glacier Flexible Retrieval / Azure Archive. Restores take minutes (expedited) to 12 hours (bulk/standard), 90-day (Glacier) or 180-day (Azure) minimum duration. The default destination for project-complete data with a remaining read value near zero.
- **Effectively write-only retention** → S3 Glacier Deep Archive. Lowest per-GB cost, 12–48 hour restore, 180-day minimum. Reserve for assets kept solely to satisfy a regulatory clock.

Two cross-cutting rules apply regardless of class. First, **consolidate before you cold-tier**: pack fragmented vector and tiled raster into GeoPackage, GeoParquet, or Zarr so you pay one minimum-size charge per asset, not per fragment. Second, **keep the discovery layer out of the cold object** — spatial extents, acquisition dates, and CRS belong in a queryable catalog (see [Metadata Cataloging & Discovery](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/metadata-cataloging-discovery/)) so a bounding-box lookup never forces a rehydration.

<svg viewBox="0 0 1000 282" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Decision matrix mapping five spatial asset classes to a storage class and its cost profile. Live tiles map to Standard or Hot: retrieval under 100 milliseconds, highest per-gigabyte band, no retrieval fee, no minimum duration, no minimum billable size. Quarterly derivatives map to Standard-IA or Cool: millisecond reads with a fee, about 40 percent lower price, per-gigabyte fee, 30-day minimum duration, 128 KB minimum billable size. Compliance LiDAR maps to Glacier Instant Retrieval or Cold: millisecond reads, low price, higher per-gigabyte fee, 90-day minimum, 128 KB minimum. Project-complete data maps to Glacier Flexible or Azure Archive: minutes to 12 hours, very low price, per-gigabyte plus per-request fee, 90 to 180-day minimum, 128 KB minimum. Write-only retention maps to Deep Archive: 12 to 48 hours, lowest price, per-gigabyte plus per-request fee, 180-day minimum, 128 KB minimum.">
  <title>Spatial Asset Class to Storage Class Decision Matrix</title>
  <desc>A seven-column table. Each row is a spatial asset class mapped to a storage class, retrieval SLA, dollar-per-gigabyte band, retrieval fee, minimum duration, and minimum billable size. Moving down the rows, retrieval latency and minimum duration rise while the per-gigabyte price band falls.</desc>
  <rect x="10" y="10" width="980" height="42" fill="currentColor" opacity="0.07"/>
  <rect x="10" y="10" width="980" height="262" fill="none" stroke="currentColor" stroke-width="1.2" opacity="0.5"/>
  <line x1="210" y1="10" x2="210" y2="272" stroke="currentColor" stroke-width="1" opacity="0.3"/>
  <line x1="370" y1="10" x2="370" y2="272" stroke="currentColor" stroke-width="1" opacity="0.3"/>
  <line x1="500" y1="10" x2="500" y2="272" stroke="currentColor" stroke-width="1" opacity="0.3"/>
  <line x1="620" y1="10" x2="620" y2="272" stroke="currentColor" stroke-width="1" opacity="0.3"/>
  <line x1="750" y1="10" x2="750" y2="272" stroke="currentColor" stroke-width="1" opacity="0.3"/>
  <line x1="870" y1="10" x2="870" y2="272" stroke="currentColor" stroke-width="1" opacity="0.3"/>
  <line x1="10" y1="52" x2="990" y2="52" stroke="currentColor" stroke-width="1" opacity="0.3"/>
  <line x1="10" y1="96" x2="990" y2="96" stroke="currentColor" stroke-width="1" opacity="0.3"/>
  <line x1="10" y1="140" x2="990" y2="140" stroke="currentColor" stroke-width="1" opacity="0.3"/>
  <line x1="10" y1="184" x2="990" y2="184" stroke="currentColor" stroke-width="1" opacity="0.3"/>
  <line x1="10" y1="228" x2="990" y2="228" stroke="currentColor" stroke-width="1" opacity="0.3"/>
  <text x="18" y="36" font-size="10" font-family="sans-serif" font-weight="600" fill="currentColor">Spatial asset</text>
  <text x="218" y="36" font-size="10" font-family="sans-serif" font-weight="600" fill="currentColor">Storage class</text>
  <text x="378" y="36" font-size="10" font-family="sans-serif" font-weight="600" fill="currentColor">Retrieval SLA</text>
  <text x="508" y="36" font-size="10" font-family="sans-serif" font-weight="600" fill="currentColor">$/GB band</text>
  <text x="628" y="36" font-size="10" font-family="sans-serif" font-weight="600" fill="currentColor">Retrieval fee</text>
  <text x="758" y="36" font-size="10" font-family="sans-serif" font-weight="600" fill="currentColor">Min duration</text>
  <text x="878" y="36" font-size="10" font-family="sans-serif" font-weight="600" fill="currentColor">Min size</text>
  <text x="18" y="78" font-size="9.5" font-family="sans-serif" fill="currentColor">Live raster /</text>
  <text x="18" y="90" font-size="9.5" font-family="sans-serif" fill="currentColor">vector tiles</text>
  <text x="218" y="80" font-size="9.5" font-family="sans-serif" fill="currentColor">Standard / Hot</text>
  <text x="378" y="80" font-size="9.5" font-family="sans-serif" fill="currentColor">&lt; 100 ms</text>
  <text x="508" y="80" font-size="9.5" font-family="sans-serif" fill="currentColor">highest</text>
  <text x="628" y="80" font-size="9.5" font-family="sans-serif" fill="currentColor">none</text>
  <text x="758" y="80" font-size="9.5" font-family="sans-serif" fill="currentColor">none</text>
  <text x="878" y="80" font-size="9.5" font-family="sans-serif" fill="currentColor">none</text>
  <text x="18" y="122" font-size="9.5" font-family="sans-serif" fill="currentColor">Quarterly</text>
  <text x="18" y="134" font-size="9.5" font-family="sans-serif" fill="currentColor">derivatives</text>
  <text x="218" y="124" font-size="9.5" font-family="sans-serif" fill="currentColor">Standard-IA / Cool</text>
  <text x="378" y="124" font-size="9.5" font-family="sans-serif" fill="currentColor">ms (+ fee)</text>
  <text x="508" y="124" font-size="9.5" font-family="sans-serif" fill="currentColor">~40% lower</text>
  <text x="628" y="124" font-size="9.5" font-family="sans-serif" fill="currentColor">per-GB</text>
  <text x="758" y="124" font-size="9.5" font-family="sans-serif" fill="currentColor">30 days</text>
  <text x="878" y="124" font-size="9.5" font-family="sans-serif" fill="currentColor">128 KB</text>
  <text x="18" y="166" font-size="9.5" font-family="sans-serif" fill="currentColor">Compliance</text>
  <text x="18" y="178" font-size="9.5" font-family="sans-serif" fill="currentColor">LiDAR</text>
  <text x="218" y="168" font-size="9.5" font-family="sans-serif" fill="currentColor">Glacier IR / Cold</text>
  <text x="378" y="168" font-size="9.5" font-family="sans-serif" fill="currentColor">ms</text>
  <text x="508" y="168" font-size="9.5" font-family="sans-serif" fill="currentColor">low</text>
  <text x="628" y="168" font-size="9.5" font-family="sans-serif" fill="currentColor">per-GB (higher)</text>
  <text x="758" y="168" font-size="9.5" font-family="sans-serif" fill="currentColor">90 days</text>
  <text x="878" y="168" font-size="9.5" font-family="sans-serif" fill="currentColor">128 KB</text>
  <text x="18" y="210" font-size="9.5" font-family="sans-serif" fill="currentColor">Project-</text>
  <text x="18" y="222" font-size="9.5" font-family="sans-serif" fill="currentColor">complete data</text>
  <text x="218" y="206" font-size="9.5" font-family="sans-serif" fill="currentColor">Glacier Flexible /</text>
  <text x="218" y="218" font-size="9.5" font-family="sans-serif" fill="currentColor">Azure Archive</text>
  <text x="378" y="212" font-size="9.5" font-family="sans-serif" fill="currentColor">mins&#8211;12 h</text>
  <text x="508" y="212" font-size="9.5" font-family="sans-serif" fill="currentColor">very low</text>
  <text x="628" y="212" font-size="9.5" font-family="sans-serif" fill="currentColor">per-GB + req</text>
  <text x="758" y="212" font-size="9.5" font-family="sans-serif" fill="currentColor">90&#8211;180 days</text>
  <text x="878" y="212" font-size="9.5" font-family="sans-serif" fill="currentColor">128 KB</text>
  <text x="18" y="254" font-size="9.5" font-family="sans-serif" fill="currentColor">Write-only</text>
  <text x="18" y="266" font-size="9.5" font-family="sans-serif" fill="currentColor">retention</text>
  <text x="218" y="254" font-size="9.5" font-family="sans-serif" fill="currentColor">Deep Archive</text>
  <text x="378" y="254" font-size="9.5" font-family="sans-serif" fill="currentColor">12&#8211;48 h</text>
  <text x="508" y="254" font-size="9.5" font-family="sans-serif" fill="currentColor">lowest</text>
  <text x="628" y="254" font-size="9.5" font-family="sans-serif" fill="currentColor">per-GB + req</text>
  <text x="758" y="254" font-size="9.5" font-family="sans-serif" fill="currentColor">180 days</text>
  <text x="878" y="254" font-size="9.5" font-family="sans-serif" fill="currentColor">128 KB</text>
</svg>

## Implementation

Drive storage-class selection from version-controlled Infrastructure-as-Code, never from console clicks. Lifecycle rules are prefix-scoped so raster derivatives, LiDAR tiles, and vector exports age on independent clocks, and tags carry the compliance signal that retention enforcement reads downstream.

```hcl
# Terraform: storage-class selection for a GIS archive bucket (AWS S3)
resource "aws_s3_bucket" "spatial_archive" {
  bucket = "org-geospatial-archive-prod"
}

resource "aws_s3_bucket_lifecycle_configuration" "gis_tiering" {
  bucket = aws_s3_bucket.spatial_archive.id

  # Raster derivatives: read for ~90 days, then drop to IA, archive, deep-archive.
  rule {
    id     = "raster-derivatives"
    status = "Enabled"
    filter { prefix = "archives/raster/derived/" }

    transition {
      days          = 90 # past analytical half-life of an orthomosaic refresh
      storage_class = "STANDARD_IA"
    }
    transition {
      days          = 365
      storage_class = "GLACIER" # Flexible Retrieval: hours-tolerable audit reach
    }
    transition {
      days          = 1095
      storage_class = "DEEP_ARCHIVE"
    }
    expiration { days = 3650 } # 10-year regulatory horizon
  }

  # LiDAR: large objects, compliance-reachable — skip IA, go straight to Glacier IR.
  rule {
    id     = "lidar-pointclouds"
    status = "Enabled"
    filter { prefix = "archives/lidar/" }

    transition {
      days          = 180
      storage_class = "GLACIER_IR" # millisecond reads at archive price
    }
    expiration { days = 3650 }
  }
}
```

The equivalent Azure policy expresses the same intent against block-blob tiers. Apply it with Bicep or `az storage account management-policy create` so it stays auditable:

```json
{
  "rules": [
    {
      "enabled": true,
      "name": "gis-archive-tiering",
      "type": "Lifecycle",
      "definition": {
        "filters": { "blobTypes": ["blockBlob"], "prefixMatch": ["archives/raster/derived/"] },
        "actions": {
          "baseBlob": {
            "tierToCool":    { "daysAfterModificationGreaterThan": 90 },
            "tierToArchive": { "daysAfterModificationGreaterThan": 365 },
            "delete":        { "daysAfterModificationGreaterThan": 3650 }
          }
        }
      }
    }
  ]
}
```

Tag every object at ingest with `project_id`, `data_type`, `retention_tier`, and `compliance_hold` so lifecycle rules scope cleanly and an IAM policy can block deletion when `compliance_hold=true`. Consult the authoritative mechanics in [AWS S3 Object Lifecycle Management](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lifecycle-mgmt.html) and [Azure Blob storage access tiers](https://learn.microsoft.com/en-us/azure/storage/blobs/access-tiers-overview) before changing day thresholds.

## Validation Gate

Never trust that a lifecycle rule does what you intended — confirm the storage class an object actually lands in. After the transition window, query the class directly:

```bash
aws s3api head-object \
  --bucket org-geospatial-archive-prod \
  --key archives/raster/derived/2019/region_north_mosaic.tif \
  --query 'StorageClass' --output text
```

Expected output once the 365-day rule has fired:

```
GLACIER
```

An object still showing `STANDARD` (or `head-object` returning no `StorageClass` field, which means Standard) past its transition day is the most common failure. Root cause is almost always a **prefix mismatch**: the lifecycle `filter` prefix is `archives/raster/derived/` but the object was written under `archives/raster/derived/2019/...` with a leading slash, a typo, or a tag-based filter that does not match the object's tags. Confirm the rule is enabled and the prefix is an exact left-anchored match with `aws s3api get-bucket-lifecycle-configuration --bucket org-geospatial-archive-prod`, then verify the object key against it. On Azure, the equivalent check is `az storage blob show --query properties.blobTier`, expecting `Archive`.

## Cost & Performance Trade-offs

The decision is a balance of three numbers: storage rate, retrieval cost, and minimum-duration exposure. Approximate per-GB-month storage rates and the penalty profile are summarized below (us-east-1 / East US list pricing, indicative — always re-model against the live calculator):

| Class | $/GB-month | Min duration | Min billable size | Retrieval latency | Retrieval fee |
|---|---|---|---|---|---|
| S3 Standard | ~0.023 | none | none | ms | none |
| S3 Standard-IA | ~0.0125 | 30 days | 128 KB | ms | per-GB |
| S3 Glacier IR | ~0.004 | 90 days | 128 KB | ms | per-GB (higher) |
| S3 Glacier Flexible | ~0.0036 | 90 days | 128 KB | mins–12 h | per-GB + per-request |
| S3 Glacier Deep Archive | ~0.00099 | 180 days | 128 KB | 12–48 h | per-GB + per-request |
| Azure Cool | ~0.015 | 30 days | none | ms | per-GB |
| Azure Archive | ~0.002 | 180 days | none | up to 15 h | per-GB (high) |

Read this matrix as break-even math, not a "cheapest wins" ranking. A 2 TB mosaic restored from Deep Archive twice a year can cost more in retrieval and rehydration than simply leaving it in Glacier IR. Bulk restores scheduled into off-peak compute windows avoid expedited premiums; reserve expedited retrieval strictly for time-critical incident response. And because direct retrieval from any archive tier bypasses CDN caching, route warm-tier assets through edge networks to absorb egress and reserve cold-tier pulls for batch ETL or audits. The same cost discipline applies to the bytes themselves — shrinking objects before archival with [ZSTD Level Configuration for Spatial Files](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/zstd-level-configuration-for-spatial-files/) lowers every per-GB line in this table at once.

## Failure Modes & Edge Cases

- **Minimum-size amplification on fragmented assets.** A folder of thousands of small tiled GeoTIFFs or split shapefile sidecars billed at the 128 KB Glacier minimum can cost 10× the real payload. Consolidate into COG, GeoPackage, or GeoParquet before transition so one asset incurs one minimum charge.
- **Early-deletion penalty on re-processed derivatives.** Overwriting a Glacier-tiered derivative before its 90-day clock expires bills the remaining days in full. Pin re-processing cadences above the minimum duration of the class the output lands in, or keep churning derivatives in Standard until they stabilize.
- **CRS and spatial metadata stranded in cold storage.** If extents and CRS live only inside the archived object, a routine bounding-box or projection lookup forces a full rehydration. Extract metadata to a warm-tier catalog at ingest; the cold object should never be the source of truth for discovery.
- **Replication consistency drift.** Cross-region or cross-cloud replication is asynchronous, so a reader can hit a stale version mid-sync. Validate replication against your RPO/RTO targets and checksum every object post-sync (`sha256sum` manifests) so downstream GIS pipelines reject version drift instead of silently consuming it.

## Operational Execution Checklist

- [ ] Storage class chosen per prefix from retrieval urgency, object size, and minimum-duration economics — not a single default bucket class.
- [ ] Lifecycle rules deployed as version-controlled IaC (Terraform / Bicep), prefix-scoped per asset type, and dry-run against a staging bucket with representative GIS payloads.
- [ ] Objects consolidated into container formats (COG / GeoPackage / GeoParquet / Zarr) before any cold-tier transition to avoid minimum-billable-size amplification.
- [ ] Spatial metadata (bbox, CRS, acquisition date) extracted to a queryable warm-tier catalog so discovery never triggers a rehydration.
- [ ] `compliance_hold` tag and Object Lock / WORM policy block deletion of retention-bound objects; deletion attempts verified to fail and to log.
- [ ] Restore-latency benchmark run from Glacier / Archive; pipeline schedulers confirmed to accommodate the observed window.
- [ ] Egress and retrieval volumes modeled against the live pricing calculator with budget alerts at 50%, 75%, and 90%.

## Related

- Up to the parent guide: [Spatial Archival Architecture & Tiering Strategy](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/) — how storage-class selection fits the full ingest-to-retention lifecycle.
- [Hot/Warm/Cold Tier Design for Geospatial Data](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/hotwarmcold-tier-design-for-geospatial-data/) — defines the transition triggers that decide *when* an asset moves between the classes selected here.
- [AWS S3 vs Azure Blob for GIS Cold Storage](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/object-storage-selection-for-gis-archives/aws-s3-vs-azure-blob-for-gis-cold-storage/) — a deep comparison of rehydration SLAs, encryption defaults, and integrity validation across the two providers.
- [Retention Policy Frameworks](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/retention-policy-frameworks/) — the WORM and legal-hold controls that override the lifecycle transitions above.
- [Metadata Cataloging & Discovery](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/metadata-cataloging-discovery/) — keeps the discovery layer out of cold objects so queries never force a restore.
- Cross-topic: tune [ZSTD Level Configuration for Spatial Files](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/zstd-level-configuration-for-spatial-files/) to lower the per-GB cost of every class in the matrix above.
