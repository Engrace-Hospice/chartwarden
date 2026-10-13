// WP 2.7b C2 (ADR-0058, Proposed) - the one BullMQ queue of the global search maintenance job. Declared HERE and nowhere
// else (`arch:queue-names`: a name declared by two owners shares one Redis queue). Deliberately NOT in MESSAGING_QUEUES.
export const GLOBAL_SEARCH_QUEUES = {
  maintenance: "messaging.search_maintenance",
} as const;

/** Every five minutes: purge requested rows, then reconcile enabled tenants (inert while every flag is off). */
export const GLOBAL_SEARCH_MAINTENANCE_PATTERN = "*/5 * * * *";
