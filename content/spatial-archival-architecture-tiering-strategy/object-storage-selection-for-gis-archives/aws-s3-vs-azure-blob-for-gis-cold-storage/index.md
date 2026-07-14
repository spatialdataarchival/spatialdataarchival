# AWS S3 Glacier vs Azure Blob Archive for GIS Cold Storage: Retrieval Latency and Integrity Validation

Geospatial cold-storage migrations consistently fail at three operational boundaries: unpredictable rehydration SLAs, spatial metadata decoupling during tier transitions, and checksum validation drift across multipart archives. This guide is written for data engineers, GIS archivists, cloud architects, and compliance teams executing long-term archival of raster mosaics, LiDAR point clouds, and vector feature collections, and it explains exactly why provider-default configurations break for spatial payloads. Out of the box, both S3 Glacier/Deep Archive and Azure Archive auto-tier on object size and access patterns that were tuned for documents and backups — not for multi-gigabyte GeoTIFFs whose ETag drift, sidecar coupling, and bounding-box lookups have no analogue in generic object workloads. Choosing the right provider configuration is the operational half of [object storage selection for GIS archives](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/object-storage-selection-for-gis-archives/); the design half — which dataset belongs in which tier — is governed by your [hot/warm/cold tier design](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/hotwarmcold-tier-design-for-geospatial-data/).

Both providers share the same hard constraint that drives every decision below: an archived object cannot be read directly. It must be rehydrated to an online tier first, and neither S3 Glacier nor Azure Archive serves bytes from the cold tier.

<svg viewBox="0 0 1000 336" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Sequence diagram of the mandatory two-phase read for an archived spatial object. The client issues a restore-object request naming the Standard retrieval tier; the object store replies 202 Accepted and begins a rehydration that takes hours. The client polls with head-object until the store reports ongoing-request false, signalling the object is now online. Only then does get-object return the object bytes. An archived object can never be read directly from the cold tier.">
  <title>Two-Phase Rehydrate-Then-Read Sequence for Archived Objects</title>
  <desc>A sequence diagram with two lifelines, Client on the left and Object store on the right. A restore-object request flows to the store, which returns 202 Accepted and then rehydrates for hours. The client polls head-object, receives ongoing-request false, then issues get-object and finally receives the object bytes.</desc>
  <defs>
    <marker id="seq-arr" markerWidth="9" markerHeight="9" refX="6" refY="3" orient="auto">
      <path d="M0,0 L0,6 L8,3 z" fill="currentColor"/>
    </marker>
  </defs>
  <rect x="110" y="18" width="180" height="36" rx="6" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="200" y="41" text-anchor="middle" font-size="12" font-family="sans-serif" fill="currentColor" font-weight="600">Client</text>
  <rect x="710" y="18" width="180" height="36" rx="6" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="800" y="41" text-anchor="middle" font-size="12" font-family="sans-serif" fill="currentColor" font-weight="600">Object store (cold tier)</text>
  <line x1="200" y1="54" x2="200" y2="318" stroke="currentColor" stroke-width="1" opacity="0.35"/>
  <line x1="800" y1="54" x2="800" y2="318" stroke="currentColor" stroke-width="1" opacity="0.35"/>
  <text x="500" y="82" text-anchor="middle" font-size="10.5" font-family="sans-serif" fill="currentColor">restore-object &#183; Tier=Standard</text>
  <line x1="200" y1="90" x2="790" y2="90" stroke="currentColor" stroke-width="1.5" marker-end="url(#seq-arr)"/>
  <text x="500" y="118" text-anchor="middle" font-size="10.5" font-family="sans-serif" fill="currentColor">202 Accepted</text>
  <line x1="800" y1="126" x2="210" y2="126" stroke="currentColor" stroke-width="1.5" stroke-dasharray="5 4" marker-end="url(#seq-arr)"/>
  <rect x="650" y="142" width="300" height="34" rx="5" fill="currentColor" opacity="0.07"/>
  <rect x="650" y="142" width="300" height="34" rx="5" fill="none" stroke="currentColor" stroke-width="1" opacity="0.5"/>
  <text x="800" y="164" text-anchor="middle" font-size="10" font-family="sans-serif" fill="currentColor">rehydration takes hours — not directly readable</text>
  <text x="500" y="204" text-anchor="middle" font-size="10.5" font-family="sans-serif" fill="currentColor">head-object (poll)</text>
  <line x1="200" y1="212" x2="790" y2="212" stroke="currentColor" stroke-width="1.5" marker-end="url(#seq-arr)"/>
  <text x="500" y="240" text-anchor="middle" font-size="10.5" font-family="sans-serif" fill="currentColor">ongoing-request = false (now online)</text>
  <line x1="800" y1="248" x2="210" y2="248" stroke="currentColor" stroke-width="1.5" stroke-dasharray="5 4" marker-end="url(#seq-arr)"/>
  <text x="500" y="276" text-anchor="middle" font-size="10.5" font-family="sans-serif" fill="currentColor">get-object</text>
  <line x1="200" y1="284" x2="790" y2="284" stroke="currentColor" stroke-width="1.5" marker-end="url(#seq-arr)"/>
  <text x="500" y="312" text-anchor="middle" font-size="10.5" font-family="sans-serif" fill="currentColor">object bytes</text>
  <line x1="800" y1="320" x2="210" y2="320" stroke="currentColor" stroke-width="1.5" stroke-dasharray="5 4" marker-end="url(#seq-arr)"/>
