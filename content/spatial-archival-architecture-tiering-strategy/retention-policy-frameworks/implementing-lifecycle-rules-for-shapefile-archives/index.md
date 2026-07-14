# Implementing Lifecycle Rules for Shapefile Archives: Atomic Tiering and Integrity Validation

Cloud-native object storage evaluates lifecycle policies at the individual key level, which directly conflicts with the multi-file architecture of ESRI Shapefiles, and that mismatch is exactly where default configurations fail. A valid geographic dataset requires synchronous retention of its `.shp`, `.shx`, and `.dbf` components; when an age- or suffix-based rule transitions one sidecar to Glacier while the rest stay in Standard, the group fractures, coordinate-system resolution breaks, and GDAL/OGR connections error out mid-pipeline. This how-to is for the data engineer, GIS archivist, or cloud architect who must move large shapefile archives through storage tiers without ever splitting a component group. It gives deterministic configuration, exact validation commands with annotated output, and root-cause fixes — all building on the broader [retention policy frameworks](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/retention-policy-frameworks/) that decide when each dataset is allowed to move or expire in the first place.

## Atomic Shapefile Tiering

Shapefile components must transition as a single group, gated on completeness so no sidecar is ever left behind in a hotter tier:

<svg viewBox="0 0 1040 220" role="img" aria-label="Atomic shapefile tiering gate. A component upload event reaches a completeness check asking whether the shp, shx, and dbf are all present. On No the group waits and is flagged incomplete; on Yes the group is tagged with a format and UUID, then tag-scoped lifecycle transitions run, then an inventory integrity check confirms convergence." xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;color:var(--primary);font-family:var(--font-sans)">
  <title>Completeness-gated atomic shapefile tiering flow</title>
  <desc>An upload event is held at a completeness gate; only a whole shp/shx/dbf group is tagged, transitioned by tag-scoped lifecycle rules, and finally reconciled by an inventory integrity check. An incomplete group is parked and flagged instead of transitioned.</desc>
  <defs>
    <marker id="lc-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <g text-anchor="middle">
    <rect x="14" y="30" width="150" height="60" rx="10" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-opacity="0.45"/>
    <text x="89" y="55" font-size="13" font-weight="600" fill="currentColor">Component</text>
    <text x="89" y="73" font-size="13" font-weight="600" fill="currentColor">upload event</text>
    <polygon points="290,12 364,60 290,108 216,60" fill="currentColor" fill-opacity="0.07" stroke="currentColor" stroke-opacity="0.55"/>
    <text x="290" y="56" font-size="12" font-weight="700" fill="currentColor">.shp .shx .dbf</text>
    <text x="290" y="74" font-size="12" font-weight="600" fill="currentColor">present?</text>
    <rect x="420" y="30" width="160" height="60" rx="10" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-opacity="0.45"/>
    <text x="500" y="55" font-size="13" font-weight="600" fill="currentColor">Tag group:</text>
    <text x="500" y="73" font-size="13" font-weight="600" fill="currentColor">format + UUID</text>
    <rect x="636" y="30" width="172" height="60" rx="10" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-opacity="0.45"/>
    <text x="722" y="55" font-size="13" font-weight="600" fill="currentColor">Tag-scoped</text>
    <text x="722" y="73" font-size="13" font-weight="600" fill="currentColor">lifecycle transitions</text>
    <rect x="864" y="30" width="162" height="60" rx="10" fill="currentColor" fill-opacity="0.13" stroke="currentColor" stroke-opacity="0.7" stroke-width="1.5"/>
    <text x="945" y="55" font-size="13" font-weight="700" fill="currentColor">Inventory</text>
    <text x="945" y="73" font-size="13" font-weight="700" fill="currentColor">integrity check</text>
    <rect x="215" y="150" width="150" height="56" rx="10" fill="currentColor" fill-opacity="0.04" stroke="currentColor" stroke-opacity="0.4" stroke-dasharray="6 5"/>
    <text x="290" y="173" font-size="13" font-weight="600" fill="currentColor">Wait / flag</text>
    <text x="290" y="191" font-size="13" font-weight="600" fill="currentColor">incomplete</text>
  </g>
  <g stroke="currentColor" stroke-width="2" fill="none" stroke-opacity="0.5">
    <path d="M164 60 H214" marker-end="url(#lc-arrow)"/>
    <path d="M364 60 H418" marker-end="url(#lc-arrow)"/>
    <path d="M580 60 H634" marker-end="url(#lc-arrow)"/>
    <path d="M808 60 H862" marker-end="url(#lc-arrow)"/>
    <path d="M290 108 V148" marker-end="url(#lc-arrow)"/>
  </g>
  <g text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">
    <text x="395" y="50">Yes</text>
    <text x="305" y="132">No</text>
  </g>
