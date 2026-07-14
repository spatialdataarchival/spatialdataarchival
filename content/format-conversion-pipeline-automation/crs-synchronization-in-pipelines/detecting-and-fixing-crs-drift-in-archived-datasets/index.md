# Detecting and Fixing CRS Drift in Archived Datasets

CRS drift is the slow divergence between the coordinate reference system a dataset *declares* in its metadata and the reference system its coordinates actually live in, and in a cold archive it is almost always silent: the declared EPSG code survives every tier transition and format conversion untouched while the geometry underneath it gets relabelled, reprojected, or axis-swapped by a tool that logged nothing. This guide is for the data engineers and GIS archivists who inherit a multi-terabyte archive of mixed vintages and must prove, file by file, that declared CRS equals actual CRS before anyone joins, tiles, or ships those coordinates. It operationalises the auditing side of [CRS Synchronization in Pipelines](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/crs-synchronization-in-pipelines/) within the wider [Format Conversion & Pipeline Automation](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/) discipline, and it draws a hard line default GDAL workflows never draw: relabelling wrong metadata is not the same operation as reprojecting wrong geometry, and confusing the two is how drift becomes permanent.

## How the Declaration Diverges From the Geometry

Drift enters an archive through a handful of well-worn paths. A batch job runs `ogr2ogr -a_srs EPSG:4326` (assign) when it meant `-t_srs EPSG:4326` (transform), stamping a geographic label onto Web Mercator metres. A shapefile arrives with no `.prj` and a connector defaults it to `EPSG:4326`. A GeoParquet writer copies a stale `geo` block from a template. A raster is warped but its sidecar STAC item keeps the old code. Each leaves the file *readable* — nothing throws — so the mismatch only surfaces when a spatial join returns zero rows or a tile lands in the ocean.

The audit that follows never trusts the label alone. It reads the declared CRS, independently infers the *actual* CRS from the coordinate envelope and axis behaviour, compares the two, and only then chooses between relabelling and reprojecting:

<svg viewBox="0 0 968 236" role="img" aria-label="A four-stage CRS drift audit running left to right. Stage one inventories the declared CRS from each dataset's geo block, projection sidecar, or footer. Stage two independently infers the actual CRS from the coordinate envelope and axis order. Stage three compares declared against inferred. Stage four re-asserts the correct EPSG code, choosing to relabel when geometry is right but the tag is wrong, or reproject when the geometry itself is in the wrong system. A branch below stage three shows that a match keeps the file untouched while a mismatch routes it to remediation." xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;color:var(--primary);font-family:var(--font-sans)">
  <title>CRS drift audit: declared versus inferred, then re-assert</title>
  <desc>Left to right: inventory the declared CRS, infer the actual CRS from the coordinate envelope and axis order, compare the two, then re-assert the correct EPSG by relabelling a correctly-shaped geometry or reprojecting a wrongly-shaped one. A match keeps the file as-is; a mismatch routes to remediation.</desc>
  <defs>
    <marker id="drift-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <g text-anchor="middle" fill="currentColor">
    <g>
      <rect x="8" y="40" width="216" height="76" rx="10" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-opacity="0.4"/>
      <text x="116" y="66" font-size="12.5" font-weight="700">1 &#183; Inventory</text>
      <text x="116" y="83" font-size="12.5" font-weight="700">declared CRS</text>
      <text x="116" y="102" font-size="10.5" fill-opacity="0.75">geo block &#183; .prj &#183; footer</text>
    </g>
    <g>
      <rect x="256" y="40" width="216" height="76" rx="10" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-opacity="0.4"/>
      <text x="364" y="66" font-size="12.5" font-weight="700">2 &#183; Infer actual</text>
      <text x="364" y="83" font-size="12.5" font-weight="700">CRS from geometry</text>
      <text x="364" y="102" font-size="10.5" fill-opacity="0.75">envelope + axis order</text>
    </g>
    <g>
      <rect x="504" y="40" width="216" height="76" rx="10" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-opacity="0.4"/>
      <text x="612" y="66" font-size="12.5" font-weight="700">3 &#183; Compare</text>
      <text x="612" y="83" font-size="12.5" font-weight="700">declared &#8596; inferred</text>
      <text x="612" y="102" font-size="10.5" fill-opacity="0.75">flag drift class</text>
    </g>
    <g>
      <rect x="752" y="40" width="208" height="76" rx="10" fill="currentColor" fill-opacity="0.14" stroke="currentColor" stroke-opacity="0.65" stroke-width="1.5"/>
      <text x="856" y="66" font-size="12.5" font-weight="700">4 &#183; Re-assert EPSG</text>
      <text x="856" y="83" font-size="11" fill-opacity="0.85">relabel or reproject</text>
      <text x="856" y="102" font-size="10.5" fill-opacity="0.8">-a_srs vs -t_srs</text>
    </g>
  </g>
  <g stroke="currentColor" stroke-width="2" stroke-opacity="0.6" fill="none">
    <path d="M226 78 H254" marker-end="url(#drift-arrow)"/>
    <path d="M474 78 H502" marker-end="url(#drift-arrow)"/>
    <path d="M722 78 H750" marker-end="url(#drift-arrow)"/>
  </g>
  <g text-anchor="middle" fill="currentColor">
    <text x="612" y="150" font-size="11" fill-opacity="0.7" font-style="italic">match &#8594; keep untouched</text>
    <text x="856" y="150" font-size="11" fill-opacity="0.7" font-style="italic">mismatch &#8594; remediate</text>
    <path d="M612 116 V138" stroke="currentColor" stroke-width="1.5" stroke-opacity="0.35" stroke-dasharray="3 3"/>
    <path d="M700 128 H812" stroke="currentColor" stroke-width="1.5" stroke-opacity="0.35" stroke-dasharray="3 3" marker-end="url(#drift-arrow)"/>
  </g>
</svg>

## Auditing the Archive for Declared-vs-Actual Mismatch

The procedure runs as a read-only sweep first. Nothing is rewritten until a report has classified every mismatch, because a blind remediation pass is exactly how the last person corrupted the archive.

### Phase 1: Inventory Every Declared CRS

Enumerate the declared reference system across heterogeneous formats. GeoParquet carries it in the `geo` footer, GeoPackage in `gpkg_spatial_ref_sys`, shapefiles in the `.prj`, and rasters in the GeoTIFF keys. Normalise all of them to an EPSG code with `pyproj` so later comparisons are code-to-code, not string-to-string.

```python
import json, pathlib
import pyarrow.parquet as pq
import pyproj

ARCHIVE = pathlib.Path("datasets/vector/archive")
rows = []
for path in ARCHIVE.rglob("*.parquet"):
    meta = pq.read_metadata(path)
    geo = json.loads(meta.metadata[b"geo"])
    col = geo["primary_column"]
    declared = geo["columns"][col].get("crs")            # PROJJSON, WKT, or "EPSG:xxxx"
    epsg = pyproj.CRS.from_user_input(declared).to_epsg() if declared else None
    rows.append({"file": str(path), "declared_epsg": epsg})

with open("crs_inventory.jsonl", "w") as fh:
    for r in rows:
        fh.write(json.dumps(r) + "\n")
```

A `declared_epsg` of `None` is itself a finding: a null CRS means every downstream reader is free to guess, and they will not all guess alike.

### Phase 2: Infer the Actual CRS From the Geometry

Independently estimate the reference system the coordinates truly occupy. The strongest signal is the bounding envelope: geographic degrees stay inside &#177;180 / &#177;90, Web Mercator metres run to roughly &#177;2.0037e7, and a national projected grid (for example a State Plane zone or UTM) sits in a characteristic false-easting range. Sample rather than scan the whole file — a few thousand geometries fix the envelope.