</svg>

The two platforms diverge sharply on rehydration tiers, minimum storage duration, and where immutability is enforced — the differences that decide both cost and recovery time.

<svg viewBox="0 0 1000 286" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Side-by-side comparison matrix of AWS S3 Glacier Deep Archive versus Azure Blob Archive across five archival properties. Rehydration tiers: AWS offers Standard and Bulk; Azure offers Standard and High-priority. Retrieval latency window: AWS Standard takes 3 to 12 hours; Azure Standard takes 1 to 15 hours; expedited retrieval is unavailable on both. Minimum storage duration is 180 days on both providers. Immutability mechanism: AWS uses Object Lock in COMPLIANCE mode; Azure uses an immutability policy enforcing WORM. Checksum model: AWS stores a SHA256 full-object hash; Azure exposes a Content-MD5 per-block value that is not a whole-object hash.">
  <title>AWS S3 Deep Archive vs Azure Blob Archive Comparison Matrix</title>
  <desc>A three-column table comparing AWS S3 Glacier Deep Archive and Azure Blob Archive across rehydration tiers, retrieval latency window, minimum storage duration, immutability mechanism and checksum model.</desc>
  <rect x="10" y="10" width="980" height="36" fill="currentColor" opacity="0.07"/>
  <rect x="10" y="10" width="980" height="266" fill="none" stroke="currentColor" stroke-width="1.2" opacity="0.5"/>
  <line x1="330" y1="10" x2="330" y2="276" stroke="currentColor" stroke-width="1" opacity="0.3"/>
  <line x1="660" y1="10" x2="660" y2="276" stroke="currentColor" stroke-width="1" opacity="0.3"/>
  <line x1="10" y1="46" x2="990" y2="46" stroke="currentColor" stroke-width="1" opacity="0.3"/>
  <line x1="10" y1="92" x2="990" y2="92" stroke="currentColor" stroke-width="1" opacity="0.3"/>
  <line x1="10" y1="138" x2="990" y2="138" stroke="currentColor" stroke-width="1" opacity="0.3"/>
  <line x1="10" y1="184" x2="990" y2="184" stroke="currentColor" stroke-width="1" opacity="0.3"/>
  <line x1="10" y1="230" x2="990" y2="230" stroke="currentColor" stroke-width="1" opacity="0.3"/>
  <text x="22" y="33" font-size="11" font-family="sans-serif" fill="currentColor" font-weight="600">Property</text>
  <text x="345" y="33" font-size="11" font-family="sans-serif" fill="currentColor" font-weight="600">AWS S3 Glacier Deep Archive</text>
  <text x="675" y="33" font-size="11" font-family="sans-serif" fill="currentColor" font-weight="600">Azure Blob Archive</text>
  <text x="22" y="74" font-size="11" font-family="sans-serif" fill="currentColor" font-weight="600">Rehydration tiers</text>
  <text x="345" y="74" font-size="10.5" font-family="sans-serif" fill="currentColor">Standard &#183; Bulk</text>
  <text x="675" y="74" font-size="10.5" font-family="sans-serif" fill="currentColor">Standard &#183; High-priority</text>
  <text x="22" y="120" font-size="11" font-family="sans-serif" fill="currentColor" font-weight="600">Retrieval latency</text>
  <text x="345" y="113" font-size="10.5" font-family="sans-serif" fill="currentColor">3&#8211;12 h (Standard)</text>
  <text x="345" y="128" font-size="8.5" font-family="sans-serif" fill="currentColor" opacity="0.65">no expedited tier</text>
  <text x="675" y="113" font-size="10.5" font-family="sans-serif" fill="currentColor">1&#8211;15 h (Standard)</text>
  <text x="675" y="128" font-size="8.5" font-family="sans-serif" fill="currentColor" opacity="0.65">no expedited tier</text>
  <text x="22" y="166" font-size="11" font-family="sans-serif" fill="currentColor" font-weight="600">Min storage duration</text>
  <text x="345" y="166" font-size="10.5" font-family="sans-serif" fill="currentColor">180 days</text>
  <text x="675" y="166" font-size="10.5" font-family="sans-serif" fill="currentColor">180 days</text>
  <text x="22" y="212" font-size="11" font-family="sans-serif" fill="currentColor" font-weight="600">Immutability</text>
  <text x="345" y="205" font-size="10.5" font-family="sans-serif" fill="currentColor">Object Lock</text>
  <text x="345" y="220" font-size="8.5" font-family="sans-serif" fill="currentColor" opacity="0.65">COMPLIANCE mode</text>
  <text x="675" y="205" font-size="10.5" font-family="sans-serif" fill="currentColor">Immutability policy</text>
  <text x="675" y="220" font-size="8.5" font-family="sans-serif" fill="currentColor" opacity="0.65">WORM lock</text>
  <text x="22" y="258" font-size="11" font-family="sans-serif" fill="currentColor" font-weight="600">Checksum model</text>
  <text x="345" y="251" font-size="10.5" font-family="sans-serif" fill="currentColor">SHA256 full-object</text>
  <text x="345" y="266" font-size="8.5" font-family="sans-serif" fill="currentColor" opacity="0.65">survives reassembly</text>
  <text x="675" y="251" font-size="10.5" font-family="sans-serif" fill="currentColor">Content-MD5 per-block</text>
  <text x="675" y="266" font-size="8.5" font-family="sans-serif" fill="currentColor" opacity="0.65">not a whole-object hash</text>