</svg>

Lifecycle windows must map to jurisdictional data mandates and query frequency, not to object age alone. Actively queried boundary layers stay in standard storage, while historical survey datasets transition to infrequent-access or deep-archive classes — a decision that depends on the same retrieval-latency and egress trade-offs covered in [object storage selection for GIS archives](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/object-storage-selection-for-gis-archives/) and in the wider [hot/warm/cold tier design for geospatial data](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/hotwarmcold-tier-design-for-geospatial-data/). The procedure below assumes S3-compatible storage with tag-based lifecycle evaluation, though the logic applies identically to Azure Blob and GCS equivalents.

## Step 1: Enforce Atomic Ingestion and Immutable Tagging

Lifecycle engines cannot guarantee atomicity without deterministic grouping at ingestion. Structure every ingestion path as `archives/{dataset_id}/{version}/{shapefile_name}/` so all components of one layer share an exact prefix, and reject flat or randomized key generation. Attach immutable tags during the `PutObject` (or `CreateMultipartUpload`) call so the lifecycle engine has a stable grouping key before any transition timer starts.

```bash
aws s3api put-object \
  --bucket spatial-archive-prod \
  --key archives/county_boundaries/v2023_10/roads/roads.shp \
  --body roads.shp \
  --tagging "shapefile_group=a1b2c3d4-e5f6-7890-abcd-ef1234567890&format=shapefile&tier=hot&retention_class=standard"
```

Repeat the call for `.shx`, `.dbf`, `.prj`, and `.cpg` using the identical `shapefile_group` UUID. Because the components arrive as separate `s3:ObjectCreated` events, deploy a pre-flight trigger that verifies group completeness before lifecycle evaluation is allowed to act on any single key.

```python
import boto3
s3 = boto3.client('s3')

def validate_shapefile_group(event, context):
    bucket = event['Records'][0]['s3']['bucket']['name']
    key = event['Records'][0]['s3']['object']['key']
    prefix = key.rsplit('/', 1)[0] + '/'

    response = s3.list_objects_v2(Bucket=bucket, Prefix=prefix)
    extensions = {obj['Key'].rsplit('.', 1)[-1] for obj in response.get('Contents', [])}

    required = {'shp', 'shx', 'dbf'}
    missing = required - extensions
    if missing:
        # Components arrive as separate ObjectCreated events, so an incomplete
        # group usually just means the rest are still uploading. Wait/flag for
        # follow-up rather than deleting the component that just arrived.
        print(f"Incomplete shapefile group at {prefix}; awaiting {missing}")
        return {"status": "incomplete", "prefix": prefix, "missing": list(missing)}
    return {"status": "complete", "prefix": prefix}
```

