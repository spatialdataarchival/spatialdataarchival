# Retention Policy Frameworks

A retention policy framework is the deterministic control plane that decides when a geospatial asset moves from active compute to cold storage, when it becomes immutable, and when — if ever — it is permitted to be deleted. The failure this page solves is *retention by convention*: lifecycle decisions left to ad-hoc administrative cleanup, where a frequently joined basemap gets purged on a calendar timer while a decade of superseded drone captures quietly accrues Standard-class charges, and where no immutable audit trail exists to prove to a regulator that a litigation-held dataset was never touched. This guide is for the data engineers, GIS archivists, and cloud architects who must engineer retention as executable state machines — codified in infrastructure-as-code, validated before any irreversible action, and auditable at the individual object level.

## The Failure Mode: Retention Drift

Retention drift is the gap between the policy a compliance team believes is in force and the lifecycle rules actually executing against the bucket. It manifests in three recurring ways across spatial archives, and each one is expensive.

The first is **policy-without-immutability**: a lifecycle rule transitions objects to an archive tier but nothing prevents an over-privileged ETL role or a `terraform destroy` from deleting them inside their mandated retention window. A regulator does not accept "we had a deletion-protection policy"; they require WORM (Write Once, Read Many) enforcement at the storage layer that even the account root cannot override.

The second is **uniform expiry on non-uniform data**. Geospatial workloads have wildly divergent decay curves — high-frequency raster time-series, LiDAR point clouds, and transactional vector feature classes all age at different rates. A single 365-day expiration rule applied across a bucket simultaneously over-retains ephemeral processing intermediates and prematurely archives reference layers that downstream tile servers still query weekly.

The third is **replica divergence**: a legal hold suspends deletion on the primary bucket but the cross-region replica keeps executing its own expiration timer, silently destroying the very evidence the hold was meant to preserve. Retention that is not enforced identically across every replica is not enforced at all.

A retention framework fixes all three by making the retention class a tagged, computed property of each dataset, by binding that class to a hardware-enforced lock mode, and by propagating both across every replica and into the discovery catalog.

## Retention Enforcement Flow

Retention is enforced from ingest through audit, not bolted on later:

