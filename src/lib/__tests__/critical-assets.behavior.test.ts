import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyCriticalAssets } from "../../../scripts/verify-critical-assets.mjs";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("critical visual asset integrity", () => {
  it("decodes every committed responsive hero format and validates its dimensions", async () => {
    const result = await verifyCriticalAssets(resolve("."));

    expect(result.checkedRasterCount).toBe(6);
    expect(result.criticalAssets).toHaveLength(6);
    expect(result.criticalAssets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "src/assets/hero-plumber.avif", width: 1600, height: 900 }),
        expect.objectContaining({
          path: "src/assets/hero-plumber-mobile.webp",
          width: 900,
          height: 1350,
        }),
      ]),
    );
  });

  it("fails when any raster asset in the critical directory is empty", async () => {
    const root = await mkdtemp(join(tmpdir(), "rrc-critical-assets-"));
    temporaryRoots.push(root);
    const assets = join(root, "src", "assets");
    await mkdir(assets, { recursive: true });
    await cp(resolve("src/assets"), assets, { recursive: true });
    await writeFile(join(assets, "empty-critical-visual.png"), Buffer.alloc(0));

    await expect(verifyCriticalAssets(root)).rejects.toThrow("empty-critical-visual.png is empty");
  });
});
