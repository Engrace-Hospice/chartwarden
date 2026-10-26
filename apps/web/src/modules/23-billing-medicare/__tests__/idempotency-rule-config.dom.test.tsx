import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
// #821: the rule-config overlay writes (save, revert, add custom) keep their Idempotency-Key only after a thrown fetch.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { SessionProvider } from "../../../shell/session";
import { RuleConfigEditor } from "../rule-config";
import { type Script, scriptedFetch } from "./idempotency-test-utils";

const RULE = {
  ruleConfigId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  ruleKey: "tenant.claim.line_count_ceiling",
  ruleVersion: 1,
  isCustom: true,
  enabled: true,
  severity: "warn",
  overrideRoleRequired: null,
  parameters: { max: 5 },
  regulatoryRequiredSnapshot: false,
  predicateDsl: null,
  setReason: null,
  version: 3,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const SESSION = {
  userId: "u",
  organizationId: "org-1",
  membershipId: "m-1",
  roles: ["org_admin"],
  permissions: ["billing.rule_config.read", "billing.rule_config.admin"],
  isAdmin: false,
};

function mount(script: Script): string[] {
  const { keys, fetchStub } = scriptedFetch(script, () => ({
    items: [RULE],
    nextCursor: null,
    hasMore: false,
  }));
  render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: fetchStub })}>
      <SessionProvider session={SESSION}>
        <ToastProvider>
          <MemoryRouter>
            <RuleConfigEditor />
          </MemoryRouter>
        </ToastProvider>
      </SessionProvider>
    </ApiClientProvider>,
  );
  return keys;
}

const press = async (name: string, expected: number, keys: string[]) => {
  fireEvent.click(await screen.findByRole("button", { name }));
  await waitFor(() => expect(keys.length).toBe(expected));
  await waitFor(() => {
    const button = screen.queryByRole("button", { name }) as HTMLButtonElement | null;
    expect(button === null || !button.disabled).toBe(true);
  });
};

afterEach(() => cleanup());

describe("Rule config overlay Idempotency-Key (#821)", () => {
  it("save: reuses the key after a thrown request", async () => {
    const keys = mount(["throw"]);
    await press("Save overlay", 1, keys);
    await press("Save overlay", 2, keys);
    expect(keys[1]).toBe(keys[0]);
  });

  it("save: mints a new key after an HTTP error answer", async () => {
    const keys = mount([422]);
    await press("Save overlay", 1, keys);
    await press("Save overlay", 2, keys);
    expect(keys[1]).not.toBe(keys[0]);
  });

  it("save: mints a new key after a field edit following a thrown request", async () => {
    const keys = mount(["throw"]);
    await press("Save overlay", 1, keys);
    fireEvent.change(await screen.findByLabelText("Parameters (JSON)"), {
      target: { value: '{"max":6}' },
    });
    await press("Save overlay", 2, keys);
    expect(keys[1]).not.toBe(keys[0]);
  });

  it("revert: reuses the key after a thrown request and drops it after an HTTP answer", async () => {
    const keys = mount(["throw", 409]);
    await press("Revert to platform default", 1, keys);
    await press("Revert to platform default", 2, keys);
    await press("Revert to platform default", 3, keys);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[1]);
  });

  it("add custom rule: reuses the key after a thrown request, new key after an edit and after an HTTP answer", async () => {
    const keys = mount(["throw", "throw", 422]);
    fireEvent.click(await screen.findByRole("button", { name: "Add custom rule" }));
    fireEvent.change(await screen.findByLabelText("Rule key"), { target: { value: "tenant.x.y" } });
    await press("Create rule", 1, keys);
    await press("Create rule", 2, keys);
    expect(keys[1]).toBe(keys[0]);
    fireEvent.change(screen.getByLabelText("Rule key"), { target: { value: "tenant.x.z" } });
    await press("Create rule", 3, keys);
    expect(keys[2]).not.toBe(keys[1]);
    await press("Create rule", 4, keys);
    expect(keys[3]).not.toBe(keys[2]);
  });
});
