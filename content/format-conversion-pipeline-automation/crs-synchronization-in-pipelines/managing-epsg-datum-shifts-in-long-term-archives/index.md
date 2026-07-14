# Managing EPSG Datum Shifts in Long-Term Archives

A datum is not a fixed thing over the lifetime of an archive: the label "NAD83" hides a family of successive realizations whose coordinates for the same physical point differ by up to one to two metres, and "WGS84" is a moving ensemble tied to shifting ITRF epochs that drift with plate motion at roughly two centimetres a year. This guide is for GIS archivists and geodesists who must retrieve a survey stored in 2004 and reproject it in 2035 to within its original accuracy, which is impossible if the archive recorded only the datum *name* and not the *realization* and *coordinate epoch*. It extends [CRS Synchronization in Pipelines](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/crs-synchronization-in-pipelines/) inside the [Format Conversion & Pipeline Automation](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/) discipline into the time dimension, where an EPSG code alone is no longer enough to reconstruct where a coordinate really sits on the Earth.

## Why a Datum Label Decays Over Decades

Reference frames are re-realized as the geodetic network improves and the crust moves. NAD83 has been realized as NAD83(1986), NAD83(CORS96), and NAD83(2011) at epoch 2010.0, with the 2022 modernization of the National Spatial Reference System replacing it entirely. Each realization is a distinct EPSG datum, yet legacy files declare the bare ensemble code and leave the reader to assume a realization — an assumption that silently introduces a metre-scale shift. Global frames are worse: ITRF2014, ITRF2020, and their WGS84 approximations are *time-dependent*, so a coordinate is only fully specified by a frame **and** the epoch at which it was observed.

An archive that plans to survive decades therefore stores three things per dataset, not one: the specific realization, the coordinate epoch, and the transformation pipeline used to bring it to the archival frame. Those fields must ride into the columnar footer during the [GeoParquet Migration Workflows](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/geoparquet-migration-workflows/) write, because a datum name that is not carried into the file is lost the first time the data is repacked. The timeline below shows why the bare name is insufficient — the ensemble spans the full spread of its realizations, and only the epoch pins a point within it:

<svg viewBox="0 0 968 224" role="img" aria-label="A timeline of NAD83 datum realizations from 1986 to the 2022 modernization. Four nodes sit on a horizontal axis: NAD83(1986), NAD83(CORS96), NAD83(2011) at coordinate epoch 2010.0, and the 2022 NSRS frame NATRF2022 at epoch 2020.0. A bracket spanning all four is labelled datum ensemble NAD83, roughly a 1 to 2 metre spread. An arrow beneath notes that faithful retrieval must pin both the realization and the coordinate epoch, not the bare name." xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;color:var(--primary);font-family:var(--font-sans)">
  <title>NAD83 realizations across four decades and why the epoch matters</title>
  <desc>A horizontal timeline with four realization nodes — NAD83(1986), NAD83(CORS96), NAD83(2011) at epoch 2010.0, and NATRF2022 at epoch 2020.0 — under a bracket labelled the NAD83 datum ensemble spanning one to two metres. The caption states that retrieval must pin the realization and coordinate epoch, not just the datum name.</desc>
  <defs>
    <marker id="dtm-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <!-- ensemble bracket -->
  <path d="M96 52 V40 H840 V52" fill="none" stroke="currentColor" stroke-width="1.5" stroke-opacity="0.45"/>
  <text x="468" y="30" text-anchor="middle" font-size="11.5" font-weight="700" fill="currentColor" fill-opacity="0.85">datum ensemble &#8220;NAD83&#8221; &#183; ~1&#8211;2 m spread across realizations</text>
  <!-- axis -->
  <line x1="60" y1="132" x2="908" y2="132" stroke="currentColor" stroke-width="1.5" stroke-opacity="0.5"/>
  <g text-anchor="middle" fill="currentColor">
    <!-- node 1 -->
    <circle cx="120" cy="132" r="7" fill="currentColor" fill-opacity="0.2" stroke="currentColor" stroke-opacity="0.7"/>
    <text x="120" y="82" font-size="12" font-weight="600">NAD83(1986)</text>
    <text x="120" y="158" font-size="10.5" fill-opacity="0.7">1986</text>
    <!-- node 2 -->
    <circle cx="360" cy="132" r="7" fill="currentColor" fill-opacity="0.2" stroke="currentColor" stroke-opacity="0.7"/>
    <text x="360" y="82" font-size="12" font-weight="600">NAD83(CORS96)</text>
    <text x="360" y="158" font-size="10.5" fill-opacity="0.7">~1998</text>
    <!-- node 3 -->
    <circle cx="600" cy="132" r="7" fill="currentColor" fill-opacity="0.25" stroke="currentColor" stroke-opacity="0.75"/>
    <text x="600" y="82" font-size="12" font-weight="600">NAD83(2011)</text>
    <text x="600" y="158" font-size="10.5" fill-opacity="0.7">epoch 2010.0</text>
    <!-- node 4 -->
    <circle cx="840" cy="132" r="7" fill="currentColor" fill-opacity="0.3" stroke="currentColor" stroke-opacity="0.8"/>
    <text x="840" y="82" font-size="12" font-weight="600">NATRF2022</text>
    <text x="840" y="158" font-size="10.5" fill-opacity="0.7">epoch 2020.0</text>
  </g>
  <!-- pin note -->
  <path d="M120 168 V190 H840 V168" fill="none" stroke="currentColor" stroke-width="1.3" stroke-opacity="0.35" stroke-dasharray="3 3"/>
  <text x="468" y="210" text-anchor="middle" font-size="11" font-style="italic" fill="currentColor" fill-opacity="0.75">retrieval must pin realization + coordinate epoch &#8594; the bare name is ambiguous</text>
