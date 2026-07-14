# Spatial Partitioning Techniques for Geospatial Archival

The most expensive failure in a geospatial cold archive is not slow compression — it is a bounded-box query that touches the entire dataset because nothing physically co-located the geometries it needed. When partition keys are derived from ingestion timestamps, ingest filenames, or arbitrary record IDs instead of spatial position, every jurisdictional or ecological-boundary read degenerates into a full `LIST` plus a full scan, and cold-tier retrieval charges and egress balloon. Spatial partitioning solves that specific failure mode: it maps continuous coordinate space onto a deterministic directory grid so the query engine can prune the vast majority of objects before reading a single byte. This page is for data engineers, GIS archivists, cloud architects, and compliance teams who already have columnar storage and lifecycle policies in place and now need partition keys that survive multi-year retention without skew or metadata blow-up.

## Prerequisites and Where This Sits

Spatial partitioning is the physical-layout stage of the broader [Compression Tuning & Storage Optimization](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/) methodology, and it assumes several upstream decisions are already settled. Before tuning partition keys you should have converted source data to a columnar archival format (GeoParquet or an Iceberg/Delta table over Parquet), selected a cold-eligible object storage class, and have an active retention or lifecycle policy that governs when objects transition tiers. Partitioning is what makes those earlier choices pay off — it determines how much of the archive a cold query has to touch at all, and it directly feeds the [Row Group Sizing Strategies](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/row-group-sizing-strategies/) and [ZSTD Level Configuration for Spatial Files](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/zstd-level-configuration-for-spatial-files/) decisions downstream. If your tiering model is not yet defined, settle the [Hot/Warm/Cold Tier Design for Geospatial Data](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/hotwarmcold-tier-design-for-geospatial-data/) first, because partition prefixes are the unit lifecycle rules and audits operate on.

## How Partition Pruning Cuts Retrieval

Aligning physical layout to spatial keys lets the engine skip most objects for a bounded query:

<svg viewBox="0 0 1080 300" role="img" aria-label="Partition-pruning decision flow: a spatial query extent enters a partition-pruning test; cells that match the query are read from the matching H3 or S2 partitions and returned as a targeted, lower-egress retrieval, while non-matching cells let the engine skip over 90 percent of objects before reading any bytes." xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;color:var(--primary);font-family:var(--font-sans)">
  <title>How partition pruning cuts cold-tier retrieval</title>
  <desc>A spatial query extent is tested against the partition key. Cells that intersect the query are read from the matching H3 or S2 partitions and returned as a targeted retrieval with lower egress; cells that do not match are skipped, letting the engine avoid over ninety percent of objects before reading a single byte.</desc>
  <defs>
    <marker id="pp-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <g font-size="13" font-weight="600" text-anchor="middle">
    <rect x="24" y="118" width="170" height="74" rx="10" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-opacity="0.35"/>
    <text x="109" y="151" fill="currentColor">Spatial query</text>
    <text x="109" y="169" fill="currentColor">extent</text>
    <polygon points="320,100 400,155 320,210 240,155" fill="currentColor" fill-opacity="0.08" stroke="currentColor" stroke-opacity="0.5"/>
    <text fill="currentColor"><tspan x="320" y="151">Partition</tspan><tspan x="320" y="169">pruning</tspan></text>
    <rect x="500" y="58" width="222" height="64" rx="10" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-opacity="0.35"/>
    <text x="611" y="85" fill="currentColor">Read matching</text>
    <text x="611" y="103" fill="currentColor">H3 / S2 cells</text>
    <rect x="500" y="218" width="222" height="64" rx="10" fill="currentColor" fill-opacity="0.04" stroke="currentColor" stroke-opacity="0.35" stroke-dasharray="6 4"/>
    <text x="611" y="245" fill="currentColor" fill-opacity="0.85">Skip 90%+</text>
    <text x="611" y="263" fill="currentColor" fill-opacity="0.85">of objects</text>
    <rect x="802" y="58" width="232" height="64" rx="10" fill="currentColor" fill-opacity="0.12" stroke="currentColor" stroke-opacity="0.6"/>
    <text x="918" y="85" fill="currentColor">Targeted retrieval,</text>
    <text x="918" y="103" fill="currentColor">lower egress</text>
  </g>
  <g stroke="currentColor" stroke-width="2" stroke-opacity="0.55" fill="none">
    <path d="M194 155 H236" marker-end="url(#pp-arrow)"/>
    <path d="M392 140 C 440 120 462 90 500 90" marker-end="url(#pp-arrow)"/>
    <path d="M392 170 C 440 190 462 250 500 250" marker-end="url(#pp-arrow)"/>
    <path d="M722 90 H802" marker-end="url(#pp-arrow)"/>
  </g>
  <g font-size="12" font-weight="600" text-anchor="middle" fill="currentColor" fill-opacity="0.8">
    <text x="452" y="108">cells match</text>
    <text x="452" y="232">no match</text>
  </g>
</svg>

Pruning only works when the query predicate and the partition key share the same discrete spatial vocabulary. A query expressed as a bounding box must be rewritten into the set of grid cells that the box intersects, and the engine then restricts its file list to the prefixes those cells produce. The quality of a partitioning scheme is therefore measured by two things: how tightly the cell set tracks the query extent (low false-positive read amplification), and how uniformly cells distribute the underlying records (low skew).

