import { createFileRoute } from "@tanstack/react-router";
import { extractBearerToken, requireAuthAndBusiness } from "@/lib/billing.server";

const MAX_LOGO_BYTES = 2 * 1024 * 1024;
const JSON_HEADERS = { "Content-Type": "application/json", "Cache-Control": "no-store" };
const TYPES = {
  "image/png": { extension: "png", signature: [0x89, 0x50, 0x4e, 0x47] },
  "image/jpeg": { extension: "jpg", signature: [0xff, 0xd8, 0xff] },
  "image/webp": { extension: "webp", signature: [0x52, 0x49, 0x46, 0x46] },
} as const;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

export function validateBusinessLogo(input: { type: string; size: number; bytes: Uint8Array }) {
  const config = TYPES[input.type as keyof typeof TYPES];
  if (!config) return { ok: false as const, code: "logo_type_not_allowed" as const };
  if (input.size < 1 || input.size > MAX_LOGO_BYTES) {
    return { ok: false as const, code: "logo_size_not_allowed" as const };
  }
  const signatureMatches = config.signature.every((byte, index) => input.bytes[index] === byte);
  const webpMatches =
    input.type !== "image/webp" || String.fromCharCode(...input.bytes.slice(8, 12)) === "WEBP";
  if (!signatureMatches || !webpMatches) {
    return { ok: false as const, code: "logo_content_invalid" as const };
  }
  return { ok: true as const, extension: config.extension };
}

async function context(request: Request) {
  const token = extractBearerToken(request);
  if (!token) throw Object.assign(new Error("Unauthorized"), { status: 401 });
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const owner = await requireAuthAndBusiness(token, supabaseAdmin);
  return { supabaseAdmin, owner };
}

export const Route = createFileRoute("/api/public/business-logo")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          const { supabaseAdmin, owner } = await context(request);
          const { data, error } = await supabaseAdmin
            .from("businesses")
            .select("private_logo_path")
            .eq("id", owner.businessId)
            .maybeSingle();
          if (error) return json({ error: "Logo lookup failed", code: "logo_lookup_failed" }, 500);
          const path = (data as { private_logo_path?: string | null } | null)?.private_logo_path;
          if (!path) return json({ url: null });
          const signed = await supabaseAdmin.storage
            .from("business-logos")
            .createSignedUrl(path, 900);
          if (signed.error)
            return json({ error: "Logo preview failed", code: "logo_preview_failed" }, 500);
          return json({ url: signed.data.signedUrl });
        } catch (error) {
          return json(
            { error: "Unauthorized", code: "unauthorized" },
            (error as { status?: number }).status ?? 401,
          );
        }
      },
      POST: async ({ request }) => {
        try {
          const { supabaseAdmin, owner } = await context(request);
          const form = await request.formData();
          const file = form.get("logo");
          if (!(file instanceof File))
            return json({ error: "Choose a logo file", code: "logo_missing" }, 400);
          const bytes = new Uint8Array(await file.arrayBuffer());
          const validation = validateBusinessLogo({ type: file.type, size: file.size, bytes });
          if (!validation.ok)
            return json(
              { error: "Use a PNG, JPEG or WebP logo up to 2 MB.", code: validation.code },
              400,
            );

          const { data: current, error: lookupError } = await supabaseAdmin
            .from("businesses")
            .select("private_logo_path")
            .eq("id", owner.businessId)
            .maybeSingle();
          if (lookupError)
            return json({ error: "Logo lookup failed", code: "logo_lookup_failed" }, 500);
          const path = `${owner.businessId}/${crypto.randomUUID()}.${validation.extension}`;
          const uploaded = await supabaseAdmin.storage.from("business-logos").upload(path, bytes, {
            contentType: file.type,
            upsert: false,
            cacheControl: "3600",
          });
          if (uploaded.error)
            return json({ error: "Logo upload failed", code: "logo_upload_failed" }, 500);
          const updated = await supabaseAdmin
            .from("businesses")
            .update({ private_logo_path: path } as never)
            .eq("id", owner.businessId);
          if (updated.error) {
            await supabaseAdmin.storage.from("business-logos").remove([path]);
            return json({ error: "Logo could not be saved", code: "logo_persistence_failed" }, 500);
          }
          const previous = (current as { private_logo_path?: string | null } | null)
            ?.private_logo_path;
          if (previous && previous.startsWith(`${owner.businessId}/`) && previous !== path) {
            await supabaseAdmin.storage.from("business-logos").remove([previous]);
          }
          return json({ saved: true });
        } catch (error) {
          return json(
            { error: "Unauthorized", code: "unauthorized" },
            (error as { status?: number }).status ?? 401,
          );
        }
      },
      DELETE: async ({ request }) => {
        try {
          const { supabaseAdmin, owner } = await context(request);
          const { data } = await supabaseAdmin
            .from("businesses")
            .select("private_logo_path")
            .eq("id", owner.businessId)
            .maybeSingle();
          const path = (data as { private_logo_path?: string | null } | null)?.private_logo_path;
          await supabaseAdmin
            .from("businesses")
            .update({ private_logo_path: null } as never)
            .eq("id", owner.businessId);
          if (path?.startsWith(`${owner.businessId}/`))
            await supabaseAdmin.storage.from("business-logos").remove([path]);
          return json({ removed: true });
        } catch (error) {
          return json(
            { error: "Unauthorized", code: "unauthorized" },
            (error as { status?: number }).status ?? 401,
          );
        }
      },
    },
  },
});
