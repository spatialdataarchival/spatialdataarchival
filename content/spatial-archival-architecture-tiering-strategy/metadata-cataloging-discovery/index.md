# Metadata Cataloging & Discovery for Geospatial Archives

A cold-tiered archive that cannot be searched is indistinguishable from data that was deleted. The most expensive failure in spatial preservation is not losing the bytes — it is losing the ability to find, scope, and load them, so a multi-terabyte LiDAR collection sits intact in Glacier while analysts re-fly the survey because nobody could prove the old one existed or which CRS it used. Metadata cataloging is the control plane that prevents that: it turns every archived object into a discoverable, standardized record carrying spatial extent, temporal range, coordinate reference system, tier state, and checksum. This page defines a deterministic cataloging and discovery layer that stays consistent as objects migrate across tiers, indexes spatial fields for sub-second query, and proves its own integrity with runnable validation rather than trust.

## The Failure Mode: Catalog Drift and Metadata Lag

The specific inefficiency this design solves is *catalog drift* — the catalog and the object store disagreeing about what exists, where it lives, and which tier holds it. Three variants recur in spatial archives, and each silently breaks retrieval.

The first is **schema drift on ingest**: pipelines accept records with missing or malformed spatial extents, inconsistent CRS declarations, or absent temporal bounds. Without a validation contract at the gateway, a quarter of an archive can accumulate `bbox` values that are `[0,0,0,0]`, swapped lat/long order, or projected coordinates stored as if they were degrees. The data is physically present but spatially unqueryable; a bounding-box search returns nothing or returns everything.

The second is **tier-state desynchronization**: an object transitions from Standard to Glacier under a lifecycle rule, but the catalog still advertises it as instantly retrievable. A tile server or WFS endpoint follows the stale pointer, issues a read against a deep-archive object, and either stalls for hours or fails outright. The catalog promised a latency the storage class can no longer honor.

The third is **metadata lag**: the search index falls behind ingestion velocity because the indexing cluster is under-provisioned. New scenes are in the bucket but invisible to discovery for hours, so analysts query an archive that does not yet know it grew. Cataloging fixes all three by treating the catalog as a production-critical service with a strict ingestion contract, idempotent tier-state updates, and a search index whose write throughput is monitored against ingestion rate — not as a passive sidecar that scrapes the bucket occasionally.

## Prerequisite Context

This page assumes the surrounding system from the [Spatial Archival Architecture & Tiering Strategy](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/) is already in place. The catalog is the layer that ties the others together, so before standing it up, confirm three things:

- **A storage backend is provisioned and its URI scheme is stable.** The catalog stores object-level pointers; if you have not yet resolved [Object Storage Selection for GIS Archives](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/object-storage-selection-for-gis-archives/), those pointers will churn when you re-platform. Decide the backend first so logical URIs map to durable physical endpoints.
- **Lifecycle transitions are defined.** The catalog must mirror tier state, which only exists once you have a [Hot/Warm/Cold Tier Design for Geospatial Data](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/hotwarmcold-tier-design-for-geospatial-data/) emitting transition events. Cataloging tier state before the tiers are defined produces fields that are always `UNKNOWN`.
- **Retention classes are documented.** Discovery must respect legal holds and visibility flags from your [Retention Policy Frameworks](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/retention-policy-frameworks/); a catalog that surfaces a record scheduled for sanitization invites a compliance incident.

If any of these is missing, the catalog will index pointers that drift, tier fields that never populate, and records it should never have exposed.

## Cataloging Pipeline

Cataloging turns each uploaded object into a discoverable, standardized catalog entry:

<svg viewBox="0 0 1000 140" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Four-stage cataloging pipeline flowing left to right: an Object upload triggers header-only Extraction of bbox, CRS and time; the extracted record is Normalized to a STAC item plus an ISO 19115 record; the STAC item is Indexed in the catalog search engine; and finally served through Discovery and spatial-temporal query. Each stage is automated and decoupled from bulk data movement.">
  <title>Event-Driven Cataloging Pipeline</title>
  <desc>A left-to-right flow of five boxes connected by arrows. Object upload leads to Extract (bbox, CRS, time), which leads to Normalize (STAC item and ISO 19115 record), which leads to Index (geo_shape search engine), which leads to Discovery (spatial + temporal query). A caption notes that extraction reads only file headers, decoupled from bulk data movement.</desc>
  <defs>
    <marker id="cat-arr" markerWidth="9" markerHeight="9" refX="6" refY="3" orient="auto">
      <path d="M0,0 L0,6 L8,3 z" fill="currentColor"/>
    </marker>
  </defs>
  <text x="12" y="22" font-size="10" font-family="sans-serif" fill="currentColor" opacity="0.7">Header-only reads, decoupled from bulk data movement — the catalog is a service, not a bucket scraper</text>
  <rect x="10" y="50" width="168" height="50" rx="6" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="94" y="72" text-anchor="middle" font-size="12" font-family="sans-serif" fill="currentColor">Object upload</text>
  <text x="94" y="88" text-anchor="middle" font-size="8.5" font-family="sans-serif" fill="currentColor" opacity="0.65">object-created event</text>
  <rect x="213" y="50" width="168" height="50" rx="6" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="297" y="72" text-anchor="middle" font-size="12" font-family="sans-serif" fill="currentColor">Extract</text>
  <text x="297" y="88" text-anchor="middle" font-size="8.5" font-family="sans-serif" fill="currentColor" opacity="0.65">bbox · CRS · time</text>
  <rect x="416" y="50" width="168" height="50" rx="6" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="500" y="72" text-anchor="middle" font-size="12" font-family="sans-serif" fill="currentColor">Normalize</text>
  <text x="500" y="88" text-anchor="middle" font-size="8.5" font-family="sans-serif" fill="currentColor" opacity="0.65">STAC + ISO 19115</text>
  <rect x="619" y="50" width="168" height="50" rx="6" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="703" y="72" text-anchor="middle" font-size="12" font-family="sans-serif" fill="currentColor">Index</text>
  <text x="703" y="88" text-anchor="middle" font-size="8.5" font-family="sans-serif" fill="currentColor" opacity="0.65">geo_shape engine</text>
  <rect x="822" y="50" width="168" height="50" rx="6" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="906" y="72" text-anchor="middle" font-size="12" font-family="sans-serif" fill="currentColor">Discovery</text>
  <text x="906" y="88" text-anchor="middle" font-size="8.5" font-family="sans-serif" fill="currentColor" opacity="0.65">spatial + temporal query</text>
  <line x1="178" y1="75" x2="211" y2="75" stroke="currentColor" stroke-width="1.5" marker-end="url(#cat-arr)"/>
  <line x1="381" y1="75" x2="414" y2="75" stroke="currentColor" stroke-width="1.5" marker-end="url(#cat-arr)"/>
  <line x1="584" y1="75" x2="617" y2="75" stroke="currentColor" stroke-width="1.5" marker-end="url(#cat-arr)"/>
  <line x1="787" y1="75" x2="820" y2="75" stroke="currentColor" stroke-width="1.5" marker-end="url(#cat-arr)"/>
  <text x="194" y="120" text-anchor="middle" font-size="8.5" font-family="sans-serif" fill="currentColor" opacity="0.6">read headers</text>
  <text x="397" y="120" text-anchor="middle" font-size="8.5" font-family="sans-serif" fill="currentColor" opacity="0.6">enforce schema</text>
  <text x="600" y="120" text-anchor="middle" font-size="8.5" font-family="sans-serif" fill="currentColor" opacity="0.6">fan out</text>
  <text x="803" y="120" text-anchor="middle" font-size="8.5" font-family="sans-serif" fill="currentColor" opacity="0.6">serve queries</text>
</svg>

Each stage is automated and decoupled from bulk data movement: extraction reads only file headers, normalization enforces the schema contract, indexing fans out to the search engine, and discovery serves spatial and temporal queries. The sections below specify the exact schema, the indexing architecture, and the validation that keeps the four stages consistent.

## Concept & Design Decisions

The core decisions are *which metadata standard to normalize to, which fields to make mandatory, and how to index spatial values for low-latency query*. Each should be justified by geospatial I/O characteristics, not copied from a generic data-catalog example.

