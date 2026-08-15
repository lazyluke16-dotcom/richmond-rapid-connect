# Slice 2.5 — Live Discovery via Google Places API (New)

Tracking issue: [#25](https://github.com/lazyluke16-dotcom/richmond-rapid-connect/issues/25).
Branch: `feat/live-discovery-google-places-v1` (stacked on `feat/autonomous-discovery-v1`).

Connects the reviewed Slice-2 discovery engine to a lawful live provider (Google Places API
(New), Text Search) so an operator can discover real plumbers in a geography without
supplying the business list. **Zero outreach; stops at `DEMO_READY`.**

## Official sources consulted (at implementation time)

- Text Search (New) reference — request/pagination/field-mask:
  https://developers.google.com/maps/documentation/places/web-service/text-search
- Usage & billing (SKU tiers, field-mask → SKU):
  https://developers.google.com/maps/documentation/places/web-service/usage-and-billing
- Places API policies & attribution (caching/storage):
  https://developers.google.com/maps/documentation/places/web-service/policies
- Google Maps Platform Service Specific Terms (temporary-caching durations):
  https://cloud.google.com/maps-platform/terms/maps-service-terms

## Confirmed provider contract → design consequences

**Request.** `POST https://places.googleapis.com/v1/places:searchText`. Headers:
`Content-Type: application/json`, `X-Goog-Api-Key: <server key>`,
`X-Goog-FieldMask: <explicit paths>`. Body: `textQuery` (required), `pageSize` (1–20, default
20), `pageToken`, `locationBias`, `includedType`, `strictTypeFiltering`, `regionCode`,
`languageCode`. When paging, all params except `pageToken` must be identical or the API
returns `INVALID_ARGUMENT`.

**Field mask (production, no `*`).** We request the smallest mask needed to discover +
qualify + route to the website:

```
places.id,places.displayName,places.websiteUri,places.formattedAddress,
places.addressComponents,places.primaryType,places.types,nextPageToken
```

We deliberately do NOT request reviews, photos, ratings, opening hours or other atmosphere
fields. This mask lands in the **Text Search Pro** SKU (websiteUri/types are above IDs-Only).

**Pagination.** `nextPageToken`; max 60 results across all pages. We additionally enforce a
hard page cap (inherited from Slice-2), detect a repeated/cycling page token, and stop.

**Billing (why cost is an estimate).** Google bills the **highest SKU** in the field mask, at
region-specific unit prices, per request — the exact cents cannot be computed reliably from
local state. We therefore use a **conservative operator-set per-request estimate**
(`GOOGLE_PLACES_PER_REQUEST_CENTS`, default 4¢) purely to enforce the mission spend ceiling.
It is an internal safety estimate, NOT Google's actual invoice; the operator should set it
≥ their observed Text Search Pro unit price. Every metered request is counted and charged
against the ceiling under a single-flight lease (below), so the ceiling cannot be exceeded by
concurrent workers.

## Data retention (compliant by construction)

Per the policies + Service Specific Terms:

- **Place ID is exempt** and may be stored indefinitely → persisted as the durable
  `provider_business_id` and used for dedup.
- **Latitude/longitude may be cached ≤30 days** → we do **not request or store lat/long at
  all**, sidestepping the rule entirely.
- **Reviews/photos must not be pre-fetched/cached/stored** → never requested, never stored.
- Other Google-derived content (display name, formatted address, locality) is treated as
  **temporary cache**: each `google_places` candidate row records
  `provider_content_expires_at = retrieved_at + 30 days`. A purge helper
  (`purgeExpiredProviderContent`) nulls the Google-derived display fields after expiry,
  keeping only the durable Place ID + internal disposition + the business's own website URL.
- **Durable demo facts always come from the business's own website** through the reviewed
  Slice-1 SSRF-safe pipeline — Google content is never converted into permanent prospect
  facts.

Attribution: the discovery operator surface is internal (not an end-user product) and shows
minimal Google-derived text; it carries a "Business listings via Google Maps Platform" note.
No Google reviews/photos/map tiles are displayed.

## Concurrency-safe metered spend (independent-review prerequisite #1)

A **DB-backed single-flight mission lease** makes it impossible for concurrent workers to
bypass the spend ceiling. `advanceMission` acquires the lease via an atomic conditional
`UPDATE ... WHERE id = $id AND (lease_expires_at IS NULL OR lease_expires_at < now())` before
doing any work and releases it at the end; a worker that cannot acquire the lease returns
immediately (no double-advance). Because only one advance runs per mission at a time, the
cost read-modify-write and cursor updates can no longer race, and the ceiling is enforced
before and after every metered request.

## Vertical classification (prerequisite #2)

Live candidates are classified from Google **place types** (`primaryType`/`types`) by a
deterministic, explainable classifier, NOT the V1 keyword fallback:

- Accept only when a plumbing type (`plumber`) is present.
- Reject explicit non-plumber trade/retail/education/directory types (hardware store, home
  improvement store, wholesaler, school, etc.) even if the name contains "plumbing".

The provider stamps each candidate's `vertical` (`plumbing` / `plumbing_supply` /
`not_plumbing`) so the existing qualifier uses the provider classification, not keywords.

## Error handling

`400 INVALID_ARGUMENT`, `401`, `403 PERMISSION_DENIED` (restricted key), billing-disabled and
quota-exhausted are **terminal** (never retried). `429 RESOURCE_EXHAUSTED` (rate limit), `5xx`
and timeouts are **transient** (retried with the mission's backoff/retry cap). Malformed JSON
/ incomplete records are handled defensively (the record is skipped or the page treated as a
terminal parse error).

## Credential security

`GOOGLE_PLACES_API_KEY` is server-side only (never in the client bundle, never logged, never
returned by an operator API). The provider fails closed when it is absent. Use a dedicated,
API-restricted Places key.

## Live certification status

See the reliability/certification section of Issue #25. Live certification requires the
operator to configure `GOOGLE_PLACES_API_KEY` (billing-enabled, Places API (New) enabled,
restricted). Until then the adapter is fully certified against deterministic mocked responses
and **no live Google request is made**.