<svg viewBox="0 0 900 240" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Retention lifecycle state machine for a geospatial object. An object enters the Ingested state on STANDARD storage while untagged, transitions on classification (a retention-class tag applied at ingest) to Classified, then on applying Object Lock to Locked in either COMPLIANCE or GOVERNANCE mode, then on a lifecycle rule to Transitioned, where it moves IA to Glacier to Deep Archive, and finally to the Expiry-Eligible end state once the retention window elapses. A separate Legal Hold state is orthogonal to the retention timer: when a hold is applied it freezes all transitions, and on release the lifecycle resumes.">
  <title>Object Retention Lifecycle State Machine with Legal Hold</title>
  <desc>A left-to-right state machine with five states — Ingested (STANDARD, untagged), Classified (retention-class tag), Locked (COMPLIANCE or GOVERNANCE), Transitioned (IA to Glacier to Deep Archive), and an Expiry-Eligible end state drawn as a double circle. Each arrow is a policy-driven transition: classify and tag, apply Object Lock, lifecycle rule, and window-elapsed expiry. Above the Transitioned state sits a Legal Hold state connected by two arrows — one that freezes transitions when a hold is applied and one that resumes the lifecycle on release — showing that a hold is orthogonal to the retention timer.</desc>
  <defs>
    <marker id="rp-arr" markerWidth="9" markerHeight="9" refX="6" refY="3" orient="auto">
      <path d="M0,0 L0,6 L8,3 z" fill="currentColor"/>
    </marker>
  </defs>
  <text x="14" y="16" font-size="10" font-family="sans-serif" fill="currentColor" opacity="0.7">Retention state machine: every arrow is a policy-enforced transition, not a manual action</text>
  <!-- Legal Hold (orthogonal) -->
  <rect x="500" y="30" width="230" height="46" rx="6" fill="currentColor" fill-opacity="0.06" stroke="currentColor" stroke-width="1.5" stroke-dasharray="5 3"/>
  <text x="615" y="51" text-anchor="middle" font-size="12.5" font-family="sans-serif" fill="currentColor">Legal Hold</text>
  <text x="615" y="66" text-anchor="middle" font-size="8.5" font-family="sans-serif" fill="currentColor" opacity="0.65">open-ended, no fixed expiry</text>
  <!-- hold apply / release arrows -->
  <line x1="600" y1="78" x2="600" y2="116" stroke="currentColor" stroke-width="1.3" marker-end="url(#rp-arr)"/>
  <line x1="630" y1="116" x2="630" y2="78" stroke="currentColor" stroke-width="1.3" marker-end="url(#rp-arr)"/>
  <text x="594" y="100" text-anchor="end" font-size="8.5" font-family="sans-serif" fill="currentColor" opacity="0.8">freeze on hold</text>
  <text x="636" y="100" text-anchor="start" font-size="8.5" font-family="sans-serif" fill="currentColor" opacity="0.8">resume on release</text>
  <!-- main states -->
  <rect x="14" y="120" width="118" height="52" rx="6" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="73" y="143" text-anchor="middle" font-size="12.5" font-family="sans-serif" fill="currentColor">Ingested</text>
  <text x="73" y="159" text-anchor="middle" font-size="8.5" font-family="sans-serif" fill="currentColor" opacity="0.65">STANDARD, untagged</text>
  <rect x="168" y="120" width="140" height="52" rx="6" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="238" y="143" text-anchor="middle" font-size="12.5" font-family="sans-serif" fill="currentColor">Classified</text>
  <text x="238" y="159" text-anchor="middle" font-size="8.5" font-family="sans-serif" fill="currentColor" opacity="0.65">retention-class tag</text>
  <rect x="344" y="120" width="150" height="52" rx="6" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="419" y="143" text-anchor="middle" font-size="12.5" font-family="sans-serif" fill="currentColor">Locked</text>
  <text x="419" y="159" text-anchor="middle" font-size="8.5" font-family="sans-serif" fill="currentColor" opacity="0.65">COMPLIANCE / GOVERNANCE</text>
  <rect x="530" y="120" width="170" height="52" rx="6" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="615" y="143" text-anchor="middle" font-size="12.5" font-family="sans-serif" fill="currentColor">Transitioned</text>
  <text x="615" y="159" text-anchor="middle" font-size="8.5" font-family="sans-serif" fill="currentColor" opacity="0.65">IA &#8594; Glacier &#8594; Deep Archive</text>
  <circle cx="788" cy="146" r="17" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <circle cx="788" cy="146" r="9" fill="currentColor" opacity="0.7"/>
  <!-- transitions -->
  <line x1="132" y1="146" x2="166" y2="146" stroke="currentColor" stroke-width="1.5" marker-end="url(#rp-arr)"/>
  <line x1="308" y1="146" x2="342" y2="146" stroke="currentColor" stroke-width="1.5" marker-end="url(#rp-arr)"/>
  <line x1="494" y1="146" x2="528" y2="146" stroke="currentColor" stroke-width="1.5" marker-end="url(#rp-arr)"/>
  <line x1="700" y1="146" x2="769" y2="146" stroke="currentColor" stroke-width="1.5" marker-end="url(#rp-arr)"/>
  <text x="149" y="190" text-anchor="middle" font-size="9" font-family="sans-serif" fill="currentColor" opacity="0.8">classify</text>
  <text x="149" y="202" text-anchor="middle" font-size="8.5" font-family="sans-serif" fill="currentColor" opacity="0.6">+ tag</text>
  <text x="325" y="190" text-anchor="middle" font-size="9" font-family="sans-serif" fill="currentColor" opacity="0.8">apply</text>
  <text x="325" y="202" text-anchor="middle" font-size="8.5" font-family="sans-serif" fill="currentColor" opacity="0.6">Object Lock</text>
  <text x="511" y="190" text-anchor="middle" font-size="9" font-family="sans-serif" fill="currentColor" opacity="0.8">lifecycle</text>
  <text x="511" y="202" text-anchor="middle" font-size="8.5" font-family="sans-serif" fill="currentColor" opacity="0.6">rule</text>
  <text x="734" y="190" text-anchor="middle" font-size="9" font-family="sans-serif" fill="currentColor" opacity="0.8">window</text>
  <text x="734" y="202" text-anchor="middle" font-size="8.5" font-family="sans-serif" fill="currentColor" opacity="0.6">elapsed</text>
  <text x="788" y="190" text-anchor="middle" font-size="9.5" font-family="sans-serif" fill="currentColor" opacity="0.8">Expiry-Eligible</text>
  <text x="788" y="202" text-anchor="middle" font-size="8.5" font-family="sans-serif" fill="currentColor" opacity="0.6">deletion permitted</text>
</svg>

## Prerequisite Context

