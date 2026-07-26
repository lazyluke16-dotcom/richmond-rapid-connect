import { describe, expect, it, vi } from "vitest";
import { resolveOnboardingPhoneContinuity } from "../onboarding-validation";

describe("signup phone continuity", () => {
  it("uses valid same-tab session storage without loading auth metadata", async () => {
    const loadMetadata = vi.fn(async () => "+61499999999");
    await expect(
      resolveOnboardingPhoneContinuity({
        hasExistingBusiness: false,
        existingBusinessPhone: null,
        sessionPhone: "0412 345 678",
        loadAuthenticatedMetadataPhone: loadMetadata,
      }),
    ).resolves.toBe("+61412345678");
    expect(loadMetadata).not.toHaveBeenCalled();
  });

  it("recovers a validated phone from authenticated metadata in a new tab", async () => {
    const loadMetadata = vi.fn(async () => "+61 412 345 679");
    await expect(
      resolveOnboardingPhoneContinuity({
        hasExistingBusiness: false,
        existingBusinessPhone: null,
        sessionPhone: null,
        loadAuthenticatedMetadataPhone: loadMetadata,
      }),
    ).resolves.toBe("+61412345679");
    expect(loadMetadata).toHaveBeenCalledOnce();
  });

  it("ignores malformed storage and falls back to valid authenticated metadata", async () => {
    await expect(
      resolveOnboardingPhoneContinuity({
        hasExistingBusiness: false,
        existingBusinessPhone: null,
        sessionPhone: "attacker-controlled",
        loadAuthenticatedMetadataPhone: async () => "0412 345 680",
      }),
    ).resolves.toBe("+61412345680");
  });

  it.each([null, "", "not a phone", "+1 415 555 0100", { phone: "+61412345678" }])(
    "rejects malformed authenticated phone metadata: %j",
    async (metadata) => {
      await expect(
        resolveOnboardingPhoneContinuity({
          hasExistingBusiness: false,
          existingBusinessPhone: null,
          sessionPhone: null,
          loadAuthenticatedMetadataPhone: async () => metadata,
        }),
      ).resolves.toBeNull();
    },
  );

  it("keeps the tenant-scoped business phone authoritative on resume", async () => {
    const loadMetadata = vi.fn(async () => "+61499999999");
    await expect(
      resolveOnboardingPhoneContinuity({
        hasExistingBusiness: true,
        existingBusinessPhone: "+61390000123",
        sessionPhone: "+61488888888",
        loadAuthenticatedMetadataPhone: loadMetadata,
      }),
    ).resolves.toBe("+61390000123");
    expect(loadMetadata).not.toHaveBeenCalled();
  });
});
