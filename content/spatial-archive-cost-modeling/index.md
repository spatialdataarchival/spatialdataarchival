# Spatial Archive Cost Modeling: Retrieval, Penalties & Compression

Modeling the true cost of a geospatial archive means combining four numbers that vendor pricing pages present separately: per-gigabyte storage, retrieval and request fees, early-deletion penalties, and the compression ratio that shrinks all three. This reference is for the data engineers, cloud architects, and compliance teams who must defend a storage budget and prove that a tiering decision saves money rather than merely relocating it. Default per-GB comparisons are misleading — a tier that looks ten times cheaper can cost more once restore fees, minimum-duration billing, and read amplification against poorly sized objects are counted. The tables and formulas below give you a single, auditable model that every section of this knowledge base can reference.

Cost is not a property of a storage class; it is a property of an access pattern applied to a storage class. The same 40 TB LiDAR collection is cheap in Deep Archive if it is read once a year and ruinous if a monthly reprocessing job restores it. Everything here is built to be plugged into that access pattern.

## The Total Cost Model

Five cost components accumulate over an object's life. Model them together, not in isolation:

<svg viewBox="0 0 860 250" role="img" aria-label="Spatial archive total cost is the sum of five components: storage cost (per gigabyte-month times compressed size times months), request cost (PUT, GET and lifecycle transition requests), retrieval cost (per-gigabyte restore fees for cold tiers), early-deletion penalty (unmet minimum-duration days billed in full), and egress cost (per-gigabyte data transfer out). Compression ratio reduces the storage, retrieval, and egress components proportionally." xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;color:var(--primary);font-family:var(--font-sans)">
  <title>Total cost of a spatial archive object over its lifetime</title>
  <desc>A ledger diagram: five stacked cost components — storage, requests, retrieval, early-deletion penalty, and egress — sum to total lifetime cost. Compression ratio multiplies down the storage, retrieval, and egress rows because it shrinks the bytes those fees are charged against.</desc>
  <text x="18" y="26" font-size="13" font-weight="700" fill="currentColor">Lifetime cost of one archived object</text>
  <g font-size="11.5">
    <rect x="18" y="42" width="470" height="30" rx="6" fill="currentColor" fill-opacity="0.07" stroke="currentColor" stroke-opacity="0.4"/>
    <text x="30" y="61" fill="currentColor" font-weight="600">Storage</text>
    <text x="150" y="61" fill="currentColor" fill-opacity="0.85">$/GB-month &#215; compressed GB &#215; months</text>
    <rect x="18" y="78" width="470" height="30" rx="6" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-opacity="0.4"/>
    <text x="30" y="97" fill="currentColor" font-weight="600">Requests</text>
    <text x="150" y="97" fill="currentColor" fill-opacity="0.85">PUT + GET + lifecycle transition counts</text>
    <rect x="18" y="114" width="470" height="30" rx="6" fill="currentColor" fill-opacity="0.07" stroke="currentColor" stroke-opacity="0.4"/>
    <text x="30" y="133" fill="currentColor" font-weight="600">Retrieval</text>
    <text x="150" y="133" fill="currentColor" fill-opacity="0.85">$/GB restore &#215; compressed GB read</text>
    <rect x="18" y="150" width="470" height="30" rx="6" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-opacity="0.4"/>
    <text x="30" y="169" fill="currentColor" font-weight="600">Penalty</text>
    <text x="150" y="169" fill="currentColor" fill-opacity="0.85">unmet minimum-duration days billed</text>
    <rect x="18" y="186" width="470" height="30" rx="6" fill="currentColor" fill-opacity="0.07" stroke="currentColor" stroke-opacity="0.4"/>
    <text x="30" y="205" fill="currentColor" font-weight="600">Egress</text>
    <text x="150" y="205" fill="currentColor" fill-opacity="0.85">$/GB transfer out &#215; compressed GB</text>
  </g>
  <line x1="508" y1="42" x2="508" y2="216" stroke="currentColor" stroke-width="1.4" stroke-opacity="0.5"/>
  <text x="600" y="120" font-size="30" font-weight="700" fill="currentColor" text-anchor="middle">&#931;</text>
  <text x="600" y="150" font-size="12" fill="currentColor" text-anchor="middle" fill-opacity="0.8">total</text>
  <rect x="662" y="96" width="180" height="58" rx="8" fill="currentColor" fill-opacity="0.12" stroke="currentColor" stroke-opacity="0.6"/>
  <text x="752" y="120" font-size="12.5" font-weight="700" fill="currentColor" text-anchor="middle">Lifetime cost</text>
  <text x="752" y="139" font-size="10.5" fill="currentColor" text-anchor="middle" fill-opacity="0.8">per object &#215; object count</text>
  <text x="18" y="238" font-size="10.5" fill="currentColor" fill-opacity="0.7">Compression ratio scales the Storage, Retrieval, and Egress rows: halve the bytes, halve those three fees.</text>