This page assumes the surrounding system from the [Spatial Archival Architecture & Tiering Strategy](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/) is already operating. A retention framework is the enforcement layer on top of that architecture, not a replacement for it, so confirm three things are in place before you enable any irreversible rule:

- **Storage classes and a tier model are configured.** Retention windows attach to objects that already live in the right class. Resolve the tier transitions first with the [Hot/Warm/Cold Tier Design for Geospatial Data](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/hotwarmcold-tier-design-for-geospatial-data/), because the expiry and minimum-storage interactions below depend on which class an object lands in.
- **A backend with immutable-lock support is selected.** Compliance-grade retention requires Object Lock or its equivalent, and the available lock modes differ by provider. Settle vendor selection through [Object Storage Selection for GIS Archives](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/object-storage-selection-for-gis-archives/) first; Object Lock must be enabled *at bucket creation* and cannot be retrofitted.
- **A metadata catalog exists to receive status changes.** When an object crosses a retention boundary its discovery record must change too. Wire the framework into [Metadata Cataloging & Discovery](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/metadata-cataloging-discovery/) so that archived assets stop being advertised by live WFS/WCS endpoints.

## Concept & Design Decisions

Three decisions define a retention framework: the lock mode, the classification scheme, and the transition thresholds.

### Lock mode: Compliance vs. Governance

Object Lock offers two modes and choosing wrong is a compliance finding waiting to happen.

- **Compliance mode** blocks deletion and retention-shortening for the entire window, for *every* principal including the account root. Use it for datasets under a statutory or contractual retention mandate — cadastral records, environmental impact baselines, anything a regulator can subpoena. It cannot be undone, so a fat-fingered 100-year window is permanent.
- **Governance mode** blocks the same operations but permits principals holding `s3:BypassGovernanceRetention` to override. Use it as the default for operational data where you need deletion protection but must retain an authorized escape hatch for genuine errors.

Legal holds are orthogonal to both: a hold is an open-ended, flag-based suspension of deletion with no fixed expiry, applied and released independently of the retention timer. Litigation uses holds; statute uses Compliance-mode retention.

### Classification by dataset class, not creation date

Lifecycle rules must be parameterized by *what the data is*, not merely *when it was created*. Drive every rule from object tags applied at ingest, so the policy engine evaluates dataset class, derivative status, and access recency rather than a blanket age timer. A workable baseline taxonomy:

| `retention-class` tag | Example assets | Lock mode | Min retention | Transition schedule |
|---|---|---|---|---|
| `regulatory` | Cadastral, flood-zone, EIA baselines | Compliance | 7–30 yr | Glacier @ 90d, no expiry |
| `reference` | Active basemaps, admin boundaries | Governance | 3 yr | Standard-IA @ 60d |
| `derivative` | Tiles, COG overviews, rendered mosaics | Governance | 90 d | IA @ 30d, expire @ 365d |
| `ephemeral` | ETL intermediates, scratch reprojections | none | — | expire @ 14d |

### Transition thresholds tied to spatial I/O

Premature archival of frequently joined layers introduces unacceptable restore latency and early-deletion penalties; over-retention of intermediates inflates monthly spend. Evaluate multiple signals before triggering a transition: dataset age, last-access timestamp, derivative-generation status, spatial-index freshness, and query SLA. A reference basemap that backs a live tile service should never be eligible for an archive tier regardless of age, which is why the `reference` class above stops at Standard-IA. Abstract these provider-specific constraints behind a single policy-as-code layer (Terraform, Crossplane, or Open Policy Agent) so the same intent enforces identically across regions and clouds.

## Implementation

The following Terraform provisions an Object Lock-enabled archive bucket and binds tag-scoped lifecycle rules to the taxonomy above. Object Lock requires versioning and must be declared at bucket creation.

