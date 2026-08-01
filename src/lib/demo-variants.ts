export const DEMO_VARIANTS = ["demo-original", "demo-real-world-v2"] as const;
export type DemoVariant = (typeof DEMO_VARIANTS)[number];

export const DEFAULT_DEMO_VARIANT: DemoVariant = "demo-real-world-v2";

export function resolveDemoVariant(value: unknown): DemoVariant {
  return DEMO_VARIANTS.includes(value as DemoVariant)
    ? (value as DemoVariant)
    : DEFAULT_DEMO_VARIANT;
}

export const DEMO_VARIANT_STORAGE = {
  "demo-original": "src/components/acquisition/DemoCommercial.tsx",
  "demo-real-world-v2": "src/components/acquisition/DemoRealWorldV2.tsx",
} as const;
