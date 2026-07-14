# Streaming FlatGeobuf Features Over HTTP Range Requests

Streaming FlatGeobuf features over HTTP range requests lets a client read only the features inside a query bounding box directly from an `.fgb` object on S3 or Azure Blob, issuing a short sequence of `206 Partial Content` reads against the packed spatial index instead of downloading the entire archive. This guide is for data engineers and application teams serving interactive maps or extract jobs from warm-tier object storage who need predictable latency and predictable egress as archives grow into the tens of gigabytes. It explains how a bounding-box query becomes a set of byte ranges, the exact requests to issue against cloud stores, the CDN behaviors that silently break range support, and the latency crossover where a full download beats streaming. It builds directly on the packed Hilbert R-tree produced in [building a FlatGeobuf spatial index for HTTP range reads](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/flatgeobuf-optimization-techniques/building-a-flatgeobuf-spatial-index-for-http-range-reads/) and sits within the broader [Format Conversion & Pipeline Automation](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/) workflow.

## The Range-Request Round Trip

A bounding-box read is not one request; it is a short, ordered conversation between the client and the object store:

<svg viewBox="0 0 840 340" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="A sequence diagram between a map client on the left and an object store reached through a CDN on the right. Three request-and-response pairs run top to bottom. First the client sends a Range request for the header and index root and receives 206 Partial Content with schema, CRS and root node. Second it requests the R-tree node ranges for its bounding box and receives the matched leaf offsets. Third it requests the matched feature byte ranges and receives the features ready to render. A caption notes total bytes fetched scale with the bounding box, not the file." style="width:100%;height:auto;color:var(--primary);font-family:var(--font-sans)">
  <title>FlatGeobuf range-request round trip</title>
  <desc>Three ordered request-and-response pairs between a map client and an object store behind a CDN: fetch the header and index root, fetch the R-tree node ranges intersecting the bounding box, then fetch only the matched feature byte ranges. Each response is 206 Partial Content.</desc>
  <defs>
    <marker id="rq-r" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
    <marker id="rq-l" viewBox="0 0 10 10" refX="2" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M10 0 L0 5 L10 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <!-- lane heads -->
  <g text-anchor="middle">
    <rect x="70" y="30" width="140" height="34" rx="7" fill="currentColor" fill-opacity="0.08" stroke="currentColor" stroke-opacity="0.55"/>
    <text x="140" y="52" font-size="11.5" font-weight="700" fill="currentColor">Map client</text>
    <rect x="610" y="30" width="150" height="34" rx="7" fill="currentColor" fill-opacity="0.08" stroke="currentColor" stroke-opacity="0.55"/>
    <text x="685" y="47" font-size="11.5" font-weight="700" fill="currentColor">Object store</text>
    <text x="685" y="60" font-size="8.5" fill="currentColor" fill-opacity="0.7">via CDN edge</text>
  </g>
  <!-- lifelines -->
  <g stroke="currentColor" stroke-opacity="0.3" stroke-width="1" stroke-dasharray="3 4">
    <path d="M140 64 V300"/>
    <path d="M685 64 V300"/>
  </g>
  <!-- row 1 -->
  <text x="417" y="98" text-anchor="middle" font-size="9.5" font-weight="600" fill="currentColor">&#9312; Range: bytes=0&#8211;65535  header + index root</text>
  <path d="M150 104 H675" stroke="currentColor" stroke-width="1.6" stroke-opacity="0.7" marker-end="url(#rq-r)"/>
  <path d="M675 128 H150" stroke="currentColor" stroke-width="1.4" stroke-opacity="0.55" stroke-dasharray="5 4" marker-end="url(#rq-l)"/>
  <text x="417" y="146" text-anchor="middle" font-size="9.5" fill="currentColor" fill-opacity="0.8">&#9312; 206 Partial Content  schema &#183; CRS &#183; root node</text>
  <!-- row 2 -->
  <text x="417" y="176" text-anchor="middle" font-size="9.5" font-weight="600" fill="currentColor">&#9313; Range: bytes=… traverse R-tree for bbox</text>
  <path d="M150 182 H675" stroke="currentColor" stroke-width="1.6" stroke-opacity="0.7" marker-end="url(#rq-r)"/>
  <path d="M675 206 H150" stroke="currentColor" stroke-width="1.4" stroke-opacity="0.55" stroke-dasharray="5 4" marker-end="url(#rq-l)"/>
  <text x="417" y="224" text-anchor="middle" font-size="9.5" fill="currentColor" fill-opacity="0.8">&#9313; 206 Partial Content  matched leaf offsets</text>
  <!-- row 3 -->
  <text x="417" y="254" text-anchor="middle" font-size="9.5" font-weight="600" fill="currentColor">&#9314; Range: bytes=… matched feature ranges</text>
  <path d="M150 260 H675" stroke="currentColor" stroke-width="1.6" stroke-opacity="0.7" marker-end="url(#rq-r)"/>
  <path d="M675 284 H150" stroke="currentColor" stroke-width="1.4" stroke-opacity="0.55" stroke-dasharray="5 4" marker-end="url(#rq-l)"/>
  <text x="417" y="302" text-anchor="middle" font-size="9.5" fill="currentColor" fill-opacity="0.8">&#9314; 206 Partial Content  features ready to render</text>
  <text x="420" y="328" text-anchor="middle" font-size="10" fill="currentColor" fill-opacity="0.75">Bytes fetched scale with the bounding box, not the file size &#8212; a small window against a 40 GB layer is still a few KB.</text>
