# Configuring S3 Object Lock for Compliance Spatial Archives

Configuring S3 Object Lock for compliance spatial archives means enforcing Write-Once-Read-Many immutability at the storage layer so regulated geospatial records — environmental baselines, cadastral surveys, defense deliverables — cannot be altered or deleted until a retention clock expires, with legal holds that override any lifecycle rule. This guide is for compliance and infrastructure teams who must produce a legally defensible answer to "prove this survey has not been modified" and cannot rely on application-layer controls that a misconfiguration or a compromised credential could bypass. The subtle decisions are choosing COMPLIANCE versus GOVERNANCE mode correctly, setting a default retention that matches the governing mandate without over-locking, and wiring legal holds so an active hold suspends the lifecycle transitions and expiries described elsewhere in your archive. Get the mode wrong and you either cannot delete data you legally must purge, or you can delete data you legally must keep.

## How a Delete Request Is Evaluated

Object Lock is a stack of independent controls — a legal hold, a retention clock, and a retention mode — each of which can independently block a mutation. Understanding the evaluation order is the whole game:

<svg viewBox="0 0 880 356" role="img" aria-label="Decision flow for a delete or overwrite request against an Object-Lock-protected object. The request first checks whether a legal hold is active; if yes, it is blocked because a legal hold overrides lifecycle. If no hold, it checks whether the retain-until date is still in the future; if the date has passed the delete is permitted. If the retention is still active, the outcome depends on mode: COMPLIANCE mode blocks the delete even for the root account, while GOVERNANCE mode blocks it unless the caller holds the BypassGovernanceRetention permission." xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;color:var(--primary);font-family:var(--font-sans)">
  <title>Object Lock delete-request evaluation flow</title>
  <desc>A delete or overwrite request is evaluated against a legal hold, then the retain-until date, then the retention mode. A legal hold blocks unconditionally; an expired retention permits deletion; active retention blocks under COMPLIANCE even for root, and under GOVERNANCE unless the caller has BypassGovernanceRetention.</desc>
  <defs>
    <marker id="lock-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <g text-anchor="middle">
    <rect x="150" y="20" width="200" height="48" rx="9" fill="currentColor" fill-opacity="0.06" stroke="currentColor" stroke-opacity="0.5"/>
    <text x="250" y="49" font-size="12" font-weight="600" fill="currentColor">DELETE / overwrite</text>
    <rect x="150" y="96" width="200" height="48" rx="9" fill="currentColor" fill-opacity="0.06" stroke="currentColor" stroke-opacity="0.5"/>
    <text x="250" y="125" font-size="12" font-weight="600" fill="currentColor">Legal hold active?</text>
    <rect x="150" y="172" width="200" height="48" rx="9" fill="currentColor" fill-opacity="0.06" stroke="currentColor" stroke-opacity="0.5"/>
    <text x="250" y="195" font-size="11.5" font-weight="600" fill="currentColor">retain-until in</text>
    <text x="250" y="210" font-size="11.5" font-weight="600" fill="currentColor">the future?</text>
    <rect x="150" y="248" width="200" height="48" rx="9" fill="currentColor" fill-opacity="0.06" stroke="currentColor" stroke-opacity="0.5"/>
    <text x="250" y="277" font-size="12" font-weight="600" fill="currentColor">Retention mode?</text>
    <rect x="20" y="172" width="110" height="48" rx="9" fill="currentColor" fill-opacity="0.12" stroke="currentColor" stroke-opacity="0.6"/>
    <text x="75" y="195" font-size="11" font-weight="700" fill="currentColor">Delete</text>
    <text x="75" y="210" font-size="11" font-weight="700" fill="currentColor">permitted</text>
    <rect x="560" y="96" width="300" height="48" rx="9" fill="currentColor" fill-opacity="0.14" stroke="currentColor" stroke-opacity="0.7" stroke-width="1.4"/>
    <text x="710" y="118" font-size="11.5" font-weight="700" fill="currentColor">BLOCKED &#8212; legal hold</text>
    <text x="710" y="134" font-size="10" fill="currentColor" fill-opacity="0.8">overrides lifecycle &amp; expiry</text>
    <rect x="560" y="224" width="300" height="48" rx="9" fill="currentColor" fill-opacity="0.14" stroke="currentColor" stroke-opacity="0.7" stroke-width="1.4"/>
    <text x="710" y="246" font-size="11.5" font-weight="700" fill="currentColor">BLOCKED &#8212; COMPLIANCE</text>
    <text x="710" y="262" font-size="10" fill="currentColor" fill-opacity="0.8">even the root account cannot delete</text>
    <rect x="560" y="284" width="300" height="48" rx="9" fill="currentColor" fill-opacity="0.1" stroke="currentColor" stroke-opacity="0.6" stroke-width="1.4"/>
    <text x="710" y="306" font-size="11.5" font-weight="700" fill="currentColor">BLOCKED &#8212; GOVERNANCE</text>
    <text x="710" y="322" font-size="9.5" fill="currentColor" fill-opacity="0.8">unless caller has BypassGovernanceRetention</text>
  </g>
  <g stroke="currentColor" stroke-width="1.8" fill="none" stroke-opacity="0.55">
    <path d="M250 68 V94" marker-end="url(#lock-arrow)"/>
    <path d="M350 120 H558" marker-end="url(#lock-arrow)"/>
    <path d="M250 144 V170" marker-end="url(#lock-arrow)"/>
    <path d="M150 196 H132" marker-end="url(#lock-arrow)"/>
    <path d="M250 220 V246" marker-end="url(#lock-arrow)"/>
    <path d="M350 268 L558 248" marker-end="url(#lock-arrow)"/>
    <path d="M350 276 L558 305" marker-end="url(#lock-arrow)"/>
  </g>
  <g font-size="9.5" fill="currentColor" fill-opacity="0.75">
    <text x="360" y="112" text-anchor="start">yes</text>
    <text x="262" y="162" text-anchor="start">no</text>
    <text x="140" y="166" text-anchor="middle">expired</text>
    <text x="262" y="240" text-anchor="start">yes (locked)</text>
  </g>