## Concept and Design Decisions: Indexing Schemes

Geospatial workloads require a discrete hierarchical index to map continuous coordinate space into object storage paths. The indexing scheme you pick dictates cold-storage retrieval cost, pruning effectiveness, and metadata overhead. Production archival pipelines prioritize uniform spatial coverage and deterministic resolution scaling to avoid unpredictable `LIST` operations during cold-tier restores.

| Scheme | Resolution Strategy | Cold Storage Fit | Production Directory Pattern |
|--------|---------------------|------------------|------------------------------|
| **H3 (Hexagonal)** | Fixed-resolution global grid | High (uniform cell sizes, predictable pruning) | `h3_res=8/h3_idx=88283082a5fffff/` |
| **S2 (Google)** | Quadtree-based Hilbert curve | High (excellent for range scans, compact keys) | `s2_level=12/s2_cell=4b59c/` |
| **Geohash** | Base-32 interleaved lat/lon | Medium (polar distortion, uneven cell shapes) | `geo_hash=dr5r/` |
| **Quadtree** | Recursive quadrant subdivision | Low-Medium (variable depth, higher metadata overhead) | `qt_depth=4/qt_node=0112/` |

The trade-offs are concrete. H3's hexagonal cells have near-uniform area and consistent neighbor distance, which keeps record counts even across cells and makes radius queries predictable — the cost is that hexagons do not nest perfectly, so a parent cell only approximately contains its children. S2's Hilbert-curve cell IDs are 64-bit integers that preserve spatial locality as a sortable range, making them ideal when you want range-scan pruning over a single sorted key. Geohash is the cheapest to compute and human-debuggable, but its rectangular cells distort badly toward the poles and change aspect ratio with latitude, producing skew in high-latitude archives. Plain quadtrees give you adaptive depth for non-uniform density but at the price of variable-length keys and heavier catalog metadata.

