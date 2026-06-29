// One-off script: builds the square PWA/app icons from the transparent master
// logo (public/logo.png) by centering it on a white square with padding. Output
// goes back into public/ so Vite serves them at the root of the deployed site.
//
//   Run: node scripts/generate-pwa-icons.mjs
//
// Re-run whenever you change logo.png.

import sharp from 'sharp';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = join(here, '..', 'public');
const logoPath = join(publicDir, 'logo.png');

const WHITE = { r: 255, g: 255, b: 255, alpha: 1 };

// Center the logo (preserving aspect ratio) on a white square of `size`, leaving
// `pad` fraction of empty margin on each edge.
async function makeIcon(size, pad) {
  const inner = Math.round(size * (1 - pad * 2));
  const logo = await sharp(logoPath)
    .resize({ width: inner, height: inner, fit: 'inside' })
    .toBuffer();
  return sharp({ create: { width: size, height: size, channels: 4, background: WHITE } })
    .composite([{ input: logo, gravity: 'center' }])
    .png({ compressionLevel: 9 })
    .toBuffer();
}

// 180 → apple-touch-icon (iOS home screen)
// 192 → manifest icon (Android Chrome) + favicon
// 512 → manifest icon / install prompt / og:image
// 1024 → master / future-proofing
for (const size of [180, 192, 512, 1024]) {
  const out = await makeIcon(size, 0.1);
  const file = join(publicDir, `icon-${size}.png`);
  await writeFile(file, out);
  console.log(`✓ wrote ${file} (${(out.byteLength / 1024).toFixed(1)} KB)`);
}

// Maskable variant for Android adaptive icons — extra padding for the safe zone.
const maskable = await makeIcon(512, 0.2);
await writeFile(join(publicDir, 'icon-maskable-512.png'), maskable);
console.log(`✓ wrote icon-maskable-512.png (${(maskable.byteLength / 1024).toFixed(1)} KB)`);