</svg>

## Choosing the Retention Mode

The mode decision is irreversible in one direction and legally consequential, so make it deliberately. GOVERNANCE mode blocks deletions and overwrites for ordinary callers but lets a principal holding the `s3:BypassGovernanceRetention` permission remove the lock — appropriate for internal data-management policies where an administrator must retain a correction path. COMPLIANCE mode blocks everyone, including the root account, until the retain-until date passes; no principal, no permission, and no support ticket can shorten it. Regulatory records that demand tamper-proof custody — the kind an auditor will test — belong in COMPLIANCE. Operational retention that merely enforces internal discipline belongs in GOVERNANCE.

Two constraints shape the rollout. Object Lock can only be enabled on a bucket at creation time (or via support for existing versioned buckets), and it requires versioning. Enforcing [Retention Policy Frameworks](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/retention-policy-frameworks/) therefore starts with the bucket definition itself, not a policy bolted on later.

## Provisioning the Lock in Terraform

Codify the bucket, its default retention, and the mode so the archive's immutability posture is reproducible from source and auditable through pull requests. Map the `days` directly to the governing regulatory window.

```hcl
resource "aws_s3_bucket" "spatial_archive" {
  bucket              = "spatial-archive"
  object_lock_enabled = true
}

resource "aws_s3_bucket_versioning" "spatial_archive" {
  bucket = aws_s3_bucket.spatial_archive.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_object_lock_configuration" "compliance" {
  bucket = aws_s3_bucket.spatial_archive.id

  rule {
    default_retention {
      mode = "COMPLIANCE"
      days = 3650 # 10-year environmental-record retention mandate
    }
  }
}
```

Default retention stamps every newly uploaded object with a retain-until date computed from its upload time — a survey landed today under this configuration is immutable until 2036. Override per object only to lengthen, never to shorten, and record the governing mandate in object metadata so the retention window is self-documenting. These immutable objects are the evidentiary backstop beneath the lifecycle transitions in [Implementing Lifecycle Rules for Shapefile Archives](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/retention-policy-frameworks/implementing-lifecycle-rules-for-shapefile-archives/): a rule may move an object to GLACIER, but Object Lock guarantees it cannot vanish mid-window.

## Applying Legal Holds and Regulatory Mapping

A legal hold is an on/off flag independent of the retention clock. It blocks deletion for as long as it is set, even after the retain-until date passes, which is exactly what a litigation hold on a disputed parcel record requires:

```bash
# Place an indefinite legal hold on a specific survey record
aws s3api put-object-legal-hold --bucket spatial-archive \
  --key survey/2019/environmental_baseline.gpkg \
  --legal-hold '{"Status":"ON"}'

# Set a longer per-object retention than the bucket default (extend only)
aws s3api put-object-retention --bucket spatial-archive \
  --key survey/2019/environmental_baseline.gpkg \
  --retention '{"Mode":"COMPLIANCE","RetainUntilDate":"2040-01-01T00:00:00Z"}'
```

