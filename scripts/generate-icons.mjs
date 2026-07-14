/* Generate favicon.ico + PNG/PWA icons from the vector favicon.svg.
   Run via `npm run icons` (also invoked by `npm run prebuild`). */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import pngToIco from "png-to-ico";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ICON_DIR = path.resolve(__dirname, "../assets/icons");
const SRC = path.join(ICON_DIR, "favicon.svg");

// Solid background for icons that get masked by the OS (no transparency).
const TEAL = { r: 15, g: 118, b: 110, alpha: 1 };

async function render(size, density = 512) {
  const svg = await fs.readFile(SRC);
  return sharp(svg, { density }).resize(size, size, { fit: "contain" }).png().toBuffer();
}

async function renderMaskable(size) {
  const inner = Math.round(size * 0.78);
  const svg = await fs.readFile(SRC);
  const emblem = await sharp(svg, { density: 512 })
    .resize(inner, inner, { fit: "contain" })
    .png()
    .toBuffer();
  const pad = Math.round((size - inner) / 2);
  return sharp({
    create: { width: size, height: size, channels: 4, background: TEAL },
  })
    .composite([{ input: emblem, top: pad, left: pad }])
    .png()
    .toBuffer();
}

async function flattened(size) {
  const buf = await render(size);
  return sharp(buf).flatten({ background: TEAL }).png().toBuffer();
}

async function main() {
  const out = (name, buf) => fs.writeFile(path.join(ICON_DIR, name), buf);

  const [i192, i512, maskable, apple, f16, f32, f48] = await Promise.all([
    render(192),
    render(512),
    renderMaskable(512),
    flattened(180),
    render(16),
    render(32),
    render(48),
  ]);

  await Promise.all([
    out("icon-192.png", i192),
    out("icon-512.png", i512),
    out("maskable-512.png", maskable),
    out("apple-touch-icon.png", apple),
  ]);

  const ico = await pngToIco([f16, f32, f48]);
  await out("favicon.ico", ico);

  console.log("✓ Generated PWA icons + favicon.ico in assets/icons/");
}

main().catch((err) => {
  console.error("Icon generation failed:", err);
  process.exit(1);
});
