// POST /api/v1/public/tenant-invitations/:tokenHash/accept — the first-admin acceptance response carries the invited
// address so the web accept page can send the password-reset email without asking the admin to retype it.
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import {
  type SignupIntentRouteService,
  registerPublicSignupRoutes,
} from "../routes/public/signup-intents";

const TOKEN = "a".repeat(43);

function serviceAccepting(email: string): {
  service: SignupIntentRouteService;
  acceptInvitation: ReturnType<typeof vi.fn>;
} {
  const acceptInvitation = vi.fn(async () => ({ accepted: true as const, email }));
  const service = {
    createIntent: vi.fn(),
    verifyEmail: vi.fn(),
    acceptInvitation,
  } as unknown as SignupIntentRouteService;
  return { service, acceptInvitation };
}

describe("tenant invitation accept route", () => {
  it("returns the service's acceptance with the invited email", async () => {
    const { service, acceptInvitation } = serviceAccepting("admin@sunrise.test");
    const app = Fastify();
    registerPublicSignupRoutes(app, { service });

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/public/tenant-invitations/${TOKEN}/accept`,
      payload: { displayName: "Sunrise Admin" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ accepted: true, email: "admin@sunrise.test" });
    expect(acceptInvitation).toHaveBeenCalledWith(TOKEN, { displayName: "Sunrise Admin" });
    await app.close();
  });
});
