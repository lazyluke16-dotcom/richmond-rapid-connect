import { readFile, readdir, stat } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const RASTER_EXTENSIONS = new Set([".avif", ".gif", ".jpeg", ".jpg", ".png", ".webp"]);

export const criticalAssets = [
  {
    path: "src/assets/hero-plumber.avif",
    format: "avif",
    width: 1600,
    height: 900,
    minBytes: 20_000,
    maxBytes: 250_000,
  },
  {
    path: "src/assets/hero-plumber.webp",
    format: "webp",
    width: 1600,
    height: 900,
    minBytes: 20_000,
    maxBytes: 250_000,
  },
  {
    path: "src/assets/hero-plumber.jpg",
    format: "jpeg",
    width: 1600,
    height: 900,
    minBytes: 20_000,
    maxBytes: 250_000,
  },
  {
    path: "src/assets/hero-plumber-mobile.avif",
    format: "avif",
    width: 900,
    height: 1350,
    minBytes: 20_000,
    maxBytes: 250_000,
  },
  {
    path: "src/assets/hero-plumber-mobile.webp",
    format: "webp",
    width: 900,
    height: 1350,
    minBytes: 20_000,
    maxBytes: 250_000,
  },
  {
    path: "src/assets/hero-plumber-mobile.jpg",
    format: "jpeg",
    width: 900,
    height: 1350,
    minBytes: 20_000,
    maxBytes: 250_000,
  },
];

function jpegDimensions(buffer) {
  if (buffer[0] !== 0xff || buffer[1] !== 0xd8) throw new Error("invalid JPEG signature");
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      offset += 2;
      continue;
    }
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2 || offset + length + 2 > buffer.length) {
      throw new Error("invalid JPEG segment length");
    }
    if (
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)
    ) {
      return {
        width: buffer.readUInt16BE(offset + 7),
        height: buffer.readUInt16BE(offset + 5),
      };
    }
    offset += length + 2;
  }
  throw new Error("JPEG dimensions not found");
}

function readUInt24LE(buffer, offset) {
  return buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16);
}

function webpDimensions(buffer) {
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WEBP") {
    throw new Error("invalid WebP signature");
  }
  const chunk = buffer.toString("ascii", 12, 16);
  if (chunk === "VP8X") {
    return {
      width: readUInt24LE(buffer, 24) + 1,
      height: readUInt24LE(buffer, 27) + 1,
    };
  }
  if (chunk === "VP8 ") {
    if (buffer.toString("hex", 23, 26) !== "9d012a") throw new Error("invalid VP8 frame");
    return {
      width: buffer.readUInt16LE(26) & 0x3fff,
      height: buffer.readUInt16LE(28) & 0x3fff,
    };
  }
  if (chunk === "VP8L") {
    if (buffer[20] !== 0x2f) throw new Error("invalid VP8L frame");
    const bits = buffer.readUInt32LE(21);
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1,
    };
  }
  throw new Error(`unsupported WebP chunk ${chunk}`);
}

function avifDimensions(buffer) {
  if (buffer.toString("ascii", 4, 8) !== "ftyp") throw new Error("invalid AVIF container");
  const brands = buffer.toString("ascii", 8, Math.min(buffer.length, 64));
  if (!brands.includes("avif") && !brands.includes("avis")) throw new Error("missing AVIF brand");
  const marker = buffer.indexOf(Buffer.from("ispe"));
  if (marker < 4 || marker + 16 > buffer.length) throw new Error("AVIF dimensions not found");
  return {
    width: buffer.readUInt32BE(marker + 8),
    height: buffer.readUInt32BE(marker + 12),
  };
}

export function inspectAsset(buffer, format) {
  if (format === "jpeg") return jpegDimensions(buffer);
  if (format === "webp") return webpDimensions(buffer);
  if (format === "avif") return avifDimensions(buffer);
  throw new Error(`unsupported critical asset format ${format}`);
}

async function findRasterAssets(directory) {
  const paths = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...(await findRasterAssets(path)));
    else if (RASTER_EXTENSIONS.has(extname(entry.name).toLowerCase())) paths.push(path);
  }
  return paths;
}

export async function verifyCriticalAssets(root = process.cwd()) {
  const assetDirectory = resolve(root, "src/assets");
  const rasterAssets = await findRasterAssets(assetDirectory);
  for (const path of rasterAssets) {
    if ((await stat(path)).size === 0) {
      throw new Error(`${path.slice(root.length + 1)} is empty`);
    }
  }

  const evidence = [];
  for (const asset of criticalAssets) {
    const absolute = resolve(root, asset.path);
    const buffer = await readFile(absolute);
    if (buffer.length < asset.minBytes || buffer.length > asset.maxBytes) {
      throw new Error(
        `${asset.path} has ${buffer.length} bytes; expected ${asset.minBytes}-${asset.maxBytes}`,
      );
    }
    const dimensions = inspectAsset(buffer, asset.format);
    if (dimensions.width !== asset.width || dimensions.height !== asset.height) {
      throw new Error(
        `${asset.path} is ${dimensions.width}x${dimensions.height}; expected ${asset.width}x${asset.height}`,
      );
    }
    evidence.push({ path: asset.path, bytes: buffer.length, ...dimensions });
  }
  return { checkedRasterCount: rasterAssets.length, criticalAssets: evidence };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  verifyCriticalAssets()
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
