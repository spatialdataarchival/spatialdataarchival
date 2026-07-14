# Verifying CRS Metadata Integrity in GeoParquet Archives

GeoParquet stores its coordinate reference system as PROJJSON inside the `geo` key of the Parquet file footer, and across a partitioned archive that single block is where CRS integrity quietly fails: one partition carries a full PROJJSON definition, its neighbour a legacy WKT1 string, a third a bare `EPSG:4326` shorthand, and a fourth an axis order that disagrees with the coordinates it labels. This guide is for the data engineers who own a partitioned GeoParquet tree and need an automated gate that reads every footer, confirms each `geo` block names the intended archival CRS in the correct form, and catches the WKT1-versus-WKT2 and axis-order defects that read fine locally but corrupt a spatial join at scale. It is the columnar-format specialisation of [CRS Synchronization in Pipelines](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/crs-synchronization-in-pipelines/) under [Format Conversion & Pipeline Automation](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/), and it treats the `geo` block as a contract every partition must satisfy identically.

## What the geo Block Must Guarantee

The [GeoParquet specification](https://geoparquet.org/) requires the `geo` metadata to name a `version`, a `primary_column`, and per-column encoding and CRS. The CRS should be PROJJSON — a machine-readable object that pins the datum, coordinate system, and axis order unambiguously. Integrity breaks when a writer substitutes a lossy form: a WKT1 string cannot express axis order reliably, a bare `EPSG:4326` shorthand defers axis order to the reader, and a `null` CRS means "assume longitude/latitude" — three different ways of losing the very information the archive exists to preserve. Because these defects live in the footer and not the data, a file opens and previews correctly while its CRS is wrong.

The verification therefore inspects the footer of every partition and asserts four independent properties against it — the CRS is PROJJSON, it equals the intended archival CRS, its axis order is the WKT2 longitude/latitude convention, and the `geo` key is present on *every* leaf, not just the one you sampled:

<svg viewBox="0 0 968 300" role="img" aria-label="The GeoParquet geo metadata block on the left, shown as a JSON object in the Parquet footer with version, primary_column, columns.geometry.encoding, and a highlighted crs field holding PROJJSON. Four integrity checks on the right connect back to it: the CRS is PROJJSON rather than a WKT1 string or bare code, the CRS equals the archival target, the axis order is longitude then latitude per WKT2:2019, and the geo key is present on every partition across the tree." xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;color:var(--primary);font-family:var(--font-sans)">
  <title>Anatomy of the GeoParquet geo block and its four integrity checks</title>
  <desc>The geo metadata block in the Parquet footer with version, primary_column, encoding, and a highlighted PROJJSON crs field, connected to four checks: CRS is PROJJSON, CRS equals the archival target, axis order is longitude/latitude per WKT2, and the geo key exists on every partition.</desc>
  <defs>
    <marker id="gp-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <!-- geo block card -->
  <rect x="20" y="44" width="446" height="232" rx="10" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-opacity="0.45"/>
  <text x="36" y="34" font-size="11.5" font-weight="700" fill="currentColor">Parquet footer &#183; &#8220;geo&#8221; key</text>
  <g fill="currentColor" font-size="11.5">
    <text x="36" y="76">{</text>
    <text x="36" y="102">&#160;&#160;"version": "1.1.0",</text>
    <text x="36" y="128">&#160;&#160;"primary_column": "geometry",</text>
    <text x="36" y="154">&#160;&#160;"columns": { "geometry": {</text>
    <text x="36" y="180">&#160;&#160;&#160;&#160;"encoding": "WKB",</text>
  </g>
  <rect x="30" y="196" width="426" height="30" rx="5" fill="currentColor" fill-opacity="0.13" stroke="currentColor" stroke-opacity="0.5"/>
  <text x="36" y="216" font-size="11.5" font-weight="700" fill="currentColor">&#160;&#160;&#160;&#160;"crs": { &#8230;PROJJSON&#8230; }</text>
  <g fill="currentColor" font-size="11.5">
    <text x="36" y="250">&#160;&#160;} }</text>
    <text x="36" y="268" font-size="10" fill-opacity="0.65">one footer per partition file</text>
  </g>
  <!-- junction + connectors -->
  <circle cx="466" cy="160" r="4" fill="currentColor" fill-opacity="0.6"/>
  <g stroke="currentColor" stroke-width="1.6" stroke-opacity="0.5" fill="none">
    <path d="M466 160 C 520 65, 540 65, 558 65" marker-end="url(#gp-arrow)"/>
    <path d="M466 160 C 520 129, 540 129, 558 129" marker-end="url(#gp-arrow)"/>
    <path d="M466 160 C 520 193, 540 193, 558 193" marker-end="url(#gp-arrow)"/>
    <path d="M466 160 C 520 257, 540 257, 558 257" marker-end="url(#gp-arrow)"/>
  </g>
  <!-- check boxes -->
  <g text-anchor="middle" fill="currentColor">
    <rect x="560" y="40" width="392" height="50" rx="8" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-opacity="0.4"/>
    <text x="756" y="61" font-size="11.5" font-weight="700">CRS is PROJJSON</text>
    <text x="756" y="78" font-size="9.5" fill-opacity="0.75">not a WKT1 string or bare EPSG code</text>
    <rect x="560" y="104" width="392" height="50" rx="8" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-opacity="0.4"/>
    <text x="756" y="125" font-size="11.5" font-weight="700">CRS equals archival target</text>
    <text x="756" y="142" font-size="9.5" fill-opacity="0.75">declared &#8596; intended EPSG</text>
    <rect x="560" y="168" width="392" height="50" rx="8" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-opacity="0.4"/>
    <text x="756" y="189" font-size="11.5" font-weight="700">Axis order lon/lat (WKT2:2019)</text>
    <text x="756" y="206" font-size="9.5" fill-opacity="0.75">no WKT1 lat/lon ambiguity</text>
    <rect x="560" y="232" width="392" height="50" rx="8" fill="currentColor" fill-opacity="0.13" stroke="currentColor" stroke-opacity="0.6" stroke-width="1.5"/>
    <text x="756" y="253" font-size="11.5" font-weight="700">geo key on EVERY partition</text>
    <text x="756" y="270" font-size="9.5" fill-opacity="0.8">fan across the whole tree</text>
  </g>
</svg>

## Validating the geo Block Across a Partitioned Tree

The checks read footers only — never the geometry payload — so a full audit of a terabyte-scale tree costs seconds per thousand files. The gate runs after any write that could touch metadata, including the conversions described in [Converting Legacy Shapefiles to GeoParquet at Scale](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/geoparquet-migration-workflows/converting-legacy-shapefiles-to-geoparquet-at-scale/).

### Phase 1: Read and Structurally Validate Every Footer

Walk the partition tree and pull the `geo` block from each footer with `pyarrow`, which reads Parquet metadata without materialising a single row group. Assert the required keys exist before inspecting the CRS — a missing `geo` key or absent `primary_column` is a hard structural failure.

```python
import json, pathlib
import pyarrow.parquet as pq

TREE = pathlib.Path("datasets/vector/archive")
findings = []
for path in TREE.rglob("*.parquet"):
    md = pq.read_metadata(path)
    if b"geo" not in md.metadata:
        findings.append({"file": str(path), "error": "MISSING_GEO_KEY"})
        continue
    geo = json.loads(md.metadata[b"geo"])
    col = geo.get("primary_column")
    if not col or col not in geo.get("columns", {}):
        findings.append({"file": str(path), "error": "NO_PRIMARY_COLUMN"})
        continue
    findings.append({"file": str(path), "geo": geo["columns"][col]})
```

### Phase 2: Assert PROJJSON Form and Target Equality

Each surviving `crs` value must be PROJJSON — a JSON object — and must equal the archival target when parsed. A string value signals a legacy WKT1 or bare-code substitution; a `None` value signals the implicit-lon/lat default. Both fail. Use `pyproj.CRS.equals` for the comparison so `EPSG:4326`, its WKT2 form, and its PROJJSON compare equal by identity rather than by text.

```python
import pyproj

TARGET = pyproj.CRS.from_epsg(4326)

def check_crs(entry):
    crs = entry.get("crs")
    if crs is None:
        return "NULL_CRS_IMPLICIT_LONLAT"
    if not isinstance(crs, dict):
        return "NOT_PROJJSON"                      # WKT1 string or "EPSG:xxxx" shorthand
    parsed = pyproj.CRS.from_json_dict(crs)
    if not parsed.equals(TARGET):
        return f"WRONG_CRS:{parsed.to_epsg()}"
    return "OK"
```

### Phase 3: Catch Axis-Order and WKT1-vs-WKT2 Defects

Axis order is the defect PROJJSON exists to prevent and WKT1 cannot express. Inspect the coordinate-system axes in the PROJJSON and confirm the first axis is easting/longitude, then cross-check against the actual coordinate envelope: if the declared order says lon/lat but the sampled `xmin` behaves like a latitude, the geometry was written transposed.

```python
import duckdb

def axis_order_ok(crs_dict):
    axes = crs_dict.get("coordinate_system", {}).get("axis", [])
    if not axes:
        return False
    first = axes[0].get("direction")               # "east"/"north" or geographic dir
    return first in ("east", "geodeticEast")

con = duckdb.connect(); con.execute("INSTALL spatial; LOAD spatial;")
def envelope_matches_lonlat(path):
    xmin, ymin = con.execute(f"""
        SELECT min(ST_XMin(geom)), min(ST_YMin(geom))
        FROM (SELECT geom FROM ST_Read('{path}') USING SAMPLE 2000 ROWS)
    """).fetchone()
    # Longitude range is wider than latitude; a swapped file inverts this.
    return abs(xmin) <= 180 and abs(ymin) <= 90
```

### Phase 4: Fan the Gate Across the Whole Tree

Combine the checks into one pass and fail the archive if a *single* partition disagrees. A tree is only trustworthy when uniform: a query engine that reads the `geo` block from the first file it opens will apply that CRS to the whole dataset, so one deviant partition mislabels everything read after it.

```python
import sys

verdicts = {}
for f in findings:
    if "error" in f:
        verdicts[f["file"]] = f["error"]; continue
    crs = check_crs(f["geo"])
    axis = "OK" if axis_order_ok(f["geo"].get("crs", {})) else "BAD_AXIS_ORDER"
    verdicts[f["file"]] = crs if crs != "OK" else axis

failures = {k: v for k, v in verdicts.items() if v != "OK"}
json.dump(verdicts, open("geo_integrity_report.json", "w"), indent=2)
sys.exit(1 if failures else 0)                     # non-zero blocks promotion in CI
```

## Confirming the Gate on a Sample Partition

Spot-check any partition with the DuckDB Parquet reader to read the raw footer key, and confirm the `crs` renders as a PROJJSON object naming the target authority.

```bash
duckdb -c "SELECT decode(value) FROM parquet_kv_metadata(
  'datasets/vector/archive/region=north/part-0007.parquet') WHERE decode(key) = 'geo'"
```

Annotated expected output — the `crs` is a nested object (PROJJSON), not a string, and its `id` names the target authority:

```text
{"version":"1.1.0","primary_column":"geometry","columns":{"geometry":{
  "encoding":"WKB","geometry_types":["MultiPolygon"],
  "crs":{"type":"GeographicCRS","name":"WGS 84",
         "coordinate_system":{"axis":[{"direction":"east"},{"direction":"north"}]},
         "id":{"authority":"EPSG","code":4326}}}}}
```

If the `crs` prints as `"EPSG:4326"` in quotes or is absent, the writer emitted a lossy form and the partition fails the PROJJSON check even though `pyproj` can still parse it — the archive standard is the full object, because only it survives a future reader that does not share your EPSG database. Record the passing CRS form in the [Metadata Cataloging & Discovery](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/metadata-cataloging-discovery/) index so the catalog and the footer never disagree.

## Troubleshooting

| Symptom | Root cause | Diagnostic & fix |
|---------|------------|------------------|
| `crs` prints as a quoted `"EPSG:4326"` string | Writer stored the shorthand instead of PROJJSON | Rewrite the footer with `table.replace_schema_metadata`, injecting `pyproj.CRS(...).to_json_dict()` |
| Some partitions pass, others report `MISSING_GEO_KEY` | Non-spatial writer (plain `pyarrow`/`pandas`) touched part of the tree | Re-emit affected partitions through a GeoParquet writer; add the gate to CI so it cannot recur |
| `BAD_AXIS_ORDER` with a valid target CRS | WKT1 lineage or a lat/lon writer under a lon/lat CRS | Re-encode PROJJSON with explicit east/north axes; verify the envelope with the DuckDB sample |
| Gate passes locally, fails in the reader | Reader took the CRS from the first footer; a later partition differs | Enforce tree-wide uniformity; block promotion on any single non-`OK` verdict |

## Operational Execution Checklist

- [ ] Read the `geo` block from every partition footer with `pyarrow`, without materialising row groups.
- [ ] Fail structurally on any partition missing the `geo` key or a resolvable `primary_column`.
- [ ] Require the `crs` to be PROJJSON; reject WKT1 strings, bare EPSG shorthands, and `null`.
- [ ] Compare against the archival target with `pyproj.CRS.equals`, not string matching.
- [ ] Assert first-axis east/longitude and cross-check the sampled envelope for transposed geometry.
- [ ] Fan the gate across the entire tree and block promotion if a single partition disagrees.
- [ ] Record the confirmed PROJJSON form in the catalog so footer and index stay in lockstep.

## Related

- Up: [CRS Synchronization in Pipelines](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/crs-synchronization-in-pipelines/) — the parent reference for the projection contract this gate enforces on columnar output.
- [Detecting and Fixing CRS Drift in Archived Datasets](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/crs-synchronization-in-pipelines/detecting-and-fixing-crs-drift-in-archived-datasets/) — the sibling audit that uses these footer checks as its declared-CRS inventory step.
- [Managing EPSG Datum Shifts in Long-Term Archives](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/crs-synchronization-in-pipelines/managing-epsg-datum-shifts-in-long-term-archives/) — the sibling that adds realization and coordinate-epoch fields the PROJJSON must also carry.
- [Converting Legacy Shapefiles to GeoParquet at Scale](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/geoparquet-migration-workflows/converting-legacy-shapefiles-to-geoparquet-at-scale/) — the neighbouring conversion path that writes the `geo` block this gate validates.
- [Metadata Cataloging & Discovery](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/metadata-cataloging-discovery/) — the archival-side catalog that must mirror the confirmed PROJJSON so index and footer never drift apart.

_Part of the [Spatial Data Archival](https://www.spatialdataarchival.org/) knowledge base._
