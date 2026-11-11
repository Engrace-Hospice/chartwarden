# Frontend accessibility and responsive behavior

The mobile worklist exposes source, status, reference, payer, reason/context, semantically labeled amount, timestamp and the existing detail link without requiring a horizontally scrolled table. Filters keep explicit labels. The in-doubt explanation distinguishes uncertainty from rejection and offers no business mutation.

DOM tests cover the rendered mobile-card content and safe in-doubt messaging. A real-browser viewport, keyboard/focus, screen-reader, and responsive visual run was not executed; CSS behavior is build/lint checked only.