</svg>

## Step-by-Step Procedure

The procedure runs in four phases regardless of provider: extract and decouple queryable metadata, write the immutable payload to the chosen archive tier, rehydrate on demand, then validate integrity against the pre-ingest manifest. Run every phase against a warm-tier catalog so the cold tier is never touched for discovery.

### Phase 1 — Pre-Ingest Validation and Spatial Metadata Decoupling

Cold tiers support neither random-access reads nor spatial-index queries. Transitioning data to S3 Deep Archive or Azure Archive without first decoupling queryable metadata forces a full-object rehydration just to answer a bounding-box or CRS lookup. Extract the spatial metadata to a warm-tier catalog so discovery stays online while the payload goes cold — the same separation enforced by the [metadata cataloging and discovery](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/metadata-cataloging-discovery/) layer.

Extract spatial extents and CRS metadata before upload and serialize them to machine-readable JSON for warm-tier cataloging in PostGIS or Azure SQL:

```bash
gdalinfo -json datasets/imagery/raw/mosaic_2024.tif \
  | jq '{crs: .coordinateSystem.wkt, extent: [.size[0], .size[1], .geoTransform[0], .geoTransform[3]], bands: [.bands[].type]}' \
  > catalog/imagery/mosaic_2024.metadata.json
```

Compute file-level cryptographic checksums and store the manifest in the same warm-tier database as the metadata, so post-restore validation never depends on cold-tier ETags:

```bash
sha256sum datasets/imagery/raw/*.tif datasets/lidar/2024/*.las datasets/vector/*.gpkg \
  > catalog/manifests/archive_2024.sha256
```

Validate topology and geometry integrity before promotion, rejecting datasets with self-intersections or invalid rings. Because OGR SQL does not implement `ST_IsValid`, use DuckDB's spatial extension for the check:

```bash
duckdb -c "INSTALL spatial; LOAD spatial; \
  SELECT count(*) AS invalid_count \
  FROM ST_Read('datasets/vector/parcels.shp') \
  WHERE NOT ST_IsValid(geom);"
```

If `invalid_count > 0`, quarantine the dataset. Convert valid features and promote single-part geometries to multi-part to avoid silent drops during conversion:

