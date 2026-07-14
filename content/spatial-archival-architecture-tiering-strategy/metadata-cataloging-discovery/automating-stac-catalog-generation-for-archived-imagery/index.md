# Automating STAC Catalog Generation for Archived Imagery

Automating STAC catalog generation for archived imagery means emitting a SpatioTemporal Asset Catalog Item for every Cloud-Optimized GeoTIFF at ingest, extracting footprint geometry, acquisition datetime, and EO band properties directly from the raster, then publishing a static STAC catalog on object storage so cold assets stay searchable without a rehydration or a live database. This guide is for data engineers and GIS archivists who tier raster collections into GLACIER or Deep Archive and cannot afford a catalog that goes blind the moment the pixels move off hot storage. Default tooling fails here in two ways: interactive catalog services assume the assets are readable on demand, and hand-written JSON drifts from the actual raster metadata within a release or two. The fix is a deterministic extract-and-serialize step wired into the same event that lands the COG, producing catalog entries that outlive the ingest team.

## Catalog Generation Flow

Each COG upload fires an extraction that builds one STAC Item, folds it into a Collection, and rewrites the static index that fronts the archive:

<svg viewBox="0 0 1010 160" role="img" aria-label="Five-stage STAC generation pipeline, left to right: stage one COG object-created event, stage two extract footprint datetime and EO properties with rio-stac, stage three build a STAC Item as JSON, stage four roll the Item into a Collection, stage five publish the static catalog.json to object storage as the search index." xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;color:var(--primary);font-family:var(--font-sans)">
  <title>STAC catalog generation stages for archived COG imagery</title>
  <desc>A left-to-right pipeline: a COG object-created event triggers property extraction with rio-stac, which builds a STAC Item, which is folded into a Collection, which is published as a static catalog.json on object storage that serves discovery without rehydrating the pixels.</desc>
  <defs>
    <marker id="stac-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <g text-anchor="middle">
    <rect x="7" y="34" width="180" height="92" rx="11" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-opacity="0.4"/>
    <circle cx="97" cy="58" r="12" fill="currentColor" fill-opacity="0.12" stroke="currentColor" stroke-opacity="0.5"/>
    <text x="97" y="62" font-size="12" font-weight="700" fill="currentColor">1</text>
    <text x="97" y="90" font-size="13" font-weight="600" fill="currentColor">COG object</text>
    <text x="97" y="108" font-size="13" font-weight="600" fill="currentColor">created</text>
    <rect x="211" y="34" width="180" height="92" rx="11" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-opacity="0.4"/>
    <circle cx="301" cy="58" r="12" fill="currentColor" fill-opacity="0.12" stroke="currentColor" stroke-opacity="0.5"/>
    <text x="301" y="62" font-size="12" font-weight="700" fill="currentColor">2</text>
    <text x="301" y="90" font-size="13" font-weight="600" fill="currentColor">Extract footprint</text>
    <text x="301" y="108" font-size="13" font-weight="600" fill="currentColor">datetime &#183; EO</text>
    <rect x="415" y="34" width="180" height="92" rx="11" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-opacity="0.4"/>
    <circle cx="505" cy="58" r="12" fill="currentColor" fill-opacity="0.12" stroke="currentColor" stroke-opacity="0.5"/>
    <text x="505" y="62" font-size="12" font-weight="700" fill="currentColor">3</text>
    <text x="505" y="90" font-size="13" font-weight="600" fill="currentColor">Build STAC</text>
    <text x="505" y="108" font-size="13" font-weight="600" fill="currentColor">Item (JSON)</text>
    <rect x="619" y="34" width="180" height="92" rx="11" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-opacity="0.4"/>
    <circle cx="709" cy="58" r="12" fill="currentColor" fill-opacity="0.12" stroke="currentColor" stroke-opacity="0.5"/>
    <text x="709" y="62" font-size="12" font-weight="700" fill="currentColor">4</text>
    <text x="709" y="90" font-size="13" font-weight="600" fill="currentColor">Roll into</text>
    <text x="709" y="108" font-size="13" font-weight="600" fill="currentColor">Collection</text>
    <rect x="823" y="34" width="180" height="92" rx="11" fill="currentColor" fill-opacity="0.13" stroke="currentColor" stroke-opacity="0.7" stroke-width="1.5"/>
    <circle cx="913" cy="58" r="12" fill="currentColor" fill-opacity="0.2" stroke="currentColor" stroke-opacity="0.7"/>
    <text x="913" y="62" font-size="12" font-weight="700" fill="currentColor">5</text>
    <text x="913" y="90" font-size="13" font-weight="700" fill="currentColor">Publish static</text>
    <text x="913" y="108" font-size="13" font-weight="700" fill="currentColor">catalog.json</text>
  </g>
  <g stroke="currentColor" stroke-width="2" fill="none" stroke-opacity="0.5">
    <path d="M189 80 H209" marker-end="url(#stac-arrow)"/>
    <path d="M393 80 H413" marker-end="url(#stac-arrow)"/>
    <path d="M597 80 H617" marker-end="url(#stac-arrow)"/>
    <path d="M801 80 H821" marker-end="url(#stac-arrow)"/>
  </g>