Map each dataset class to the window its mandate dictates rather than applying one blanket duration: a ten-year environmental baseline, a permanent cadastral record held under indefinite legal hold, a seven-year contract deliverable. When a retention window finally expires and deletion is authorized, sanitize according to [NIST SP 800-88 Rev 1](https://csrc.nist.gov/publications/detail/sp/800-88/rev-1/final), treating KMS key destruction as the cloud-native equivalent of media destruction. The CRS lineage and provenance those records carry — asserted upstream by [CRS Synchronization in Pipelines](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/crs-synchronization-in-pipelines/) — are part of the legally significant content the lock protects, not incidental metadata.

Two interactions catch teams out when they extend a lock across a real archive. First, replication and Object Lock must be designed together: to keep an immutable copy in a second region, the destination bucket must itself have Object Lock enabled, and same-mode replication carries the retain-until date across so the replica is protected identically — a replica without its own lock is a deletable back door around the whole scheme. Second, retroactive locking of an existing archive is a batch operation, not a bucket flag. Objects that predate the lock configuration carry no retention, so apply retention to them explicitly with an S3 Batch Operations job that issues `put-object-retention` across the inventory, and verify coverage against a bucket inventory report rather than assuming the default retention reached historical uploads.

Minimum-duration billing is the cost tail of any retention decision. A ten-year COMPLIANCE lock means those objects cannot leave their storage class early without penalty, so the retention window and the tier policy have to agree — locking an object into COMPLIANCE while a lifecycle rule tries to expire it produces a rule that silently no-ops for a decade. Price the locked footprint over its full window, since the commitment is contractual the moment the object lands.

## Verifying Immutability

A lock you have not tested is a lock you do not have. Confirm the configuration, inspect an object's retention, then attempt a deletion and confirm it is refused.

```bash
aws s3api get-object-lock-configuration --bucket spatial-archive \
  --query "ObjectLockConfiguration.Rule.DefaultRetention"
```

Expected output — the mode and window match the mandate:
```text
{
  "Mode": "COMPLIANCE",
  "Days": 3650
}
```

Now prove a delete is actually refused on a locked object:
```bash
aws s3api delete-object --bucket spatial-archive \
  --key survey/2019/environmental_baseline.gpkg \
  --version-id "3sL4kqtJlcpXroDTDmJ+rmSpXd3dIbrHY"
```

Expected result — the storage layer, not the application, refuses:
```text
An error occurred (AccessDenied) when calling the DeleteObject operation:
Access Denied because object protected by object lock.
```
An `AccessDenied` citing object lock is the proof auditors want: the immutability is enforced below any credential. If the delete succeeds, either versioning is disabled, the object predates the lock configuration, or the retain-until date has already passed — each of which is a finding to remediate before certifying the archive.

## Diagnosing Lock Failures

| Symptom | Root Cause | Resolution |
|---------|------------|------------|
| Object deletes despite lock config | Object uploaded before Object Lock was enabled, or no per-object retention applied | Re-copy objects post-configuration; confirm default retention stamps new uploads |
| Cannot enable Object Lock on existing bucket | Lock requires enablement at creation or via support, plus versioning | Create a new locked bucket and migrate; enable versioning first |
| Retention cannot be shortened after error | COMPLIANCE mode forbids shortening even for root | Accept the window; use GOVERNANCE only where a correction path is legally acceptable |
| Object expired but must stay | Retention lapsed with no legal hold set | Apply a legal hold, which overrides expiry until explicitly removed |

## Operational Execution Checklist

- [ ] Enable Object Lock and versioning at bucket creation; migrate to a new bucket if the target predates lock support.
- [ ] Choose COMPLIANCE for tamper-proof regulatory records and GOVERNANCE only where an authorized correction path is required.
- [ ] Set default retention `days` to the governing mandate and record that mandate in object metadata.
- [ ] Override per-object retention only to lengthen the window, never to shorten it.
- [ ] Apply legal holds for litigation and indefinite-custody records, knowing they override lifecycle and expiry.
- [ ] Verify with `get-object-lock-configuration` and prove a delete returns `AccessDenied` on a locked object.
- [ ] Map expiry-time sanitization to NIST SP 800-88, using KMS key destruction as cryptographic erasure.

## Related

- Up: [Retention Policy Frameworks](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/retention-policy-frameworks/) — the parent reference for legally defensible retention across the spatial archive.
- [Implementing Lifecycle Rules for Shapefile Archives](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/retention-policy-frameworks/implementing-lifecycle-rules-for-shapefile-archives/) — the lifecycle transitions that Object Lock guarantees cannot delete data mid-window.
- [How to Design a 3-Tier Spatial Storage Architecture](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/hotwarmcold-tier-design-for-geospatial-data/how-to-design-a-3-tier-spatial-storage-architecture/) — the tier model whose cold destinations these locked objects occupy.
- [Automating CRS Transformations in ETL Pipelines](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/crs-synchronization-in-pipelines/automating-crs-transformations-in-etl-pipelines/) — asserting the CRS lineage that forms part of the locked record's legal content.
- [Spatial Archive Cost Modeling](https://www.spatialdataarchival.org/spatial-archive-cost-modeling/) — accounting for the minimum-duration billing that locked retention windows imply.

_Part of the [Spatial Data Archival](https://www.spatialdataarchival.org/) knowledge base._