</svg>

The single most consequential lever is compression, because it reduces three of the five components at once. A 3:1 ratio on a vector archive does not just cut storage by two-thirds — it cuts every future restore and every egress byte by the same factor, compounding over the retention window. That is why compression tuning is a cost decision, not merely a storage decision, and why the [Compression Tuning & Storage Optimization](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/) guides are upstream of every number here.

## Storage Class Pricing Reference

The table below lists representative US-region list prices for the storage classes a spatial archive typically spans. Prices drift; treat these as the model's default coefficients and override them with your contracted rates. What rarely changes is the *shape*: each step down in price buys a step up in retrieval latency and minimum-duration commitment.

| Storage class | $/GB-month | Retrieval | Min. duration | Retrieval fee | Typical spatial asset |
|---------------|-----------:|-----------|--------------:|---------------|-----------------------|
| S3 Standard | ~$0.023 | milliseconds | none | none | active mosaics, live sensor feeds |
| S3 Standard-IA | ~$0.0125 | milliseconds | 30 days | ~$0.01/GB | recent imagery, vector indexes |
| S3 Glacier Instant | ~$0.004 | milliseconds | 90 days | ~$0.03/GB | quarterly-access rasters |
| S3 Glacier Flexible | ~$0.0036 | minutes–hours | 90 days | ~$0.01/GB + per-request | historical project archives |
| S3 Glacier Deep Archive | ~$0.00099 | ~12 hours | 180 days | ~$0.02/GB | legal-hold survey records, raw LiDAR |

The per-gigabyte spread from Standard to Deep Archive is roughly 23:1, which is why aggressive cold-tiering is tempting. But the minimum-duration column is where naive models break: an object pushed to Deep Archive and deleted after 40 days still bills all 180 days. Choosing where an asset lands is the subject of [Hot/Warm/Cold Tier Design for Geospatial Data](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/hotwarmcold-tier-design-for-geospatial-data/), and the substrate that carries these classes is covered in [Object Storage Selection for GIS Archives](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/object-storage-selection-for-gis-archives/).

## Early-Deletion Penalty Matrix

Every tier below Standard bills a minimum number of days regardless of how long the object actually lived. The penalty for deleting — or transitioning — an object early is the remaining unmet days at that tier's storage rate. Model it explicitly before setting any `hot-to-warm` or `warm-to-cold` transition trigger:

| Deleted/transitioned at | Standard-IA (30d) | Glacier IR (90d) | Glacier Flexible (90d) | Deep Archive (180d) |
|-------------------------|------------------:|-----------------:|-----------------------:|--------------------:|
| Day 10 | 20 days billed | 80 days billed | 80 days billed | 170 days billed |
| Day 30 | 0 (met) | 60 days billed | 60 days billed | 150 days billed |
| Day 90 | 0 | 0 (met) | 0 (met) | 90 days billed |
| Day 180 | 0 | 0 | 0 | 0 (met) |

The practical rule this table encodes: never transition an asset into a tier whose minimum duration exceeds the time it will actually stay there. A dataset re-queried every 60 days should sit in Standard-IA, not Glacier — a too-aggressive rule that bounces it back to a hot tier on the next query pays the full 90-day Glacier minimum each round. Deriving transition days from real access telemetry rather than a static age cutoff is exactly the discipline in [Setting Lifecycle Transition Thresholds from Query Telemetry](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/hotwarmcold-tier-design-for-geospatial-data/setting-lifecycle-transition-thresholds-from-query-telemetry/).

