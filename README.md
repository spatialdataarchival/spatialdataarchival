<p align="center">
  <a href="https://www.spatialdataarchival.org">
    <img src="https://www.spatialdataarchival.org/assets/icons/og-image.png" alt="Spatial Data Archival & Cold Storage Optimization" width="100%">
  </a>
</p>

<h1 align="center">Spatial Data Archival &amp; Cold Storage Optimization</h1>

<p align="center">
  <strong>A production-focused operational reference for the geospatial data lifecycle —<br>
  cold-storage optimization, format conversion, and compliance automation.</strong>
</p>

<p align="center">
  <a href="https://www.spatialdataarchival.org"><b>🌐 www.spatialdataarchival.org</b></a>
</p>

---

## What this is

**[Spatial Data Archival](https://www.spatialdataarchival.org)** is a hands-on field guide for the
engineers and archivists who keep petabyte-scale spatial data **affordable, retrievable, and
audit-ready**. Raster mosaics, LiDAR point clouds, historical basemaps, and continuous sensor
telemetry each demand distinct lifecycle handling — and treating them as a single low-cost bucket is
how archives quietly hemorrhage money and durability.

Every page favours concrete configuration over theory: copy-ready CLI commands, PyArrow and DuckDB
snippets, Terraform lifecycle rules, validation thresholds, and root-cause troubleshooting tables you
can apply directly to production pipelines. External references are restricted to primary sources —
OGC, NIST, AWS, GDAL, and the GeoParquet/FlatGeobuf specifications.

It is written for **data engineers, GIS archivists, cloud architects, and compliance/operations
teams**. Across **50 in-depth articles** the material drills from strategic overviews down to
task-level playbooks, with a hand-authored diagram on every page.

## Explore the reference

The knowledge base is organised into three connected disciplines plus a cross-cutting cost model:

### 🗜️ [Compression Tuning &amp; Storage Optimization](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/)
Shrink cold-tier footprint and egress cost without breaking retrieval SLAs — ZSTD level selection,
row-group sizing, dictionary encoding for categorical GIS attributes, spatial partitioning (H3 / S2 /
Quadkey), and the [ZSTD vs LZ4 vs Snappy](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/zstd-vs-lz4-vs-snappy-compression-trade-offs-for-spatial-files/)
trade-off analysis.

### 🏛️ [Spatial Archival Architecture &amp; Tiering Strategy](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/)
Design hot/warm/cold tiers, select object storage, catalog metadata (STAC, ISO 19115), and codify
retention with policy-as-code for legally defensible archives — including telemetry-driven lifecycle
thresholds and S3 Object Lock for compliance.

### 🔄 [Format Conversion &amp; Pipeline Automation](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/)
Migrate legacy shapefiles to GeoParquet and FlatGeobuf, validate schemas and CRS, and automate
idempotent, compliance-ready conversion pipelines — plus the head-to-head
[GeoParquet vs FlatGeobuf for cold-archive retrieval](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/geoparquet-vs-flatgeobuf-for-cold-archive-retrieval/)
decision guide.

### 💰 [Spatial Archive Cost Modeling](https://www.spatialdataarchival.org/spatial-archive-cost-modeling/)
One auditable model tying together storage-class pricing, retrieval and request fees, early-deletion
penalties, and compression-ratio tables — the numbers behind every tiering decision, referenced from
all three disciplines.

## Why it stands out

- **Runnable, not hand-wavy** — real bucket names, real EPSG codes, real GDAL/DuckDB/Terraform flags.
- **Decision-oriented** — comparison matrices and cost models that produce an actual recommendation.
- **Standards-grounded** — every external link points to an authoritative specification or vendor doc.
- **Fast &amp; accessible** — a static site that meets WCAG 2 AA, with an original inline SVG on every page.

## Tech

Built as a static site with [Eleventy](https://www.11ty.dev/) and deployed on Cloudflare. Content is
plain Markdown; page metadata, breadcrumbs, JSON-LD, and navigation are derived automatically at build
time. To build locally:

```bash
npm install
npm run build     # output in _site/
npm run serve     # local preview
```

## Contributing &amp; commit policy

This repository is maintained solely by the **`spatialdataarchival`** account. **All commits are
authored by that single account with no co-authors and no additional `Co-authored-by` trailers.**
Please preserve this convention in any change.

## License &amp; usage

© Spatial Data Archival & Cold Storage Optimization. Content is published for reference at
[www.spatialdataarchival.org](https://www.spatialdataarchival.org).
