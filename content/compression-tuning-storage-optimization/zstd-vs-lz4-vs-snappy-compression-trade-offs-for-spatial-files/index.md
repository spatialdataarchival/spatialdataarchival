# ZSTD vs LZ4 vs Snappy: Compression Trade-offs for Spatial Files

Choosing a compression codec for spatial columnar and vector archives is a trade among storage footprint, decompression latency, and CPU cost, and the right answer flips completely between a hot analytical tier and a cold archive tier. This guide puts ZSTD, LZ4, and Snappy head-to-head on GeoParquet and Arrow-backed spatial files, measuring compression ratio, compress and decompress throughput, CPU burn, cold-retrieval decompression latency, and level tunability — then gives a concrete recommendation by scenario. It is written for the data engineers and cloud architects who set `compression=` once and pay for it on every scan and every restore, under the [Compression Tuning & Storage Optimization](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/) framework. The default Parquet codec (Snappy) is tuned for query speed, not archival density, so leaving it in place on a cold tier quietly overpays for storage for years.

## The Decision Framing

Every codec choice trades three quantities that cannot all be maximized at once: the ratio (how small the file gets), the compression throughput (how fast you can write it), and the decompression throughput (how fast a reader can rehydrate it). Snappy and LZ4 sit at the fast-but-loose end — they compress and decompress at gigabytes per second but leave twenty to forty percent more bytes on disk than ZSTD. ZSTD sits at the dense end, with a single tunable `level` knob that spans a range from "faster than gzip, denser than Snappy" to "maximum ratio, slow to write." For spatial archives the load profile is asymmetric: you write a partition once at ingest and read it rarely but under a latency SLA when a restore is triggered. That asymmetry is what makes the codec choice tier-dependent, and it is why a blanket default is almost always wrong for at least one of your tiers.

