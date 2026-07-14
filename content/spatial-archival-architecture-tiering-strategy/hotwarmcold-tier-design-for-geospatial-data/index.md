# Hot/Warm/Cold Tier Design for Geospatial Data

A single-class storage strategy is the most expensive mistake a geospatial archive makes, because spatial workloads do not have a single access profile — they have several that diverge by orders of magnitude. Live vector tiles and sensor ingestion demand sub-100ms reads, quarterly orthomosaic refreshes tolerate seconds, and a decade-old compliance archive can wait hours. Flatten all of it into one bucket and you either overpay for cold bytes sitting on hot media, or you cold-tier active data and watch retrieval fees and pipeline timeouts spike. This page defines a deterministic hot/warm/cold tier design that maps each spatial dataset's I/O profile to the right storage substrate, enforces every transition through policy-as-code, and proves the configuration with runnable validation rather than assumptions.

## The Failure Mode: Access-Pattern Blindness

The specific inefficiency this design solves is *access-pattern blindness* — provisioning storage from how data was created instead of how it is read. Two patterns recur in spatial archives and both are costly.

The first is **premature cold-tiering**: an aggressive lifecycle rule pushes a basemap or a frequently re-queried LiDAR tile into Glacier or Deep Archive while downstream tile servers and ETL jobs still touch it weekly. Every cache miss now triggers a restore that costs money, adds minutes-to-hours of latency, and incurs an early-deletion penalty if the object is later re-promoted or replaced before its minimum-storage window closes. A single misrouted 2 TB GeoTIFF mosaic can turn a "cheap" archive into a four-figure monthly restore bill.

The second is **hot-tier hoarding**: raw drone captures, intermediate ETL artifacts, and superseded vector snapshots accumulate on Standard-class storage indefinitely because no transition policy exists. Spatial data compounds — UAV photogrammetry and continuous sensor telemetry generate terabytes per project — so the cost of doing nothing grows linearly while the read value of the data decays exponentially.

Tier design fixes both by making the storage class a *computed function of measured access frequency and age*, not a manual decision taken once at ingest and never revisited.

## Prerequisite Context

This page assumes you have the surrounding system from the [Spatial Archival Architecture & Tiering Strategy](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/) already in place. Before configuring tier transitions, confirm three things:

- **A storage backend is chosen and provisioned.** Tier classes (`STANDARD`, `STANDARD_IA`, `GLACIER`, `DEEP_ARCHIVE` on AWS, or the equivalent access tiers on other clouds) differ in minimum-storage duration and retrieval mechanics. Resolve vendor selection first using [Object Storage Selection for GIS Archives](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/object-storage-selection-for-gis-archives/), because the penalty matrix below is provider-specific.
- **Assets are in archive-friendly formats.** Tiering raw, uncompressed rasters wastes both hot and cold capacity. Convert imagery to Cloud-Optimized GeoTIFF and vector layers to columnar formats via the [GeoParquet Migration Workflows](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/geoparquet-migration-workflows/) pipeline before policies take effect, so cold objects are already small and range-readable on restore.
- **Retention requirements are documented.** Transition timing must respect legal holds and grant conditions defined in your [Retention Policy Frameworks](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/retention-policy-frameworks/); a lifecycle rule that deletes a WORM-locked object will simply fail.

If any of these is missing, the tier policy will produce drift or hard errors rather than savings.

## Lifecycle State Transitions

Objects move through tiers on age-based triggers, ending under retention lock:

<svg viewBox="0 0 820 150" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Lifecycle state transitions for archived geospatial objects: an object starts in the Hot tier (STANDARD), transitions to Warm (STANDARD_IA) on day 30, to Cold (GLACIER) on day 90, to Deep Archive (DEEP_ARCHIVE) on day 365, and finally reaches a retention-expiry end state. Each arrow is a policy boundary enforced by the lifecycle engine.">
  <title>Age-Based Lifecycle State Transitions</title>
  <desc>A left-to-right state machine with four tier states — Hot (STANDARD), Warm (STANDARD_IA), Cold (GLACIER), and Deep Archive (DEEP_ARCHIVE) — terminating in a retention-expiry end state drawn as a double circle. The arrow between each pair is labelled with the age threshold and target storage class that triggers the transition: day 30 to STANDARD_IA, day 90 to GLACIER, day 365 to DEEP_ARCHIVE, then expiry.</desc>
  <defs>
    <marker id="st-arr" markerWidth="9" markerHeight="9" refX="6" refY="3" orient="auto">
      <path d="M0,0 L0,6 L8,3 z" fill="currentColor"/>
    </marker>
  </defs>
  <text x="12" y="24" font-size="10" font-family="sans-serif" fill="currentColor" opacity="0.7">Lifecycle state machine: each arrow is a policy boundary, not a human action</text>
  <rect x="12" y="48" width="150" height="50" rx="6" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="87" y="72" text-anchor="middle" font-size="13" font-family="sans-serif" fill="currentColor">Hot</text>
  <text x="87" y="88" text-anchor="middle" font-size="9" font-family="sans-serif" fill="currentColor" opacity="0.65">STANDARD</text>
  <rect x="200" y="48" width="150" height="50" rx="6" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="275" y="72" text-anchor="middle" font-size="13" font-family="sans-serif" fill="currentColor">Warm</text>
  <text x="275" y="88" text-anchor="middle" font-size="9" font-family="sans-serif" fill="currentColor" opacity="0.65">STANDARD_IA</text>
  <rect x="388" y="48" width="150" height="50" rx="6" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="463" y="72" text-anchor="middle" font-size="13" font-family="sans-serif" fill="currentColor">Cold</text>
  <text x="463" y="88" text-anchor="middle" font-size="9" font-family="sans-serif" fill="currentColor" opacity="0.65">GLACIER</text>
  <rect x="576" y="48" width="150" height="50" rx="6" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="651" y="72" text-anchor="middle" font-size="13" font-family="sans-serif" fill="currentColor">Deep Archive</text>
  <text x="651" y="88" text-anchor="middle" font-size="9" font-family="sans-serif" fill="currentColor" opacity="0.65">DEEP_ARCHIVE</text>
  <circle cx="770" cy="73" r="15" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <circle cx="770" cy="73" r="8" fill="currentColor" opacity="0.7"/>
  <line x1="162" y1="73" x2="198" y2="73" stroke="currentColor" stroke-width="1.5" marker-end="url(#st-arr)"/>
  <line x1="350" y1="73" x2="386" y2="73" stroke="currentColor" stroke-width="1.5" marker-end="url(#st-arr)"/>
  <line x1="538" y1="73" x2="574" y2="73" stroke="currentColor" stroke-width="1.5" marker-end="url(#st-arr)"/>
  <line x1="726" y1="73" x2="753" y2="73" stroke="currentColor" stroke-width="1.5" marker-end="url(#st-arr)"/>
  <text x="181" y="116" text-anchor="middle" font-size="9.5" font-family="sans-serif" fill="currentColor" opacity="0.8">day 30</text>
  <text x="181" y="129" text-anchor="middle" font-size="8.5" font-family="sans-serif" fill="currentColor" opacity="0.6">STANDARD_IA</text>
  <text x="369" y="116" text-anchor="middle" font-size="9.5" font-family="sans-serif" fill="currentColor" opacity="0.8">day 90</text>
  <text x="369" y="129" text-anchor="middle" font-size="8.5" font-family="sans-serif" fill="currentColor" opacity="0.6">GLACIER</text>
  <text x="557" y="116" text-anchor="middle" font-size="9.5" font-family="sans-serif" fill="currentColor" opacity="0.8">day 365</text>
  <text x="557" y="129" text-anchor="middle" font-size="8.5" font-family="sans-serif" fill="currentColor" opacity="0.6">DEEP_ARCHIVE</text>
  <text x="748" y="116" text-anchor="middle" font-size="9.5" font-family="sans-serif" fill="currentColor" opacity="0.8">retention</text>
  <text x="748" y="129" text-anchor="middle" font-size="8.5" font-family="sans-serif" fill="currentColor" opacity="0.6">expiry</text>
