// apps/admin/src/shell — Better Auth client for the console's login screen. Ported from
// apps/web/src/modules/02-identity/auth-client.ts (same package, same session-cookie model — the
// admin console shares the platform's one Better Auth session across apps on localhost).
import { createChartWardenAuthClient } from "@wardenx/auth/client";

export const authClient = createChartWardenAuthClient();
