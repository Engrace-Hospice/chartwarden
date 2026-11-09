# Frontend confirmation

The M23 editor retains the opaque token only in component state, renders service-line and diagnosis summaries, exposes refresh, disables submit without an unexpired eligible token, and sends token plus `ifVersion` with the existing `If-Match`. A `CLAIM_PREVIEW_STALE` response clears confirmation and tells the user to refresh/review. A 15-second UI clock refreshes expiry state. No raw X12, MBI, TIN or source fingerprint is displayed.

The editor still uses its pre-existing local narrowed API wrapper/cast for the generated client call because the monorepo OpenAPI generic type depth issue remains. This phase does not add a broad generated-client type workaround. Focused component-level React tests remain a gap; backend token/route and preview UI source checks are documented separately.