<svg viewBox="0 0 960 212" role="img" aria-label="Compression codec comparison matrix for spatial files. ZSTD: high compression ratio around 3.6 to 1, compress throughput roughly 120 to 450 megabytes per second depending on level, decompress throughput around 1200 megabytes per second, moderate CPU cost, 22 tunable levels, best suited to cold and archive tiers. LZ4: medium ratio around 2.4 to 1, very fast compress at roughly 500 megabytes per second, very fast decompress above 3000 megabytes per second, low CPU cost, an acceleration knob rather than fine levels, best for warm tiers and transient shuffle. Snappy: low ratio around 2.1 to 1, fast compress near 400 megabytes per second, fast decompress near 1800 megabytes per second, low CPU cost, no tuning knob, best for hot interactive query tiers." xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;color:var(--primary);font-family:var(--font-sans)">
  <title>Compression codec comparison matrix: ZSTD vs LZ4 vs Snappy</title>
  <desc>A three-row matrix comparing ZSTD, LZ4, and Snappy across compression ratio, compress throughput, decompress throughput, CPU cost, level tunability, and the storage tier each best fits. ZSTD maximizes ratio for cold tiers, LZ4 maximizes decompression speed for warm tiers, and Snappy is the low-overhead default for hot interactive query.</desc>
  <rect x="10" y="10" width="940" height="36" fill="currentColor" fill-opacity="0.07"/>
  <rect x="10" y="10" width="940" height="192" fill="none" stroke="currentColor" stroke-width="1.2" stroke-opacity="0.5"/>
  <line x1="118" y1="10" x2="118" y2="202" stroke="currentColor" stroke-width="1" stroke-opacity="0.3"/>
  <line x1="238" y1="10" x2="238" y2="202" stroke="currentColor" stroke-width="1" stroke-opacity="0.3"/>
  <line x1="398" y1="10" x2="398" y2="202" stroke="currentColor" stroke-width="1" stroke-opacity="0.3"/>
  <line x1="558" y1="10" x2="558" y2="202" stroke="currentColor" stroke-width="1" stroke-opacity="0.3"/>
  <line x1="668" y1="10" x2="668" y2="202" stroke="currentColor" stroke-width="1" stroke-opacity="0.3"/>
  <line x1="788" y1="10" x2="788" y2="202" stroke="currentColor" stroke-width="1" stroke-opacity="0.3"/>
  <line x1="10" y1="46" x2="950" y2="46" stroke="currentColor" stroke-width="1" stroke-opacity="0.3"/>
  <line x1="10" y1="98" x2="950" y2="98" stroke="currentColor" stroke-width="1" stroke-opacity="0.3"/>
  <line x1="10" y1="150" x2="950" y2="150" stroke="currentColor" stroke-width="1" stroke-opacity="0.3"/>
  <text x="20" y="32" font-size="11" font-weight="600" fill="currentColor">Codec</text>
  <text x="128" y="32" font-size="11" font-weight="600" fill="currentColor">Ratio</text>
  <text x="248" y="32" font-size="11" font-weight="600" fill="currentColor">Compress MB/s</text>
  <text x="408" y="32" font-size="11" font-weight="600" fill="currentColor">Decompress MB/s</text>
  <text x="568" y="32" font-size="11" font-weight="600" fill="currentColor">CPU</text>
  <text x="678" y="32" font-size="11" font-weight="600" fill="currentColor">Tuning</text>
  <text x="798" y="32" font-size="11" font-weight="600" fill="currentColor">Best tier</text>
  <text x="20" y="68" font-size="12" font-weight="700" fill="currentColor">ZSTD</text>
  <text x="20" y="83" font-size="8.5" fill="currentColor" fill-opacity="0.7">lvl 1&#8211;22</text>
  <text x="128" y="76" font-size="10" fill="currentColor">~3.6:1</text>
  <text x="248" y="76" font-size="10" fill="currentColor">120&#8211;450</text>
  <text x="408" y="76" font-size="10" fill="currentColor">~1200</text>
  <text x="568" y="76" font-size="10" fill="currentColor">moderate</text>
  <text x="678" y="76" font-size="10" fill="currentColor">22 levels</text>
  <text x="798" y="76" font-size="10" fill="currentColor">cold / archive</text>
  <text x="20" y="120" font-size="12" font-weight="700" fill="currentColor">LZ4</text>
  <text x="20" y="135" font-size="8.5" fill="currentColor" fill-opacity="0.7">accel knob</text>
  <text x="128" y="128" font-size="10" fill="currentColor">~2.4:1</text>
  <text x="248" y="128" font-size="10" fill="currentColor">~500</text>
  <text x="408" y="128" font-size="10" fill="currentColor">&gt;3000</text>
  <text x="568" y="128" font-size="10" fill="currentColor">low</text>
  <text x="678" y="128" font-size="10" fill="currentColor">acceleration</text>
  <text x="798" y="128" font-size="10" fill="currentColor">warm / shuffle</text>
  <text x="20" y="172" font-size="12" font-weight="700" fill="currentColor">Snappy</text>
  <text x="20" y="187" font-size="8.5" fill="currentColor" fill-opacity="0.7">default</text>
  <text x="128" y="180" font-size="10" fill="currentColor">~2.1:1</text>
  <text x="248" y="180" font-size="10" fill="currentColor">~400</text>
  <text x="408" y="180" font-size="10" fill="currentColor">~1800</text>
  <text x="568" y="180" font-size="10" fill="currentColor">low</text>
  <text x="678" y="180" font-size="10" fill="currentColor">none</text>
  <text x="798" y="180" font-size="10" fill="currentColor">hot / interactive</text>
</svg>

The numbers above are representative of GeoParquet with WKB geometry plus mixed attribute columns; your exact ratios depend on data entropy and are why you benchmark on a real sample rather than trusting a table. Highly repetitive attributes such as categorical land-use codes compress far better than dense floating-point coordinate columns, which is also why [dictionary encoding for GIS attributes](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/dictionary-encoding-for-gis-attributes/) often matters more than the codec choice for the attribute side of the file.

## Per-Dimension Analysis

**Compression ratio.** ZSTD's larger window and entropy stage consistently beat LZ4 and Snappy on spatial data by twenty to forty percent, and the gap widens at higher levels. On a cold tier that ratio is money — thirty percent fewer bytes is thirty percent off every GB-month for the life of the archive, plus proportionally less cross-region replication bandwidth. Snappy and LZ4 were designed to be "good enough" ratio at maximum speed, and on coordinate-heavy geometry they leave real bytes on the table.

**Compress throughput.** This matters only at ingest, which for an archive happens once. LZ4 leads, Snappy close behind, and ZSTD is competitive at low levels but drops sharply as you climb toward level 19–22. Because ingest is a batch job you can parallelize across workers, compress throughput is rarely the binding constraint for a cold archive — you can afford ZSTD level 15 on a write that happens once and is read once a year.

