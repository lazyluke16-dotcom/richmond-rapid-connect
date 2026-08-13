import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  buildSmartAnswerCaptureTool,
  buildSmartAnswerPrompt,
  smartAnswerStructuredDataSchema,
} from "@/lib/smart-answer-prompt";

function smartAnswerWebhookUrl(): string {
  const base = (process.env.PUBLIC_JOB_REQUEST_URL ?? "").replace(/\/+$/, "");
  if (!base) throw new Error("PUBLIC_JOB_REQUEST_URL is required");
  return `${base}/api/public/webhooks/vapi-smart-answer`;
}

export const provisionMySmartAnswerStack = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data: businessIdRaw, error: ownerError } = await context.supabase.rpc(
      "call_handling_admin_business" as never,
    );
    if (ownerError) throw new Error(ownerError.message);
    const businessId = String(businessIdRaw ?? "");
    if (!businessId) throw new Error("Owner or admin access is required");

    const { data: access, error: accessError } = await context.supabase.rpc(
      "has_ai_receptionist_access",
      { _business_id: businessId },
    );
    if (accessError) throw new Error(accessError.message);
    if (!access) throw new Error("AI Receptionist access is required");

    const username = process.env.VAPI_SIP_AUTH_USERNAME?.trim() ?? "";
    const password = process.env.VAPI_SIP_AUTH_PASSWORD?.trim() ?? "";
    if (!username || !password) {
      return {
        provisioned: false,
        reason: "Secure SIP credentials are not configured server-side",
        requiredSecrets: ["VAPI_SIP_AUTH_USERNAME", "VAPI_SIP_AUTH_PASSWORD"],
      };
    }

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: stackData, error: stackError } = await supabaseAdmin.rpc(
      "get_smart_answer_stack_provisioning" as never,
      { _business_id: businessId } as never,
    );
    if (stackError) throw new Error(stackError.message);
    const stack = (Array.isArray(stackData) ? stackData[0] : stackData) as
      | {
          business_name?: string;
          existing_assistant_id?: string | null;
          smart_assistant_id?: string | null;
          sip_phone_id?: string | null;
          sip_uri?: string | null;
        }
      | null
      | undefined;
    if (!stack?.existing_assistant_id) {
      throw new Error("Provision the standard Vapi receptionist before Smart Answer");
    }
    if (stack.smart_assistant_id && stack.sip_phone_id && stack.sip_uri) {
      return { provisioned: true, reused: true, sipUri: stack.sip_uri };
    }

    const [{ data: settings }, { data: services }, { data: areas }] = await Promise.all([
      supabaseAdmin
        .from("business_ai_receptionist_settings")
        .select(
          "assistant_name,first_message,tone,language,callback_message,pricing_response,human_request_response,emergency_response,recording_enabled,max_call_duration_seconds",
        )
        .eq("business_id", businessId)
        .maybeSingle(),
      supabaseAdmin
        .from("business_services")
        .select("display_name")
        .eq("business_id", businessId),
      supabaseAdmin
        .from("business_service_areas")
        .select("suburb")
        .eq("business_id", businessId),
    ]);
    if (!settings) throw new Error("AI receptionist settings are missing");
    const s = settings as unknown as {
      assistant_name: string;
      first_message: string;
      tone: string;
      language: string;
      callback_message: string;
      pricing_response: string;
      human_request_response: string;
      emergency_response: string;
      recording_enabled: boolean;
      max_call_duration_seconds: number;
    };

    const {
      createVapiAssistant,
      createVapiSipPhoneNumber,
      deleteVapiAssistant,
      deleteVapiPhoneNumber,
      resolveVapiServerCredentialId,
      vapiCredentialsAvailable,
      vapiSipHost,
    } = await import("@/lib/vapi.server");
    if (!vapiCredentialsAvailable()) {
      return {
        provisioned: false,
        reason: "VAPI_API_KEY not configured server-side",
        requiredSecrets: ["VAPI_API_KEY"],
      };
    }

    const serverUrl = smartAnswerWebhookUrl();
    const serverCredentialId = await resolveVapiServerCredentialId(
      serverUrl,
      stack.existing_assistant_id,
    );
    const prompt = buildSmartAnswerPrompt({
      businessName: stack.business_name ?? "the business",
      assistantName: s.assistant_name,
      language: s.language,
      tone: s.tone,
      firstMessage: s.first_message,
      services: ((services ?? []) as unknown as { display_name: string }[]).map(
        (row) => row.display_name,
      ),
      serviceAreas: ((areas ?? []) as unknown as { suburb: string }[]).map((row) => row.suburb),
      callbackMessage: s.callback_message,
      pricingResponse: s.pricing_response,
      humanRequestResponse: s.human_request_response,
      emergencyResponse: s.emergency_response,
    });
    const tool = buildSmartAnswerCaptureTool({ serverUrl, serverCredentialId });

    let assistantId = stack.smart_assistant_id ?? null;
    let assistantCreatedNow = false;
    if (!assistantId) {
      const assistant = await createVapiAssistant({
        name: `${stack.business_name ?? "Business"} Smart Answer`,
        firstMessage: s.first_message,
        systemPrompt: prompt,
        language: s.language,
        serverUrl,
        serverCredentialId,
        recordingEnabled: s.recording_enabled,
        maxDurationSeconds: s.max_call_duration_seconds,
        structuredDataSchema: smartAnswerStructuredDataSchema,
        summaryPrompt:
          "Summarise the call in 1-2 sentences. For plumbing enquiries capture the job and urgency; for other callers capture who called and the message.",
        tools: [tool],
        serverMessages: ["tool-calls"],
      });
      assistantId = assistant.id;
      assistantCreatedNow = true;
    }

    const sipUser = `smart-${crypto.randomUUID().replaceAll("-", "")}`;
    const expectedSipUri = `sip:${sipUser}@${vapiSipHost()}`;
    let sipPhoneId = stack.sip_phone_id ?? null;
    let sipUri = stack.sip_uri ?? null;
    let sipCreatedNow = false;
    try {
      if (!sipPhoneId || !sipUri) {
        const phone = await createVapiSipPhoneNumber({
          assistantId,
          sipUser,
          name: `${stack.business_name ?? "Business"} Smart Answer SIP`,
          username,
          password,
        });
        sipPhoneId = phone.id;
        sipUri = phone.sipUri ?? expectedSipUri;
        sipCreatedNow = true;
      }

      const { error: saveError } = await supabaseAdmin.rpc(
        "save_smart_answer_stack" as never,
        {
          _business_id: businessId,
          _assistant_id: assistantId,
          _sip_phone_id: sipPhoneId,
          _sip_uri: sipUri,
        } as never,
      );
      if (saveError) throw new Error(saveError.message);
    } catch (error) {
      if (sipCreatedNow && sipPhoneId) {
        try {
          await deleteVapiPhoneNumber(sipPhoneId);
        } catch (cleanupError) {
          console.error("[smart-answer] SIP cleanup failed", cleanupError);
        }
      }
      if (assistantCreatedNow && assistantId) {
        try {
          await deleteVapiAssistant(assistantId);
        } catch (cleanupError) {
          console.error("[smart-answer] assistant cleanup failed", cleanupError);
        }
      }
      throw error;
    }

    return { provisioned: true, reused: false, sipUri };
  });