<svg viewBox="0 0 1080 500" role="img" aria-label="Side-by-side grid comparison of the same rectangular query extent overlaid on an H3 hexagon grid versus a Geohash rectangle grid. On the hexagon grid seventeen cells must be read to cover the query; on the Geohash grid twenty cells are read for the identical extent because its rectangular cells overshoot the query boundary further, so more cold-tier objects are scanned." xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;color:var(--primary);font-family:var(--font-sans)">
  <title>Read amplification: H3 hexagons versus Geohash rectangles for one query extent</title>
  <desc>The same dashed query rectangle is overlaid on two partition grids. Filled cells intersect the query and must be read; outlined cells are pruned. The H3 hexagon grid covers the extent with seventeen read cells, while the Geohash rectangle grid needs twenty read cells for the identical extent, illustrating the larger false-positive overshoot of rectangular cells.</desc>
  <g font-size="15" font-weight="700" text-anchor="middle" fill="currentColor">
    <text x="260" y="46">H3 hexagons</text>
    <text x="820" y="46">Geohash rectangles</text>
  </g>
  <g font-size="12.5" font-weight="600" text-anchor="middle" fill="currentColor" fill-opacity="0.75">
    <text x="260" y="68">17 cells read &#183; tight overshoot</text>
    <text x="820" y="68">20 cells read &#183; wider overshoot</text>
  </g>
  <rect x="36" y="86" width="448" height="334" rx="8" fill="none" stroke="currentColor" stroke-opacity="0.25"/>
  <rect x="596" y="86" width="448" height="334" rx="8" fill="none" stroke="currentColor" stroke-opacity="0.25"/>
  <g>
    <polygon points="100.0,125.0 85.0,151.0 55.0,151.0 40.0,125.0 55.0,99.0 85.0,99.0" fill="none" stroke="currentColor" stroke-opacity="0.2" stroke-width="1"/>
    <polygon points="100.0,177.0 85.0,202.9 55.0,202.9 40.0,177.0 55.0,151.0 85.0,151.0" fill="none" stroke="currentColor" stroke-opacity="0.2" stroke-width="1"/>
    <polygon points="100.0,228.9 85.0,254.9 55.0,254.9 40.0,228.9 55.0,202.9 85.0,202.9" fill="none" stroke="currentColor" stroke-opacity="0.2" stroke-width="1"/>
    <polygon points="100.0,280.9 85.0,306.9 55.0,306.9 40.0,280.9 55.0,254.9 85.0,254.9" fill="none" stroke="currentColor" stroke-opacity="0.2" stroke-width="1"/>
    <polygon points="100.0,332.8 85.0,358.8 55.0,358.8 40.0,332.8 55.0,306.9 85.0,306.9" fill="none" stroke="currentColor" stroke-opacity="0.2" stroke-width="1"/>
    <polygon points="100.0,384.8 85.0,410.8 55.0,410.8 40.0,384.8 55.0,358.8 85.0,358.8" fill="none" stroke="currentColor" stroke-opacity="0.2" stroke-width="1"/>
    <polygon points="145.0,151.0 130.0,177.0 100.0,177.0 85.0,151.0 100.0,125.0 130.0,125.0" fill="none" stroke="currentColor" stroke-opacity="0.2" stroke-width="1"/>
    <polygon points="145.0,202.9 130.0,228.9 100.0,228.9 85.0,202.9 100.0,177.0 130.0,177.0" fill="none" stroke="currentColor" stroke-opacity="0.2" stroke-width="1"/>
    <polygon points="145.0,254.9 130.0,280.9 100.0,280.9 85.0,254.9 100.0,228.9 130.0,228.9" fill="none" stroke="currentColor" stroke-opacity="0.2" stroke-width="1"/>
    <polygon points="145.0,306.9 130.0,332.8 100.0,332.8 85.0,306.9 100.0,280.9 130.0,280.9" fill="none" stroke="currentColor" stroke-opacity="0.2" stroke-width="1"/>
    <polygon points="145.0,358.8 130.0,384.8 100.0,384.8 85.0,358.8 100.0,332.8 130.0,332.8" fill="none" stroke="currentColor" stroke-opacity="0.2" stroke-width="1"/>
    <polygon points="190.0,125.0 175.0,151.0 145.0,151.0 130.0,125.0 145.0,99.0 175.0,99.0" fill="none" stroke="currentColor" stroke-opacity="0.2" stroke-width="1"/>
    <polygon points="190.0,177.0 175.0,202.9 145.0,202.9 130.0,177.0 145.0,151.0 175.0,151.0" fill="none" stroke="currentColor" stroke-opacity="0.2" stroke-width="1"/>
    <polygon points="190.0,228.9 175.0,254.9 145.0,254.9 130.0,228.9 145.0,202.9 175.0,202.9" fill="none" stroke="currentColor" stroke-opacity="0.2" stroke-width="1"/>
    <polygon points="190.0,280.9 175.0,306.9 145.0,306.9 130.0,280.9 145.0,254.9 175.0,254.9" fill="none" stroke="currentColor" stroke-opacity="0.2" stroke-width="1"/>
    <polygon points="190.0,332.8 175.0,358.8 145.0,358.8 130.0,332.8 145.0,306.9 175.0,306.9" fill="none" stroke="currentColor" stroke-opacity="0.2" stroke-width="1"/>
    <polygon points="190.0,384.8 175.0,410.8 145.0,410.8 130.0,384.8 145.0,358.8 175.0,358.8" fill="none" stroke="currentColor" stroke-opacity="0.2" stroke-width="1"/>
    <polygon points="235.0,151.0 220.0,177.0 190.0,177.0 175.0,151.0 190.0,125.0 220.0,125.0" fill="none" stroke="currentColor" stroke-opacity="0.2" stroke-width="1"/>
    <polygon points="235.0,202.9 220.0,228.9 190.0,228.9 175.0,202.9 190.0,177.0 220.0,177.0" fill="none" stroke="currentColor" stroke-opacity="0.2" stroke-width="1"/>
    <polygon points="280.0,125.0 265.0,151.0 235.0,151.0 220.0,125.0 235.0,99.0 265.0,99.0" fill="none" stroke="currentColor" stroke-opacity="0.2" stroke-width="1"/>
    <polygon points="280.0,177.0 265.0,202.9 235.0,202.9 220.0,177.0 235.0,151.0 265.0,151.0" fill="none" stroke="currentColor" stroke-opacity="0.2" stroke-width="1"/>
    <polygon points="325.0,151.0 310.0,177.0 280.0,177.0 265.0,151.0 280.0,125.0 310.0,125.0" fill="none" stroke="currentColor" stroke-opacity="0.2" stroke-width="1"/>
    <polygon points="325.0,202.9 310.0,228.9 280.0,228.9 265.0,202.9 280.0,177.0 310.0,177.0" fill="none" stroke="currentColor" stroke-opacity="0.2" stroke-width="1"/>
    <polygon points="370.0,125.0 355.0,151.0 325.0,151.0 310.0,125.0 325.0,99.0 355.0,99.0" fill="none" stroke="currentColor" stroke-opacity="0.2" stroke-width="1"/>
    <polygon points="370.0,177.0 355.0,202.9 325.0,202.9 310.0,177.0 325.0,151.0 355.0,151.0" fill="none" stroke="currentColor" stroke-opacity="0.2" stroke-width="1"/>
    <polygon points="415.0,151.0 400.0,177.0 370.0,177.0 355.0,151.0 370.0,125.0 400.0,125.0" fill="none" stroke="currentColor" stroke-opacity="0.2" stroke-width="1"/>
    <polygon points="415.0,202.9 400.0,228.9 370.0,228.9 355.0,202.9 370.0,177.0 400.0,177.0" fill="none" stroke="currentColor" stroke-opacity="0.2" stroke-width="1"/>
    <polygon points="460.0,125.0 445.0,151.0 415.0,151.0 400.0,125.0 415.0,99.0 445.0,99.0" fill="none" stroke="currentColor" stroke-opacity="0.2" stroke-width="1"/>
    <polygon points="460.0,177.0 445.0,202.9 415.0,202.9 400.0,177.0 415.0,151.0 445.0,151.0" fill="none" stroke="currentColor" stroke-opacity="0.2" stroke-width="1"/>
    <polygon points="460.0,228.9 445.0,254.9 415.0,254.9 400.0,228.9 415.0,202.9 445.0,202.9" fill="none" stroke="currentColor" stroke-opacity="0.2" stroke-width="1"/>
    <polygon points="460.0,280.9 445.0,306.9 415.0,306.9 400.0,280.9 415.0,254.9 445.0,254.9" fill="none" stroke="currentColor" stroke-opacity="0.2" stroke-width="1"/>
    <polygon points="460.0,332.8 445.0,358.8 415.0,358.8 400.0,332.8 415.0,306.9 445.0,306.9" fill="none" stroke="currentColor" stroke-opacity="0.2" stroke-width="1"/>
    <polygon points="460.0,384.8 445.0,410.8 415.0,410.8 400.0,384.8 415.0,358.8 445.0,358.8" fill="none" stroke="currentColor" stroke-opacity="0.2" stroke-width="1"/>
    <polygon points="235.0,254.9 220.0,280.9 190.0,280.9 175.0,254.9 190.0,228.9 220.0,228.9" fill="currentColor" fill-opacity="0.16" stroke="currentColor" stroke-opacity="0.55" stroke-width="1"/>
    <polygon points="235.0,306.9 220.0,332.8 190.0,332.8 175.0,306.9 190.0,280.9 220.0,280.9" fill="currentColor" fill-opacity="0.16" stroke="currentColor" stroke-opacity="0.55" stroke-width="1"/>
    <polygon points="235.0,358.8 220.0,384.8 190.0,384.8 175.0,358.8 190.0,332.8 220.0,332.8" fill="currentColor" fill-opacity="0.16" stroke="currentColor" stroke-opacity="0.55" stroke-width="1"/>
    <polygon points="280.0,228.9 265.0,254.9 235.0,254.9 220.0,228.9 235.0,202.9 265.0,202.9" fill="currentColor" fill-opacity="0.16" stroke="currentColor" stroke-opacity="0.55" stroke-width="1"/>
    <polygon points="280.0,280.9 265.0,306.9 235.0,306.9 220.0,280.9 235.0,254.9 265.0,254.9" fill="currentColor" fill-opacity="0.16" stroke="currentColor" stroke-opacity="0.55" stroke-width="1"/>
    <polygon points="280.0,332.8 265.0,358.8 235.0,358.8 220.0,332.8 235.0,306.9 265.0,306.9" fill="currentColor" fill-opacity="0.16" stroke="currentColor" stroke-opacity="0.55" stroke-width="1"/>
    <polygon points="280.0,384.8 265.0,410.8 235.0,410.8 220.0,384.8 235.0,358.8 265.0,358.8" fill="currentColor" fill-opacity="0.16" stroke="currentColor" stroke-opacity="0.55" stroke-width="1"/>
    <polygon points="325.0,254.9 310.0,280.9 280.0,280.9 265.0,254.9 280.0,228.9 310.0,228.9" fill="currentColor" fill-opacity="0.16" stroke="currentColor" stroke-opacity="0.55" stroke-width="1"/>
    <polygon points="325.0,306.9 310.0,332.8 280.0,332.8 265.0,306.9 280.0,280.9 310.0,280.9" fill="currentColor" fill-opacity="0.16" stroke="currentColor" stroke-opacity="0.55" stroke-width="1"/>
    <polygon points="325.0,358.8 310.0,384.8 280.0,384.8 265.0,358.8 280.0,332.8 310.0,332.8" fill="currentColor" fill-opacity="0.16" stroke="currentColor" stroke-opacity="0.55" stroke-width="1"/>
    <polygon points="370.0,228.9 355.0,254.9 325.0,254.9 310.0,228.9 325.0,202.9 355.0,202.9" fill="currentColor" fill-opacity="0.16" stroke="currentColor" stroke-opacity="0.55" stroke-width="1"/>
    <polygon points="370.0,280.9 355.0,306.9 325.0,306.9 310.0,280.9 325.0,254.9 355.0,254.9" fill="currentColor" fill-opacity="0.16" stroke="currentColor" stroke-opacity="0.55" stroke-width="1"/>
    <polygon points="370.0,332.8 355.0,358.8 325.0,358.8 310.0,332.8 325.0,306.9 355.0,306.9" fill="currentColor" fill-opacity="0.16" stroke="currentColor" stroke-opacity="0.55" stroke-width="1"/>
    <polygon points="370.0,384.8 355.0,410.8 325.0,410.8 310.0,384.8 325.0,358.8 355.0,358.8" fill="currentColor" fill-opacity="0.16" stroke="currentColor" stroke-opacity="0.55" stroke-width="1"/>
    <polygon points="415.0,254.9 400.0,280.9 370.0,280.9 355.0,254.9 370.0,228.9 400.0,228.9" fill="currentColor" fill-opacity="0.16" stroke="currentColor" stroke-opacity="0.55" stroke-width="1"/>
    <polygon points="415.0,306.9 400.0,332.8 370.0,332.8 355.0,306.9 370.0,280.9 400.0,280.9" fill="currentColor" fill-opacity="0.16" stroke="currentColor" stroke-opacity="0.55" stroke-width="1"/>
    <polygon points="415.0,358.8 400.0,384.8 370.0,384.8 355.0,358.8 370.0,332.8 400.0,332.8" fill="currentColor" fill-opacity="0.16" stroke="currentColor" stroke-opacity="0.55" stroke-width="1"/>
  </g>
  <g>
    <rect x="606" y="101" width="44" height="52" fill="none" stroke="currentColor" stroke-opacity="0.2" stroke-width="1"/>
    <rect x="650" y="101" width="44" height="52" fill="none" stroke="currentColor" stroke-opacity="0.2" stroke-width="1"/>
    <rect x="694" y="101" width="44" height="52" fill="none" stroke="currentColor" stroke-opacity="0.2" stroke-width="1"/>
    <rect x="738" y="101" width="44" height="52" fill="none" stroke="currentColor" stroke-opacity="0.2" stroke-width="1"/>
    <rect x="782" y="101" width="44" height="52" fill="none" stroke="currentColor" stroke-opacity="0.2" stroke-width="1"/>
    <rect x="826" y="101" width="44" height="52" fill="none" stroke="currentColor" stroke-opacity="0.2" stroke-width="1"/>
    <rect x="870" y="101" width="44" height="52" fill="none" stroke="currentColor" stroke-opacity="0.2" stroke-width="1"/>
    <rect x="914" y="101" width="44" height="52" fill="none" stroke="currentColor" stroke-opacity="0.2" stroke-width="1"/>
    <rect x="958" y="101" width="44" height="52" fill="none" stroke="currentColor" stroke-opacity="0.2" stroke-width="1"/>
    <rect x="606" y="153" width="44" height="52" fill="none" stroke="currentColor" stroke-opacity="0.2" stroke-width="1"/>
    <rect x="650" y="153" width="44" height="52" fill="none" stroke="currentColor" stroke-opacity="0.2" stroke-width="1"/>
    <rect x="694" y="153" width="44" height="52" fill="none" stroke="currentColor" stroke-opacity="0.2" stroke-width="1"/>
    <rect x="738" y="153" width="44" height="52" fill="none" stroke="currentColor" stroke-opacity="0.2" stroke-width="1"/>
    <rect x="782" y="153" width="44" height="52" fill="none" stroke="currentColor" stroke-opacity="0.2" stroke-width="1"/>
    <rect x="826" y="153" width="44" height="52" fill="none" stroke="currentColor" stroke-opacity="0.2" stroke-width="1"/>
    <rect x="870" y="153" width="44" height="52" fill="none" stroke="currentColor" stroke-opacity="0.2" stroke-width="1"/>
    <rect x="914" y="153" width="44" height="52" fill="none" stroke="currentColor" stroke-opacity="0.2" stroke-width="1"/>
    <rect x="958" y="153" width="44" height="52" fill="none" stroke="currentColor" stroke-opacity="0.2" stroke-width="1"/>
    <rect x="606" y="205" width="44" height="52" fill="none" stroke="currentColor" stroke-opacity="0.2" stroke-width="1"/>
    <rect x="650" y="205" width="44" height="52" fill="none" stroke="currentColor" stroke-opacity="0.2" stroke-width="1"/>
    <rect x="694" y="205" width="44" height="52" fill="none" stroke="currentColor" stroke-opacity="0.2" stroke-width="1"/>
    <rect x="958" y="205" width="44" height="52" fill="none" stroke="currentColor" stroke-opacity="0.2" stroke-width="1"/>
    <rect x="606" y="257" width="44" height="52" fill="none" stroke="currentColor" stroke-opacity="0.2" stroke-width="1"/>
    <rect x="650" y="257" width="44" height="52" fill="none" stroke="currentColor" stroke-opacity="0.2" stroke-width="1"/>
    <rect x="694" y="257" width="44" height="52" fill="none" stroke="currentColor" stroke-opacity="0.2" stroke-width="1"/>
    <rect x="958" y="257" width="44" height="52" fill="none" stroke="currentColor" stroke-opacity="0.2" stroke-width="1"/>
    <rect x="606" y="309" width="44" height="52" fill="none" stroke="currentColor" stroke-opacity="0.2" stroke-width="1"/>
    <rect x="650" y="309" width="44" height="52" fill="none" stroke="currentColor" stroke-opacity="0.2" stroke-width="1"/>
    <rect x="694" y="309" width="44" height="52" fill="none" stroke="currentColor" stroke-opacity="0.2" stroke-width="1"/>
    <rect x="958" y="309" width="44" height="52" fill="none" stroke="currentColor" stroke-opacity="0.2" stroke-width="1"/>
    <rect x="606" y="361" width="44" height="52" fill="none" stroke="currentColor" stroke-opacity="0.2" stroke-width="1"/>
    <rect x="650" y="361" width="44" height="52" fill="none" stroke="currentColor" stroke-opacity="0.2" stroke-width="1"/>
    <rect x="694" y="361" width="44" height="52" fill="none" stroke="currentColor" stroke-opacity="0.2" stroke-width="1"/>
    <rect x="958" y="361" width="44" height="52" fill="none" stroke="currentColor" stroke-opacity="0.2" stroke-width="1"/>
    <rect x="738" y="205" width="44" height="52" fill="currentColor" fill-opacity="0.16" stroke="currentColor" stroke-opacity="0.55" stroke-width="1"/>
    <rect x="782" y="205" width="44" height="52" fill="currentColor" fill-opacity="0.16" stroke="currentColor" stroke-opacity="0.55" stroke-width="1"/>
    <rect x="826" y="205" width="44" height="52" fill="currentColor" fill-opacity="0.16" stroke="currentColor" stroke-opacity="0.55" stroke-width="1"/>
    <rect x="870" y="205" width="44" height="52" fill="currentColor" fill-opacity="0.16" stroke="currentColor" stroke-opacity="0.55" stroke-width="1"/>
    <rect x="914" y="205" width="44" height="52" fill="currentColor" fill-opacity="0.16" stroke="currentColor" stroke-opacity="0.55" stroke-width="1"/>
    <rect x="738" y="257" width="44" height="52" fill="currentColor" fill-opacity="0.16" stroke="currentColor" stroke-opacity="0.55" stroke-width="1"/>
    <rect x="782" y="257" width="44" height="52" fill="currentColor" fill-opacity="0.16" stroke="currentColor" stroke-opacity="0.55" stroke-width="1"/>
    <rect x="826" y="257" width="44" height="52" fill="currentColor" fill-opacity="0.16" stroke="currentColor" stroke-opacity="0.55" stroke-width="1"/>
    <rect x="870" y="257" width="44" height="52" fill="currentColor" fill-opacity="0.16" stroke="currentColor" stroke-opacity="0.55" stroke-width="1"/>
    <rect x="914" y="257" width="44" height="52" fill="currentColor" fill-opacity="0.16" stroke="currentColor" stroke-opacity="0.55" stroke-width="1"/>
    <rect x="738" y="309" width="44" height="52" fill="currentColor" fill-opacity="0.16" stroke="currentColor" stroke-opacity="0.55" stroke-width="1"/>
    <rect x="782" y="309" width="44" height="52" fill="currentColor" fill-opacity="0.16" stroke="currentColor" stroke-opacity="0.55" stroke-width="1"/>
    <rect x="826" y="309" width="44" height="52" fill="currentColor" fill-opacity="0.16" stroke="currentColor" stroke-opacity="0.55" stroke-width="1"/>
    <rect x="870" y="309" width="44" height="52" fill="currentColor" fill-opacity="0.16" stroke="currentColor" stroke-opacity="0.55" stroke-width="1"/>
    <rect x="914" y="309" width="44" height="52" fill="currentColor" fill-opacity="0.16" stroke="currentColor" stroke-opacity="0.55" stroke-width="1"/>
    <rect x="738" y="361" width="44" height="52" fill="currentColor" fill-opacity="0.16" stroke="currentColor" stroke-opacity="0.55" stroke-width="1"/>
    <rect x="782" y="361" width="44" height="52" fill="currentColor" fill-opacity="0.16" stroke="currentColor" stroke-opacity="0.55" stroke-width="1"/>
    <rect x="826" y="361" width="44" height="52" fill="currentColor" fill-opacity="0.16" stroke="currentColor" stroke-opacity="0.55" stroke-width="1"/>
    <rect x="870" y="361" width="44" height="52" fill="currentColor" fill-opacity="0.16" stroke="currentColor" stroke-opacity="0.55" stroke-width="1"/>
    <rect x="914" y="361" width="44" height="52" fill="currentColor" fill-opacity="0.16" stroke="currentColor" stroke-opacity="0.55" stroke-width="1"/>
  </g>
  <g fill="none" stroke="currentColor" stroke-width="2.5" stroke-dasharray="7 5">
    <rect x="190" y="245" width="170" height="150" rx="3"/>
    <rect x="750" y="245" width="170" height="150" rx="3"/>
  </g>
  <g font-size="13" font-weight="600" text-anchor="middle">
    <rect x="300" y="448" width="22" height="15" rx="3" fill="currentColor" fill-opacity="0.16" stroke="currentColor" stroke-opacity="0.55"/>
    <text x="376" y="460" fill="currentColor">Cells read</text>
    <rect x="452" y="448" width="22" height="15" rx="3" fill="none" stroke="currentColor" stroke-opacity="0.45"/>
    <text x="520" y="460" fill="currentColor">Pruned</text>
    <line x1="588" y1="455" x2="612" y2="455" stroke="currentColor" stroke-width="2.5" stroke-dasharray="6 4"/>
    <text x="690" y="460" fill="currentColor">Query extent</text>
  </g>
  <text x="540" y="490" font-size="13" font-weight="600" text-anchor="middle" fill="currentColor" fill-opacity="0.85">Same query extent &#8212; near-uniform hexagons hug the boundary, so fewer cold-tier objects are read.</text>