```python
import duckdb

con = duckdb.connect()
con.execute("INSTALL spatial; LOAD spatial;")
env = con.execute("""
    SELECT min(ST_XMin(geom)) xmin, min(ST_YMin(geom)) ymin,
           max(ST_XMax(geom)) xmax, max(ST_YMax(geom)) ymax
    FROM (SELECT geom FROM ST_Read('datasets/vector/archive/parcels_region_north.parquet')
          USING SAMPLE 5000 ROWS)
""").fetchone()

xmin, ymin, xmax, ymax = env
if abs(xmax) <= 180 and abs(ymax) <= 90:
    inferred = "geographic (EPSG:4326 family)"
elif abs(xmax) <= 2.004e7 and abs(ymax) <= 2.004e7:
    inferred = "EPSG:3857 (Web Mercator metres)"
else:
    inferred = "projected national grid — resolve against known zone extents"
print(env, "->", inferred)
```

The envelope test also catches axis-order drift: if `xmin` reads like a latitude (roughly &#177;90) while `ymin` spans a longitude range, the coordinates were written in lat/lon order under a CRS that expects lon/lat, a WKT1-versus-WKT2 hazard covered in the GeoParquet integrity checks referenced below.

### Phase 3: Classify Drift and Choose the Fix

Join the inventory to the inference and label each file. The classification decides the remediation verb, and getting the verb wrong doubles the damage.

- **Clean** — declared equals inferred; leave untouched.
- **Mislabelled** — geometry is correct for some CRS, but the declared tag names a different one. Fix by *relabelling* (`-a_srs`), which rewrites metadata and never moves a coordinate.
- **Misprojected** — geometry is genuinely in the wrong system and must be moved. Fix by *reprojecting* (`-s_srs`/`-t_srs`), which transforms coordinates.

```python
import json

report = []
for line in open("crs_inventory.jsonl"):
    r = json.loads(line)
    # inferred_epsg comes from Phase 2, keyed by file in your run
    declared, inferred = r["declared_epsg"], r.get("inferred_epsg")
    if declared == inferred:
        verdict = "clean"
    elif inferred is not None and declared is not None:
        # geometry matches inferred; the label is simply wrong -> relabel
        verdict = "mislabelled" if r.get("geometry_valid_for_inferred") else "misprojected"
    else:
        verdict = "needs_manual_review"
    report.append({**r, "verdict": verdict})

json.dump(report, open("crs_drift_report.json", "w"), indent=2)
```

### Phase 4: Batch Remediation

Drive remediation from the report, one verb per verdict. Relabelling is metadata-only and cheap; reprojection moves coordinates and must target the archival standard CRS. Write to a staging prefix and promote only after the per-file validation gate passes, so a half-fixed archive is never visible to query engines.

```bash
# MISLABELLED: geometry is really EPSG:3857; the footer wrongly says 4326.
# Assign the correct code WITHOUT moving a single coordinate.
ogr2ogr -f Parquet \
  datasets/vector/_staging/parcels_region_north.parquet \
  datasets/vector/archive/parcels_region_north.parquet \
  -a_srs EPSG:3857 -lco COMPRESSION=ZSTD

# MISPROJECTED: geometry is in EPSG:3857 but the archive standard is EPSG:4326.
# Declare the true source, then transform to the target.
ogr2ogr -f Parquet \
  datasets/vector/_staging/roads_region_south.parquet \
  datasets/vector/archive/roads_region_south.parquet \
  -s_srs EPSG:3857 -t_srs EPSG:4326 -nlt PROMOTE_TO_MULTI -lco COMPRESSION=ZSTD
```

Keep the ZSTD level as a placeholder default here and tune it separately with [ZSTD Level Configuration for Spatial Files](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/zstd-level-configuration-for-spatial-files/); coordinate precision is fixed at this CRS stage, so compression choices come after, never before.

## Verifying the Re-Assertion Held

Confirm two independent facts on the promoted artifact: the declared code is now correct, and the envelope still agrees with that code. Checking only the label re-introduces exactly the drift you set out to remove.

```bash
gdalsrsinfo -o epsg datasets/vector/archive/parcels_region_north.parquet
ogrinfo datasets/vector/archive/parcels_region_north.parquet -al -so | grep -i "Extent"
```

Annotated expected output for a corrected EPSG:3857 layer:

```text
EPSG:3857
Extent: (-13736000.000, 6199000.000) - (-13590000.000, 6320000.000)
```

The reported code reads `EPSG:3857` and the extent is in the multi-million-metre Web Mercator range, so declaration and geometry now agree. Had the relabel run against geometry that was actually geographic, the extent would still read in the &#177;180 range while the code claimed 3857 — an immediate red flag that the verdict, not the fix, was wrong. Feed the confirmed code into the [Metadata Cataloging & Discovery](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/metadata-cataloging-discovery/) layer so the catalog's CRS lineage matches the object, closing the loop that let the sidecar drift in the first place.

## Troubleshooting

| Symptom | Root cause | Diagnostic & fix |
|---------|------------|------------------|
| Extent in millions of metres but footer says `EPSG:4326` | Web Mercator geometry relabelled with `-a_srs 4326` upstream | Reclassify as mislabelled; relabel to `EPSG:3857` with `-a_srs`, do **not** reproject |
| Reprojection moved coordinates that were already correct | Ran `-t_srs` on a mislabelled file instead of `-a_srs` | Restore from the retained raw source; relabel only; never transform a merely-mislabelled layer |
| Features mirror across the diagonal after fix | Lat/lon axis order under a lon/lat CRS (WKT1 vs WKT2) | Force `always_xy=True` / `OAMS_TRADITIONAL_GIS_ORDER`; verify against a known control point |
| `declared_epsg` is `None` for a whole prefix | Writer dropped the `geo` CRS or `.prj` was missing at ingest | Infer from envelope, confirm against a trusted neighbour, then assert the code explicitly |

## Operational Execution Checklist

- [ ] Inventory the declared CRS across every format in the archive and flag null declarations as findings.
- [ ] Infer the actual CRS from a sampled coordinate envelope and axis-order probe, independent of the label.
- [ ] Classify each file as clean, mislabelled, or misprojected before touching any bytes.
- [ ] Relabel mislabelled files with `-a_srs` (metadata only); reproject misprojected files with `-s_srs`/`-t_srs`.
- [ ] Stage remediated outputs under a worker-scoped prefix and promote only after the per-file gate passes.
- [ ] Verify both the declared code and the envelope on the promoted artifact, not the label alone.
- [ ] Push the confirmed EPSG back into the catalog so sidecar metadata cannot drift again.

## Related

- Up: [CRS Synchronization in Pipelines](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/crs-synchronization-in-pipelines/) — the parent reference for target-CRS selection, quarantine policy, and write-time projection contracts this audit enforces after the fact.
- [Managing EPSG Datum Shifts in Long-Term Archives](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/crs-synchronization-in-pipelines/managing-epsg-datum-shifts-in-long-term-archives/) — the sibling procedure for the harder drift where the datum realization itself changed, not just the label.
- [Verifying CRS Metadata Integrity in GeoParquet Archives](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/crs-synchronization-in-pipelines/verifying-crs-metadata-integrity-in-geoparquet-archives/) — the sibling that formalises the PROJJSON and axis-order checks used in Phase 1 above.
- [Handling Attribute Loss During Spatial Format Conversion](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/schema-mapping-attribute-validation/handling-attribute-loss-during-spatial-format-conversion/) — the attribute-side companion for conversions that also touch geometry metadata.
- [Metadata Cataloging & Discovery](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/metadata-cataloging-discovery/) — the catalog layer where corrected CRS lineage must be recorded to stop sidecar drift recurring.

_Part of the [Spatial Data Archival](https://www.spatialdataarchival.org/) knowledge base._