**Decompress throughput and cold-retrieval latency.** This is the dimension that trips up archives. When a cold object is restored and a query engine reads it, decompression sits on the critical path of time-to-first-byte. LZ4 decompresses several times faster than ZSTD, which is why it wins for warm data that is read often. But ZSTD decompression is roughly constant regardless of the compression level used to write the file — a level-19 file decompresses about as fast as a level-3 file — so you get maximum ratio without a decompression-latency penalty. Snappy decompresses fast but, because its files are larger, more bytes have to move over the network from storage, which can erase its CPU advantage on a bandwidth-bound cold read.

**CPU cost.** LZ4 and Snappy are cheap on both ends. ZSTD costs meaningfully more CPU to compress at high levels and modestly more to decompress. In a serverless restore path where you pay per GB-second, ZSTD's extra decompression CPU is usually dwarfed by the storage and egress savings from the smaller file, but you should model it explicitly against the [spatial archive cost model](https://www.spatialdataarchival.org/spatial-archive-cost-modeling/).

**Level tunability.** Snappy has no knob — you get one operating point. LZ4 exposes an acceleration factor that trades ratio for speed. ZSTD exposes 22 levels, which makes it the only codec you can dial precisely onto a tier's latency and density budget; the mechanics of choosing that number are the subject of [ZSTD Level Configuration for Spatial Files](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/zstd-level-configuration-for-spatial-files/).

## Benchmarking on Your Own Spatial Sample

Never adopt a codec from a table. Round-trip a representative partition through all three and measure ratio and decompress time on your actual data. The following writes one partition three ways and reports the trade.

```python
import time, os
import pyarrow.parquet as pq
import pyarrow as pa

table = pq.read_table("s3://spatial-archive/vector/sample/parcels_la_h3_res7.parquet")
raw_bytes = table.nbytes

for codec, level in [("snappy", None), ("lz4", None), ("zstd", 3), ("zstd", 15)]:
    out = f"/tmp/bench_{codec}_{level}.parquet"
    kw = {"compression": codec}
    if level is not None:
        kw["compression_level"] = level
    pq.write_table(table, out, row_group_size=100_000, **kw)
    size = os.path.getsize(out)

    t0 = time.perf_counter()
    for _ in range(5):
        _ = pq.read_table(out)          # cold-read decompression proxy
    dt = (time.perf_counter() - t0) / 5

    tag = f"{codec}-{level}" if level else codec
    print(f"{tag:10s} ratio={raw_bytes/size:5.2f}:1  file={size/1e6:7.1f}MB  read={dt*1000:6.1f}ms")
```

For non-Python pipelines the same choice is a single GDAL layer-creation flag, so you can A/B two codecs directly at conversion time:

```bash
# Dense cold-tier write with ZSTD level 15
ogr2ogr -f Parquet parcels_zstd.parquet parcels.fgb \
  -lco COMPRESSION=ZSTD -lco COMPRESSION_LEVEL=15 -lco ROW_GROUP_SIZE=100000

# Fast warm-tier write with LZ4 for comparison
ogr2ogr -f Parquet parcels_lz4.parquet parcels.fgb \
  -lco COMPRESSION=LZ4 -lco ROW_GROUP_SIZE=100000
```

## Validating the Trade You Chose

Confirm the on-disk codec is what you intended and that the ratio justifies it. Read the Parquet column metadata directly rather than trusting the write call.

```bash
python -c "
import pyarrow.parquet as pq
m = pq.ParquetFile('parcels_zstd.parquet').metadata
rg = m.row_group(0)
for i in range(rg.num_columns):
    c = rg.column(i)
    print(f'{c.path_in_schema:20s} codec={c.compression:8s} '
          f'ratio={c.total_uncompressed_size/max(c.total_compressed_size,1):.2f}')
"
```

Expected output — every column reports the intended `ZSTD` codec, and the geometry column shows a lower ratio than the categorical attribute columns, which is normal for dense WKB coordinates:

```text
geometry             codec=ZSTD     ratio=2.31
land_use_code        codec=ZSTD     ratio=8.74
parcel_area_m2       codec=ZSTD     ratio=3.02
owner_type           codec=ZSTD     ratio=9.51
```