</svg>

Each arrow is a policy boundary enforced by the lifecycle engine, not a human action. The thresholds shown are starting points; the next section explains how to derive them from real spatial access telemetry rather than copying defaults.

## Concept & Design Decisions

Three tiers map cleanly onto the three access regimes spatial data exhibits. The design decision for each is *which storage class, at which age threshold, with which retrieval expectation* — and every threshold should be justified by the workload, not inherited from a generic example.

- **Hot Tier — active processing and real-time serving.** Optimized for high-throughput, low-latency I/O: NVMe-backed object storage or provisioned-IOPS block volumes with aggressive edge caching. This is where live sensor ingestion (IoT, UAV photogrammetry), dynamic vector tile generation, and iterative ML training live. Latency target: `<50ms`. Keep an object here only while its read frequency justifies premium media — typically the first 30 days, but extend it for canonical basemaps that are queried continuously regardless of age.
- **Warm Tier — periodic analysis and reference.** Standard infrequent-access object storage. Designed for datasets read weekly or monthly: quarterly orthomosaics, historical basemaps, and staging buckets for spatial ETL. Latency tolerance: `1–5s`. The class trades a lower per-GB price for a per-GB retrieval fee, so it only pays off when reads are genuinely sparse — the break-even is roughly one full read per object per month.
- **Cold Tier — compliance archive and immutable preservation.** Archive or deep-archive classes for immutable datasets, decommissioned project archives, legacy shapefile dumps, and regulatory-mandated retention. Retrieval runs from minutes (instant-retrieval archive) to hours (deep archive). Here the priorities invert: WORM compliance, minimum `$/GB`, and explicit early-deletion-penalty modeling matter far more than latency.

**Choosing thresholds from telemetry, not defaults.** The right transition age is the point where the per-GB savings of the colder class exceeds the expected retrieval cost at the observed read rate. Derive it empirically: pull 90 days of access logs, bucket objects by prefix and age, and compute reads-per-object-per-month per age band. Where that rate drops below the warm-tier break-even, set the Hot→Warm threshold; where it approaches zero, set Warm→Cold. For spatial archives the natural boundaries usually fall on project lifecycle events — survey completion, publication of a basemap version, project decommission — so align thresholds to those rather than to round calendar numbers where you can.

**Prefix and tag strategy.** Lifecycle rules in object storage are scoped by key prefix and object tag. Lay out keys so that access regime is encoded in the path — `datasets/imagery/raw/`, `datasets/imagery/published/`, `archive/decommissioned/` — so one rule cleanly targets one regime. Tag-based rules let you carve exceptions (a legal hold, a still-hot historical layer) without rewriting the whole policy.

