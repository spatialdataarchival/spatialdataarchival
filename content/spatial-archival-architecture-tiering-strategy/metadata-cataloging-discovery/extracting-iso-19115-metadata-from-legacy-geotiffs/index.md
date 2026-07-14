# Extracting ISO 19115 Metadata from Legacy GeoTIFFs

Extracting ISO 19115 metadata from legacy GeoTIFFs means harvesting whatever provenance survives inside decades-old rasters — embedded TIFF tags, GDAL metadata domains, and orphaned sidecar files — and mapping it into a compliant ISO 19115/19139 record so the archive remains discoverable and audit-defensible after the originating team is gone. This guide is for GIS archivists and compliance teams inheriting scanned topographic sheets, old orthophotos, and government raster deliveries where the metadata is partial, inconsistent, or externalized into `.aux.xml` and `.tfw` companions. Generic converters fail because they assume a clean single-file source with a complete header; legacy GeoTIFFs routinely carry a missing CRS, an undocumented processing lineage, and datestamps buried in vendor-specific tags. The extraction has to be forgiving about where metadata lives and strict about where it lands.

## Where Legacy Metadata Hides and Where It Must Land

The hard part is not the ISO schema — it is that a single logical record is scattered across the raster header and its companions, and mapping it correctly is what turns scraps into a compliant record:

<svg viewBox="0 0 1000 340" role="img" aria-label="Two-column mapping diagram. Left column, GeoTIFF sources: GDAL default metadata domain, TIFFTAG_DATETIME tag, GeoKeys and prj CRS definition, and aux.xml or xml sidecar. Right column, ISO 19115 and 19139 elements: identificationInfo citation, dateStamp, referenceSystemInfo, and dataQualityInfo lineage. Arrows connect each source to its target element; the lineage element is marked as frequently missing and gap-filled from an ingest manifest." xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;color:var(--primary);font-family:var(--font-sans)">
  <title>Mapping legacy GeoTIFF metadata sources to ISO 19115 elements</title>
  <desc>Four GeoTIFF metadata sources on the left map to four ISO 19115/19139 elements on the right: the GDAL default domain feeds identificationInfo, TIFFTAG_DATETIME feeds dateStamp, GeoKeys and the prj definition feed referenceSystemInfo, and the aux.xml sidecar feeds dataQualityInfo lineage. The lineage target is highlighted as commonly absent and filled from the ingest manifest.</desc>
  <defs>
    <marker id="iso-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <text x="170" y="24" text-anchor="middle" font-size="12.5" font-weight="700" fill="currentColor">GeoTIFF sources</text>
  <text x="830" y="24" text-anchor="middle" font-size="12.5" font-weight="700" fill="currentColor">ISO 19115 / 19139 elements</text>
  <g text-anchor="middle">
    <rect x="20" y="44" width="300" height="52" rx="9" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-opacity="0.45"/>
    <text x="170" y="68" font-size="12.5" font-weight="600" fill="currentColor">GDAL default domain</text>
    <text x="170" y="85" font-size="10" fill="currentColor" fill-opacity="0.7">AREA_OR_POINT &#183; TIFFTAG_SOFTWARE</text>
    <rect x="20" y="116" width="300" height="52" rx="9" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-opacity="0.45"/>
    <text x="170" y="140" font-size="12.5" font-weight="600" fill="currentColor">TIFFTAG_DATETIME</text>
    <text x="170" y="157" font-size="10" fill="currentColor" fill-opacity="0.7">acquisition / processing date</text>
    <rect x="20" y="188" width="300" height="52" rx="9" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-opacity="0.45"/>
    <text x="170" y="212" font-size="12.5" font-weight="600" fill="currentColor">GeoKeys &#183; .prj CRS</text>
    <text x="170" y="229" font-size="10" fill="currentColor" fill-opacity="0.7">ProjectedCSTypeGeoKey / WKT</text>
    <rect x="20" y="260" width="300" height="52" rx="9" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-opacity="0.45"/>
    <text x="170" y="284" font-size="12.5" font-weight="600" fill="currentColor">.aux.xml / .xml sidecar</text>
    <text x="170" y="301" font-size="10" fill="currentColor" fill-opacity="0.7">vendor lineage &#183; contact</text>
  </g>
  <g text-anchor="middle">
    <rect x="680" y="44" width="300" height="52" rx="9" fill="currentColor" fill-opacity="0.06" stroke="currentColor" stroke-opacity="0.5"/>
    <text x="830" y="68" font-size="12.5" font-weight="600" fill="currentColor">identificationInfo</text>
    <text x="830" y="85" font-size="10" fill="currentColor" fill-opacity="0.7">citation &#183; title &#183; abstract</text>
    <rect x="680" y="116" width="300" height="52" rx="9" fill="currentColor" fill-opacity="0.06" stroke="currentColor" stroke-opacity="0.5"/>
    <text x="830" y="140" font-size="12.5" font-weight="600" fill="currentColor">dateStamp</text>
    <text x="830" y="157" font-size="10" fill="currentColor" fill-opacity="0.7">CI_Date / gco:Date</text>
    <rect x="680" y="188" width="300" height="52" rx="9" fill="currentColor" fill-opacity="0.06" stroke="currentColor" stroke-opacity="0.5"/>
    <text x="830" y="212" font-size="12.5" font-weight="600" fill="currentColor">referenceSystemInfo</text>
    <text x="830" y="229" font-size="10" fill="currentColor" fill-opacity="0.7">RS_Identifier &#183; EPSG code</text>
    <rect x="680" y="260" width="300" height="52" rx="9" fill="currentColor" fill-opacity="0.14" stroke="currentColor" stroke-opacity="0.7" stroke-width="1.5"/>
    <text x="830" y="281" font-size="12.5" font-weight="700" fill="currentColor">dataQualityInfo / lineage</text>
    <text x="830" y="298" font-size="10" fill="currentColor" fill-opacity="0.75">often missing &#8594; gap-fill</text>
  </g>
  <g stroke="currentColor" stroke-width="1.8" fill="none" stroke-opacity="0.5">
    <path d="M320 70 H678" marker-end="url(#iso-arrow)"/>
    <path d="M320 142 H678" marker-end="url(#iso-arrow)"/>
    <path d="M320 214 H678" marker-end="url(#iso-arrow)"/>
    <path d="M320 286 H678" stroke-dasharray="6 4" marker-end="url(#iso-arrow)"/>
  </g>
