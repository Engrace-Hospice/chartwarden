// M36 ADR-0083 (PROPOSED), slice G1 - the audited, time-limited, one-thread read grant. Constants only; nothing reads them until G2.

/** Tenant flag (absent = off). Off is the uniform 404 and the built interim skip (ADR-0070 limit (i)). */
export const THREAD_ACCESS_GRANT_FLAG_KEY = "messaging.thread_access_grant";

/** Why the system issued the grant (migration 1132 CHECK `message_thread_grant_reason`). */
export const THREAD_ACCESS_GRANT_REASONS = ["escalated", "reassigned", "oncall_role_send"] as const;
export type ThreadAccessGrantReason = (typeof THREAD_ACCESS_GRANT_REASONS)[number];