<svg viewBox="0 0 1000 196" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Comparison matrix of the three storage tiers. Hot tier (STANDARD): latency target under 50 ms, highest price per gigabyte at about $0.023, no minimum-storage window, holds live sensor ingestion, dynamic vector tiles and ML training, retrieved by instant direct read. Warm tier (STANDARD_IA): latency 1 to 5 seconds, about $0.0125 per gigabyte, 30-day minimum, holds quarterly orthomosaics and ETL staging, direct read plus a per-gigabyte retrieval fee. Cold tier (GLACIER or DEEP_ARCHIVE): latency minutes to hours, lowest price near $0.004 or below, 90 to 180-day minimum, holds compliance archives and legacy shapefile dumps, retrieved via an asynchronous restore job.">
  <title>Hot / Warm / Cold Tier Comparison Matrix</title>
  <desc>A three-row table comparing the Hot, Warm and Cold tiers across six attributes: storage class, latency target, price per gigabyte-month, minimum-storage window, typical spatial workload, and retrieval mechanism. Moving from Hot down to Cold, latency tolerance and minimum-storage window rise while per-gigabyte price falls and retrieval shifts from instant reads to asynchronous restore jobs.</desc>
  <rect x="10" y="10" width="980" height="36" fill="currentColor" opacity="0.07"/>
  <rect x="10" y="10" width="980" height="176" fill="none" stroke="currentColor" stroke-width="1.2" opacity="0.5"/>
  <line x1="100" y1="10" x2="100" y2="186" stroke="currentColor" stroke-width="1" opacity="0.3"/>
  <line x1="230" y1="10" x2="230" y2="186" stroke="currentColor" stroke-width="1" opacity="0.3"/>
  <line x1="345" y1="10" x2="345" y2="186" stroke="currentColor" stroke-width="1" opacity="0.3"/>
  <line x1="435" y1="10" x2="435" y2="186" stroke="currentColor" stroke-width="1" opacity="0.3"/>
  <line x1="580" y1="10" x2="580" y2="186" stroke="currentColor" stroke-width="1" opacity="0.3"/>
  <line x1="790" y1="10" x2="790" y2="186" stroke="currentColor" stroke-width="1" opacity="0.3"/>
  <line x1="10" y1="46" x2="990" y2="46" stroke="currentColor" stroke-width="1" opacity="0.3"/>
  <line x1="10" y1="93" x2="990" y2="93" stroke="currentColor" stroke-width="1" opacity="0.3"/>
  <line x1="10" y1="140" x2="990" y2="140" stroke="currentColor" stroke-width="1" opacity="0.3"/>
  <text x="20" y="32" font-size="11" font-family="sans-serif" fill="currentColor" font-weight="600">Tier</text>
  <text x="110" y="32" font-size="11" font-family="sans-serif" fill="currentColor" font-weight="600">Storage class</text>
  <text x="240" y="32" font-size="11" font-family="sans-serif" fill="currentColor" font-weight="600">Latency</text>
  <text x="355" y="32" font-size="11" font-family="sans-serif" fill="currentColor" font-weight="600">$/GB</text>
  <text x="445" y="32" font-size="11" font-family="sans-serif" fill="currentColor" font-weight="600">Min. window</text>
  <text x="590" y="32" font-size="11" font-family="sans-serif" fill="currentColor" font-weight="600">Typical spatial workload</text>
  <text x="800" y="32" font-size="11" font-family="sans-serif" fill="currentColor" font-weight="600">Retrieval mechanism</text>
  <text x="20" y="74" font-size="12" font-family="sans-serif" fill="currentColor">Hot</text>
  <text x="110" y="74" font-size="9.5" font-family="sans-serif" fill="currentColor">STANDARD</text>
  <text x="240" y="74" font-size="9.5" font-family="sans-serif" fill="currentColor">&lt; 50 ms</text>
  <text x="355" y="74" font-size="9.5" font-family="sans-serif" fill="currentColor">~$0.023</text>
  <text x="445" y="74" font-size="9.5" font-family="sans-serif" fill="currentColor">none</text>
  <text x="590" y="68" font-size="9.5" font-family="sans-serif" fill="currentColor">live sensor ingest, vector</text>
  <text x="590" y="82" font-size="9.5" font-family="sans-serif" fill="currentColor">tiles, ML training</text>
  <text x="800" y="74" font-size="9.5" font-family="sans-serif" fill="currentColor">instant direct read</text>
  <text x="20" y="121" font-size="12" font-family="sans-serif" fill="currentColor">Warm</text>
  <text x="110" y="121" font-size="9.5" font-family="sans-serif" fill="currentColor">STANDARD_IA</text>
  <text x="240" y="121" font-size="9.5" font-family="sans-serif" fill="currentColor">1&#8211;5 s</text>
  <text x="355" y="121" font-size="9.5" font-family="sans-serif" fill="currentColor">~$0.0125</text>
  <text x="445" y="121" font-size="9.5" font-family="sans-serif" fill="currentColor">30 days</text>
  <text x="590" y="115" font-size="9.5" font-family="sans-serif" fill="currentColor">quarterly orthomosaics,</text>
  <text x="590" y="129" font-size="9.5" font-family="sans-serif" fill="currentColor">ETL staging buckets</text>
  <text x="800" y="115" font-size="9.5" font-family="sans-serif" fill="currentColor">direct read +</text>
  <text x="800" y="129" font-size="9.5" font-family="sans-serif" fill="currentColor">per-GB retrieval fee</text>
  <text x="20" y="168" font-size="12" font-family="sans-serif" fill="currentColor">Cold</text>
  <text x="110" y="164" font-size="9.5" font-family="sans-serif" fill="currentColor">GLACIER /</text>
  <text x="110" y="178" font-size="9.5" font-family="sans-serif" fill="currentColor">DEEP_ARCHIVE</text>
  <text x="240" y="168" font-size="9.5" font-family="sans-serif" fill="currentColor">minutes&#8211;hours</text>
  <text x="355" y="168" font-size="9.5" font-family="sans-serif" fill="currentColor">&#8804;$0.004</text>
  <text x="445" y="168" font-size="9.5" font-family="sans-serif" fill="currentColor">90&#8211;180 days</text>
  <text x="590" y="162" font-size="9.5" font-family="sans-serif" fill="currentColor">compliance archive,</text>
  <text x="590" y="176" font-size="9.5" font-family="sans-serif" fill="currentColor">legacy shapefile dumps</text>
  <text x="800" y="168" font-size="9.5" font-family="sans-serif" fill="currentColor">async restore job</text>