</svg>

### Choosing a resolution

Resolution is the single most consequential parameter. Too coarse and each cell holds many records spanning a wide area, so pruning leaves you reading large irrelevant tracts; too fine and you generate millions of tiny partitions, inflate `LIST` latency, and produce small-file proliferation that destroys columnar efficiency. As a starting rule for continental-scale vector archives, target a resolution where the median cell holds between roughly 128 MB and 1 GB of compressed data — for H3 that is typically resolution 6–8 for country-level datasets and 8–10 for metropolitan ones. Validate the choice against real data rather than trusting the nominal cell area, because record density varies by orders of magnitude between, say, ocean bathymetry and urban parcel data.

### Directory layout and compound prefixes

Directory layouts must balance depth against API call volume. Overly deep hierarchies inflate `LIST` latency during cold restores, while flat structures cause partition skew and degrade predicate pushdown. A standard production layout combines a coarse temporal prefix with a spatial leaf:

```
s3://archive/year=2024/region=eu-central/h3_res=7/h3_idx=87283082a5fffff/
```

This structure isolates jurisdictional boundaries for compliance audits while maintaining uniform file distribution. The leading `year=` and `region=` components let lifecycle rules and data-residency audits operate on a prefix without parsing geometry, and they bound the cardinality of the spatial leaf within each partition so the H3 index never produces a globe-spanning flat namespace.

