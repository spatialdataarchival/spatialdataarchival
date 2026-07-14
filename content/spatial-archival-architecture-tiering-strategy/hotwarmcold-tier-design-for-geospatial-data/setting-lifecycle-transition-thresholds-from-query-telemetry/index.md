# Setting Lifecycle Transition Thresholds from Query Telemetry

Setting lifecycle transition thresholds from query telemetry replaces arbitrary age cutoffs with data-driven rules derived from how often each spatial prefix is actually read, so imagery and vector tiles move to warm and cold storage on their own measured decay curve instead of a guessed 90-day clock. This guide is for cloud architects and data engineers who own a geospatial archive large enough that a wrong threshold costs real money — either in retrieval fees when live assets get cold-tiered too early, or in storage waste when dead assets linger on hot storage. Static lifecycle rules fail because different asset classes decay at wildly different rates: a raster mosaic backing an active basemap may be queried heavily for a year, while a one-off vector export goes silent in weeks. The remedy is to mine S3 server access logs, compute a per-prefix access-recency profile, and generate lifecycle rules whose transition days match observed behavior.

## Why One Cutoff Cannot Fit Two Decay Curves

A single static threshold is either too aggressive for slow-decaying assets or too lax for fast-decaying ones. Telemetry lets each prefix transition at its own crossing point:

<svg viewBox="0 0 820 340" role="img" aria-label="A query-frequency decay chart. The x-axis is asset age in days from zero to 365; the y-axis is query frequency. Two curves decay from full frequency: a fast-decaying vector prefix and a slow-decaying raster prefix. A horizontal transition-threshold line marks where an asset becomes warm-eligible. The vector curve crosses it around day 76 and the raster curve around day 266. A vertical dashed line marks a naive static 90-day cutoff, which would prematurely cold-tier the still-busy raster prefix." xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;color:var(--primary);font-family:var(--font-sans)">
  <title>Per-prefix query decay versus a static age cutoff</title>
  <desc>Two exponential decay curves for a fast vector prefix and a slow raster prefix cross a horizontal transition threshold at different ages (about day 76 and day 266). A vertical dashed line at day 90 shows a static cutoff that would tier the raster prefix while it is still heavily queried.</desc>
  <!-- axes -->
  <g stroke="currentColor" stroke-opacity="0.6" stroke-width="1.3">
    <line x1="60" y1="280" x2="780" y2="280"/>
    <line x1="60" y1="50" x2="60" y2="280"/>
  </g>
  <text x="420" y="322" text-anchor="middle" font-size="11" fill="currentColor" fill-opacity="0.8">asset age (days) &#8594;</text>
  <text x="20" y="165" text-anchor="middle" font-size="11" fill="currentColor" fill-opacity="0.8" transform="rotate(-90 20 165)">query frequency &#8593;</text>
  <text x="60" y="298" text-anchor="middle" font-size="9.5" fill="currentColor" fill-opacity="0.65">0</text>
  <text x="237" y="298" text-anchor="middle" font-size="9.5" fill="currentColor" fill-opacity="0.65">90</text>
  <text x="780" y="298" text-anchor="middle" font-size="9.5" fill="currentColor" fill-opacity="0.65">365</text>
  <!-- transition threshold -->
  <line x1="60" y1="245.5" x2="780" y2="245.5" stroke="currentColor" stroke-width="1.2" stroke-opacity="0.55" stroke-dasharray="2 3"/>
  <text x="775" y="240" text-anchor="end" font-size="10" fill="currentColor" fill-opacity="0.8">transition threshold</text>
  <!-- static 90d cutoff -->
  <line x1="237" y1="50" x2="237" y2="280" stroke="currentColor" stroke-width="1.2" stroke-opacity="0.4" stroke-dasharray="6 4"/>
  <text x="243" y="64" font-size="10" fill="currentColor" fill-opacity="0.75">static 90-day cutoff</text>
  <!-- slow raster curve -->
  <path d="M60 50 L138.9 107.3 L217.8 150 L296.7 182.4 L375.6 206.6 L454.5 224.8 L572.9 244.3 L691.3 257 L780 262.7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-opacity="0.85"/>
  <text x="470" y="200" font-size="11" font-weight="600" fill="currentColor">raster/ &#183; slow decay</text>
  <!-- fast vector curve -->
  <path d="M60 50 L99.5 140.5 L138.9 195.4 L178.4 228.7 L217.8 248.9 L257.3 261.1 L336 273 L454 278.5 L770 280" fill="none" stroke="currentColor" stroke-width="2.2" stroke-opacity="0.55" stroke-dasharray="7 3"/>
  <text x="150" y="160" font-size="11" font-weight="600" fill="currentColor" fill-opacity="0.85">vector/ &#183; fast decay</text>
  <!-- crossing markers -->
  <circle cx="210" cy="245.5" r="5" fill="currentColor" fill-opacity="0.9"/>
  <text x="210" y="264" text-anchor="middle" font-size="9.5" fill="currentColor" fill-opacity="0.85">warm ~76d</text>
  <circle cx="584" cy="245.5" r="5" fill="currentColor" fill-opacity="0.9"/>
  <text x="584" y="234" text-anchor="middle" font-size="9.5" fill="currentColor" fill-opacity="0.85">warm ~266d</text>