<svg viewBox="0 0 1040 288" role="img" aria-label="Atomic group versus fractured group. On the left, an atomic group binds five components — shp, shx, dbf, prj, cpg — under one immutable shapefile_group UUID, all resident in the STANDARD_IA tier and evaluated by one rule on the same day, so the layer stays valid. On the right, a fractured group keeps shp, shx, dbf, and cpg in STANDARD_IA while the prj sidecar has drifted to DEEP_ARCHIVE, so coordinate-system resolution fails and GDAL or OGR errors mid-pipeline." xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;color:var(--primary);font-family:var(--font-sans)">
  <title>Atomic shapefile bundle versus a fractured, partially tiered group</title>
  <desc>Left: all five shapefile components share one UUID tag and one storage class, so the dataset resolves. Right: the prj sidecar has transitioned to a colder tier on its own timer, splitting the group and breaking CRS resolution for any reader.</desc>
  <g text-anchor="middle">
    <!-- Panel A: atomic bundle -->
    <rect x="18" y="56" width="486" height="180" rx="12" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-opacity="0.45"/>
    <text x="261" y="40" font-size="13.5" font-weight="700" fill="currentColor">Atomic group: one UUID, all sidecars in one tier</text>
    <g font-size="12" font-weight="600">
      <rect x="30" y="86" width="82" height="50" rx="8" fill="currentColor" fill-opacity="0.1" stroke="currentColor" stroke-opacity="0.5"/>
      <text x="71" y="116" fill="currentColor">.shp</text>
      <rect x="124" y="86" width="82" height="50" rx="8" fill="currentColor" fill-opacity="0.1" stroke="currentColor" stroke-opacity="0.5"/>
      <text x="165" y="116" fill="currentColor">.shx</text>
      <rect x="218" y="86" width="82" height="50" rx="8" fill="currentColor" fill-opacity="0.1" stroke="currentColor" stroke-opacity="0.5"/>
      <text x="259" y="116" fill="currentColor">.dbf</text>
      <rect x="312" y="86" width="82" height="50" rx="8" fill="currentColor" fill-opacity="0.1" stroke="currentColor" stroke-opacity="0.5"/>
      <text x="353" y="116" fill="currentColor">.prj</text>
      <rect x="406" y="86" width="82" height="50" rx="8" fill="currentColor" fill-opacity="0.1" stroke="currentColor" stroke-opacity="0.5"/>
      <text x="447" y="116" fill="currentColor">.cpg</text>
    </g>
    <path d="M30 152 V160 H488 V152" fill="none" stroke="currentColor" stroke-width="1.6" stroke-opacity="0.55"/>
    <text x="259" y="182" font-size="11.5" font-weight="600" fill="currentColor">shapefile_group = a1b2c3d4 (immutable)</text>
    <text x="259" y="208" font-size="11.5" font-weight="600" fill="currentColor" fill-opacity="0.85">tier = STANDARD_IA · one rule, same day &#8594; layer resolves</text>
    <!-- Panel B: fractured group -->
    <rect x="536" y="56" width="486" height="180" rx="12" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-opacity="0.55" stroke-dasharray="6 5"/>
    <text x="779" y="40" font-size="13.5" font-weight="700" fill="currentColor">Fractured group: one sidecar drifted to a colder tier</text>
    <text x="708" y="80" font-size="11" font-weight="700" fill="currentColor" fill-opacity="0.85">STANDARD_IA</text>
    <g font-size="12" font-weight="600">
      <rect x="548" y="88" width="80" height="46" rx="8" fill="currentColor" fill-opacity="0.1" stroke="currentColor" stroke-opacity="0.5"/>
      <text x="588" y="116" fill="currentColor">.shp</text>
      <rect x="640" y="88" width="80" height="46" rx="8" fill="currentColor" fill-opacity="0.1" stroke="currentColor" stroke-opacity="0.5"/>
      <text x="680" y="116" fill="currentColor">.shx</text>
      <rect x="732" y="88" width="80" height="46" rx="8" fill="currentColor" fill-opacity="0.1" stroke="currentColor" stroke-opacity="0.5"/>
      <text x="772" y="116" fill="currentColor">.dbf</text>
      <rect x="824" y="88" width="80" height="46" rx="8" fill="currentColor" fill-opacity="0.1" stroke="currentColor" stroke-opacity="0.5"/>
      <text x="864" y="116" fill="currentColor">.cpg</text>
    </g>
    <path d="M772 134 V150" fill="none" stroke="currentColor" stroke-width="1.6" stroke-opacity="0.6" stroke-dasharray="4 4"/>
    <polygon points="754,150 790,150 772,124" fill="none" stroke="currentColor" stroke-width="1.4" stroke-opacity="0.7"/>
    <text x="772" y="146" font-size="12" font-weight="700" fill="currentColor">!</text>
    <g font-size="12" font-weight="700">
      <rect x="700" y="158" width="144" height="46" rx="8" fill="currentColor" fill-opacity="0.04" stroke="currentColor" stroke-opacity="0.6" stroke-dasharray="6 5"/>
      <text x="772" y="180" fill="currentColor">.prj &#8594; DEEP_ARCHIVE</text>
      <text x="772" y="197" font-size="11" font-weight="600" fill="currentColor" fill-opacity="0.85">drifted on its own timer</text>
    </g>
    <text x="779" y="226" font-size="11.5" font-weight="600" fill="currentColor">CRS resolution fails &#8594; GDAL/OGR errors mid-pipeline</text>
  </g>