## Implementation: Computing Keys and Writing to Iceberg

Implementing spatial partitioning requires strict alignment between partition keys, row group boundaries, and catalog metadata. Misalignment triggers small-file proliferation, inflates catalog overhead, and degrades cold-storage retrieval performance. In Apache Spark and Iceberg pipelines, partition transforms must be explicitly defined to prevent skew and ensure deterministic file placement.

The example below computes H3 cell keys before writing to Iceberg using a column expression. Iceberg's built-in transforms (`identity`, `bucket`, `truncate`, `year`, `month`, `day`, `hour`) do not include H3 functions, so the H3 key must be pre-computed as a column in the DataFrame and then partitioned with the `identity` transform:

```python
from pyspark.sql import SparkSession
from pyspark.sql.functions import col, udf
from pyspark.sql.types import StringType
import h3

spark = SparkSession.builder \
    .config("spark.sql.extensions", "org.apache.iceberg.spark.extensions.IcebergSparkSessionExtensions") \
    .config("spark.sql.catalog.prod", "org.apache.iceberg.spark.SparkCatalog") \
    .config("spark.sql.catalog.prod.catalog-impl", "org.apache.iceberg.aws.glue.GlueCatalog") \
    .config("spark.sql.catalog.prod.warehouse", "s3://archive/geospatial/") \
    .getOrCreate()

# Pre-compute H3 cell at resolution 7 as a plain string column.
# Resolution 7 keeps median compressed partition size near 256 MB
# for this continental vector dataset (validated against record density).
h3_udf = udf(lambda lat, lon: h3.latlng_to_cell(lat, lon, 7), StringType())
df = df.withColumn("h3_cell", h3_udf(col("lat"), col("lon")))

# Partition on the pre-computed column using Iceberg's identity transform.
# hash distribution shuffles records so each cell lands in one file,
# preventing the small-file fan-out a range distribution would cause.
df.writeTo("prod.geospatial_archival") \
    .using("iceberg") \
    .partitionedBy("h3_cell") \
    .option("write.distribution-mode", "hash") \
    .option("write.target-file-size-bytes", str(128 * 1024 * 1024)) \
    .append()
```

