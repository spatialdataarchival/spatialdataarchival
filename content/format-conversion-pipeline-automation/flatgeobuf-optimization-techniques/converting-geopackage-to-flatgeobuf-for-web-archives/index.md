# Converting GeoPackage to FlatGeobuf for Web Archives

Converting GeoPackage to FlatGeobuf turns a multi-layer SQLite container into one range-readable `.fgb` file per layer, the form a read-mostly web-map archive needs to serve features straight from object storage without a database engine in the path. This guide is for GIS archivists and data engineers who receive vector deliverables as `.gpkg` bundles and must republish them as cold-storage-friendly web assets while preserving layer boundaries, per-layer coordinate reference systems (CRS), and feature counts exactly. It covers the decision — when a FlatGeobuf split genuinely beats keeping the GeoPackage — plus per-layer and CRS handling, a batch `ogr2ogr` conversion loop, and the parity checks that prove nothing was dropped. It applies the packed-index discipline from [FlatGeobuf Optimization Techniques](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/flatgeobuf-optimization-techniques/) inside the broader [Format Conversion & Pipeline Automation](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/) workflow.

## GeoPackage Versus FlatGeobuf for Cold Web Delivery

The two formats solve different problems; the split only pays off when the access pattern is read-mostly delivery from object storage:

<svg viewBox="0 0 860 262" role="img" aria-label="Comparison matrix of GeoPackage against FlatGeobuf across five dimensions for cold web delivery. Range read from an object store: GeoPackage does page-by-page random input-output, FlatGeobuf is native with a packed R-tree. Layers per file: GeoPackage holds many in a SQLite container, FlatGeobuf holds one layer per file. In-place edits: GeoPackage supports full read-write transactions, FlatGeobuf is write-once and immutable. Cold web delivery fit: GeoPackage is weak because it needs a database engine, FlatGeobuf is strong because it serves bytes over HTTP. Spatial index: GeoPackage keeps an R-tree inside SQLite, FlatGeobuf keeps a Hilbert R-tree in the file itself." xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;color:var(--primary);font-family:var(--font-sans)">
  <title>GeoPackage versus FlatGeobuf comparison matrix</title>
  <desc>Five dimensions compared. FlatGeobuf wins for cold web delivery: native HTTP range reads, one layer per file, an in-file Hilbert R-tree. GeoPackage wins for multi-layer bundling and in-place editing but needs a database engine to read.</desc>
  <rect x="10" y="10" width="840" height="242" fill="none" stroke="currentColor" stroke-opacity="0.5" stroke-width="1.2"/>
  <rect x="10" y="10" width="840" height="38" fill="currentColor" fill-opacity="0.07"/>
  <rect x="580" y="10" width="270" height="242" fill="currentColor" fill-opacity="0.05"/>
  <line x1="310" y1="10" x2="310" y2="252" stroke="currentColor" stroke-opacity="0.3"/>
  <line x1="580" y1="10" x2="580" y2="252" stroke="currentColor" stroke-opacity="0.3"/>
  <line x1="10" y1="48" x2="850" y2="48" stroke="currentColor" stroke-opacity="0.3"/>
  <line x1="10" y1="89" x2="850" y2="89" stroke="currentColor" stroke-opacity="0.25"/>
  <line x1="10" y1="130" x2="850" y2="130" stroke="currentColor" stroke-opacity="0.25"/>
  <line x1="10" y1="171" x2="850" y2="171" stroke="currentColor" stroke-opacity="0.25"/>
  <line x1="10" y1="212" x2="850" y2="212" stroke="currentColor" stroke-opacity="0.25"/>
  <!-- headers -->
  <text x="20" y="34" font-size="11" font-weight="700" fill="currentColor">Dimension</text>
  <text x="320" y="34" font-size="11" font-weight="700" fill="currentColor">GeoPackage (.gpkg)</text>
  <text x="590" y="34" font-size="11" font-weight="700" fill="currentColor">FlatGeobuf (.fgb)</text>
  <!-- row 1 -->
  <text x="20" y="73" font-size="10.5" fill="currentColor">Range read from object store</text>
  <text x="320" y="73" font-size="10" fill="currentColor" fill-opacity="0.85">page-by-page random I/O</text>
  <text x="590" y="73" font-size="10" font-weight="600" fill="currentColor">native, packed R-tree</text>
  <!-- row 2 -->
  <text x="20" y="114" font-size="10.5" fill="currentColor">Layers per file</text>
  <text x="320" y="114" font-size="10" fill="currentColor" fill-opacity="0.85">many (SQLite container)</text>
  <text x="590" y="114" font-size="10" fill="currentColor">one layer per file</text>
  <!-- row 3 -->
  <text x="20" y="155" font-size="10.5" fill="currentColor">In-place edits</text>
  <text x="320" y="155" font-size="10" font-weight="600" fill="currentColor">read/write, transactions</text>
  <text x="590" y="155" font-size="10" fill="currentColor" fill-opacity="0.85">write-once, immutable</text>
  <!-- row 4 -->
  <text x="20" y="196" font-size="10.5" fill="currentColor">Cold web delivery fit</text>
  <text x="320" y="196" font-size="10" fill="currentColor" fill-opacity="0.85">weak &#8212; needs a DB engine</text>
  <text x="590" y="196" font-size="10" font-weight="600" fill="currentColor">strong &#8212; bytes over HTTP</text>
  <!-- row 5 -->
  <text x="20" y="237" font-size="10.5" fill="currentColor">Spatial index</text>
  <text x="320" y="237" font-size="10" fill="currentColor" fill-opacity="0.85">R-tree inside SQLite</text>
  <text x="590" y="237" font-size="10" fill="currentColor">Hilbert R-tree in the file</text>
