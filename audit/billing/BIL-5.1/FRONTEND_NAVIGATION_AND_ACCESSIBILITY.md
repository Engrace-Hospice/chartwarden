# Frontend navigation and accessibility

`Billing Operations` is registered with the M23 Billing screen registry at `/billing/operations`; the existing Billing tabs expose it beside the legacy all-work queue. M25 ERA links carry a stage query parameter and the review page loads a detail only after matching the stage against the caller's authorized list, then revalidates detail and matching through existing endpoints. M23, M24 and M41 links open their existing claim detail routes.

Controls have accessible labels for provider entity, location, source and ERA filters. Status and source text accompany colors; unavailable sources use an explicit message; loading and empty states are rendered. Provider switching invalidates old requests using a sequence guard so a slower previous scope cannot overwrite the current one. No posting or approval button is present.

DOM tests exercise all four owner sources, scope propagation, location option narrowing, navigation, denied-source presentation and absence of write calls. Dedicated narrow-screen card layout and broader keyboard/browser accessibility automation remain follow-up work.
