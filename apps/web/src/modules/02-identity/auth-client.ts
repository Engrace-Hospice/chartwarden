// apps/web/src/modules/02-identity — shared Better Auth client for the M2 auth screens (AUTH-T07/ADR-0034).
// One instance: sign-in and the MFA challenge share it (Better Auth carries the challenge state in cookies).
import { createWardenxAuthClient } from "@wardenx/auth/client";

export const authClient = createWardenxAuthClient();