```hcl
# archive bucket — Object Lock MUST be enabled at creation, not retrofitted
resource "aws_s3_bucket" "spatial_archive" {
  bucket              = "org-spatial-archive-prod"
  object_lock_enabled = true
}

resource "aws_s3_bucket_versioning" "spatial_archive" {
  bucket = aws_s3_bucket.spatial_archive.id
  versioning_configuration { status = "Enabled" }
}

# default COMPLIANCE retention for regulatory geospatial records (7 years)
resource "aws_s3_bucket_object_lock_configuration" "spatial_archive" {
  bucket = aws_s3_bucket.spatial_archive.id
  rule {
    default_retention {
      mode = "COMPLIANCE"
      days = 2557 # 7 years; immutable even to account root
    }
  }
}

# tag-scoped lifecycle: each rule filters on the retention-class tag set at ingest
resource "aws_s3_bucket_lifecycle_configuration" "spatial_archive" {
  bucket = aws_s3_bucket.spatial_archive.id

  rule {
    id     = "regulatory-deep-archive"
    status = "Enabled"
    filter { tag { key = "retention-class", value = "regulatory" } }
    transition { days = 90, storage_class = "DEEP_ARCHIVE" }
    # no expiration — Compliance lock governs deletion
  }

  rule {
    id     = "reference-warm"
    status = "Enabled"
    filter { tag { key = "retention-class", value = "reference" } }
    transition { days = 60, storage_class = "STANDARD_IA" }
  }

  rule {
    id     = "derivative-tiles"
    status = "Enabled"
    filter { tag { key = "retention-class", value = "derivative" } }
    transition { days = 30, storage_class = "STANDARD_IA" }
    expiration { days = 365 } # rendered tiles are regenerable
  }

  rule {
    id     = "ephemeral-scratch"
    status = "Enabled"
    filter { tag { key = "retention-class", value = "ephemeral" } }
    expiration { days = 14 }
    # clean up failed multipart uploads of large rasters/point clouds
    abort_incomplete_multipart_upload { days_after_initiation = 7 }
  }
}
```

Apply the `retention-class` tag at ingest, never as a later batch job — an object that lands untagged falls through every filter and is silently retained forever on Standard. A minimal ingest tagging call:

```bash
aws s3api put-object \
  --bucket org-spatial-archive-prod \
  --key datasets/cadastral/2026/parcels_region_north.gpkg \
  --body parcels_region_north.gpkg \
  --tagging "retention-class=regulatory&compliance-tier=verified" \
  --object-lock-mode COMPLIANCE \
  --object-lock-retain-until-date 2033-06-26T00:00:00Z
```

## Validation Gate

Never enable irreversible rules without a dry run. Validate in three checks before and after rollout.

First, confirm the lock configuration is actually `COMPLIANCE` and not silently absent:

```bash
aws s3api get-object-lock-configuration --bucket org-spatial-archive-prod
```

Expected output — the mode and window must match your intent exactly:

```json
{
  "ObjectLockConfiguration": {
    "ObjectLockEnabled": "Enabled",
    "Rule": { "DefaultRetention": { "Mode": "COMPLIANCE", "Days": 2557 } }
  }
}
```

Second, prove an object is genuinely immutable by attempting a delete that *should* fail:

```bash
aws s3api delete-object \
  --bucket org-spatial-archive-prod \
  --key datasets/cadastral/2026/parcels_region_north.gpkg
# Expected: An error occurred (AccessDenied) — Object is WORM protected
```

Third, surface objects that escaped classification, since these are the silent cost and compliance leak:

```bash
aws s3api list-objects-v2 --bucket org-spatial-archive-prod \
  --query "Contents[].Key" --output text | tr '\t' '\n' | while read k; do
    t=$(aws s3api get-object-tagging --bucket org-spatial-archive-prod --key "$k" \
        --query "TagSet[?Key=='retention-class'].Value" --output text)
    [ -z "$t" ] && echo "UNCLASSIFIED: $k"
  done
# Expected output: (empty) — every object carries a retention-class tag
```

**Most common failure — the delete in check two *succeeds*.** The root cause is almost always that Object Lock was never enabled at bucket creation: a lifecycle `expiration` rule or a versioning-only config gives the appearance of retention without WORM enforcement. Object Lock cannot be turned on after the fact, so the remediation is to create a new lock-enabled bucket and re-replicate the data into it — there is no in-place fix.

## Cost & Performance Trade-offs

Retention decisions are storage-economics decisions. The dominant levers are minimum-storage duration (which creates early-deletion penalties), retrieval pricing, and the per-object overhead that punishes small-file spatial archives.

| Storage class | Min-storage window | Early-delete penalty | Retrieval latency | Best-fit retention class |
|---|---|---|---|---|
| Standard | none | none | ms | freshly ingested, pre-classification |
| Standard-IA | 30 days | charged to 30 d | ms | `reference` basemaps |
| Glacier Flexible | 90 days | charged to 90 d | minutes–hours | aging `regulatory` |
| Deep Archive | 180 days | charged to 180 d | up to 12 h | long-horizon `regulatory` |

