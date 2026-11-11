# Security and nonmutation

The three tables are FORCE-RLS protected for `chartwarden_app` by organization. Service SQL carries the authenticated organization predicate and server-derived provider scope. Detail and every mutation first resolve the source through M23/M41 owner readers; an inaccessible source/case returns not found. M41's owner read preserves caseload authorization. New permissions are cataloged separately and the migration grants none to a role.

The overlay stores only source identity, safe operational reason/time, assignment, bounded reviewer note, and append-only history. It does not store raw 837/835 content, central Claim.MD inbox rows, credentials, or financial values. Review operations have no calls to `receiveAdvice`, `postAdvice`, payment allocation, outbox publishing, claim balance updates, or source submission mutations. Production posting and automatic processing flags are unchanged.