</svg>

## Preserving Realization and Epoch Through the Archive

The workflow captures the full frame specification at ingest, pins a reproducible transformation, and — for time-dependent frames — propagates coordinates by epoch. Each phase writes to an immutable lineage record so a retrieval decades later is deterministic rather than a guess.

### Phase 1: Capture the Realization and Coordinate Epoch at Ingest

Resolve the source to a *specific* realization EPSG code, never the ensemble. Record the coordinate epoch alongside it; for a static-frame product the epoch is the frame's reference epoch, and for an observed dataset it is the survey date expressed as a decimal year.

```python
import json, pyproj

# Resolve to the realization, not the ensemble. EPSG:6318 = NAD83(2011) geographic 2D;
# EPSG:4269 is the bare NAD83 ensemble and must NOT be stored as the archival frame.
src = pyproj.CRS.from_epsg(6318)
assert not src.is_deprecated

record = {
    "file": "datasets/survey/2011/control_region_north.gpkg",
    "realization_epsg": src.to_epsg(),          # 6318, not 4269
    "realization_name": src.name,               # "NAD83(2011)"
    "coordinate_epoch": 2010.0,                  # decimal year — mandatory for time-dependent frames
    "datum_ensemble": src.datum.name,            # human-readable ensemble for discovery
}
with open("frame_lineage.jsonl", "a") as fh:
    fh.write(json.dumps(record) + "\n")
```

Storing `coordinate_epoch` as a first-class field is the single change that makes long-term retrieval reproducible; without it a future reader cannot choose the correct time-dependent transformation and will fall back to a static shift that is wrong by the accumulated plate motion.

### Phase 2: Pin a Reproducible Transformation Pipeline

PROJ can produce several candidate operations between two frames, ranked by accuracy, and the winner can change when the PROJ or EPSG database is upgraded. For an archive that must reproduce a result identically in ten years, capture the exact pipeline string and the versions that produced it, then replay *that* pipeline rather than re-solving.

```bash
# Enumerate candidate operations and their accuracies, then freeze the chosen one.
projinfo -s "EPSG:6318" -t "EPSG:4326" --summary
projinfo -s "EPSG:6318" -t "EPSG:4326" -o PROJ --hide-ballpark > pinned_pipeline.txt

# Record the toolchain that produced the pipeline, so a rebuild is reproducible.
projinfo --version >> pinned_pipeline.txt   # PROJ + EPSG database versions
```

Bake every grid shift file the pipeline references into the container image and forbid runtime downloads, exactly as the ETL guidance in [Automating CRS Transformations in ETL Pipelines](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/crs-synchronization-in-pipelines/automating-crs-transformations-in-etl-pipelines/) requires. A pipeline that depends on `us_noaa_nadcon5_nad83_1986_nad83_2011.tif` is only reproducible if that grid is present and its checksum is recorded:

```bash
export PROJ_NETWORK=OFF                       # no silent runtime grid fetches
GRID="us_noaa_nadcon5_nad83_1986_nad83_2011.tif"
test -f "$PROJ_DATA/$GRID" || { echo "FATAL: datum grid $GRID not baked in"; exit 1; }
sha256sum "$PROJ_DATA/$GRID" >> frame_lineage.jsonl
```

### Phase 3: Propagate Time-Dependent Coordinates by Epoch

Between a global frame and a plate-fixed frame, the transformation is a function of epoch. PROJ carries the coordinate epoch as a fourth ordinate, so a point observed in ITRF2014 at epoch 2015.7 transforms into NAD83(2011) through a time-dependent Helmert plus a plate-motion or deformation model. Supply the epoch explicitly — omitting it makes PROJ assume the frame's reference epoch and reintroduces the drift you are trying to remove.