</svg>

## Harvesting Every Metadata Domain

GDAL exposes TIFF tags and sidecar content through named metadata domains, and legacy tools scattered values across all of them. Dump every domain before assuming a field is absent, because the datestamp you need is frequently sitting in a nonstandard domain the original vendor invented.

1. **Enumerate the full metadata surface:**
```bash
gdalinfo -json -mdd all datasets/imagery/legacy/ortho_1998_tile_042.tif > raw_meta.json
```
 The `-mdd all` flag forces GDAL to read every metadata domain, not just the default one — including `IMAGE_STRUCTURE`, `GEOLOCATION`, and any vendor domain such as `ESRI` or `DERIVED_SUBDATASET`. The JSON also carries the `coordinateSystem` block and the corner coordinates you need for the geographic extent. Run this across the whole archive as a batch harvest before writing any records: a single pass that dumps every raster's full metadata surface into a staging table lets you profile which fields are consistently present and which are systematically absent, so the gap-fill strategy is designed from evidence rather than discovered one broken record at a time. Legacy collections are rarely uniform — a directory of orthophotos may span three vendors and two decades of tooling conventions — and the batch profile is what surfaces those seams.

2. **Pull the datestamp from whichever tag actually holds it.** Legacy writers used `TIFFTAG_DATETIME`, a sidecar `<ProcessDate>`, or nothing at all. Prefer the embedded tag, fall back to the sidecar, and record which source won so the lineage is honest:
```python
import json
from datetime import datetime

meta = json.load(open("raw_meta.json"))
tags = meta.get("metadata", {}).get("", {})
raw_date = tags.get("TIFFTAG_DATETIME")  # e.g. "1998:07:23 00:00:00"

if raw_date:
    date_stamp = datetime.strptime(raw_date, "%Y:%m:%d %H:%M:%S").date().isoformat()
    date_source = "TIFFTAG_DATETIME"
else:
    date_stamp, date_source = None, "MISSING"  # trigger gap-fill downstream
```

