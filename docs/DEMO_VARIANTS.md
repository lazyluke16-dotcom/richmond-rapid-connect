# Acquisition demo variants

The acquisition page displays one demo at a time. Both variants remain committed and addressable:

| Stable ID            | Source                                           | Purpose                                                                                                                              |
| -------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `demo-original`      | `src/components/acquisition/DemoCommercial.tsx`  | Preserved original 58-second animated commercial and rollback/comparison candidate.                                                  |
| `demo-real-world-v2` | `src/components/acquisition/DemoRealWorldV2.tsx` | Staging candidate with separate Missed-Call Recovery and AI Receptionist reconstructions, service controls, captions and transcript. |

`DemoExperience.tsx` is the single player switch. The active version is selected by, in order:

1. a validated `?demo=demo-original` or `?demo=demo-real-world-v2` staging/test query;
2. `VITE_ACQUISITION_DEMO_VARIANT`; or
3. the default `demo-real-world-v2`.

Visitors never see both variants at once. The original source was not deleted, renamed, overwritten or re-encoded. Its existing component URL references remain build-compatible.

Start, 25%, 50%, 75%, completion and close events include the stable `demo_variant` value. Service-card, signup and checkout events use the same session/attribution convention and contain no names, email addresses, phone numbers, job text or other personal content. Subscription completion remains authoritative from the verified Stripe/webhook event, not browser state.

The v2 candidate is an interface-led simulated reconstruction, not mastered real-world footage. The repository still requires the separately approved production assets listed in `COMMERCIAL_PRODUCTION_PACKAGE.md`—plumber/customer footage, device captures, voice-over, music/effects stems, mastered 16:9/9:16/1:1 files and SRT—before it can be described as a finished live-action video.
