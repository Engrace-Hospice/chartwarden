# Security and RLS

Migration 1396 creates the line evidence table with FORCE RLS, organization scoping, parent-evidence identity checks, an append-only trigger, and audit events. The application role has no UPDATE grant; a live test verifies update denial and tenant/provider scoping. Posting authorization and plan isolation remain unimplemented because no posting workflow exists.