</svg>

The first read pulls the header and the top of the index in one shot, resolving the schema, CRS, and the R-tree's root node. The client then walks the tree: it descends only the nodes whose bounding boxes intersect the query rectangle, issuing follow-up range reads for deeper node blocks as needed. Traversal terminates at a set of leaf offsets, each pointing at a contiguous run of features in the payload. The final reads fetch exactly those feature byte ranges. Because Hilbert ordering keeps spatially adjacent features adjacent on disk, the matched features usually coalesce into a handful of contiguous ranges rather than hundreds of scattered ones — which is what keeps the request count, and therefore the latency, bounded. The write-side guarantee that makes this hold is covered under [FlatGeobuf Optimization Techniques](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/flatgeobuf-optimization-techniques/).

Each read is a network round trip, so the total latency of a query is roughly the number of dependent range requests multiplied by the store's time-to-first-byte. Against a warm tier that is typically tens of milliseconds per request, and a tight bounding box resolves in three to five reads. That is the entire economic argument: you pay for a few kilobytes of transfer and a few round trips instead of egressing a whole object, which is why FlatGeobuf owns the range-read web-delivery tier while analytical extracts belong to the columnar [GeoParquet Migration Workflows](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/geoparquet-migration-workflows/) path.

## Issuing Range Requests Against Object Storage

The steps below take a bounding-box query from a raw HTTP probe to a working GDAL client that reads only the intersecting features.

1. **Confirm the store and its edge honor byte ranges.** Object stores support ranges natively, but a fronting CDN may not. Probe with an explicit range and inspect the status line — you need `206`, not `200`.

```bash
# A GET (not HEAD) reveals whether ranges are actually served end to end.
curl -s -r 0-65535 -o /dev/null -D - \
  https://spatial-archive.s3.us-west-2.amazonaws.com/fgb/parcels/2024/region_north_indexed.fgb
# Expected:
#   HTTP/1.1 206 Partial Content
#   Accept-Ranges: bytes
#   Content-Range: bytes 0-65535/1974330112
#   Content-Length: 65536
```

2. **Run the bounding-box query through GDAL's range-reading virtual filesystem.** GDAL reads `.fgb` over `/vsis3/` (or `/vsicurl/` for a public URL) using the spatial index and HTTP ranges automatically; `pyogrio` exposes this with a `bbox` filter. Only the intersecting features are materialized.

```python
import pyogrio

# bbox is (minx, miny, maxx, maxy) in the file's CRS (EPSG:4326 here).
# GDAL walks the R-tree and issues range reads under the hood — the whole
# 1.9 GB object is never downloaded.
gdf = pyogrio.read_dataframe(
    "/vsis3/spatial-archive/fgb/parcels/2024/region_north_indexed.fgb",
    bbox=(-122.72, 45.44, -122.55, 45.60),  # Portland west-side window
    columns=["parcel_id", "zoning", "assessed_value"],
)
print(len(gdf), "features fetched inside the window")
```

3. **Account for the bytes actually transferred.** Enable GDAL's cURL tracing to see each range request and prove the read footprint matches the bounding box rather than the file size.

```bash
# CPL_CURL_VERBOSE logs every Range request GDAL issues for one query.
export CPL_CURL_VERBOSE=YES
export CPL_DEBUG=ON
export AWS_REGION=us-west-2
python query_bbox.py 2>&1 | grep -E "Range: bytes|Content-Range" | head
# Each line is one 206 read; sum the Content-Length values for total bytes moved.
```

## Validation & Verification

Prove three things before trusting a range-streaming endpoint in production: the store returns `206`, the query returns only in-window features, and the transferred bytes are a small fraction of the object.

```bash
# 1. Range support and object size in one probe.
curl -s -r 0-1023 -o /dev/null -D - \
  https://spatial-archive.s3.us-west-2.amazonaws.com/fgb/parcels/2024/region_north_indexed.fgb \
  | grep -E "206|Content-Range"
# Expected: HTTP/1.1 206 Partial Content
#           Content-Range: bytes 0-1023/1974330112
```