```bash
ogr2ogr -f "GPKG" -nlt PROMOTE_TO_MULTI \
  datasets/vector/parcels_valid.gpkg datasets/vector/parcels.shp
```

### Phase 2a — AWS S3 Glacier / Deep Archive Configuration

Intelligent-Tiering introduces unpredictable retrieval costs and auto-transition delays for large raster tiles. Use explicit lifecycle rules and Object Lock to guarantee retention and cost predictability; this is the same atomic-transition discipline applied to multi-file groups in the [retention policy frameworks](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/retention-policy-frameworks/).

Define the lifecycle rule (`lifecycle.json`) so imagery transitions to Deep Archive after the active-query window closes:

```json
{
  "Rules": [
    {
      "ID": "GIS-DeepArchive-180d",
      "Status": "Enabled",
      "Filter": {"Prefix": "gis-archives/imagery/"},
      "Transitions": [{"Days": 180, "StorageClass": "DEEP_ARCHIVE"}],
      "NoncurrentVersionTransitions": [{"NoncurrentDays": 90, "StorageClass": "DEEP_ARCHIVE"}]
    }
  ]
}
```

Apply the lifecycle rule, set a COMPLIANCE-mode retention default, then upload with customer-managed KMS encryption and a multipart chunk size aligned to large rasters:

```bash
aws s3api put-bucket-lifecycle-configuration \
  --bucket spatial-archive-prod --lifecycle-configuration file://lifecycle.json

aws s3api put-object-lock-configuration --bucket spatial-archive-prod \
  --object-lock-configuration '{"ObjectLockEnabled":"Enabled","Rule":{"DefaultRetention":{"Mode":"COMPLIANCE","Days":730}}}'

aws configure set default.s3.multipart_threshold 5GB
aws configure set default.s3.multipart_chunksize 100MB
aws s3 cp ./datasets/imagery/raw/ s3://spatial-archive-prod/gis-archives/imagery/ --recursive \
  --storage-class DEEP_ARCHIVE --sse aws:kms --sse-kms-key-id <kms-key-arn> --checksum-algorithm SHA256
```

The `--checksum-algorithm SHA256` flag is load-bearing: it forces S3 to store a per-object SHA256 alongside the multipart ETag, which is the only value that survives reassembly and can be checked against your warm-tier manifest.

### Phase 2b — Azure Blob Archive Configuration

Relying solely on Azure lifecycle management for immediate archival introduces race conditions during bulk ingestion. Assign the Archive tier explicitly at upload time and enforce immutability with a WORM policy rather than waiting for a lifecycle sweep:

```bash
az storage account update --name spatialarchiveprod \
  --encryption-key-source Microsoft.Keyvault \
  --encryption-key-name gis-archive-cmk \
  --encryption-key-vault https://spatial-kv.vault.azure.net/

az storage container immutability-policy create \
  --account-name spatialarchiveprod --container-name gis-archives \
  --resource-group geo-archival-rg \
  --allow-protected-append-writes false --immutability-period-in-days 730

az storage blob upload --account-name spatialarchiveprod --container-name gis-archives \
  --file ./datasets/lidar/2024/region_north.las --name lidar/2024/region_north.las \
  --tier Archive --max-concurrency 8 --blob-type BlockBlob --overwrite
```

Azure Archive requires an explicit encryption scope and a tuned `--max-concurrency` to prevent timeout failures on multi-gigabyte point clouds; the default concurrency of 5 saturates network buffers on 50 GB-class LAS files.

### Phase 3 — On-Demand Rehydration

Rehydration requests must name an exact retrieval tier. Standard retrieval for Glacier/Deep Archive carries 3–12 hour latency; Azure Archive rehydration takes 1–15 hours. Expedited retrieval is unavailable for both Deep Archive and Azure Archive, so never design a recovery runbook that assumes it.

On AWS, request a restore and keep the rehydrated copy online for the duration your transformation pipeline needs:

```bash
aws s3api restore-object --bucket spatial-archive-prod \
  --key gis-archives/imagery/mosaic_2024.tif \
  --restore-request '{"Days":7,"GlacierJobParameters":{"Tier":"Standard"}}'
```

On Azure, rehydrate by re-tiering the blob to Hot (or Cool):

```bash
az storage blob set-tier --account-name spatialarchiveprod \
  --container-name gis-archives --name lidar/2024/region_north.las --tier Hot
```

## Validation and Verification