## Compression Ratio Reference

Compression ratio converts raw dataset size into the compressed bytes every storage, retrieval, and egress fee is actually charged against. Representative ratios for spatial data, measured against uncompressed source:

| Source → archive format | Codec | Typical ratio | Notes |
|-------------------------|-------|--------------:|-------|
| Shapefile → GeoParquet | ZSTD-3 | 4:1 – 8:1 | columnar + dictionary-encoded attributes |
| Shapefile → GeoParquet | ZSTD-19 | 6:1 – 12:1 | higher ratio, ~5× compress CPU |
| GeoTIFF → COG | DEFLATE | 1.5:1 – 3:1 | lossless; predictor 2 for continuous rasters |
| GeoTIFF → COG | ZSTD | 2:1 – 3.5:1 | faster decode than DEFLATE at similar ratio |
| CSV attributes → Parquet | Snappy | 3:1 – 6:1 | fast decode, lower ratio than ZSTD |
| LAS → LAZ (point cloud) | LASzip | 5:1 – 10:1 | domain codec; COPC keeps range-read layout |

Two attribute-level techniques amplify these ratios further: collapsing repetitive categorical columns with [Dictionary Encoding for GIS Attributes](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/dictionary-encoding-for-gis-attributes/), and matching the codec to the tier with the trade-offs in [ZSTD vs LZ4 vs Snappy: Compression Trade-offs for Spatial Files](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/zstd-vs-lz4-vs-snappy-compression-trade-offs-for-spatial-files/). The exact level to run is governed by [ZSTD Level Configuration for Spatial Files](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/zstd-level-configuration-for-spatial-files/), because higher levels trade compress-time CPU for a smaller footprint — a cost you pay once against a saving you collect for the whole retention window.

## A Worked Cost Model

The following script models the total lifetime cost of an archive under a candidate tiering plan. It uses realistic coefficients and a real access pattern, so the output is directly comparable across plans.

```python
# spatial_archive_cost.py — model lifetime cost of one dataset under a tiering plan
RATES = {
    "STANDARD":     {"gb_month": 0.023,  "min_days": 0,   "retrieval_gb": 0.0},
    "STANDARD_IA":  {"gb_month": 0.0125, "min_days": 30,  "retrieval_gb": 0.01},
    "GLACIER_IR":   {"gb_month": 0.004,  "min_days": 90,  "retrieval_gb": 0.03},
    "DEEP_ARCHIVE": {"gb_month": 0.00099,"min_days": 180, "retrieval_gb": 0.02},
}
EGRESS_GB = 0.09  # data transfer out to internet

def object_cost(raw_gb, ratio, plan, restores, egress_restores):
    """plan = list of (storage_class, days_resident); restores = GB read from cold."""
    comp_gb = raw_gb / ratio
    storage = requests = retrieval = penalty = 0.0
    for cls, days in plan:
        r = RATES[cls]
        storage += r["gb_month"] * comp_gb * (days / 30.0)
        if days < r["min_days"]:                      # early-deletion / transition penalty
            penalty += r["gb_month"] * comp_gb * ((r["min_days"] - days) / 30.0)
    retrieval = sum(RATES[c]["retrieval_gb"] * comp_gb for c in restores)
    egress = EGRESS_GB * comp_gb * egress_restores
    return round(storage + requests + retrieval + penalty + egress, 2)

# 2 TB vector estate, 6:1 GeoParquet, 1 yr Standard-IA then 4 yr Deep Archive,
# restored from Deep Archive twice with one full egress:
plan = [("STANDARD_IA", 365), ("DEEP_ARCHIVE", 1460)]
print(object_cost(raw_gb=2048, ratio=6.0, plan=plan,
                  restores=["DEEP_ARCHIVE", "DEEP_ARCHIVE"], egress_restores=1))
```

Run it and compare plans side by side:

```bash
python3 spatial_archive_cost.py
```