3. **Resolve the CRS to an EPSG authority code.** GeoKeys often encode the projection without a clean EPSG reference, and a stray `.prj` may disagree with the embedded GeoKeys. Force a single authoritative answer:
```bash
gdalsrsinfo -o epsg datasets/imagery/legacy/ortho_1998_tile_042.tif
```
 If this returns `Unknown` or an ambiguous WKT, the raster is CRS-orphaned and must be resolved before it can populate `referenceSystemInfo` — the same discipline enforced upstream by [CRS Synchronization in Pipelines](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/crs-synchronization-in-pipelines/).

## Mapping to a Compliant ISO 19139 Record

Harvested values are inert until serialized into the ISO 19139 XML encoding of the 19115 model. Map each source to its target element and, critically, mark provenance for anything you infer rather than read.

```python
from lxml import etree

NS = {
    "gmd": "http://www.isotc211.org/2005/gmd",
    "gco": "http://www.isotc211.org/2005/gco",
}
root = etree.Element("{%s}MD_Metadata" % NS["gmd"], nsmap=NS)

def gco(parent, tag, value):
    el = etree.SubElement(parent, "{%s}%s" % (NS["gmd"], tag))
    child = etree.SubElement(el, "{%s}CharacterString" % NS["gco"])
    child.text = value
    return el

# dateStamp — from the harvested tag, or an explicit nil for a genuine gap
ds = etree.SubElement(root, "{%s}dateStamp" % NS["gmd"])
if date_stamp:
    etree.SubElement(ds, "{%s}Date" % NS["gco"]).text = date_stamp
else:
    ds.set("{http://www.isotc211.org/2005/gco}nilReason", "missing")

# referenceSystemInfo — the resolved EPSG authority code
gco(root, "referenceSystemInfo", "urn:ogc:def:crs:EPSG::32610")

# lineage — filled from the ingest manifest when the raster carries none
lineage = gco(root, "lineage", "Digitized from 1998 orthophoto series; "
              "georeferenced by archive ingest 2026-07, source metadata partial.")

tree = etree.ElementTree(root)
tree.write("datasets/imagery/legacy/ortho_1998_tile_042.iso19139.xml",
           pretty_print=True, xml_declaration=True, encoding="UTF-8")
```

Keep the distinction between the ISO 19115 abstract model and its ISO 19139 XML encoding clear as you build. ISO 19115 defines the content — which elements exist, which are mandatory, and how they relate — while ISO 19139 defines the concrete XML serialization with its `gmd`/`gco` namespaces and `nilReason` machinery. Newer archives may target the ISO 19115-1:2014 model serialized as 19115-3 XML, but the vast majority of legacy raster deliveries were catalogued against the original 19115:2003 model, and 19139 remains the encoding most national spatial data infrastructures still ingest. Pick the profile your regulator or catalog actually consumes and validate against that exact schema; a record that is valid 19139 but wrong-profile is as useless to a harvester as no record at all.

The `nilReason="missing"` attribute is the honest way to represent an absent field: it keeps the record schema-valid while telling a future auditor the gap was real, not an extraction bug. ISO 19115 defines a controlled vocabulary of nil reasons — `missing`, `unknown`, `inapplicable`, `withheld` — and choosing the right one carries meaning: an orthophoto with no recorded sensor is `unknown`, whereas a derived hillshade with no acquisition datetime is `inapplicable`. Encoding that nuance rather than blanking the field is what separates a defensible harvest from a lossy one. Fill `lineage` from your ingest manifest rather than leaving it blank — a georeferenced-but-undocumented raster with no lineage statement is the single most common finding when these archives are reviewed. Persist the resulting XML as a sidecar next to the raster and register it in the archive's index alongside the STAC entries described in [Automating STAC Catalog Generation for Archived Imagery](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/metadata-cataloging-discovery/automating-stac-catalog-generation-for-archived-imagery/); ISO 19139 serves the formal compliance record while STAC serves fast spatial search, and mature archives keep both.