Cold-tier multipart uploads routinely produce ETag drift, so confirm rehydration state first, then validate bytes against the pre-ingest manifest — never against the provider-reported ETag.

Check AWS restore status; an in-progress restore reports `ongoing-request="true"`, a completed one reports `false` with an expiry timestamp:

```bash
aws s3api head-object --bucket spatial-archive-prod \
  --key gis-archives/imagery/mosaic_2024.tif --query 'Restore'
```

```text
# Completed restore — object is now readable until the expiry date:
"ongoing-request=\"false\", expiry-date=\"Wed, 03 Jul 2026 00:00:00 GMT\""
```

On Azure, an empty `archiveStatus` means rehydration has finished; `rehydrate-pending-to-hot` means it is still in flight:

```bash
az storage blob show --account-name spatialarchiveprod \
  --container-name gis-archives --name lidar/2024/region_north.las \
  --query 'properties.archiveStatus'
```

Once the object is online, download with checksum mode enabled and verify against the warm-tier manifest. A clean run prints `OK` for every line:

```bash
aws s3api get-object --bucket spatial-archive-prod \
  --key gis-archives/imagery/mosaic_2024.tif --checksum-mode ENABLED /tmp/verify.tif
sha256sum -c catalog/manifests/archive_2024.sha256
```

```text
datasets/imagery/raw/mosaic_2024.tif: OK
```

A `FAILED` line here almost always signals provider metadata wrapping rather than true corruption — strip HTTP headers by re-reading the raw object and re-hash before declaring a data-integrity incident.

## Troubleshooting

| Symptom | Root Cause | Exact Resolution |
|---------|------------|------------------|
| Rehydration request rejected (`InvalidObjectState`) | Object is already in `STANDARD` or `GLACIER_IR` tier | Run `aws s3api head-object` or `az storage blob show` to confirm the current tier before issuing a restore |
| Checksum mismatch on >5GB multipart files | Provider concatenates per-part MD5 hashes into the ETag, so the ETag is not a whole-object hash | Pre-compute SHA256, upload with `--checksum-algorithm SHA256` (AWS) or verify with `--content-md5` (Azure), and validate the downloaded bytes against the manifest |
| Spatial query latency >30s after rehydration | Application runs `gdalinfo`/`ogrinfo` directly against the cold-tier URI | Decouple metadata to warm-tier PostGIS/Azure SQL during Phase 1; query the catalog first, then trigger a restore only when payload bytes are needed |
| Object Lock bypassed during a compliance audit | `BypassGovernanceRetention` is enabled in the IAM policy | Set `BypassGovernanceRetention=false` and enforce `COMPLIANCE` (not `GOVERNANCE`) mode for regulated datasets |
| Azure Archive upload timeout on 50GB LAS files | Default `--max-concurrency 5` saturates network buffers | Raise `--max-concurrency 16`, set `--blob-type BlockBlob`, and confirm the storage account bandwidth tier |

For authoritative parameters, consult the [AWS S3 RestoreObject API reference](https://docs.aws.amazon.com/AmazonS3/latest/API/API_RestoreObject.html) and the [Azure Blob immutable storage documentation](https://learn.microsoft.com/en-us/azure/storage/blobs/immutable-storage-overview), and validate every spatial transformation against the [GDAL/OGR command reference](https://gdal.org/programs/gdalinfo.html) so coordinate systems are not corrupted during Phase 1 extraction.

## Related

- Up one level: [Object Storage Selection for GIS Archives](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/object-storage-selection-for-gis-archives/) maps storage classes to dataset access frequency and is the parent topic for this provider comparison.
- [Spatial Archival Architecture & Tiering Strategy](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/) is the overarching strategy these cold-storage configurations slot into.
- [Implementing Lifecycle Rules for Shapefile Archives](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/retention-policy-frameworks/implementing-lifecycle-rules-for-shapefile-archives/) covers atomic, sidecar-safe transitions when the payload is a multi-file ESRI dataset rather than a single GeoTIFF.
- [Converting Legacy Shapefiles to GeoParquet at Scale](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/geoparquet-migration-workflows/converting-legacy-shapefiles-to-geoparquet-at-scale/) reduces the object count and per-restore overhead before anything reaches the cold tier.
- [Tuning ZSTD Compression for GeoParquet Archives](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/zstd-level-configuration-for-spatial-files/tuning-zstd-compression-for-geoparquet-archives/) lowers stored bytes — and therefore both retrieval cost and rehydration time — across either provider.
