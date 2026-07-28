export interface CriticalAssetEvidence {
  path: string;
  bytes: number;
  width: number;
  height: number;
}

export interface CriticalAssetVerification {
  checkedRasterCount: number;
  criticalAssets: CriticalAssetEvidence[];
}

export const criticalAssets: Array<{
  path: string;
  format: "avif" | "jpeg" | "webp";
  width: number;
  height: number;
  minBytes: number;
  maxBytes: number;
}>;

export function inspectAsset(
  buffer: Buffer,
  format: "avif" | "jpeg" | "webp",
): { width: number; height: number };

export function verifyCriticalAssets(root?: string): Promise<CriticalAssetVerification>;
