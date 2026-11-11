# API and frontend

The existing posting-plan response is extended additively: each adjustment exposes source group/CARC/amount, reported-responsibility category, accounting disposition, policy version (null until a policy contract exists), and M25 action. OpenAPI and the generated client were regenerated from TypeBox; no handwritten client schema or new route was added.

The existing ERA review plan table now distinguishes CO provider responsibility, PR patient-reported amount and PI payer reduction from accounting authorization. CO explains that policy is required and no write-off is authorized. Existing approval/execution controls remain subject to server-derived eligibility; blocked plans cannot be approved or executed.
