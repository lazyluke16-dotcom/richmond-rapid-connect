import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendSms } from "../sms";

const insert = vi.fn(async (_row: Record<string, unknown>) => ({ error: null }));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: () => ({ insert }),
  },
}));

describe("Twilio production-mode isolation", () => {
  beforeEach(() => {
    process.env.SMS_MODE = "twilio";
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
    delete process.env.TWILIO_FROM_NUMBER;
    insert.mockClear();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    delete process.env.SMS_MODE;
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
    delete process.env.TWILIO_FROM_NUMBER;
    vi.restoreAllMocks();
  });

  it("fails closed instead of falling back to a simulated SMS", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const result = await sendSms("+61400000000", "Synthetic test", "business-test");

    expect(result).toMatchObject({
      status: "failed",
      mode: "twilio",
      errorMessage: "Twilio production configuration is incomplete",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(insert).toHaveBeenCalledOnce();
    expect(insert.mock.calls[0]?.[0]).toMatchObject({
      mode: "twilio",
      status: "failed",
    });
  });
});
