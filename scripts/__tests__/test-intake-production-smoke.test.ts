import { describe, expect, it } from "vitest";
import {
  INTAKE_SMOKE_PROJECT_PREFIX,
  assertLocalDockerEndpoint,
  assertSafeIntakeSmokeProject,
  isolatedComposeEnvironment,
} from "../test-intake-production-smoke";

describe("intake production-like smoke isolation", () => {
  it("accepts only generated isolated project names", () => {
    expect(() =>
      assertSafeIntakeSmokeProject(`${INTAKE_SMOKE_PROJECT_PREFIX}${"a".repeat(12)}`),
    ).not.toThrow();
    for (const unsafe of [
      "chartwarden",
      "cw-intake-oa-smoke-",
      "cw-intake-oa-smoke-../../x",
      "production",
    ]) {
      expect(() => assertSafeIntakeSmokeProject(unsafe)).toThrow(/refusing non-isolated/);
    }
  });

  it("refuses remote Docker daemons", () => {
    expect(() => assertLocalDockerEndpoint("unix:///var/run/docker.sock")).not.toThrow();
    expect(() => assertLocalDockerEndpoint("tcp://127.0.0.1:2375")).not.toThrow();
    expect(() => assertLocalDockerEndpoint("ssh://shared.example.test")).toThrow(/non-local/);
    expect(() => assertLocalDockerEndpoint("tcp://10.0.0.12:2375")).toThrow(/non-local/);
  });

  it("strips inherited credentials and disables external adapters", () => {
    const env = isolatedComposeEnvironment({
      PATH: "/synthetic/bin",
      DOCKER_HOST: "unix:///var/run/docker.sock",
      POSTMARK_SERVER_TOKEN: "must-not-survive",
      TWILIO_AUTH_TOKEN: "must-not-survive",
      AWS_SECRET_ACCESS_KEY: "must-not-survive",
    });
    expect(env.PATH).toBe("/synthetic/bin");
    expect(env.DOCKER_HOST).toBe("unix:///var/run/docker.sock");
    expect(env.POSTMARK_SERVER_TOKEN).toBe("");
    expect(env.TWILIO_AUTH_TOKEN).toBe("");
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.M24_LAUNCH_GATEWAY_ENABLED).toBe("false");
  });
});