</svg>

## Mining Access Telemetry per Prefix

The raw signal is the archive's own read history. AWS S3 server access logs record every `GET` with a timestamp, key, and operation, and they are the ground truth for how live each object really is. Enable them if they are not already flowing, then aggregate.

1. **Confirm access logging targets a durable log bucket:**
```bash
aws s3api get-bucket-logging --bucket spatial-archive
# Expect a LoggingEnabled block pointing at s3://spatial-archive-logs/access/
```
 If empty, enable it — you cannot derive thresholds from telemetry you never captured, and there is no retroactive fix. Give the log accumulation at least one full decay cycle (typically 90+ days) before trusting the derived thresholds.

2. **Aggregate reads per top-level prefix and asset age.** DuckDB parses the space-delimited access log format directly and lets you bucket by prefix and by the days elapsed between object creation and each read:
```sql
-- duckdb: reads per prefix, bucketed by object age at read time
SELECT
  regexp_extract(key, '^([^/]+/)', 1)          AS prefix,
  date_diff('day', create_ts, request_ts)      AS age_days,
  count(*)                                      AS reads
FROM read_csv('s3://spatial-archive-logs/access/*', sep=' ', header=false,
              columns={'request_ts':'TIMESTAMP','key':'VARCHAR',
                       'operation':'VARCHAR','create_ts':'TIMESTAMP'})
WHERE operation = 'REST.GET.OBJECT'
GROUP BY prefix, age_days
ORDER BY prefix, age_days;
```

3. **Find the age where each prefix's read rate crosses your warm-eligibility threshold.** Fit the per-prefix decay and locate the crossing day, guarding against sparse tails that produce noisy fits:
```python
import numpy as np

def transition_day(age_days, reads, floor_frac=0.15):
    peak = reads.max()
    norm = reads / peak
    below = np.where(norm < floor_frac)[0]
    # first age at which normalized read rate stays under the floor
    return int(age_days[below[0]]) if len(below) else int(age_days.max())

vector_day = transition_day(vec_ages, vec_reads)   # e.g. 76
raster_day = transition_day(ras_ages, ras_reads)   # e.g. 266
```

Two adjustments keep the derived day trustworthy. The `floor_frac` parameter sets how quiet a prefix must go before it is warm-eligible; a value near 0.15 tolerates a long low-activity tail, while a stricter 0.05 waits for near-silence and is appropriate for assets whose late reads are expensive to re-hydrate. Seasonality is the other trap: agricultural imagery, flood-season hydrology layers, and academic-calendar datasets spike annually, so a threshold fitted over a single quiet quarter will cold-tier assets weeks before their next predictable surge. Fit over at least a full seasonal cycle and, where a prefix shows clear periodicity, add a guard that suppresses a transition inside a known busy window rather than trusting the raw decay curve.

Cold-start is the honest limitation. A brand-new prefix has no history, so there is nothing to fit — do not invent a telemetry-driven threshold from a week of data. Seed new prefixes with a conservative static rule, let the access logs accumulate, and switch to a derived threshold only once the log window covers a real decay cycle. Where per-object access logs are too voluminous to retain, S3 Storage Lens and last-access analytics give a coarser but cheaper signal that still distinguishes a live prefix from a dead one.

## Generating Per-Prefix Lifecycle Rules

Each derived crossing day becomes the `transition.days` of a prefix-scoped lifecycle rule. Generating the Terraform from the telemetry output keeps the policy honest — the archive's rules trace directly back to measured behavior, which is exactly the telemetry-driven tiering that a [Hot/Warm/Cold Tier Design for Geospatial Data](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/hotwarmcold-tier-design-for-geospatial-data/) demands over guesswork.

```hcl
# Terraform: per-prefix lifecycle rules derived from query telemetry
resource "aws_s3_bucket_lifecycle_configuration" "telemetry_driven" {
  bucket = aws_s3_bucket.spatial_archive.id

  rule {
    id     = "vector-fast-decay"
    status = "Enabled"
    filter { prefix = "vector/" }
    transition {
      days          = 76   # measured warm-eligibility crossing
      storage_class = "STANDARD_IA"
    }
    transition {
      days          = 210  # sustained silence past the warm window
      storage_class = "GLACIER"
    }
  }

  rule {
    id     = "raster-slow-decay"
    status = "Enabled"
    filter { prefix = "raster/" }
    transition {
      days          = 266  # raster stays hot far longer than a static rule assumes
      storage_class = "STANDARD_IA"
    }
  }
}
```