</svg>

## Extracting Item Properties from the COG

A STAC Item is only as trustworthy as the metadata it copies out of the raster. Extract from the pixels, never from the filename, so a mislabeled path never poisons the index. `rio-stac` reads the GeoTIFF header and returns a spec-compliant Item skeleton with footprint, bbox, projection extension, and per-band EO properties already populated.

1. **Extract the base Item from the raster header:**
```bash
rio stac s3://spatial-archive/imagery/cog/2023/sentinel2_region_north.tif \
  --datetime 2023-06-14T10:21:00Z \
  --collection sentinel2-l2a \
  --asset-name visual \
  --asset-mediatype COG \
  --with-proj --with-eo \
  --output /tmp/sentinel2_region_north.json
```
 `--with-proj` writes `proj:epsg` and `proj:transform` from the raster's CRS and geotransform; `--with-eo` derives `eo:bands` and cloud-cover where the driver exposes it. Pass `--datetime` explicitly when the acquisition time lives in a sidecar rather than a GDAL metadata domain — inferring it from the object's last-modified timestamp is a common and corrupting mistake.

2. **Assert the footprint is a true geometry, not the bounding box.** For scenes with nodata collars (rotated swaths, masked ocean), the convex bbox overstates coverage and breaks spatial search. Derive the valid-data footprint and reproject it to EPSG:4326, the CRS the STAC geometry field mandates:
```python
import rasterio
from rasterio.features import dataset_features
from shapely.geometry import shape, mapping
from shapely.ops import transform
import pyproj

with rasterio.open("s3://spatial-archive/imagery/cog/2023/sentinel2_region_north.tif") as ds:
    feats = list(dataset_features(ds, bidx=1, as_mask=True, geographic=False))
    geom_native = shape(feats[0]["geometry"])
    to_wgs84 = pyproj.Transformer.from_crs(ds.crs, "EPSG:4326", always_xy=True).transform
    footprint = transform(to_wgs84, geom_native).simplify(0.001)
    item_geometry = mapping(footprint)  # GeoJSON in EPSG:4326 for the STAC Item
```

3. **Attach the COG as a range-readable asset.** The asset `href` must point at the archived object with an explicit media type so a reader knows a range request works. Preserving the `proj:` and `eo:` extensions is what lets a query filter by CRS or band without opening the file, which is the entire point once the object is cold.

## Building Collections and the Static Catalog

Individual Items are useless without a parent that defines shared extent, license, and band definitions. Assemble a Collection, then serialize a static catalog — a tree of JSON files linked by relative `rel` hrefs — that lives beside the imagery on the same object store.

```python
import pystac
from datetime import datetime, timezone

collection = pystac.Collection(
    id="sentinel2-l2a",
    description="Archived Sentinel-2 L2A COGs, cold-tiered after 365 days",
    extent=pystac.Extent(
        spatial=pystac.SpatialExtent([[-124.8, 45.5, -116.9, 49.1]]),
        temporal=pystac.TemporalExtent([[datetime(2015, 6, 27, tzinfo=timezone.utc), None]]),
    ),
    license="proprietary",
)

item = pystac.Item.from_file("/tmp/sentinel2_region_north.json")
collection.add_item(item)

catalog = pystac.Catalog(id="spatial-archive", description="Cold imagery archive index")
catalog.add_child(collection)

# Static, relative-href layout: no server, no database — just JSON on object storage.
catalog.normalize_hrefs("s3://spatial-archive/catalog")
catalog.save(catalog_type=pystac.CatalogType.SELF_CONTAINED)
```

Push the resulting tree to the archive bucket under a hot prefix even when the imagery itself is cold. The catalog is a few megabytes of JSON; keeping it on `STANDARD` while the COGs sit in GLACIER costs almost nothing and preserves millisecond discovery. This mirrors the ingest discipline described in [Metadata Cataloging & Discovery](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/metadata-cataloging-discovery/): the catalog is the search layer, the pixels are the payload, and they are tiered independently. Because `proj:epsg` is copied straight from the raster, the same reference-system integrity enforced by [CRS Synchronization in Pipelines](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/crs-synchronization-in-pipelines/) during conversion carries through into the index unchanged.

```bash
aws s3 sync s3://spatial-archive/catalog/ s3://spatial-archive/catalog/ \
  --storage-class STANDARD --content-type application/json
```

Two serialization choices decide how the catalog behaves at scale. A `SELF_CONTAINED` layout uses relative hrefs so the whole tree is portable — copy it to another bucket or provider and every link still resolves, which matters for the cross-cloud resilience an archive is built to survive. An `ABSOLUTE_PUBLISHED` layout bakes the bucket URL into every link, which is faster for a static browser to crawl but pins the catalog to one location. For a long-lived archive, favor self-contained trees and resolve absolute URLs only at publish time. The second choice is granularity: a single monolithic catalog file becomes a bottleneck past a few thousand Items, so shard Collections by year or sensor and let the root catalog link to child catalogs rather than to every Item directly. This keeps any single JSON document small enough to parse in a browser or a Lambda without loading the entire index into memory.

