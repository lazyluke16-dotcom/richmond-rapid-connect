import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const SUBJECT = "Confirm your Rapid Connect account";
const TEMPLATE_PATH = new URL("../supabase/templates/confirmation.html", import.meta.url);

function required(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function managementRequest(url, token, init = {}) {
  const attempts = 3;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...init.headers,
      },
    });
    const body = await response.json().catch(() => ({}));
    if (response.ok) return body;

    const safeDetail = [body?.code, body?.message, body?.error]
      .find((value) => typeof value === "string")
      ?.replace(/[\r\n]+/g, " ")
      .slice(0, 240);
    const retryable = response.status === 429 || response.status >= 500;
    if (retryable && attempt < attempts) {
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
      continue;
    }
    const error = new Error(
      `Supabase Auth configuration returned HTTP ${response.status}${safeDetail ? `: ${safeDetail}` : ""}`,
    );
    error.status = response.status;
    error.safeDetail = safeDetail ?? "";
    throw error;
  }
  throw new Error("Supabase Auth configuration retry loop ended unexpectedly");
}

export async function configureStagingAuthEmail(env = process.env) {
  assert(env.DEPLOYMENT_TARGET === "staging", "Auth email configuration is staging-only");
  const projectRef = required(env, "STAGING_SUPABASE_PROJECT_REF");
  const stagingUrl = new URL(required(env, "CERTIFICATION_BASE_URL"));
  assert(stagingUrl.protocol === "https:", "Staging Auth confirmation requires HTTPS");
  assert(stagingUrl.hostname.includes("staging"), "Refusing a non-staging confirmation origin");
  const token = required(env, "SUPABASE_ACCESS_TOKEN");
  const template = await readFile(TEMPLATE_PATH, "utf8");
  for (const requiredCopy of ["Rapid Connect", "Confirm my email", "{{ .ConfirmationURL }}"]) {
    assert(template.includes(requiredCopy), `Confirmation template is missing: ${requiredCopy}`);
  }
  assert(
    /This inbox is not\s+monitored/.test(template),
    "Confirmation template must identify the unmonitored sender",
  );
  assert(!template.includes("Supabase Auth"), "Provider branding must not appear in the template");

  const endpoint = `https://api.supabase.com/v1/projects/${encodeURIComponent(projectRef)}/config/auth`;
  const before = await managementRequest(endpoint, token);
  const allowed = String(before.uri_allow_list ?? "");
  const siteUrl = String(before.site_url ?? "");
  assert(
    siteUrl.startsWith(stagingUrl.origin) || allowed.includes(stagingUrl.origin),
    "The isolated-staging confirmation origin is not in Supabase Auth redirect configuration",
  );

  try {
    await managementRequest(endpoint, token, {
      method: "PATCH",
      body: JSON.stringify({
        mailer_subjects_confirmation: SUBJECT,
        mailer_templates_confirmation_content: template,
      }),
    });
  } catch (error) {
    const defaultProviderBoundary =
      error?.status === 400 &&
      String(error?.safeDetail).includes(
        "Email template modification is not available for free tier projects using the default email provider",
      );
    if (!defaultProviderBoundary) throw error;

    // This is an explicit external configuration boundary, not a code-deployment
    // failure. Supabase requires a paid Auth plan or verified custom SMTP before it
    // will accept the repository-owned branded template. Continue deploying the
    // branded confirmation landing flow, but report that the hosted email remains
    // provider-branded until that boundary is completed.
    return {
      configured: false,
      projectVerified: true,
      subject: SUBJECT,
      providerBrandingAbsent: false,
      confirmationOriginAllowed: true,
      customSmtpConfigured: false,
      externalSenderConfigurationRequired: true,
      boundary: "supabase_default_email_provider",
    };
  }
  const after = await managementRequest(endpoint, token);
  assert(after.mailer_subjects_confirmation === SUBJECT, "Confirmation subject was not applied");
  assert(
    after.mailer_templates_confirmation_content === template,
    "Confirmation template was not applied exactly",
  );

  // Do not mutate sender/SMTP fields here. A Rapid Connect From identity requires
  // an externally verified domain and SMTP credentials.
  const customSmtpConfigured = Boolean(String(after.smtp_host ?? "").trim());
  return {
    configured: true,
    projectVerified: true,
    subject: SUBJECT,
    providerBrandingAbsent: true,
    confirmationOriginAllowed: true,
    customSmtpConfigured,
    externalSenderConfigurationRequired: !customSmtpConfigured,
  };
}

const isDirect = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirect) {
  configureStagingAuthEmail()
    .then((result) => {
      if (result.boundary) {
        process.stdout.write(
          `::warning title=Rapid Connect Auth email boundary::Supabase requires verified custom SMTP (or an eligible Auth plan) before the hosted confirmation template and sender can be branded.\n`,
        );
      }
      process.stdout.write(`${JSON.stringify(result)}\n`);
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
