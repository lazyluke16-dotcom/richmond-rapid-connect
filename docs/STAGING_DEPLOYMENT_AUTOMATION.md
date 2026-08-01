# Isolated staging deployment automation

Status: source-controlled and locally testable. No hosted service is changed until an authorized operator manually dispatches the workflow with a complete `staging` GitHub Environment.

## Rapid Connect Auth email

The reviewed signup email is stored at `supabase/templates/confirmation.html`. The guarded
isolated-staging deployment applies its subject and HTML body to the hosted staging Supabase
project through `scripts/configure-staging-auth-email.mjs`; it never changes SMTP credentials or
sender fields. Signup confirmation returns to `/auth/confirm`, which supports Supabase token-hash,
PKCE code and implicit-session responses, removes one-time tokens from the URL, verifies the user,
and then resumes the tenant-owned acquisition payment stage.

The active subject is `Confirm your Rapid Connect account`. A fully Rapid Connect-branded From
identity remains an external mail-delivery configuration: in Supabase Dashboard → Project Settings
→ Authentication → SMTP Settings, enable Custom SMTP only after a mail provider has verified the
chosen Rapid Connect domain. Use sender name `Rapid Connect` and a verified non-reply address such
as `no-reply@<verified Rapid Connect domain>`. Required provider values are host, port, username and
password; SPF/DKIM records supplied by that provider must be published, and DMARC should remain
aligned. Do not use an unverified From address. Disable provider click tracking for Auth links.

The deployment reports only whether custom SMTP is configured; it never prints sender addresses,
SMTP credentials, confirmation tokens or customer data.

## What the workflow does

`.github/workflows/staging-deployment.yml` accepts an exact 40-character release SHA and performs one serialized staging deployment:

1. checks out that immutable commit;
2. verifies it is an ancestor of `feat/customer-call-handling-reconstructed`;
3. verifies all frozen migration hashes;
4. runs the complete tests, TypeScript and production dependency gate;
5. builds the Cloudflare artifact with staging client configuration;
6. links only the declared staging Supabase project;
7. runs `supabase db push --dry-run` before any database mutation;
8. applies the frozen additive migrations only when the explicit boolean gate remains enabled;
9. deploys only a Worker whose name contains `staging` and contains no production-like token;
10. checks `/api/public/staging-release` for the exact environment ID and release SHA; and
11. retains a non-secret evidence artifact for 30 days.

The workflow is manual-only. It is not triggered by a push, pull request, schedule, or merge.

## GitHub Environment contract

Create one GitHub Environment named exactly `staging`. The deployment workflow reads the following non-secret environment variables:

- `CERTIFICATION_BASE_URL` — HTTPS origin with a hostname containing `staging`;
- `CERTIFICATION_STAGING_HOSTNAME` — exact hostname from that origin;
- `CLOUDFLARE_STAGING_WORKER_NAME` — lowercase Worker name containing `staging`;
- `STAGING_SUPABASE_PROJECT_REF` — dedicated, non-production project reference; and
- `STAGING_SUPABASE_URL` — `https://<project-ref>.supabase.co`.

The Environment must contain these encrypted secrets:

- Cloudflare: `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`;
- Supabase deployment: `SUPABASE_ACCESS_TOKEN`, `STAGING_SUPABASE_DB_PASSWORD`;
- Supabase runtime: `STAGING_SUPABASE_SERVICE_ROLE_KEY`, `STAGING_SUPABASE_PUBLISHABLE_KEY`;
- Twilio: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`;
- Vapi: `VAPI_API_KEY`, `VAPI_SERVER_SECRET`;
- Stripe test mode: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_SMS_GST_TAX_RATE_ID`, `STRIPE_GST_INCLUSIVE_TAX_RATE_ID`, `STRIPE_PRICE_MCR_BASE`, `STRIPE_PRICE_AIR_BASE`, `STRIPE_PRICE_AIR_USAGE`, `STRIPE_COUPON_UNION_FIRST_PLATFORM_FEE`, `STRIPE_COUPON_FOUNDING_THREE_MONTH_PLATFORM_FEES`;
- application controls: `SMS_INVOICE_PROCESSOR_KEY`, `WEBHOOK_SECRET`, `DASHBOARD_PIN`.

The preflight checks presence without printing values. It also rejects a non-test Stripe key, a short invoice processor key, inconsistent URLs, mismatched Supabase references, production-like identifiers, an unqualified Worker name, or a release that is not an exact SHA.

Cloudflare runtime secrets remain GitHub Environment secrets and are passed by
name through the Cloudflare action's encrypted-secret channel. The workflow
does not put secret values in command arguments or create a plaintext secrets
file. Supabase deployment authentication likewise uses the CLI's documented
environment variables rather than password arguments.

## Dispatch contract

Run `Deploy isolated staging` from the feature branch and supply:

- `release_sha`: the exact certified SHA;
- `environment_id`: the exact ID beginning `staging-` or `staging_`;
- `apply_migrations`: `true`; and
- `confirmation`: `DEPLOY_STAGING_ONLY`.

Selecting `false` for migrations performs the migration dry run and then deliberately fails before Worker deployment. This makes the dry-run path useful without allowing an application/schema mismatch.

The guarded workflow verifies the three application Prices and two Australian GST paths in the
same Stripe TEST account. With an explicitly supplied one-time staging configuration token, it may
set an `unspecified` application Price to `inclusive`, create or reuse the tagged 10% inclusive AU
Tax Rate, attach that rate to matching TEST subscriptions without proration, and save only its ID
as `STRIPE_GST_INCLUSIVE_TAX_RATE_ID`. It refuses live keys and Prices already locked as exclusive.
The separate `STRIPE_SMS_GST_TAX_RATE_ID` remains the 10% exclusive rate used only by SMS draft
invoices. The deployment does not send an SMS, finalize an invoice, charge a customer, create a
live resource, or modify production configuration.

The deployed Worker explicitly receives `CERTIFICATION_TARGET=staging`; the
guarded invoice route remains unavailable if this or any other staging-only
execution control is absent.

## Release identity

`GET /api/public/staging-release` exists only when all of these are true:

- `DEPLOYMENT_TARGET=staging`;
- `STAGING_CERTIFICATION_ENABLED=true`;
- the environment ID is an explicit non-production staging ID; and
- `DEPLOYED_RELEASE_SHA` is an exact Git commit SHA.

The endpoint returns only target, environment ID and release SHA with `cache-control: no-store`. It returns 404 when the staging identity is incomplete or production-like.

## Rollback

`.github/workflows/staging-rollback.yml` restores one exact Cloudflare Worker version after validating:

- `ROLLBACK_STAGING_ONLY`;
- the staging environment ID;
- the staging Worker name;
- a Cloudflare version UUID; and
- the expected release SHA reported by the restored Worker.

The workflow then verifies the restored release identity. It does not reverse Supabase migrations. The release migrations are additive, and database rollback remains a separately reviewed recovery operation because destructive remote schema rollback is intentionally not automated.

## Evidence boundary

Successful deployment evidence contains only:

- exact release SHA;
- exact staging environment ID;
- staging target;
- verification timestamp;
- Nitro preset and compatibility date; and
- a digest of the generated non-secret deployment metadata.

Credentials, provider payloads, database rows, phone numbers and customer information are never written to the evidence artifact.