**Standard selection.** ISO 19115-1 and FGDC CSDGM remain the authoritative descriptive standards for geospatial metadata and are often required by data-grant conditions, but they are verbose XML and awkward to index directly. Modern archival pipelines normalize to the SpatioTemporal Asset Catalog (STAC) model — a JSON-native, cloud-friendly structure now stewarded as an [OGC](https://www.ogc.org/standards/) community standard — because its flat `properties` block maps cleanly onto a search index, and its extension mechanism carries archival-specific fields without forking the schema. The pragmatic design is to *store* a rich ISO/FGDC record for compliance and *index* a derived STAC item for discovery, keeping one canonical source and one query-optimized projection.

**Mandatory fields.** Enforce a non-negotiable core on every record, because these are exactly the fields whose absence breaks spatial query:

- `bbox` — spatial extent as `[west, south, east, north]`, validated against the declared CRS so projected coordinates are never stored as if they were degrees.
- `datetime` (or `start_datetime`/`end_datetime`) — temporal range in RFC 3339 UTC, so time-window filters are unambiguous.
- `proj:epsg` — the EPSG code of the coordinate reference system; never assume EPSG:4326. CRS loss is the single most common cause of an archived object becoming unloadable, so make this required and validate it against the surrounding pipeline's [CRS Synchronization in Pipelines](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/crs-synchronization-in-pipelines/) guarantees.
- `archive:tier` — current storage class (`hot`, `warm`, `cold`), so discovery can advertise honest retrieval latency.
- `archive:checksum` — a SHA-256 of the object for integrity reconciliation.
- `archive:retention_class` — links the record to its retention policy and legal-hold state.

**Schema rigidity vs ingestion velocity.** Strict validation prevents drift but can bottleneck a high-throughput pipeline; loose validation keeps the pipeline fast but lets bad records in. Resolve the trade-off by validating with a versioned JSON Schema (or Avro) contract at the ingestion gateway and registering every schema version in a registry, so a contract change is a reviewed, backward-compatible event rather than a silent break. Run mandatory fields as hard rejects and descriptive fields as warnings, so a missing `bbox` blocks ingest while a missing `description` only flags it. Field-level provenance and attribute typing here should align with the rules in [Schema Mapping & Attribute Validation](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/schema-mapping-attribute-validation/), so the catalog and the conversion pipeline agree on what a valid attribute looks like.

**Spatial indexing strategy.** A search index that treats `bbox` as four plain numbers cannot answer "what intersects this polygon" efficiently. Index spatial fields with a structure built for it — a BKD-tree `geo_shape` or a `geohash` grid — to bring bounding-box and intersection queries from full-scan seconds down to sub-100ms. Choose geohash precision deliberately: precision 6 (~1.2 km cells) suits continental basemap discovery, precision 8 (~38 m cells) suits parcel- or tile-level search; higher precision inflates index size and write cost without helping coarse queries.

<svg viewBox="0 0 1000 268" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Comparison matrix of three geospatial metadata standards across four attributes, with a callout of the six mandatory core fields. STAC item: JSON, cloud-native format; native indexing fit because its flat properties block maps onto a search index; serves as the derived discovery projection; archival extension support is strong via STAC extensions. ISO 19115: verbose XML; poor indexing fit, awkward to index directly; authoritative and often grant-required for compliance; archival extension via community profiles. FGDC CSDGM: legacy US XML; poor indexing fit; authoritative legacy compliance role; limited extension support. The six mandatory core fields, hard-rejected on absence, are bbox, datetime, proj:epsg, archive:tier, archive:checksum, and archive:retention_class. The design stores a rich ISO or FGDC record for compliance and indexes a derived STAC item for discovery.">
  <title>Metadata Standard Comparison and Mandatory Core Fields</title>
  <desc>A three-row table comparing STAC item, ISO 19115 and FGDC CSDGM across format, indexing fit, compliance role and archival extension support, followed by a band of six chips listing the mandatory core fields enforced as hard rejects at the ingestion gateway.</desc>
  <rect x="10" y="10" width="980" height="36" fill="currentColor" opacity="0.07"/>
  <rect x="10" y="10" width="980" height="168" fill="none" stroke="currentColor" stroke-width="1.2" opacity="0.5"/>
  <line x1="150" y1="10" x2="150" y2="178" stroke="currentColor" stroke-width="1" opacity="0.3"/>
  <line x1="340" y1="10" x2="340" y2="178" stroke="currentColor" stroke-width="1" opacity="0.3"/>
  <line x1="540" y1="10" x2="540" y2="178" stroke="currentColor" stroke-width="1" opacity="0.3"/>
  <line x1="740" y1="10" x2="740" y2="178" stroke="currentColor" stroke-width="1" opacity="0.3"/>
  <line x1="10" y1="46" x2="990" y2="46" stroke="currentColor" stroke-width="1" opacity="0.3"/>
  <line x1="10" y1="90" x2="990" y2="90" stroke="currentColor" stroke-width="1" opacity="0.3"/>
  <line x1="10" y1="134" x2="990" y2="134" stroke="currentColor" stroke-width="1" opacity="0.3"/>
  <text x="20" y="32" font-size="11" font-family="sans-serif" fill="currentColor" font-weight="600">Standard</text>
  <text x="160" y="32" font-size="11" font-family="sans-serif" fill="currentColor" font-weight="600">Format</text>
  <text x="350" y="32" font-size="11" font-family="sans-serif" fill="currentColor" font-weight="600">Indexing fit</text>
  <text x="550" y="32" font-size="11" font-family="sans-serif" fill="currentColor" font-weight="600">Compliance role</text>
  <text x="750" y="32" font-size="11" font-family="sans-serif" fill="currentColor" font-weight="600">Archival extension</text>
  <text x="20" y="64" font-size="11" font-family="sans-serif" fill="currentColor" font-weight="600">STAC item</text>
  <text x="20" y="78" font-size="8.5" font-family="sans-serif" fill="currentColor" opacity="0.65">indexed projection</text>
  <text x="160" y="71" font-size="9.5" font-family="sans-serif" fill="currentColor">JSON, cloud-native</text>
  <text x="350" y="64" font-size="9.5" font-family="sans-serif" fill="currentColor">native — flat properties</text>
  <text x="350" y="78" font-size="9.5" font-family="sans-serif" fill="currentColor">map onto the index</text>
  <text x="550" y="71" font-size="9.5" font-family="sans-serif" fill="currentColor">derived discovery view</text>
  <text x="750" y="64" font-size="9.5" font-family="sans-serif" fill="currentColor">strong — STAC</text>
  <text x="750" y="78" font-size="9.5" font-family="sans-serif" fill="currentColor">extension mechanism</text>
  <text x="20" y="108" font-size="11" font-family="sans-serif" fill="currentColor" font-weight="600">ISO 19115</text>
  <text x="20" y="122" font-size="8.5" font-family="sans-serif" fill="currentColor" opacity="0.65">canonical record</text>
  <text x="160" y="115" font-size="9.5" font-family="sans-serif" fill="currentColor">verbose XML</text>
  <text x="350" y="115" font-size="9.5" font-family="sans-serif" fill="currentColor">poor — awkward to index</text>
  <text x="550" y="108" font-size="9.5" font-family="sans-serif" fill="currentColor">authoritative;</text>
  <text x="550" y="122" font-size="9.5" font-family="sans-serif" fill="currentColor">often grant-required</text>
  <text x="750" y="115" font-size="9.5" font-family="sans-serif" fill="currentColor">via community profiles</text>
  <text x="20" y="152" font-size="11" font-family="sans-serif" fill="currentColor" font-weight="600">FGDC CSDGM</text>
  <text x="20" y="166" font-size="8.5" font-family="sans-serif" fill="currentColor" opacity="0.65">legacy US standard</text>
  <text x="160" y="159" font-size="9.5" font-family="sans-serif" fill="currentColor">XML (legacy)</text>
  <text x="350" y="159" font-size="9.5" font-family="sans-serif" fill="currentColor">poor</text>
  <text x="550" y="159" font-size="9.5" font-family="sans-serif" fill="currentColor">authoritative (legacy)</text>
  <text x="750" y="159" font-size="9.5" font-family="sans-serif" fill="currentColor">limited</text>
  <text x="10" y="208" font-size="10" font-family="sans-serif" fill="currentColor" opacity="0.8" font-weight="600">Mandatory core fields — hard reject on absence at the ingestion gateway</text>
  <rect x="10"  y="220" width="152" height="30" rx="5" fill="currentColor" opacity="0.07"/>
  <rect x="10"  y="220" width="152" height="30" rx="5" fill="none" stroke="currentColor" stroke-width="1" opacity="0.45"/>
  <text x="86"  y="239" text-anchor="middle" font-size="9.5" font-family="monospace" fill="currentColor">bbox</text>
  <rect x="175" y="220" width="152" height="30" rx="5" fill="currentColor" opacity="0.07"/>
  <rect x="175" y="220" width="152" height="30" rx="5" fill="none" stroke="currentColor" stroke-width="1" opacity="0.45"/>
  <text x="251" y="239" text-anchor="middle" font-size="9.5" font-family="monospace" fill="currentColor">datetime</text>
  <rect x="340" y="220" width="152" height="30" rx="5" fill="currentColor" opacity="0.07"/>
  <rect x="340" y="220" width="152" height="30" rx="5" fill="none" stroke="currentColor" stroke-width="1" opacity="0.45"/>
  <text x="416" y="239" text-anchor="middle" font-size="9.5" font-family="monospace" fill="currentColor">proj:epsg</text>
  <rect x="505" y="220" width="152" height="30" rx="5" fill="currentColor" opacity="0.07"/>
  <rect x="505" y="220" width="152" height="30" rx="5" fill="none" stroke="currentColor" stroke-width="1" opacity="0.45"/>
  <text x="581" y="239" text-anchor="middle" font-size="9.5" font-family="monospace" fill="currentColor">archive:tier</text>
  <rect x="670" y="220" width="152" height="30" rx="5" fill="currentColor" opacity="0.07"/>
  <rect x="670" y="220" width="152" height="30" rx="5" fill="none" stroke="currentColor" stroke-width="1" opacity="0.45"/>
  <text x="746" y="239" text-anchor="middle" font-size="9.5" font-family="monospace" fill="currentColor">archive:checksum</text>
  <rect x="835" y="220" width="155" height="30" rx="5" fill="currentColor" opacity="0.07"/>
  <rect x="835" y="220" width="155" height="30" rx="5" fill="none" stroke="currentColor" stroke-width="1" opacity="0.45"/>
  <text x="912" y="239" text-anchor="middle" font-size="9" font-family="monospace" fill="currentColor">archive:retention_class</text>
</svg>

## Implementation

Manual cataloging does not survive contact with archival volume, and a catalog populated by periodic bucket scans is always stale. Make the catalog event-driven and codified: extract metadata at ingest in a serverless function, write the canonical STAC item, and fan it out to a search index. The Python below parses a Cloud-Optimized GeoTIFF header and emits a schema-compliant STAC item — reading only metadata, never the pixel payload.

```python
# catalog/extract_stac_item.py — runs on object-created event, header-only read
import hashlib
import rasterio
from rasterio.warp import transform_bounds
from datetime import datetime, timezone

def build_stac_item(s3_uri: str, local_path: str, tier: str) -> dict:
    with rasterio.open(local_path) as src:
        epsg = src.crs.to_epsg()                       # never assume 4326
        # Reproject native bounds to WGS84 for the index; keep native EPSG in props
        west, south, east, north = transform_bounds(
            src.crs, "EPSG:4326", *src.bounds, densify_pts=21
        )
    bbox = [round(west, 6), round(south, 6), round(east, 6), round(north, 6)]
    if not (-180 <= west < east <= 180 and -90 <= south < north <= 90):
        raise ValueError(f"Invalid bbox for {s3_uri}: {bbox}")  # hard reject

    with open(local_path, "rb") as fh:
        checksum = hashlib.sha256(fh.read()).hexdigest()

    return {
        "type": "Feature",
        "stac_version": "1.0.0",
        "id": s3_uri.rsplit("/", 1)[-1],
        "bbox": bbox,
        "geometry": {
            "type": "Polygon",
            "coordinates": [[[west, south], [east, south],
                             [east, north], [west, north], [west, south]]],
        },
        "properties": {
            "datetime": datetime.now(timezone.utc).isoformat(),
            "proj:epsg": epsg,
            "archive:tier": tier,
            "archive:checksum": checksum,
            "archive:retention_class": "compliance-7y",
        },
        "assets": {
            # Logical URI resolved by the routing service — never a hard-coded bucket
            "data": {"href": s3_uri, "type": "image/tiff; application=geotiff; profile=cloud-optimized"}
        },
    }
```

Keep the search index aligned to that schema. The OpenSearch mapping below types the spatial field as `geo_shape` (BKD-tree backed) and the temporal field as `date`, so range and intersection filters are index-native rather than scripted:

```json
{
  "mappings": {
    "properties": {
      "geometry":   { "type": "geo_shape" },
      "bbox":       { "type": "float" },
      "properties": {
        "properties": {
          "datetime":         { "type": "date" },
          "proj:epsg":        { "type": "integer" },
          "archive:tier":     { "type": "keyword" },
          "archive:checksum": { "type": "keyword" }
        }
      }
    }
  }
}
```

To keep tier state honest, consume lifecycle transition events from a durable broker and apply them as idempotent upserts rather than blind writes, so a replayed or out-of-order event cannot regress a record:

```bash
# Update only the tier field when a TIER_MIGRATION event lands; create-or-update, never duplicate
aws s3api head-object --bucket geo-archive-prod \
  --key datasets/imagery/published/2024/region_north.tif --query 'StorageClass'
# → "GLACIER"  → drives an upsert of properties.archive:tier = "cold"
```

Two spatial-specific choices are load-bearing. First, the extractor reprojects native bounds to EPSG:4326 for the index but preserves the native `proj:epsg` in `properties`, so coarse global search works while the record still records the true CRS for loading. Second, the asset `href` is a logical URI resolved through a routing service, never a hard-coded bucket path — that single indirection is what lets storage re-platforming or a cost-driven tier shift happen without invalidating every pointer in the catalog.

## Validation Gate

A catalog that ingests is not the same as a catalog that is *consistent* with storage. Two checks prove it. First, confirm a spatial query actually returns the object you expect, exercising the `geo_shape` index end to end:

```bash
curl -s "https://catalog.geo-archive-prod/_search" -H 'Content-Type: application/json' -d '{
  "query": { "geo_shape": { "geometry": {
    "shape": { "type": "envelope", "coordinates": [[-123.5, 49.3], [-122.1, 48.4]] },
    "relation": "intersects" } } } }' | jq '.hits.total.value'
```

Expected output is a non-zero count for a region you know is archived — for example `1` for the `region_north` mosaic above. If it returns `0` for an object that is demonstrably in the bucket, the most common root cause is a **CRS/axis-order mismatch in `bbox`**: the extractor stored projected coordinates (e.g. UTM metres) or swapped lat/long, so the envelope never intersects. Re-run the extractor's bounds validation and confirm `transform_bounds` ran against the object's true `proj:epsg`, not an assumed EPSG:4326.

Second, reconcile the catalog against the object store to catch drift directly:

```bash
# Count catalog records whose pointer no longer resolves to a live object
python catalog/reconcile.py --bucket geo-archive-prod --report orphans.json \
  && jq '.orphaned_pointers | length' orphans.json
```

Expected output is `0`. A non-zero count means the catalog advertises objects that were deleted, moved, or re-keyed — exactly the drift this gate exists to surface. Inspect `orphans.json`; if the orphans share a key prefix, a bucket re-platforming bypassed the routing service and the logical-URI indirection was not honored.

## Cost & Performance Trade-offs

The catalog is small in bytes but its design choices have outsized cost and latency effects.

**Transactional store vs analytical index.** Separate the two. A managed catalog such as AWS Glue maintains partitioned tables, schema evolution, and lineage for SQL-based access through Athena/EMR without standing up dedicated compute; a search engine such as OpenSearch serves low-latency discovery. Collapsing both into one engine either makes lineage queries slow or makes spatial discovery expensive.

| Layer | Best at | Cost driver | Spatial use case |
|---|---|---|---|
| Glue + Athena | partitioned scans, lineage, schema evolution | per-TB scanned | audit "which scenes overlap this AOI, by year" |
| OpenSearch `geo_shape` | sub-100ms bbox/intersection, full-text | provisioned cluster hours | interactive map-extent discovery |
| S3 inventory / manifest | cheap source of truth for reconciliation | per-million-object listing | nightly orphan detection |

**Index lifecycle.** Discovery indexes grow with the archive, but old metadata is queried far less than new. Roll indexes over monthly with index lifecycle management and migrate aged indexes to frozen/searchable-snapshot tiers — this keeps hot index RAM bounded so a decade of records does not force the OpenSearch cluster to scale linearly with total asset count.

**Geohash precision vs index size.** Precision is a direct cost lever: each added geohash level multiplies cell count by 32. Index at the coarsest precision that satisfies the query — over-precise spatial indexing inflates both storage and write throughput for no recall benefit on extent-level search.

**Indexing throughput vs ingestion velocity.** Provision indexing write capacity against peak ingestion, not average. An under-provisioned cluster produces metadata lag — new scenes invisible to discovery — which is an SLA breach even though no data was lost. Monitor index write rate against ingestion rate and alert when the gap grows.

## Failure Modes & Edge Cases

Four pitfalls are specific to geospatial cataloging and account for most discovery incidents.

1. **CRS loss on extraction.** If the extractor defaults a missing CRS to EPSG:4326, projected datasets get a `bbox` in metres interpreted as degrees, and the object becomes spatially unfindable. Make `proj:epsg` a hard-required field and reject records whose declared CRS cannot be resolved, cross-checking against the conversion pipeline's [CRS Synchronization in Pipelines](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/crs-synchronization-in-pipelines/) contract.
2. **Antimeridian and pole-crossing bboxes.** A scene spanning the 180° meridian yields a `bbox` whose `west` is greater than `east`; naive validation rejects it or, worse, a query treats it as a globe-spanning extent. Detect dateline-crossing geometries and split them, or store a MultiPolygon, rather than letting the bbox check silently drop polar and Pacific datasets.
3. **Tier-state pointer staleness.** When an object transitions to a deep-archive class but the `archive:tier` field is not upserted, discovery promises instant retrieval the storage cannot deliver. Drive every tier field exclusively from broker events with idempotent upserts; never let it be set once at ingest and forgotten.
4. **Multi-file format atomicity.** Legacy shapefiles (`.shp`, `.shx`, `.dbf`, `.prj`) and sidecar `.cpg`/`.aux.xml` files must catalog as one logical asset; index the `.shp` alone and a restore returns an unreadable fragment because the CRS lives in the missing `.prj`. Group sidecars into a single STAC item with multiple assets so the unit of discovery matches the unit of use.

## Operational Execution Checklist

- [ ] Normalize every record to a STAC item while retaining a canonical ISO 19115 record for compliance
- [ ] Enforce mandatory `bbox`, `datetime`, `proj:epsg`, `archive:tier`, and `archive:checksum` as hard rejects at the gateway
- [ ] Register every schema version in a registry and gate changes for backward compatibility
- [ ] Extract metadata from headers only, decoupled from bulk data movement
- [ ] Reproject bounds to EPSG:4326 for the index while preserving native `proj:epsg` in properties
- [ ] Resolve asset `href` through a routing service — never hard-code bucket paths
- [ ] Drive `archive:tier` exclusively from broker events via idempotent upserts
- [ ] Index spatial fields as `geo_shape`/geohash at the coarsest precision the query needs
- [ ] Run a daily reconciliation job and alert when orphaned pointers exceed 0.5% of asset count
- [ ] Validate `bbox` against declared CRS and handle antimeridian/pole-crossing geometries explicitly

## Compliance & Security Alignment

Catalog access must be least-privilege and auditable, because the index is the map of everything the archive holds. Apply attribute-based access control keyed to dataset classification, geographic jurisdiction, and retention status, disable public access on catalog stores, and require VPC endpoints for catalog API calls. For multi-region or multi-cloud deployments, synchronize catalog state with change-data-capture streams serialized to a neutral format and replicate only to approved jurisdictions, resolving conflicts with checksum-validated last-write-wins; encrypt in transit with TLS 1.3 and mutual authentication. Keep the descriptive records interoperable with [OGC](https://www.ogc.org/standards/) metadata standards and align audit and sanitization practices with the [NIST SP 800-88 Rev. 1](https://csrc.nist.gov/publications/detail/sp/800-88/rev-1/final) guidelines, so the catalog remains both discoverable and defensible years after ingest.

## Related

- [Spatial Archival Architecture & Tiering Strategy](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/) — the parent guide this cataloging layer fits inside; start there for the end-to-end lifecycle.
- [Hot/Warm/Cold Tier Design for Geospatial Data](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/hotwarmcold-tier-design-for-geospatial-data/) — emits the tier-transition events the catalog mirrors to advertise honest retrieval latency.
- [Object Storage Selection for GIS Archives](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/object-storage-selection-for-gis-archives/) — determines the URI scheme behind the logical pointers the catalog resolves.
- [Retention Policy Frameworks](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/retention-policy-frameworks/) — supplies the visibility flags and legal-hold state discovery must respect.
- [Schema Mapping & Attribute Validation](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/schema-mapping-attribute-validation/) — the cross-pipeline contract that keeps catalog attributes and converted data in agreement.

Up one level: [Spatial Archival Architecture & Tiering Strategy](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/).