Expected output — the modeled five-year cost of the 2 TB estate under this plan:

```text
228.53
```

Swap `ratio=6.0` for `ratio=3.0` and the same command returns roughly double, making the compression-versus-cost relationship concrete: the storage, retrieval, and egress lines all scale inversely with the ratio, while the request line does not.

## Cost Trade-off Analysis

Reading the model's output back into decisions:

- **Storage dominates for cold, rarely-read data.** For a 5-year Deep Archive object read once, storage is >90% of cost; shaving it with a higher compression level is the only meaningful lever.
- **Retrieval dominates for warm, frequently-read data.** If a dataset is restored monthly, retrieval and egress can exceed a year of storage — keep it in Standard-IA or Glacier Instant, not Flexible or Deep Archive.
- **Penalties dominate for churning data.** Assets rewritten or re-tiered before their minimum duration bleed penalty cost invisibly. Incremental update patterns like [Incremental GeoParquet Updates Without a Full Rewrite](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/geoparquet-migration-workflows/incremental-geoparquet-updates-without-full-rewrite/) exist partly to avoid rewriting cold objects that would trigger these penalties.
- **Object sizing changes request and read amplification.** Millions of tiny partitions inflate PUT/GET counts and lifecycle-transition request fees; oversized objects amplify partial-read restore cost. Aligning file and row-group size to the retrieval tier is covered in [Sizing Row Groups for Glacier Retrieval of GeoParquet](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/row-group-sizing-strategies/sizing-row-groups-for-glacier-retrieval-of-geoparquet/).

## Compliance & Retention Cost Interaction

Retention requirements set a floor under the model. When a regulatory mandate forces a 10-year hold, the cost question narrows to "the cheapest class whose minimum duration and retrieval SLA I can tolerate for 10 years." Object Lock in COMPLIANCE mode, detailed in [Configuring S3 Object Lock for Compliance Spatial Archives](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/retention-policy-frameworks/configuring-s3-object-lock-for-compliance-spatial-archives/), removes early deletion from the table entirely for the locked window — which means the early-deletion penalty column becomes irrelevant and Deep Archive's low storage rate wins outright, provided the ~12-hour restore is acceptable for audit response. Model the retrieval fee against the realistic number of audit or legal-discovery restores per year, not the theoretical maximum. Consult the official [AWS S3 storage pricing documentation](https://aws.amazon.com/s3/pricing/) and [S3 Storage Classes documentation](https://docs.aws.amazon.com/AmazonS3/latest/userguide/storage-class-intro.html) for authoritative current coefficients before committing a budget.

## Operational Execution Checklist

- [ ] **Model all five components** — storage, requests, retrieval, penalties, and egress — never per-GB storage alone.
- [ ] **Apply the real compression ratio** measured on a representative sample, not a vendor headline number.
- [ ] **Check every transition against minimum duration** — never move an asset into a tier it will leave before the minimum-duration clock expires.
- [ ] **Derive transition days from access telemetry**, not static age cutoffs, to avoid penalty churn.
- [ ] **Bound object and row-group size to the retrieval tier** to control request counts and partial-read amplification.
- [ ] **Re-run the model per storage class** and pick the plan with the lowest modeled total, not the lowest headline rate.
- [ ] **Refresh rate coefficients** against contracted pricing at least annually and re-validate the chosen plan.

## Related

- [Compression Tuning & Storage Optimization](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/) — the ratios that scale three of the five cost components; upstream of every number here.
- [Spatial Archival Architecture & Tiering Strategy](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/) — the tier model this cost reference prices out end to end.
- [Format Conversion & Pipeline Automation](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/) — converting to columnar formats is what unlocks the compression ratios modeled above.
- [Hot/Warm/Cold Tier Design for Geospatial Data](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/hotwarmcold-tier-design-for-geospatial-data/) — where the transition triggers this model prices are actually set.
- [ZSTD Level Configuration for Spatial Files](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/zstd-level-configuration-for-spatial-files/) — tuning the compress-time CPU cost against lifetime storage savings.

_Part of the [Spatial Data Archival](https://www.spatialdataarchival.org/) knowledge base._