</svg>

GeoPackage is a full SQLite database: one file can carry dozens of layers, an R-tree index per geometry column, styles, and metadata tables, and it supports transactional in-place editing. Those are exactly the properties a desktop editing or field-collection workflow wants. But reading a `.gpkg` means running a SQLite engine that issues many small, dependent page reads. Over a local disk that is invisible; over HTTP from cold object storage it is a chatty, latency-bound access pattern, and most cloud consumers simply download the entire database first. FlatGeobuf inverts the trade: it drops multi-layer bundling and editability, and in return each layer becomes a single self-describing file whose packed Hilbert R-tree lets a browser range-read only the features it needs — the mechanism detailed in [streaming FlatGeobuf features over HTTP range requests](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/flatgeobuf-optimization-techniques/streaming-flatgeobuf-features-over-http-range-requests/).

The decision follows the access pattern. Keep the GeoPackage as the archival master and editing surface when the workflow still writes to it, when a single portable multi-layer file matters, or when the consumer is desktop GIS. Publish a FlatGeobuf derivative per layer when the archive is read-mostly, served to web clients, and parked in a warm or cold tier where a full-database download would blow the egress budget. For heavy analytical scans over attributes rather than spatial windows, neither wins — that workload belongs to the columnar [GeoParquet Migration Workflows](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/geoparquet-migration-workflows/) path, and a mature archive keeps both derivatives behind one manifest.

Treat the conversion as a derivation, not a replacement. The GeoPackage remains the source of truth and the object you retain under a retention schedule; the FlatGeobuf set is a disposable, regenerable delivery projection you can rebuild from the master at any time. That framing matters for two operational reasons. First, it decouples the delivery format's lifecycle from the archive's: you can re-split with a newer GDAL, a different delivery CRS, or a pruned attribute set without touching the record copy. Second, it clarifies where the conversion belongs in a tiered layout — the `.gpkg` master can sit in a colder, cheaper tier because it is read only when the derivative is regenerated, while the `.fgb` layers occupy the warm, range-served tier that actually faces traffic. Size the split accordingly: a GeoPackage carrying twenty small thematic layers becomes twenty small objects, and very small `.fgb` files may fall below a store's minimum billable object size, so consolidate thin layers or accept the floor before generating hundreds of sub-kilobyte files.

