#!/usr/bin/env node
"use strict";

/* ============================================================
   axomexam - tools/build-exam-logos.js

   Converts the raw exam logo art dropped in "exam logo/" into the
   site-standard WebP tiles served from images/exams/<id>-logo.webp.

   The source files are photographs and exports of very different
   sizes (225px to 900px) on white or transparent backgrounds. Each
   one is trimmed of its uniform border, centred on a square white
   canvas with a small margin, and written out at a single size so
   the exam-wise mock test cards and hero render them consistently.

   ADRE Grade III and Grade IV are intentionally NOT handled here:
   those two keep the existing book-cover art in images/exams/.

   Requires python3 with Pillow, so it is NOT part of the normal
   build. Run it by hand when the source art changes.

   Usage:
     node tools/build-exam-logos.js
   ============================================================ */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const SRC_DIR = path.join(ROOT, "exam logo");
const OUT_DIR = path.join(ROOT, "images", "exams");
const SIZE = 512;
const MARGIN = 26;

/* Source file -> exam id. The ids match data/exams/index.json. */
const MAP = [
  ["assam oplice.jpg", "assam-police"],
  ["apsc.jpg", "apsc"],
  ["tet.png", "assam-tet"],
  ["dhs & dme.jpg", "dhs-dme"],
  ["GUWAHATI HIGH COURT.jpg", "guwahati-hc"],
  ["ssc.png", "ssc"],
  ["railway.png", "railway"],
];

function main() {
  const jobs = [];
  for (const [file, id] of MAP) {
    const src = path.join(SRC_DIR, file);
    if (!fs.existsSync(src)) {
      console.error(`missing source: ${file}`);
      process.exitCode = 1;
      continue;
    }
    jobs.push({ src, out: path.join(OUT_DIR, `${id}-logo.webp`) });
  }
  if (!jobs.length) return;

  const script = `
import sys
from PIL import Image, ImageChops

size = ${SIZE}
margin = ${MARGIN}
jobs = ${JSON.stringify(jobs)}

for job in jobs:
    im = Image.open(job["src"]).convert("RGBA")
    # Trim a uniform border (white or transparent) so the logo fills the tile.
    rgb = im.convert("RGB")
    bg = Image.new("RGB", im.size, rgb.getpixel((0, 0)))
    diff = ImageChops.difference(rgb, bg)
    bbox = diff.getbbox()
    if bbox:
        im = im.crop(bbox)
    inner = size - margin * 2
    im.thumbnail((inner, inner), Image.LANCZOS)
    canvas = Image.new("RGBA", (size, size), (255, 255, 255, 255))
    canvas.alpha_composite(im, ((size - im.width) // 2, (size - im.height) // 2))
    canvas.convert("RGB").save(job["out"], "WEBP", quality=88, method=6)
    print(f'{job["out"]}  {im.width}x{im.height} -> {size}x{size}')
`;
  const out = execFileSync("python3", ["-c", script], { encoding: "utf8" });
  process.stdout.write(out);
}

main();