## Verifying the Record Is Schema-Valid and Complete

Well-formed XML is not the same as a valid ISO 19139 document. Validate against the official schema and then assert the elements your compliance profile requires are actually populated.

```bash
xmllint --noout --schema http://www.isotc211.org/2005/gmd/gmd.xsd \
  datasets/imagery/legacy/ortho_1998_tile_042.iso19139.xml
```

Expected output on a conformant record:
```text
ortho_1998_tile_042.iso19139.xml validates
```

Then confirm the mandatory core elements are present and no required field slipped through as an empty string:
```bash
xmllint --xpath "count(//*[local-name()='dateStamp']) + \
  count(//*[local-name()='referenceSystemInfo']) + \
  count(//*[local-name()='identificationInfo'])" \
  datasets/imagery/legacy/ortho_1998_tile_042.iso19139.xml
```
The count must equal `3`; a lower number means a mandatory ISO 19115 core element is absent and the record will fail a formal metadata conformance review even though the XML parses.

## Resolving Common Extraction Gaps

| Symptom | Root Cause | Resolution |
|---------|------------|------------|
| `referenceSystemInfo` empty | GeoKeys present but no EPSG authority match | Resolve with `gdalsrsinfo -o epsg`; if ambiguous, assign the project CRS and note it in `lineage` |
| Datestamp is the file's mtime | No `TIFFTAG_DATETIME`, extractor fell back to filesystem time | Treat missing dates as `nilReason="missing"`; never substitute filesystem timestamps |
| Sidecar `.aux.xml` ignored | GDAL not reading external domains | Re-run `gdalinfo` with `-mdd all` and confirm the `.aux.xml` sits beside the `.tif` |
| `xmllint` reports namespace errors | Hand-built XML missing `gco`/`gmd` bindings | Declare both namespaces in `nsmap` and qualify every element |

## Operational Execution Checklist

- [ ] Dump every metadata domain with `gdalinfo -json -mdd all` before declaring any field absent.
- [ ] Resolve the CRS to a single EPSG authority code and reconcile embedded GeoKeys against any stray `.prj`.
- [ ] Prefer embedded date tags over sidecars, and record which source supplied the datestamp.
- [ ] Represent genuinely missing fields with `nilReason="missing"`, never with filesystem or ingest-time substitutes.
- [ ] Fill `lineage` from the ingest manifest so no georeferenced raster ships with a blank provenance statement.
- [ ] Validate each record against the official `gmd.xsd` schema and assert the mandatory core elements are populated.
- [ ] Persist the ISO 19139 sidecar next to the raster and register it alongside the archive's STAC index.

## Related

- Up: [Metadata Cataloging & Discovery](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/metadata-cataloging-discovery/) — the parent reference for provenance, CRS lineage, and long-term findability.
- [Automating STAC Catalog Generation for Archived Imagery](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/metadata-cataloging-discovery/automating-stac-catalog-generation-for-archived-imagery/) — the fast-search companion index that pairs with these formal ISO records.
- [Automating CRS Transformations in ETL Pipelines](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/crs-synchronization-in-pipelines/automating-crs-transformations-in-etl-pipelines/) — resolving the CRS-orphaned rasters this extraction depends on.
- [Handling Attribute Loss During Spatial Format Conversion](https://www.spatialdataarchival.org/format-conversion-pipeline-automation/schema-mapping-attribute-validation/handling-attribute-loss-during-spatial-format-conversion/) — the same "prove nothing was silently dropped" discipline applied to vector attributes.

_Part of the [Spatial Data Archival](https://www.spatialdataarchival.org/) knowledge base._