Incremental generation is what keeps the catalog cheap to maintain. Because each COG event writes exactly one Item, you never regenerate the whole tree — you write the new Item, append its link to the parent Collection, and touch only the two files that changed. Guard against duplicate Items on event retries by making the Item `id` a deterministic function of the object key, so a replayed `ObjectCreated` event overwrites the same Item rather than creating a second one. That idempotency is what lets the pipeline run at-least-once delivery without corrupting the index.

## Validating the Generated Catalog

A catalog that fails validation silently is worse than no catalog, because it invites false confidence. Run the official validator against every Item and Collection before treating the index as authoritative.

```bash
stac-validator s3://spatial-archive/catalog/sentinel2-l2a/sentinel2_region_north/sentinel2_region_north.json
```

Expected output — the Item must pass core plus every declared extension schema:
```text
[
  {
    "version": "1.0.0",
    "path": ".../sentinel2_region_north.json",
    "schema": [
      "https://schemas.stacspec.org/v1.0.0/item-spec/json-schema/item.json",
      "https://stac-extensions.github.io/projection/v1.1.0/schema.json",
      "https://stac-extensions.github.io/eo/v1.1.0/schema.json"
    ],
    "valid_stac": true
  }
]
```

Then confirm the catalog is actually queryable without touching the cold pixels. A DuckDB scan over the static Item JSON proves footprint and datetime made it in intact:
```bash
duckdb -c "SELECT id, properties->>'datetime' AS dt, properties->>'proj:epsg' AS epsg
  FROM read_json_auto('s3://spatial-archive/catalog/**/*.json', maximum_object_size=20000000)
  WHERE type = 'Feature' LIMIT 5"
```
A non-null `epsg` and a valid ISO-8601 `dt` on every row confirms the extraction wrote real values, not the placeholders that appear when `--with-proj` silently no-ops on a CRS-less raster.

## Failure Modes and Fixes

| Symptom | Root Cause | Resolution |
|---------|------------|------------|
| Item `geometry` equals the bbox rectangle | Footprint taken from raster extent, not valid-data mask | Derive footprint via `dataset_features(..., as_mask=True)` and `simplify()` before writing |
| `proj:epsg` is `null` in every Item | Source COG has no embedded CRS or a broken PROJ string | Assert CRS at ingest; reproject with `gdalwarp -t_srs EPSG:4326` and re-extract |
| Spatial search misses cold scenes | Item `datetime` inferred from object last-modified, not acquisition | Pass `--datetime` from the authoritative sidecar; reject Items with a datetime after ingest time |
| `stac-validator` fails on extension schema | Extension declared in `stac_extensions` but properties absent | Run `--with-eo`/`--with-proj` consistently, or drop the unused extension URL from the Item |

## Operational Execution Checklist

- [ ] Trigger extraction on the COG `ObjectCreated` event so the Item is written in the same transaction as the asset.
- [ ] Populate `datetime` from the authoritative acquisition source, never the object's last-modified timestamp.
- [ ] Derive the valid-data footprint reprojected to EPSG:4326; do not ship the bbox as the geometry.
- [ ] Copy `proj:epsg`, `proj:transform`, and `eo:bands` straight from the raster header via `--with-proj --with-eo`.
- [ ] Serialize a self-contained static catalog with relative hrefs and keep it on a hot prefix while the COGs go cold.
- [ ] Run `stac-validator` against core plus every declared extension schema before promoting the catalog.
- [ ] Reconcile the Item count against the ingested COG count so no scene lands in the archive uncatalogued.

## Related

- Up: [Metadata Cataloging & Discovery](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/metadata-cataloging-discovery/) — the parent reference for keeping cold spatial assets findable without rehydration.
- [Extracting ISO 19115 Metadata from Legacy GeoTIFFs](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/metadata-cataloging-discovery/extracting-iso-19115-metadata-from-legacy-geotiffs/) — the complementary record standard for older rasters that predate STAC.
- [How to Design a 3-Tier Spatial Storage Architecture](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/hotwarmcold-tier-design-for-geospatial-data/how-to-design-a-3-tier-spatial-storage-architecture/) — where the imagery this catalog indexes actually lives across hot, warm, and cold.
- [Automating CRS Transformations in ETL Pipelines](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/crs-synchronization-in-pipelines/automating-crs-transformations-in-etl-pipelines/) — enforcing the reference-system integrity that `proj:epsg` inherits.
- [Spatial Archive Cost Modeling](https://www.spatialdataarchival.org/spatial-archive-cost-modeling/) — pricing the split between a hot catalog and cold pixels.

_Part of the [Spatial Data Archival](https://www.spatialdataarchival.org/) knowledge base._
