import { describe, expect, it } from "vitest";
import { M26_WORKER_SYSTEM_USER_ID, orgContextFor } from "../system-actor";

const ORG = "11111111-1111-1111-1111-111111111111";
const USER = "33333333-3333-3333-3333-333333333333";

describe("M26 orgContextFor — the cron sentinel never reaches app.user_id", () => {
  it("maps the cron sentinel to the NULL (system) audit actor", () => {
    expect(orgContextFor({ organizationId: ORG, userId: M26_WORKER_SYSTEM_USER_ID })).toEqual({
      organizationId: ORG,
      userId: "",
      systemActor: true,
    });
  });

  it("keeps a real acting user as-is (and drops the route actor's extra fields)", () => {
    expect(
      orgContextFor({ organizationId: ORG, userId: USER, roles: [], stepUpRecent: true } as never),
    ).toEqual({ organizationId: ORG, userId: USER });
  });
});