</svg>

## Step 2: Configure Tag-Scoped Lifecycle Rules

Suffix-based rules such as `*.shp` will fragment archives, because the lifecycle engine evaluates each matching key independently. Configure rules exclusively on the `format` and `retention_class` tags so every component of a group is selected by the same filter and transitions inside the same maintenance window. Apply the configuration with `aws s3api put-bucket-lifecycle-configuration`.

```json
{
  "Rules": [
    {
      "ID": "Shapefile_Tiering",
      "Status": "Enabled",
      "Filter": {
        "Tag": { "Key": "format", "Value": "shapefile" }
      },
      "Transitions": [
        { "Days": 90, "StorageClass": "STANDARD_IA" },
        { "Days": 365, "StorageClass": "DEEP_ARCHIVE" }
      ]
    },
    {
      "ID": "Shapefile_Expiration",
      "Status": "Enabled",
      "Filter": {
        "Tag": { "Key": "retention_class", "Value": "standard" }
      },
      "Expiration": { "Days": 2555 }
    }
  ]
}
```

```bash
aws s3api put-bucket-lifecycle-configuration \
  --bucket spatial-archive-prod \
  --lifecycle-configuration file://lifecycle-rules.json
```

Because every component shares the identical `format` and `shapefile_group` tags, all of them are evaluated by the same rule on the same day, which prevents partial tier drift. The 2555-day (seven-year) expiration window must trace back to a documented mandate in your [retention policy frameworks](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/retention-policy-frameworks/) rather than an arbitrary timer, so deletion is always defensible to an auditor.

## Step 3: Run a Cross-Tier Integrity Pipeline

Lifecycle transitions are asynchronous, so a group can momentarily straddle two storage classes; you confirm convergence after the fact with deterministic inventory checks. Enable S3 Inventory with daily Parquet (or CSV) output filtered to the `shapefile_group` tag, then reconcile the report.

```bash
aws s3api put-bucket-inventory-configuration \
  --bucket spatial-archive-prod \
  --id shapefile-integrity-check \
  --inventory-configuration file://inventory-config.json
```

Run the reconciliation against the inventory output to detect any group whose components have landed in more than one storage class.

```python
import pandas as pd
from collections import defaultdict

def check_fragmentation(inventory_csv):
    df = pd.read_csv(inventory_csv)
    groups = defaultdict(set)

    for _, row in df.iterrows():
        if row.get('Tag_format') == 'shapefile':
            groups[row['Tag_shapefile_group']].add(row['StorageClass'])

    fragmented = []
    for group_id, classes in groups.items():
        if len(classes) > 1:
            fragmented.append({
                "group_id": group_id,
                "classes": list(classes),
                "action": "restore_all_to_hot"
            })
    return fragmented
```

Any group emitted by `check_fragmentation` must trigger an immediate `restore-object` call for every component back to standard storage, followed by a lifecycle reset once the group is whole again.

## Validation & Verification

Confirm that a representative group is intact in a single tier before declaring the policy healthy. The fastest check lists every object under a group prefix and prints its storage class.

```bash
aws s3api list-objects-v2 \
  --bucket spatial-archive-prod \
  --prefix archives/county_boundaries/v2023_10/roads/ \
  --query 'Contents[].{Key:Key,Class:StorageClass}' \
  --output table
```

**Expected output** — every component reports the *same* storage class, which is the proof that the group transitioned atomically:

```
-------------------------------------------------------------------
|                         ListObjectsV2                           |
+-------------------------------------------------+---------------+
|                       Key                       |     Class     |
+-------------------------------------------------+---------------+
|  archives/.../roads/roads.shp                   |  STANDARD_IA  |
|  archives/.../roads/roads.shx                   |  STANDARD_IA  |
|  archives/.../roads/roads.dbf                   |  STANDARD_IA  |
|  archives/.../roads/roads.prj                   |  STANDARD_IA  |
|  archives/.../roads/roads.cpg                   |  STANDARD_IA  |
+-------------------------------------------------+---------------+
```

If any row shows a different `Class` (or `null`, meaning a sidecar was never tagged), the group is fragmented and must be restored and reset before it is trusted in a retrieval workflow.

## Troubleshooting

| Failure symptom | Root cause | Exact remediation |
|---|---|---|
| `.shx` transitions to Glacier while `.shp` stays in Standard | Tag mismatch or delayed tag propagation during multipart upload | `aws s3api put-object-tagging --bucket spatial-archive-prod --key archives/county_boundaries/v2023_10/roads/roads.shx --tagging "shapefile_group=a1b2c3d4-...&format=shapefile"`, then re-run the inventory check |
| GIS client times out reading a cold-tier layer | Partial restore; the missing `.dbf` blocks the attribute-table read | `aws s3api restore-object --bucket spatial-archive-prod --key archives/.../roads/roads.dbf --restore-request '{"Days":7,"GlacierJobParameters":{"Tier":"Standard"}}'` for **every** group key (Expedited is unavailable for DEEP_ARCHIVE) |
| `.prj` deleted prematurely, breaking CRS resolution | Lifecycle rule scoped to `*.shp` suffix or the `format` tag is absent | Audit with `aws s3api get-bucket-lifecycle-configuration --bucket spatial-archive-prod`; delete the suffix filter and re-scope the rule to the `format` tag |
| Egress cost spike during a transformation job | Cold objects restored individually instead of as a group | Batch the restore through AWS Batch or Step Functions targeting the exact `shapefile_group` UUID so all sidecars rehydrate together |

When implementing cross-region replication, verify that lifecycle tags propagate identically to the destination bucket — an untagged replica re-fragments on its own timer. Validate every configuration against the official [AWS S3 Lifecycle Management documentation](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lifecycle-mgmt.html) and the [ESRI Shapefile Technical Description](https://www.esri.com/content/dam/esrisites/sitecore-archive/Files/Pdfs/library/whitepapers/pdfs/shapefile.pdf) to stay compliant with multi-file geospatial standards.

## Operational Execution Checklist

- [ ] Enforce the `archives/{dataset_id}/{version}/{shapefile_name}/` prefix so every component of a layer shares one prefix.
- [ ] Tag `.shp`, `.shx`, `.dbf`, `.prj`, and `.cpg` with an identical `shapefile_group` UUID and a `format=shapefile` tag at upload time.
- [ ] Deploy the `s3:ObjectCreated:*` pre-flight trigger to flag incomplete groups instead of deleting the component that just arrived.
- [ ] Scope all lifecycle rules to the `format` and `retention_class` tags — never to a `*.shp` suffix or bare key prefix.
- [ ] Tie the expiration window to a documented retention mandate, not an arbitrary day count.
- [ ] Enable daily S3 Inventory and run the fragmentation reconciliation against it.
- [ ] Confirm a sample group reports one identical storage class across all sidecars before trusting the policy.
- [ ] Verify lifecycle tags replicate identically to every cross-region destination bucket.

## Related

- Up: [Retention Policy Frameworks](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/retention-policy-frameworks/) — the parent control plane that decides when a shapefile group is permitted to transition, lock, or expire.
- [How to Design a 3-Tier Spatial Storage Architecture](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/hotwarmcold-tier-design-for-geospatial-data/how-to-design-a-3-tier-spatial-storage-architecture/) — companion procedure that defines the hot/warm/cold tier boundaries these lifecycle rules execute against.
- [Converting Legacy Shapefiles to GeoParquet at Scale](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/geoparquet-migration-workflows/converting-legacy-shapefiles-to-geoparquet-at-scale/) — eliminate multi-file fragility entirely by migrating archived shapefiles to a single-file columnar format before tiering.
- [Object Storage Selection for GIS Archives](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/object-storage-selection-for-gis-archives/) — resolve provider storage classes and retrieval mechanics before committing the transition windows above.