</svg>

## Implementation

Manual tiering fails at scale, and clicking storage classes in a console produces undocumented drift. Codify the policy as infrastructure-as-code so transitions are deterministic, reviewable, and reproducible across buckets and regions. The configuration below is a production-grade AWS S3 lifecycle policy tuned for geospatial assets: it enforces age-based transitions, aborts orphaned multipart uploads (large GeoTIFF and LAZ uploads frequently fail partway and leave billable fragments), expires superseded object versions, and sets a hard retention horizon.

```json
{
  "Rules": [
    {
      "ID": "Geospatial_Lifecycle_Policy_v2",
      "Status": "Enabled",
      "Filter": { "Prefix": "datasets/imagery/raw/" },
      "Transitions": [
        { "Days": 30, "StorageClass": "STANDARD_IA" },
        { "Days": 90, "StorageClass": "GLACIER" },
        { "Days": 365, "StorageClass": "DEEP_ARCHIVE" }
      ],
      "NoncurrentVersionTransitions": [
        { "NoncurrentDays": 14, "StorageClass": "STANDARD_IA" }
      ],
      "AbortIncompleteMultipartUpload": { "DaysAfterInitiation": 7 },
      "Expiration": { "Days": 2555 }
    }
  ]
}
```

Apply it with the CLI rather than the console so the policy lives in version control alongside the rest of the archive's infrastructure:

```bash
# Attach the lifecycle policy to the imagery archive bucket
aws s3api put-bucket-lifecycle-configuration \
  --bucket geo-archive-prod \
  --lifecycle-configuration file://geospatial-lifecycle.json
```

A few spatial-specific choices in that policy are worth calling out. The `AbortIncompleteMultipartUpload` rule is mandatory for geospatial buckets because terabyte-scale point clouds and mosaics are uploaded in parts; a failed network transfer otherwise leaves invisible, billed fragments forever. The 7-day window is generous enough for legitimate resumable uploads but reclaims abandoned ones quickly. The `Expiration` at 2555 days (seven years) encodes a common records-retention horizon — set yours from the legal requirement, not the example. Keep the cold-tier classes (`GLACIER`, `DEEP_ARCHIVE`) for objects you have already confirmed are range-readable after restore; pairing them with Cloud-Optimized GeoTIFF means a restored object can be partially read rather than fully re-downloaded.

## Validation Gate

