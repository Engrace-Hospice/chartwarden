# Operator authorization and audit

The recovery route composes `requirePermission("billing.rule_config.platform_admin")` and `requireStepUp(...)`. The service receives `request.context.userId` as actor identity; a username or actor UUID in the body cannot impersonate an operator. The service's authorization callback accepts only a platform operator with the exact permission marker and a UUID identity.

Request validation fixes account and environment to the central Claim.MD binding composed at boot. It accepts no organization/provider reassignment and rejects unsupported stages, malformed UUIDs, invalid reason codes, invalid version values and account/environment mismatch. Recovery result errors are translated to safe HTTP errors; raw database/vendor messages are not returned by this route.

The durable recovery history records action ID, actor, inbox/account/environment scope, stage, reason, expected/resulting state, prior retry count, retry eligibility, resolution/delivery versions, outcome and safe failure code. Source evidence and payload are not copied to the audit record. Valid rejected actions for a known scoped target are written using a separate audited transaction. Requests rejected before a valid target can be established are covered by the existing authenticated request/security audit mechanism.

This permission is intentionally platform-wide; it must be assigned only through the existing platform role governance. Ordinary tenant billing permissions do not authorize recovery. BIL-1.5B must verify the live permission resolver, step-up context, operational-role grants and central-table grants using a non-superuser application role.