Set a floor on any generated threshold below the storage class minimum-duration billing window: never emit a `STANDARD_IA` transition earlier than 30 days or a `GLACIER` transition that will be undone before its 90-day minimum, or the early-deletion penalty erases the saving. Model those penalties against real read volumes with the [Spatial Archive Cost Modeling](https://www.spatialdataarchival.org/spatial-archive-cost-modeling/) framework before applying. The threshold is a policy input; the cost model is the sanity check that keeps an aggressive rule from costing more than the storage it saves.

## Verifying the Rules Took Effect

Applying Terraform proves the configuration exists, not that objects are transitioning correctly. Confirm both the rule set and the actual storage class of aged objects.

```bash
aws s3api get-bucket-lifecycle-configuration --bucket spatial-archive \
  --query "Rules[].{id:ID, prefix:Filter.Prefix, days:Transitions[0].Days}"
```

Expected output — each prefix carries its telemetry-derived day, not a shared constant:
```text
[
  { "id": "vector-fast-decay", "prefix": "vector/", "days": 76 },
  { "id": "raster-slow-decay", "prefix": "raster/", "days": 266 }
]
```

Then spot-check that an object past its transition day actually moved, and that a still-young object did not:
```bash
aws s3api head-object --bucket spatial-archive --key vector/2024/parcels_region_north.fgb \
  --query "StorageClass"
```
An object created more than 76 days ago under `vector/` should report `STANDARD_IA`; a `null` or `STANDARD` result on an aged object means the rule's filter prefix does not match the real key layout — the most common cause of a lifecycle rule that silently does nothing.

## Diagnosing Threshold Misfires

| Symptom | Root Cause | Resolution |
|---------|------------|------------|
| Assets bounce warm-to-hot and re-bill retrieval | Threshold set below the prefix's true query half-life | Recompute `transition_day` over a longer log window; raise the floor fraction |
| Rule reports enabled but nothing transitions | Filter `prefix` does not match actual key layout | Align the rule prefix to the real key hierarchy from the access-log aggregation |
| Derived day is noisy month to month | Sparse reads in the decay tail overfit the curve | Aggregate to weekly buckets and require the read rate to stay below the floor, not just touch it |
| Early-deletion penalty on cold transitions | Cold threshold shorter than the 90-day minimum billing | Clamp generated `GLACIER` days to at least the storage-class minimum duration |

## Operational Execution Checklist

- [ ] Confirm S3 server access logging is enabled and has captured at least one full decay cycle before deriving thresholds.
- [ ] Aggregate reads per top-level prefix bucketed by object age at read time, not by wall-clock date.
- [ ] Compute each prefix's warm-eligibility crossing from normalized read rate, guarding against sparse-tail noise.
- [ ] Generate prefix-scoped lifecycle rules whose `transition.days` come straight from the telemetry output.
- [ ] Clamp every generated threshold to the storage class minimum-duration window to avoid early-deletion penalties.
- [ ] Validate applied rules with `get-bucket-lifecycle-configuration` and spot-check aged objects with `head-object`.
- [ ] Re-derive thresholds on a schedule so the policy tracks changing access patterns instead of ossifying.

## Related

- Up: [Hot/Warm/Cold Tier Design for Geospatial Data](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/hotwarmcold-tier-design-for-geospatial-data/) — the parent reference for tier definitions and retrieval SLAs these thresholds drive.
- [How to Design a 3-Tier Spatial Storage Architecture](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/hotwarmcold-tier-design-for-geospatial-data/how-to-design-a-3-tier-spatial-storage-architecture/) — the tier model whose transition edges these telemetry-derived days populate.
- [Implementing Lifecycle Rules for Shapefile Archives](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/retention-policy-frameworks/implementing-lifecycle-rules-for-shapefile-archives/) — the retention-side counterpart where lifecycle rules meet compliance holds.
- [Tuning ZSTD Compression for GeoParquet Archives](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/zstd-level-configuration-for-spatial-files/tuning-zstd-compression-for-geoparquet-archives/) — shrinking the warm-tier footprint that these thresholds route assets into.
- [Spatial Archive Cost Modeling](https://www.spatialdataarchival.org/spatial-archive-cost-modeling/) — pricing each candidate threshold against retrieval and early-deletion penalties.

_Part of the [Spatial Data Archival](https://www.spatialdataarchival.org/) knowledge base._