Partition boundaries must align with the [Row Group Sizing Strategies](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/row-group-sizing-strategies/) you configure so columnar readers can skip irrelevant blocks without full decompression. Target row group sizes between 128–256 MB to optimize cold-tier read throughput while preventing memory pressure during compliance audits. The `write.target-file-size-bytes` setting above and the row group size should be chosen together: a 128 MB target file holding a single 128 MB row group gives the cleanest one-seek-one-group read pattern for a pruned cold query.

### Compression synergy

Spatial clustering at the partition level directly amplifies downstream compression efficiency. When geometries and attributes are co-located, coordinate deltas become highly repetitive and attribute dictionaries compress aggressively. Configuring [ZSTD Level Configuration for Spatial Files](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/zstd-level-configuration-for-spatial-files/) within spatially isolated partitions yields higher ratios without increasing decompression latency, and applying [Dictionary Encoding for GIS Attributes](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/dictionary-encoding-for-gis-attributes/) to categorical fields (land-cover codes, jurisdictional IDs, sensor types) further shrinks footprint because a single cell tends to share the same categorical values. Operational teams should validate compression ratios per partition during ETL dry runs: spatially homogeneous partitions typically achieve 3.5–5.2x compression with ZSTD level 3, while mixed-partition layouts rarely exceed 2.1x due to dictionary fragmentation and delta-encoding inefficiency.

