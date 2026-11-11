# Remaining limitations

- M24 and M25 in-doubt/exception records are not openable as investigations until their source owners expose a safe read contract.
- The live integration added here exercises M41 source ownership plus M25 FORCE-RLS persistence. It does not certify deployment IdP/session behavior; the live suite uses the repository's authenticated test transport and authorization resolver.
- Permission catalog entries are not automatically granted. Tenant role assignment remains an explicit administrative policy decision.
- Investigation list totals are not exact queue counts; the API labels the page count as a lower bound.
- Source status is revalidated against current `in_doubt` state. Once the source owner changes that state, source detail may no longer be available through this overlay; the investigation history remains tenant/provider scoped.
