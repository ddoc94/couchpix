// One-off script: rasterizes public/icon.svg into the PNG sizes needed for
// PWA install ("Add to Home Screen") on iOS and Android. Output goes back
// into public/ so Vite serves them at the root of the deployed site.
//
//   Run: node scripts/generate-pwa-icons.mjs
//
// You only need to re-run this when you change icon.svg.

import sharp from 'sharp';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = join(here, '..', 'public');
const svgPath = join(publicDir, 'icon.svg');
const svg = await readFile(svgPath);

// Required: square PNGs for manifest icons + apple-touch-icon.
// 180  → apple-touch-icon (iOS home screen)
// 192  → manifest icon (Android Chrome home screen, recommended minimum)
// 512  → manifest icon (Android Chrome splash, install prompt)
// 1024 → master / future-proofing
const sizes = [180, 192, 512, 1024];

for (const size of sizes) {
  const out = await sharp(svg)
    .resize(size, size, { fit: 'contain', background: { r: 244, g: 247, b: 250, alpha: 1 } })
    .png({ compressionLevel: 9 })
    .toBuffer();
  const file = join(publicDir, `icon-${size}.png`);
  await writeFile(file, out);
  console.log(`✓ wrote ${file} (${(out.byteLength / 1024).toFixed(1)} KB)`);
}

// A maskable variant for Android adaptive icons (safe zone is the inner 80%).
// We use the same icon since our remote already has padding around it.
const maskable = await sharp(svg)
  .resize(512, 512, { fit: 'contain', background: { r: 10, g: 10, b: 15, alpha: 1 } })
  .png({ compressionLevel: 9 })
  .toBuffer();
await writeFile(join(publicDir, 'icon-maskable-512.png'), maskable);
console.log(`✓ wrote icon-maskable-512.png (${(maskable.byteLength / 1024).toFixed(1)} KB)`);