A lifecycle policy that exists is not the same as a lifecycle policy that works. Confirm the configuration is attached and that objects are actually landing in the expected class. First, read back the live policy:

```bash
aws s3api get-bucket-lifecycle-configuration --bucket geo-archive-prod
```

Expected output is the JSON document you applied, echoed back with every rule `"Status": "Enabled"`. If the command returns `NoSuchLifecycleConfiguration`, the policy never attached — re-run the `put-bucket-lifecycle-configuration` call and check the bucket name and IAM permissions.

Then verify a representative object has transitioned to the class its age implies:

```bash
aws s3api head-object \
  --bucket geo-archive-prod \
  --key datasets/imagery/raw/2024/region_north_mosaic.tif \
  --query 'StorageClass'
```

For an object older than 90 days you expect `"GLACIER"`. The most common failure here is the command returning `null` (i.e. `STANDARD`) for an object that is clearly past its transition age. The root cause is almost always a **prefix mismatch**: the lifecycle `Filter` targets `datasets/imagery/raw/` but the object was written to `datasets/imagery/raw-2024/` or `imagery/raw/`. Lifecycle filters are exact prefix matches, not globs, so a single divergent path segment silently excludes whole subtrees. Audit your actual key layout against the rule's prefix before assuming the policy is broken. The second most common cause is that the object is genuinely younger than it looks because it was re-uploaded (a new `LastModified` resets the transition clock) — check `head-object`'s `LastModified` against the rule's `Days`.

## Cost & Performance Trade-offs

Cold storage looks free until the first restore. Model three cost dimensions explicitly before committing thresholds.

**Early-deletion penalties.** Each archive class bills a minimum-storage duration regardless of when you actually delete or overwrite the object. Transitioning or deleting before that window charges the remainder. The matrix below shows AWS minimums; consult the [AWS S3 Lifecycle Management](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lifecycle-mgmt.html) documentation for current values and replicate the table for your provider.

| Storage class | Minimum storage duration | Early-deletion charge if removed sooner |
|---|---|---|
| `STANDARD` | none | none |
| `STANDARD_IA` | 30 days | prorated remainder of 30 days |
| `GLACIER` (Flexible) | 90 days | prorated remainder of 90 days |
| `DEEP_ARCHIVE` | 180 days | prorated remainder of 180 days |

The trap for spatial pipelines: an ETL job that re-publishes a basemap every month will, if pointed at a Glacier-tiered prefix, pay the 90-day penalty on every overwrite. Keep frequently-rewritten outputs in Standard or Standard-IA and reserve archive classes for objects that are genuinely immutable.

**Retrieval tiers.** Restores come in speed grades — expedited, standard, and bulk — at inversely-related prices. A multi-terabyte LiDAR or GeoTIFF restore is exactly where bulk pays off, because the dataset is rarely needed in minutes. Align the restore tier to operational urgency, and budget the per-GB retrieval fee plus the egress to wherever the data is processed.

| Restore tier | Typical latency (deep archive) | Relative cost | Spatial use case |
|---|---|---|---|
| Expedited | minutes | highest | single urgent tile or scene for an incident response |
| Standard | hours | medium | a project folder pulled for re-analysis |
| Bulk | up to 12 hours | lowest | full multi-terabyte point-cloud or mosaic restore |

**Intelligent tiering.** When access is genuinely unpredictable — a research archive where any historical layer might be re-queried at any time — an automated monitoring tier can shift objects on observed request frequency, trading a small per-object monitoring fee for the elimination of guesswork. It is the right default only when you cannot characterize the access pattern; where you can, explicit lifecycle rules are cheaper and more predictable.

## Failure Modes & Edge Cases

Four pitfalls are specific to geospatial workloads and account for most tiering incidents.