```python
# 2. Spatial correctness + byte-footprint sanity check.
import pyogrio, shapely.geometry as sg

bbox = (-122.72, 45.44, -122.55, 45.60)
gdf = pyogrio.read_dataframe(
    "/vsis3/spatial-archive/fgb/parcels/2024/region_north_indexed.fgb", bbox=bbox
)
window = sg.box(*bbox)
# Every returned geometry must intersect the query window (the index is exact
# at the leaf, so no far-away features should appear).
assert gdf.geometry.intersects(window).all(), "index returned out-of-window features"
print(f"{len(gdf)} features; expected a few thousand, not all 482,817")
```

Expected result: a query over a neighborhood-scale window against a ~1.9 GB layer returns a few thousand features and moves on the order of a few hundred kilobytes — three to four orders of magnitude less than a full download. If the returned count approaches the full feature count, the index was bypassed and the client fell back to a scan.

## CDN and Range-Support Caveats

Range streaming lives or dies on the transport layer between the client and the object bytes. The failure modes are specific and quiet.

| Symptom | Root cause | Fix |
|---|---|---|
| First probe returns `200 OK` with the full `Content-Length`, and every query downloads the whole file | A fronting CDN or proxy strips the `Range` header or is configured to collapse ranges into a full-object fetch | Enable range/origin passthrough and range-based caching at the edge; verify `Accept-Ranges: bytes` survives to the client |
| `HTTP 416 Range Not Satisfiable` on a valid offset | The object was replaced with a shorter version but a stale edge cache still advertises the old length | Purge the edge cache on republish and key the cache on the object's ETag, not just the path |
| Query latency spikes to seconds and the request log shows dozens of tiny reads | Attribute-heavy features fragment the payload, or the file predates the index and clients scan linearly | Prune attributes at write time and rebuild with the packed index; confirm contiguous matched ranges in the cURL trace |

There is a real crossover point. Each range read is a dependent round trip, so a query that must return most of the file — a country-wide extract, or a layer small enough that the whole object fits in one read — is faster and cheaper as a single full `GET` than as many ranged reads, because it avoids per-request overhead and index-traversal latency. Use range streaming for selective, bounding-box-scoped reads against large objects in warm and cold tiers; fall back to a full download when the selection ratio is high. The request-count and egress economics that decide this crossover for a given archive are modeled in the [spatial archive cost model](https://www.spatialdataarchival.org/spatial-archive-cost-modeling/), and the store's per-request pricing depends on the [object storage selection for GIS archives](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/object-storage-selection-for-gis-archives/) you standardized on.

For the authoritative range semantics on each platform, see the [AWS S3 GetObject Range documentation](https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObject.html) and the [Azure Blob range GET documentation](https://learn.microsoft.com/en-us/rest/api/storageservices/specifying-the-range-header-for-blob-service-operations), and confirm your client against the [FlatGeobuf specification](https://flatgeobuf.org/) for HTTP reader behavior.

## Operational Execution Checklist

- [ ] `curl -r` probe returns `206 Partial Content` with `Accept-Ranges: bytes` all the way through any CDN
- [ ] Bounding-box query runs over `/vsis3/` or `/vsicurl/` and materializes only intersecting features
- [ ] Returned geometries verified to intersect the query window (index exactness confirmed)
- [ ] Transferred bytes measured via `CPL_CURL_VERBOSE` and confirmed to be a small fraction of the object
- [ ] Edge cache keyed on ETag and configured to pass and cache `Range` requests
- [ ] Full-download fallback defined for high-selection-ratio queries above the latency crossover
- [ ] Per-request and egress costs reconciled against the archive cost model for the expected query mix

## Related

- Up: [FlatGeobuf Optimization Techniques](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/flatgeobuf-optimization-techniques/) — the parent reference for the `.fgb` index, schema, and CRS tuning this streaming path relies on.
- [Building a FlatGeobuf Spatial Index for HTTP Range Reads](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/flatgeobuf-optimization-techniques/building-a-flatgeobuf-spatial-index-for-http-range-reads/) — how the packed R-tree that these range reads traverse is written and verified.
- [Converting GeoPackage to FlatGeobuf for Web Archives](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/flatgeobuf-optimization-techniques/converting-geopackage-to-flatgeobuf-for-web-archives/) — producing the range-readable objects this workflow queries.
- [Spatial Archive Cost Modeling](https://www.spatialdataarchival.org/spatial-archive-cost-modeling/) — the request-count and egress math behind the range-versus-full-download crossover.
- [Object Storage Selection for GIS Archives](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/object-storage-selection-for-gis-archives/) — matching a store's range and per-request pricing to a streaming access pattern.

_Part of the [Spatial Data Archival](https://www.spatialdataarchival.org/) knowledge base._