## Converting a GeoPackage to Indexed FlatGeobuf

A GeoPackage may hold many layers on different CRSes and even aspatial attribute tables. The steps below enumerate the container, convert each spatial layer to its own indexed `.fgb`, and normalize projection along the way.

1. **Enumerate layers and their CRSes.** FlatGeobuf is single-layer, so you must know every layer name and geometry type before splitting. List them without reading features.

```bash
# Summarize every layer, its geometry type, and its CRS.
ogrinfo -so datasets/basemaps/city_base.gpkg
# Layer: parcels  (Polygon)   SRS: EPSG:2913
# Layer: roads    (LineString) SRS: EPSG:2913
# Layer: hydro    (MultiPolygon) SRS: EPSG:4326
# Layer: address_points (Point) SRS: EPSG:2913
# Table: layer_styles  (non-spatial — skip)
```

2. **Convert one layer with an explicit target CRS and a packed index.** Web-map archives standardize on a single delivery CRS — `EPSG:4326` for raw coordinates or `EPSG:3857` for pre-projected tiles — so reproject during the split. Enable the spatial index in the same pass; the projection-registry rules behind this belong to [CRS synchronization in pipelines](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/crs-synchronization-in-pipelines/).

```bash
# One GPKG layer -> one indexed FlatGeobuf, reprojected to the web CRS.
ogr2ogr -f "FlatGeobuf" \
  datasets/basemaps/fgb/parcels.fgb \
  datasets/basemaps/city_base.gpkg parcels \
  -t_srs EPSG:4326 \
  -lco SPATIAL_INDEX=YES \
  -nln parcels \
  -nlt PROMOTE_TO_MULTI
```

`PROMOTE_TO_MULTI` guards against a layer that mixes `Polygon` and `MultiPolygon`; FlatGeobuf stores a single geometry type per file, so promoting to the multi form keeps the whole layer in one valid file.

3. **Batch every spatial layer in the container.** Drive the split from the enumerated layer list, skip non-spatial tables, and index each output. Emit to a per-layer prefix in the target archive.

```bash
# Convert all spatial layers; aspatial tables (no geometry) are skipped by name.
LAYERS=$(ogrinfo -so -q datasets/basemaps/city_base.gpkg \
  | awk '/^Layer name:/ {print $3}')

for layer in $LAYERS; do
  [ "$layer" = "layer_styles" ] && continue   # non-spatial metadata table
  ogr2ogr -f "FlatGeobuf" \
    "s3://spatial-archive/fgb/basemaps/${layer}.fgb" \
    datasets/basemaps/city_base.gpkg "$layer" \
    -t_srs EPSG:4326 \
    -lco SPATIAL_INDEX=YES \
    -nln "$layer" \
    -nlt PROMOTE_TO_MULTI \
    -skipfailures
  echo "converted ${layer}"
done
```

## Validation & Verification

The conversion is only trustworthy if every layer's feature count survived and every output carries a spatial index. Reconcile source against derivative per layer, then confirm the index.

```bash
# Per-layer parity: source GPKG count must equal the FlatGeobuf count.
for layer in parcels roads hydro address_points; do
  src=$(ogrinfo -so -q datasets/basemaps/city_base.gpkg "$layer" \
    | awk '/Feature Count/ {print $3}')
  dst=$(ogrinfo -so -q "datasets/basemaps/fgb/${layer}.fgb" \
    | awk '/Feature Count/ {print $3}')
  if [ "$src" = "$dst" ]; then echo "$layer OK ($src)"; \
  else echo "$layer MISMATCH src=$src dst=$dst"; fi
done
```

Expected output — every layer reconciles exactly, or the mismatch is surfaced for triage:

```text
parcels OK (482817)
roads OK (91245)
hydro OK (12830)
address_points OK (655102)
```

Then prove each output is genuinely range-readable by confirming the packed R-tree is present. An index-less `.fgb` is a valid file that forces every web client into a full scan:

```python
# Confirm the packed spatial index exists on each converted layer.
from flatgeobuf import HeaderReader  # pip install flatgeobuf
import glob

for path in glob.glob("datasets/basemaps/fgb/*.fgb"):
    with open(path, "rb") as f:
        h = HeaderReader.read(f)
    assert h.index_node_size > 0, f"{path} has NO spatial index"
    assert "4326" in (h.crs.code_string or str(h.crs.code)), f"{path} wrong CRS"
    print(f"{path}: index ok, {h.features_count} features, EPSG:4326")
```

## Troubleshooting

| Symptom | Root cause | Fix |
|---|---|---|
| `ogr2ogr` errors with `layer has no geometry column` on some tables | The GeoPackage holds aspatial attribute or style tables (`layer_styles`, `gpkg_metadata`) that FlatGeobuf cannot represent | Skip tables with no geometry in the batch loop; convert only layers `ogrinfo` reports with a geometry type |
| Converted layer renders offset or in the wrong place on the web map | Source layers were on mixed CRSes (some `EPSG:2913`, some `EPSG:4326`) and one was not reprojected | Apply `-t_srs EPSG:4326` (or `EPSG:3857`) to every layer so all outputs share one delivery CRS |
| `Mixed geometry types` or `Unsupported geometry type` during write | A GPKG layer mixes single and multi geometries, or contains curved `CircularString` types FlatGeobuf lacks | Add `-nlt PROMOTE_TO_MULTI`, and for curves add `-nlt CONVERT_TO_LINEAR` to linearize before writing |

Consult the [GDAL FlatGeobuf driver documentation](https://gdal.org/drivers/vector/flatgeobuf.html) and [GDAL GeoPackage driver documentation](https://gdal.org/drivers/vector/gpkg.html) for the exact geometry-type and layer-creation matrices, the [OGC GeoPackage standard](https://www.ogc.org/standards/geopackage/) for the source container semantics, and the [FlatGeobuf specification](https://flatgeobuf.org/) for the target encoding.

## Operational Execution Checklist

- [ ] Every layer, geometry type, and per-layer CRS enumerated with `ogrinfo -so` before splitting
- [ ] Non-spatial tables (styles, metadata) identified and excluded from the conversion loop
- [ ] Each spatial layer written to its own indexed `.fgb` with `-lco SPATIAL_INDEX=YES`
- [ ] A single delivery CRS (`EPSG:4326` or `EPSG:3857`) forced with `-t_srs` on every layer
- [ ] Mixed single/multi geometries reconciled with `-nlt PROMOTE_TO_MULTI`
- [ ] Per-layer feature counts reconciled between the source GeoPackage and each derivative
- [ ] `index_node_size > 0` confirmed on every output before promotion to the web archive

## Related

- Up: [FlatGeobuf Optimization Techniques](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/flatgeobuf-optimization-techniques/) — the parent reference for the `.fgb` index, schema, and CRS tuning these conversions apply.
- [Building a FlatGeobuf Spatial Index for HTTP Range Reads](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/flatgeobuf-optimization-techniques/building-a-flatgeobuf-spatial-index-for-http-range-reads/) — the index-construction detail behind the `SPATIAL_INDEX=YES` flag used here.
- [Streaming FlatGeobuf Features Over HTTP Range Requests](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/flatgeobuf-optimization-techniques/streaming-flatgeobuf-features-over-http-range-requests/) — how web clients consume the layers this procedure produces.
- [Hot/Warm/Cold Tier Design for Geospatial Data](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/hotwarmcold-tier-design-for-geospatial-data/) — deciding which tier serves the converted `.fgb` web layers versus deep archive.
- [Spatial Archive Cost Modeling](https://www.spatialdataarchival.org/spatial-archive-cost-modeling/) — comparing full-database egress against per-layer range reads before committing to the split.

_Part of the [Spatial Data Archival](https://www.spatialdataarchival.org/) knowledge base._