1. **CRS and metadata loss masquerading as a tiering bug.** Restored objects that fail to load are sometimes blamed on the storage tier when the real cause is a format conversion upstream that dropped the coordinate reference system or projection metadata. A cold object is only as useful as its metadata; validate CRS integrity at conversion time and re-check it post-restore, cross-referencing the catalog built in [Metadata Cataloging & Discovery](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/metadata-cataloging-discovery/). Corrupt spatial metadata renders archived data operationally useless regardless of how cheaply it was stored.
2. **Multipart fragments inflating cost invisibly.** Large spatial uploads fail mid-transfer and leave incomplete multipart parts that the console does not show but the bill does. Without the `AbortIncompleteMultipartUpload` rule from the implementation above, these accumulate indefinitely. Periodically run `aws s3api list-multipart-uploads --bucket geo-archive-prod` to confirm none are lingering.
3. **Restore-window starvation on partial reads.** Cloud-Optimized GeoTIFF and range-readable formats let an application read a sub-window after restore, but the restore makes the *whole object* temporarily available for only a set number of days. A tile server that restores on demand can re-trigger (and re-pay) restores if the window expires between reads. Set restore retention to span the expected re-read interval, or promote the object to warm if access has clearly resumed.
4. **Versioned overwrites resetting the transition clock.** Spatial pipelines that re-publish layers create new object versions; the noncurrent versions, not the current one, are what should age into cold storage. Without a `NoncurrentVersionTransitions` rule, superseded basemap versions sit on hot storage forever while you assume the policy handled them.

## Operational Execution Checklist

- [ ] Derive transition thresholds from 90 days of access logs, not from copied defaults
- [ ] Encode access regime in the key prefix layout (`raw/`, `published/`, `archive/`)
- [ ] Codify the lifecycle policy as IaC and commit it to version control
- [ ] Include an `AbortIncompleteMultipartUpload` rule on every geospatial bucket
- [ ] Add `NoncurrentVersionTransitions` so superseded layer versions age into cold storage
- [ ] Confirm cold-tiered objects are Cloud-Optimized / range-readable before transition
- [ ] Validate the live policy with `get-bucket-lifecycle-configuration` and `head-object`
- [ ] Model early-deletion penalties before pointing any rewriting pipeline at archive classes
- [ ] Run quarterly test restores of a representative GeoTIFF and LAZ to validate SLA and budget
- [ ] Re-verify CRS and projection metadata on restored objects against the catalog

## Compliance Alignment

Geospatial archives frequently fall under strict retention frameworks (NARA schedules, SEC Rule 17a-4, GDPR, and ISO 19115 metadata standards). Apply Object Lock or WORM policies at the bucket level so cold-tiered data cannot be modified or deleted before its retention horizon, and align media-sanitization practices with the [NIST SP 800-88 Rev. 1](https://csrc.nist.gov/publications/detail/sp/800-88/rev-1/final) guidelines when decommissioning legacy storage nodes. Keep metadata interoperable with the [OGC standards](https://www.ogc.org/standards/) so that archived layers remain discoverable and loadable across GIS platforms years after the engineers who archived them have moved on.

## Related

- [Spatial Archival Architecture & Tiering Strategy](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/) — the parent guide this tier design fits inside; start there for the end-to-end lifecycle.
- [Object Storage Selection for GIS Archives](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/object-storage-selection-for-gis-archives/) — choose the storage backend whose class minimums and retrieval mechanics the thresholds here depend on.
- [Retention Policy Frameworks](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/retention-policy-frameworks/) — the WORM and legal-hold rules that constrain how aggressively you can transition.
- [Metadata Cataloging & Discovery](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/metadata-cataloging-discovery/) — keeps cold objects discoverable and validates CRS integrity across transitions.
- [GeoParquet Migration Workflows](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/geoparquet-migration-workflows/) — convert vector layers to a range-readable columnar format before they reach cold storage.

For the full reference covering capacity planning, network topology, failover routing, and cross-tier movement orchestration, work through [How to Design a 3-Tier Spatial Storage Architecture](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/hotwarmcold-tier-design-for-geospatial-data/how-to-design-a-3-tier-spatial-storage-architecture/).