```bash
# Transform ITRF2014 lon/lat/h observed at epoch 2015.7 into NAD83(2011).
# The 4th input value is the coordinate epoch (decimal year).
echo "-104.9903 39.7392 1609.0 2015.7" | \
  cs2cs "EPSG:7912" "EPSG:6318" -d 6
```

For bulk archives, drive the same operation through `pyproj.Transformer`, passing a `tt` array of epochs so every feature is propagated to the archival reference epoch before it is written:

```python
from pyproj import Transformer
tr = Transformer.from_crs("EPSG:7912", "EPSG:6318", always_xy=True)
lon, lat, h, epoch = -104.9903, 39.7392, 1609.0, 2015.7
x, y, z = tr.transform(lon, lat, h, epoch)   # epoch drives the time-dependent step
```

## Verifying the Transformation Is Reproducible

Reproducibility here means two things: the pipeline resolves to the pinned operation, and a known control point round-trips within the operation's stated accuracy. Check both, because a matching pipeline string over a changed grid still yields wrong coordinates.

```bash
projinfo -s "EPSG:6318" -t "EPSG:4326" -o PROJ --hide-ballpark
```

Annotated expected output — the operation and its accuracy must match `pinned_pipeline.txt` exactly:

```text
+proj=pipeline
  +step +proj=axisswap +order=2,1
  +step +proj=unitconvert +xy_in=deg +xy_out=rad
  +step +proj=noop            # NAD83(2011) -> WGS84 is sub-metre; ballpark hidden
  +step +proj=unitconvert +xy_in=rad +xy_out=deg
  +step +proj=axisswap +order=2,1
```

If instead the output names a grid-based step with a different accuracy figure, the EPSG database was upgraded under you and the archive's transformations are no longer the ones its lineage claims — freeze the toolchain and re-pin deliberately. Because these pinned pipelines and their grids are part of the legal record of what a coordinate meant, govern their retention under the [Retention Policy Frameworks](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/retention-policy-frameworks/) that keep the rest of the archive defensible.

## Troubleshooting

| Symptom | Root cause | Diagnostic & fix |
|---------|------------|------------------|
| Coordinates off by ~1 m between two "NAD83" datasets | Different realizations stored under the bare ensemble code | Recover each realization from the survey date; store `realization_epsg` (e.g. 6318), transform through NADCON5 grids |
| Global-frame points drift ~2 cm/year vs expected | Coordinate epoch omitted; static transform assumed | Record the observation epoch; use a time-dependent transform with the epoch as the 4th ordinate |
| `projinfo` returns a different pipeline than last year | PROJ/EPSG database upgraded, changing the ranked winner | Replay the pinned pipeline string; freeze PROJ + EPSG versions in the image and re-pin only on review |
| `Cannot find grid` at transform time | Required `.tif` grid not baked in under `PROJ_NETWORK=OFF` | Stage the grid, verify its recorded checksum, treat a missing grid as a hard failure |

## Operational Execution Checklist

- [ ] Resolve and store the specific realization EPSG code, never the bare datum ensemble.
- [ ] Record the coordinate epoch as a first-class decimal-year field for every dataset.
- [ ] Freeze the chosen transformation pipeline string plus the PROJ and EPSG database versions that produced it.
- [ ] Bake every referenced grid shift file into the image and record its checksum; forbid runtime downloads.
- [ ] Pass the coordinate epoch explicitly through time-dependent transforms; never let PROJ assume the reference epoch.
- [ ] Verify the pipeline resolves to the pinned operation and a control point round-trips within stated accuracy.
- [ ] Retain pinned pipelines and grids under the archive's retention policy as part of the coordinate's provenance.

## Related

- Up: [CRS Synchronization in Pipelines](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/crs-synchronization-in-pipelines/) — the parent reference for target-frame selection and the projection contracts these time-dependent transforms extend.
- [Detecting and Fixing CRS Drift in Archived Datasets](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/crs-synchronization-in-pipelines/detecting-and-fixing-crs-drift-in-archived-datasets/) — the sibling audit for label-versus-geometry drift, the failure mode a missing realization quietly creates.
- [Verifying CRS Metadata Integrity in GeoParquet Archives](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/crs-synchronization-in-pipelines/verifying-crs-metadata-integrity-in-geoparquet-archives/) — the sibling that checks realization and epoch metadata survived the columnar write.
- [Automating CRS Transformations in ETL Pipelines](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/crs-synchronization-in-pipelines/automating-crs-transformations-in-etl-pipelines/) — the sibling ETL stage that pins PROJ grids the same way at ingest.
- [Retention Policy Frameworks](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/retention-policy-frameworks/) — the archival-governance controls determining how long pinned pipelines and grids must be retained as coordinate provenance.

_Part of the [Spatial Data Archival](https://www.spatialdataarchival.org/) knowledge base._