## Validation Gate

Before promoting a partitioned dataset to the cold tier, confirm two properties: that the physical file distribution is even, and that the catalog metadata agrees with the objects on disk. The fastest distribution check is to summarize record counts per partition directly from the Iceberg metadata tables:

```bash
spark-sql --catalog prod -e "
  SELECT partition, file_count, record_count,
         total_size / file_count AS avg_file_bytes
  FROM prod.geospatial_archival.partitions
  ORDER BY record_count DESC
  LIMIT 5;"
```

Expected output for a well-balanced resolution-7 layout looks like this — file counts low, average file size near the 128–256 MB target, and the top partitions within a small multiple of the median:

```
partition                 file_count  record_count  avg_file_bytes
{h3_cell=87283082a...}    1           812334        198311042
{h3_cell=87283470b...}    1           794118        191204882
{h3_cell=872830829...}    1           770955        188730110
{h3_cell=87283082b...}    2           1402980       142883901
{h3_cell=87283471a...}    1           688204        167551200
```

The most common failure this gate catches is a single partition with a `record_count` an order of magnitude above the median and a `file_count` in the dozens — the signature of partition skew. Root cause is almost always a resolution that is too coarse for a dense region (a city dropped into one country-level cell) or a `range` distribution mode that scattered a hot cell across many writer tasks. The fix is to raise the resolution for the dense extent or switch to `hash` distribution as shown above, then rewrite the affected partitions with a compaction job. To confirm the catalog matches disk, run `spark-sql -e "CALL prod.system.remove_orphan_files(table => 'prod.geospatial_archival')"` in dry-run mode; any reported orphans indicate incomplete writes that violate retention windows.