Two spatial-specific cost effects dominate the matrix. **Early-deletion penalties** make premature transitions actively worse than doing nothing: archive a 2 TB orthomosaic to Deep Archive, discover next week a downstream pipeline still needs it, and you pay the full 180-day storage charge plus a bulk retrieval fee to get it back. **Per-object minimum billing** punishes archives of many small vector files — a Glacier tier bills a minimum object size, so a folder of thousands of tiny GeoJSON tiles costs far more than its byte count suggests. Consolidate small features before archival; tuning [ZSTD Level Configuration for Spatial Files](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/zstd-level-configuration-for-spatial-files/) on the consolidated objects compounds the saving by shrinking the bytes that sit under the long retention window.

## Failure Modes & Edge Cases

- **Multi-file legacy formats transition non-atomically.** A Shapefile is not one object — it is `.shp` + `.shx` + `.dbf` + `.prj` (and often `.cpg`/`.sbn`). Tag-scoped lifecycle rules can move the `.shp` while leaving a sidecar on a different timer, producing an unreadable archive. Route these through the dedicated [lifecycle rules for Shapefile archives](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/retention-policy-frameworks/implementing-lifecycle-rules-for-shapefile-archives/) procedure, which keeps the sibling files on one rule, or convert to a single-object format first.
- **Replica retention drift.** A legal hold or Compliance window on the primary does not automatically apply to a cross-region replica. Replication must propagate the lock state, and a hold must suspend expiration on *every* replica simultaneously, or the replica becomes the deletion path that defeats the hold.
- **Catalog desync on transition.** When an object cold-tiers, its live service endpoints (WFS/WCS/tile servers) must be deprecated and discovery routed to an archived proxy. If the catalog is not updated bidirectionally, analysts hit stale cache entries or broken spatial joins and assume data loss.
- **Compliance-mode over-commitment.** A Compliance window cannot be shortened by anyone. A misconfigured 100-year default on a `derivative` class permanently blocks deletion of regenerable tiles, inflating storage indefinitely. Default-retention values belong in version-controlled IaC and code review, never a console click.

## Operational Execution Checklist

- [ ] Object Lock enabled **at bucket creation** with versioning on (verified via `get-object-lock-configuration`).
- [ ] Lock mode chosen deliberately per class — Compliance for statutory data, Governance elsewhere.
- [ ] `retention-class` and `compliance-tier` tags applied at ingest, not as a later batch.
- [ ] Lifecycle rules filter on tags, not blanket age; `ephemeral` and `derivative` carry expirations.
- [ ] `abort_incomplete_multipart_upload` set to clean up failed large-raster/point-cloud uploads.
- [ ] Dry-run executed and predicted transitions/deletions reviewed before enabling irreversible rules.
- [ ] WORM immutability proven with a delete that returns `AccessDenied`.
- [ ] No unclassified objects remain (validation sweep returns empty).
- [ ] Replica buckets inherit identical retention windows and lock states; holds suspend deletion on all replicas.
- [ ] Legal-hold override path is IAM-bound and audit-logged.
- [ ] Metadata catalog updated on every transition; live endpoints deprecated for archived assets.
- [ ] Execution monitored — `retention_policy_evaluations_total`, `tier_transition_latency_ms`, `compliance_violations_count` — with alerts on deletion spikes and replication drift.

For authoritative lifecycle-configuration syntax and retention semantics, consult the [AWS S3 Object Lifecycle Management documentation](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lifecycle-mgmt.html), and align audit and sanitization controls with the [NIST SP 800-88 Rev. 1 guidelines](https://www.nist.gov/publications/guidelines-media-sanitization) for secure media sanitization and records management.

## Related

- Up one level: the [Spatial Archival Architecture & Tiering Strategy](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/) sets the lifecycle this framework enforces.
- The [Hot/Warm/Cold Tier Design for Geospatial Data](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/hotwarmcold-tier-design-for-geospatial-data/) defines the transitions that retention rules attach to.
- [Object Storage Selection for GIS Archives](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/object-storage-selection-for-gis-archives/) determines which lock modes and archive tiers are available.
- [Metadata Cataloging & Discovery](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/metadata-cataloging-discovery/) receives the visibility changes a retention transition triggers.
- [Implementing Lifecycle Rules for Shapefile Archives](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/retention-policy-frameworks/implementing-lifecycle-rules-for-shapefile-archives/) handles the multi-file atomicity edge case.
- Cross-domain: shrink the bytes under long retention windows with [ZSTD Level Configuration for Spatial Files](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/zstd-level-configuration-for-spatial-files/).