If the geometry column's ratio is the one dragging the file down and it dominates the byte budget, the codec is doing its job and further gains come from geometry encoding, not from switching codecs.

## Recommendation by Scenario

The codec should follow the tier, and in a multi-tier archive it is entirely reasonable to re-encode as data ages — the pipeline that transitions an object from warm to cold can also rewrite it from LZ4 to ZSTD level 15. Coordinate the choice with the [Hot/Warm/Cold Tier Design for Geospatial Data](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/hotwarmcold-tier-design-for-geospatial-data/) model so the codec matches the tier's read pattern:

- **Hot / interactive tier** — keep **Snappy** (or ZSTD level 1). Reads are frequent and latency-sensitive, storage volume is small, and the default's low decompression overhead is exactly right. Density does not pay off here.
- **Warm / frequently-restored tier** — use **LZ4**. When objects are read often but you still want some size reduction, LZ4's very high decompression throughput keeps restore latency low while trimming bytes over Snappy.
- **Cold / archive tier** — use **ZSTD level 12–15**. Written once, read rarely, held for years: maximize ratio. Decompression stays fast because ZSTD decompression is level-independent, so a restore SLA is met while storage and replication bandwidth drop sharply.
- **Deep archive / legal hold** — use **ZSTD level 19+**. These objects may never be read; every byte saved compounds over a decade-long retention window, and the one-time high compress cost is negligible amortized across that lifespan.

## Codec Selection Failure Modes

| Symptom | Cause | Fix |
|---------|-------|-----|
| Cold-tier storage bill higher than modeled | Left the Snappy default on archived partitions | Re-encode aging objects to ZSTD level 12&#8211;15 during the warm-to-cold transition |
| Restore SLA missed on a bandwidth-bound read | Snappy's larger files move more bytes over the network from cold storage | Switch to ZSTD; smaller files cut transfer time even after decompression CPU |
| Ingest job saturates CPU and stalls | ZSTD level 19+ applied at write time on a hot ingest path | Ingest at ZSTD level 3 or LZ4, then re-compress to a high level asynchronously as data cools |
| Codec flag silently ignored, file stays Snappy | Engine or GDAL build lacks the codec, falls back to default | Verify with `parquet` metadata that `compression` matches intent before publishing |

## Operational Execution Checklist

- [ ] Benchmark ratio and decompress time for Snappy, LZ4, and ZSTD (levels 3 and 15) on a real partition, not a reference table.
- [ ] Match the codec to the tier: Snappy hot, LZ4 warm, ZSTD 12&#8211;15 cold, ZSTD 19+ deep archive / legal hold.
- [ ] Confirm ZSTD decompression stays level-independent so a high level does not blow the restore latency SLA.
- [ ] Verify the on-disk codec per column with `parquet` metadata before publishing; never trust the write call alone.
- [ ] Keep the high-level ZSTD re-compression off the hot ingest path — ingest fast, densify asynchronously as data cools.
- [ ] Model ZSTD's extra decompression GB-seconds against storage and egress savings in the cost model before committing.
- [ ] Re-encode objects at each tier transition so codec always tracks the current read pattern, not the pattern at ingest.

## Related

- Up: [Compression Tuning & Storage Optimization](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/) — the parent framework for codec, level, encoding, and row-group decisions across the archive.
- [ZSTD Level Configuration for Spatial Files](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/zstd-level-configuration-for-spatial-files/) — the sibling deep-dive on picking the exact ZSTD level once you have chosen the codec.
- [When to Use Dictionary Encoding for Categorical GIS Fields](https://www.spatialdataarchival.org/compression-tuning-storage-optimization/dictionary-encoding-for-gis-attributes/when-to-use-dictionary-encoding-for-categorical-gis-fields/) — attribute-side gains that often outweigh the codec choice for categorical columns.
- [Hot/Warm/Cold Tier Design for Geospatial Data](https://www.spatialdataarchival.org/spatial-archival-architecture-tiering-strategy/hotwarmcold-tier-design-for-geospatial-data/) — the tier read patterns that determine which codec each partition should carry.
- [Spatial Archive Cost Modeling](https://www.spatialdataarchival.org/spatial-archive-cost-modeling/) — quantify the storage, egress, and decompression-CPU trade of each codec choice.

_Part of the [Spatial Data Archival](https://www.spatialdataarchival.org/) knowledge base._