## Cost and Performance Trade-offs

Cold-storage pricing penalizes unpruned scans and excessive metadata operations, so the partitioning return on investment is measurable. Effective spatial partitioning enables predicate pushdown at the directory level and reduces data retrieval by 60–85% for jurisdictional and ecological-boundary queries. The table below frames the resolution decision as the cost trade-off it actually is:

| Resolution choice | Cells / partitions | Read amplification on a small query | `LIST` + metadata overhead | Best fit |
|-------------------|--------------------|-------------------------------------|----------------------------|----------|
| Too coarse (e.g. H3 res 4–5) | Few, large | High — pruned cell still spans a wide area | Low | Sparse, globally uniform data |
| Tuned (e.g. H3 res 6–8) | Balanced | Low | Moderate | Most continental vector archives |
| Too fine (e.g. H3 res 11+) | Many, tiny | Very low per cell, but small-file penalty dominates | High — millions of prefixes | Dense local data with point queries only |

Two cost mechanics drive this. First, every `LIST` and `GetObject` call is billed and rate-limited, so a million-prefix layout can spend more on request charges and restore latency than it saves on scanned bytes. Second, immutable partition prefixes are what make WORM (Write Once Read Many) retention cheap to enforce — when a partition path maps cleanly to a jurisdiction and a retention class, residency audits and legal holds operate on a prefix instead of re-reading geometry. Settle the prefix scheme against your [Retention Policy Frameworks](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/retention-policy-frameworks/) before the first bulk write, because re-partitioning a petabyte archive after the fact is itself a full-rewrite cost.

## Failure Modes and Edge Cases

- **Antimeridian and pole wrap.** A bounding-box query that crosses ±180° longitude or includes a pole will, under Geohash or naive lat/lon binning, generate a discontinuous cell set and silently drop matching partitions. H3 and S2 handle the wrap natively; if you must use Geohash, split the query at the antimeridian before deriving prefixes.
- **Resolution mismatch between writer and reader.** If ingestion computes H3 at resolution 7 but the query layer derives cells at resolution 8, the prefixes never align and pruning falls back to a full scan with no error raised. Pin the resolution in one shared config and assert it at read time.
- **Geometry spanning multiple cells.** Polygons and linestrings frequently cross cell boundaries. Partitioning on a single representative point (centroid) keeps the layout simple but can place a large polygon in a cell that does not cover all of its vertices, causing it to be missed by a query over the uncovered area. For large or sliver geometries, store the covering cell set and partition on the primary cell while keeping a covering-cell column for predicate fallback.
- **Small-file proliferation from over-partitioning.** Combining a fine spatial resolution with a fine temporal prefix multiplies partition cardinality and produces sub-50 MB files that wreck columnar read efficiency. Enforce a partition-validation gate in ETL that rejects jobs producing partitions above 10,000 files or below a 50 MB average file size, and schedule quarterly compaction when spatial distribution deviates more than ~20% from uniform cell coverage. The [H3 core library documentation](https://h3geo.org/docs/core-library/overview) covers resolution scaling and neighbor validation for compaction, and the [Apache Iceberg partitioning specification](https://iceberg.apache.org/docs/latest/partitioning/) covers transform validation and manifest pruning.

Spatial partitioning is not a static configuration; it is a continuous operational control. By enforcing strict directory layouts, aligning row groups, and tuning compression per partition, archival pipelines achieve predictable cold-storage costs, audit-ready data residency, and sub-second query pruning for geospatial workloads.

## Related

- [Row Group Sizing Strategies](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/row-group-sizing-strategies/) — pair your partition keys with row group boundaries so a pruned cold query reads one group per seek.
- [ZSTD Level Configuration for Spatial Files](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/zstd-level-configuration-for-spatial-files/) — set the compression level that spatially homogeneous partitions reward most.
- [Dictionary Encoding for GIS Attributes](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/dictionary-encoding-for-gis-attributes/) — collapse categorical attribute storage within each cell after partitioning.
- [Hot/Warm/Cold Tier Design for Geospatial Data](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/hotwarmcold-tier-design-for-geospatial-data/) — the tiering model whose lifecycle rules act on your partition prefixes.
- Up to the parent guide: [Compression Tuning & Storage Optimization](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/).
