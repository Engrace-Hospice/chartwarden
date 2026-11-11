import { ApiClientProvider, createApiClient } from "@chartwarden/ui";
// apps/admin/src/modules/34-saas-platform — "New tenant" used to be a browser alert() placeholder. The drawer posts
// the six fields the route requires, and a step-up refusal must keep what was typed and offer Re-verify rather than
// claim success or wipe the form.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SLUG_CHECK_DEBOUNCE_MS } from "./slug-field";
import { TenantProvisionDrawer } from "./tenant-provision";

interface Recorded {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
}

const AVAILABILITY_PATH = /^\/api\/v1\/platform\/tenant-slugs\/([^/]+)\/availability$/;
const BASE_URL = "chartwarden.cloud";

/** The route's answer for a free, valid slug; tests override it to simulate a taken slug or an outage. */
const freeSlug = (slug: string): Response =>
  json(200, { slug, valid: true, available: true, url: `https://${slug}.${BASE_URL}` });

function mount(
  respond: () => Response,
  availability: (slug: string) => Response = freeSlug,
): {
  calls: Recorded[];
  /** Everything that is not an availability probe. */
  posts: () => Recorded[];
  checks: () => string[];
  onAccepted: () => void;
} {
  const calls: Recorded[] = [];
  const onAccepted = vi.fn();
  const client = createApiClient({
    baseUrl: "http://localhost",
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(String(input), init);
      let body: Record<string, unknown> | null = null;
      try {
        body = JSON.parse(await req.clone().text()) as Record<string, unknown>;
      } catch {
        body = null;
      }
      const path = new URL(req.url).pathname;
      calls.push({ method: req.method, path, body });
      const probe = AVAILABILITY_PATH.exec(path);
      return probe ? availability(decodeURIComponent(probe[1] ?? "")) : respond();
    },
  });
  render(
    <ApiClientProvider client={client}>
      <MemoryRouter initialEntries={["/tenants?tenant=new"]}>
        <TenantProvisionDrawer onClose={() => undefined} onAccepted={onAccepted} />
      </MemoryRouter>
    </ApiClientProvider>,
  );
  return {
    calls,
    posts: () => calls.filter((c) => !AVAILABILITY_PATH.test(c.path)),
    checks: () =>
      calls.flatMap((c) => {
        const slug = AVAILABILITY_PATH.exec(c.path)?.[1];
        return slug === undefined ? [] : [decodeURIComponent(slug)];
      }),
    onAccepted,
  };
}

function fill(label: string, value: string): void {
  // Required fields carry a visible "*" after the label text, so match the start of it.
  fireEvent.change(screen.getByLabelText(new RegExp(`^${label}`)), {
    target: { value },
  });
}

/** Focus leaves the legal name field: while the subdomain follows it, this is what triggers the availability check. */
function leaveLegalName(): void {
  fireEvent.blur(screen.getByLabelText(/^Legal business name/));
}

function fillAll(): void {
  fill("Legal business name", "  Cedar Ridge Hospice LLC ");
  fill("Billing contact email", "billing@cedar.example");
  fill("Breach notification email", "privacy@cedar.example");
  fill("First admin full name", "Ada Admin");
  fill("First admin email", "ada@cedar.example");
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

afterEach(() => {
  cleanup();
  sessionStorage.clear();
});

describe("TenantProvisionDrawer", () => {
  it("explains what is missing instead of silently disabling Provision (#597)", async () => {
    const { posts } = mount(() => json(202, {}));
    const submit = screen.getByRole("button", {
      name: "Provision tenant",
    }) as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    expect(screen.queryByText("Enter the billing contact email.")).toBeNull();
    fireEvent.click(submit);
    expect(await screen.findByText("Enter the billing contact email.")).toBeTruthy();
    expect(screen.getByText(/Enter the legal business name/)).toBeTruthy();
    expect(posts()).toEqual([]);
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByLabelText(/^Legal business name/)),
    );
    fillAll();
    fill("Billing contact email", "not-an-email");
    fireEvent.click(submit);
    expect(await screen.findByText(/Enter a valid email address/)).toBeTruthy();
    expect(posts()).toEqual([]);
  });

  it("does not ask for a plan: it is signed at onboarding step 2", () => {
    mount(() => json(202, {}));
    expect(screen.queryByLabelText("Plan")).toBeNull();
  });

  it("posts the trimmed fields and reports the request as accepted", async () => {
    const { posts, onAccepted } = mount(() => json(202, { accepted: true }));
    fillAll();
    fireEvent.click(screen.getByRole("button", { name: "Provision tenant" }));
    await waitFor(() => expect(onAccepted).toHaveBeenCalled());
    expect(posts()).toEqual([
      {
        method: "POST",
        path: "/api/v1/platform/tenants",
        body: {
          legalBusinessName: "Cedar Ridge Hospice LLC",
          billingContactEmail: "billing@cedar.example",
          breachNotificationContactEmail: "privacy@cedar.example",
          firstAdminEmail: "ada@cedar.example",
          firstAdminFullName: "Ada Admin",
          // No plan label: the plan is a census-banded contract signed at onboarding step 2, not a tier picked here.
          // Suggested from the legal name; the operator never touched the field.
          slug: "cedar-ridge-hospice",
        },
      },
    ]);
    expect(await screen.findByText(/Provisioning requested/)).toBeTruthy();
    // Queued, not created yet: a second click must not enqueue a duplicate provision.
    const again = screen.getByRole("button", {
      name: "Requested",
    }) as HTMLButtonElement;
    expect(again.disabled).toBe(true);
    fireEvent.click(again);
    expect(posts()).toHaveLength(1);
  });

  it("sends the optional subdomain trimmed, and refuses a reserved or malformed one before posting", async () => {
    const { posts } = mount(() => json(202, {}));
    fillAll();
    fill("Subdomain", "admin");
    fireEvent.click(screen.getByRole("button", { name: "Provision tenant" }));
    expect(await screen.findByText(/reserved/)).toBeTruthy();
    fill("Subdomain", "xn--abc");
    fireEvent.click(screen.getByRole("button", { name: "Provision tenant" }));
    expect(await screen.findByText(/xn--/)).toBeTruthy();
    fill("Subdomain", "Bad_Slug");
    fireEvent.click(screen.getByRole("button", { name: "Provision tenant" }));
    expect(await screen.findByText(/lowercase letters/)).toBeTruthy();
    expect(posts()).toEqual([]);
    fill("Subdomain", " sunrise ");
    fireEvent.click(screen.getByRole("button", { name: "Provision tenant" }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]?.body).toMatchObject({ slug: "sunrise" });
  });

  it("a step-up refusal keeps the typed values and offers Re-verify", async () => {
    const { onAccepted } = mount(() =>
      json(403, {
        error: {
          code: "STEP_UP_REQUIRED",
          message: "step up",
          correlationId: "c",
        },
      }),
    );
    fillAll();
    fireEvent.click(screen.getByRole("button", { name: "Provision tenant" }));
    expect(await screen.findByRole("link", { name: "Re-verify" })).toBeTruthy();
    expect(onAccepted).not.toHaveBeenCalled();
    expect((screen.getByLabelText(/^First admin email/) as HTMLInputElement).value).toBe(
      "ada@cedar.example",
    );
  });

  it("shows a taken subdomain on the field, keeps the typed value, and the form stays usable", async () => {
    const { onAccepted } = mount(() =>
      json(409, {
        error: {
          code: "TENANT_SLUG_UNAVAILABLE",
          message: "that subdomain is taken",
          correlationId: "c",
        },
      }),
    );
    fillAll();
    fill("Subdomain", "sunrise");
    fireEvent.click(screen.getByRole("button", { name: "Provision tenant" }));
    expect(await screen.findByText("that subdomain is taken")).toBeTruthy();
    expect((screen.getByLabelText(/^Subdomain/) as HTMLInputElement).value).toBe("sunrise");
    expect(onAccepted).not.toHaveBeenCalled();
    fill("Subdomain", "sunrise2");
    expect(screen.queryByText("that subdomain is taken")).toBeNull();
  });

  it("restores the typed subdomain after Re-verify", async () => {
    mount(() =>
      json(403, {
        error: {
          code: "STEP_UP_REQUIRED",
          message: "step up",
          correlationId: "c",
        },
      }),
    );
    fillAll();
    fill("Subdomain", "sunrise");
    fireEvent.click(screen.getByRole("button", { name: "Provision tenant" }));
    fireEvent.click(await screen.findByRole("link", { name: "Re-verify" }));
    cleanup();
    mount(() => json(202, {}));
    expect((screen.getByLabelText(/^Subdomain/) as HTMLInputElement).value).toBe("sunrise");
  });

  it("restores the typed values after the Re-verify round trip", async () => {
    mount(() =>
      json(403, {
        error: {
          code: "STEP_UP_REQUIRED",
          message: "step up",
          correlationId: "c",
        },
      }),
    );
    fillAll();
    fireEvent.click(screen.getByRole("button", { name: "Provision tenant" }));
    fireEvent.click(await screen.findByRole("link", { name: "Re-verify" }));
    cleanup();
    mount(() => json(202, {}));
    expect((screen.getByLabelText(/^Legal business name/) as HTMLInputElement).value).toBe(
      "  Cedar Ridge Hospice LLC ",
    );
    expect((screen.getByLabelText(/^First admin email/) as HTMLInputElement).value).toBe(
      "ada@cedar.example",
    );
  });

  it("shows the server's reason when provisioning is refused (e.g. a duplicate name)", async () => {
    const { onAccepted } = mount(() =>
      json(409, {
        error: {
          code: "CONFLICT",
          message: "a tenant with that legal name already exists",
          correlationId: "c",
        },
      }),
    );
    fillAll();
    fireEvent.click(screen.getByRole("button", { name: "Provision tenant" }));

    expect(await screen.findByText(/already exists/)).toBeTruthy();
    expect(onAccepted).not.toHaveBeenCalled();
  });

  it("a network failure shows a retryable message and re-enables the button", async () => {
    mount(() => {
      throw new Error("offline");
    });
    fillAll();
    fireEvent.click(screen.getByRole("button", { name: "Provision tenant" }));

    expect(await screen.findByText(/could not reach the server/i)).toBeTruthy();
    expect(
      (
        screen.getByRole("button", {
          name: "Provision tenant",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });

  it("points the operator at the tenant to follow provisioning progress", async () => {
    mount(() => json(202, { tenantAccountId: "t-1", jobId: "j" }));
    fillAll();
    fireEvent.click(screen.getByRole("button", { name: "Provision tenant" }));

    expect(await screen.findByText(/open the tenant to follow its progress/i)).toBeTruthy();
  });
});

describe("TenantProvisionDrawer subdomain field", () => {
  const slugInput = () => screen.getByLabelText(/^Subdomain/) as HTMLInputElement;
  const provision = () => fireEvent.click(screen.getByRole("button", { name: "Provision tenant" }));

  it("suggests a subdomain from the legal name and follows it until the operator edits the field", () => {
    mount(() => json(202, {}));
    expect(slugInput().value).toBe("");

    fill("Legal business name", "Sunrise Hospice of Ohio, LLC");
    expect(slugInput().value).toBe("sunrise-hospice-of-ohio");
    fill("Legal business name", "Sunrise Hospice of Ohio and Indiana, LLC");
    expect(slugInput().value).toBe("sunrise-hospice-of-ohio-and-indiana");

    fill("Subdomain", "sunrise");
    fill("Legal business name", "Totally Different Name Inc");
    expect(slugInput().value).toBe("sunrise");
  });

  it("a cleared field stays blank so the server generates one", async () => {
    const { posts } = mount(() => json(202, {}));
    fillAll();
    fill("Subdomain", "");
    fill("Legal business name", "Cedar Ridge Hospice LLC Two");
    expect(slugInput().value).toBe("");

    provision();

    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]?.body).not.toHaveProperty("slug");
  });

  it("while the subdomain follows the legal name, typing the name asks nothing; leaving the field asks once", async () => {
    const { checks, posts } = mount(() => json(202, {}));

    for (const typedName of ["Ce", "Cedar", "Cedar Ridge", "Cedar Ridge Hospice LLC"]) {
      fill("Legal business name", typedName);
    }
    await new Promise((resolve) => setTimeout(resolve, SLUG_CHECK_DEBOUNCE_MS * 2));

    expect(checks()).toEqual([]);
    expect(screen.queryByText("Checking availability…")).toBeNull();
    expect(slugInput().value).toBe("cedar-ridge-hospice");

    leaveLegalName();

    expect(screen.getByText("Checking availability…")).toBeTruthy();
    expect(
      await screen.findByText("Available: https://cedar-ridge-hospice.chartwarden.cloud"),
    ).toBeTruthy();
    expect(checks()).toEqual(["cedar-ridge-hospice"]);
    expect(posts()).toEqual([]);
  });

  it("changing the name again drops the verdict until the field is left again", async () => {
    const { checks } = mount(() => json(202, {}));
    fill("Legal business name", "Cedar Ridge Hospice LLC");
    leaveLegalName();
    expect(await screen.findByText(/Available: https:\/\/cedar-ridge-hospice\./)).toBeTruthy();

    fill("Legal business name", "Cedar Ridge Hospice of Ohio LLC");
    await new Promise((resolve) => setTimeout(resolve, SLUG_CHECK_DEBOUNCE_MS * 2));

    expect(screen.queryByText(/Available:/)).toBeNull();
    expect(checks()).toEqual(["cedar-ridge-hospice"]);
    leaveLegalName();
    expect(
      await screen.findByText("Available: https://cedar-ridge-hospice-of-ohio.chartwarden.cloud"),
    ).toBeTruthy();
    expect(checks()).toEqual(["cedar-ridge-hospice", "cedar-ridge-hospice-of-ohio"]);
  });

  it("a typed subdomain is still checked after the short pause, with no need to leave a field", async () => {
    const { checks } = mount(() => json(202, {}));
    fill("Legal business name", "Cedar Ridge Hospice LLC");

    fill("Subdomain", "sunrise");

    expect(screen.getByText("Checking availability…")).toBeTruthy();
    expect(await screen.findByText(/Available: https:\/\/sunrise\./)).toBeTruthy();
    expect(checks()).toEqual(["sunrise"]);
  });

  it("submitting without leaving the name field still posts the suggestion; the server decides", async () => {
    const { checks, posts } = mount(() => json(202, {}));
    fillAll();

    provision();

    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]?.body).toMatchObject({ slug: "cedar-ridge-hospice" });
    expect(checks()).toEqual([]);
  });

  it("debounces: typing in a burst asks the server about the last value only", async () => {
    const { checks } = mount(() => json(202, {}));

    for (const typed of ["s", "su", "sun", "sunr", "sunri", "sunrise"]) fill("Subdomain", typed);

    expect(await screen.findByText(/Available: https:\/\/sunrise\./)).toBeTruthy();
    expect(checks()).toEqual(["sunrise"]);
  });

  it("shows a taken subdomain on the field and blocks submitting it", async () => {
    const { posts } = mount(
      () => json(202, {}),
      (slug) => json(200, { slug, valid: true, available: false, reason: "taken" }),
    );
    fillAll();
    leaveLegalName();

    expect(await screen.findByText(/already taken/i)).toBeTruthy();
    expect(slugInput().getAttribute("aria-invalid")).toBe("true");
    provision();

    await waitFor(() => expect(document.activeElement).toBe(slugInput()));
    expect(posts()).toEqual([]);
  });

  it("a taken subdomain stops blocking once it is changed to a free one", async () => {
    const { posts } = mount(
      () => json(202, {}),
      (slug) =>
        slug === "cedar-ridge-hospice"
          ? json(200, { slug, valid: true, available: false, reason: "taken" })
          : freeSlug(slug),
    );
    fillAll();
    leaveLegalName();
    expect(await screen.findByText(/already taken/i)).toBeTruthy();

    fill("Subdomain", "cedar-ridge");
    expect(await screen.findByText(/Available: https:\/\/cedar-ridge\./)).toBeTruthy();
    provision();

    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]?.body).toMatchObject({ slug: "cedar-ridge" });
  });

  it.each([
    ["admin", /reserved/],
    ["xn--abc", /xn--/],
    ["Bad_Slug", /lowercase letters/],
  ])("explains why %s cannot be used without asking the server", async (typed, message) => {
    const { checks, posts } = mount(() => json(202, {}));
    fillAll();
    fill("Subdomain", typed);

    expect(await screen.findByText(message)).toBeTruthy();
    expect(slugInput().getAttribute("aria-invalid")).toBe("true");
    provision();

    await waitFor(() => expect(document.activeElement).toBe(slugInput()));
    expect(posts()).toEqual([]);
    expect(checks()).not.toContain(typed);
  });

  it("an availability outage says so but does not stop the request; the server still decides", async () => {
    const { posts } = mount(
      () => json(202, {}),
      () => json(500, { error: { code: "INTERNAL", message: "boom", correlationId: "c" } }),
    );
    fillAll();
    leaveLegalName();

    expect(await screen.findByText(/could not check availability/i)).toBeTruthy();
    provision();

    await waitFor(() => expect(posts()).toHaveLength(1));
  });

  it("a network failure on the check is treated the same way", async () => {
    mount(
      () => json(202, {}),
      () => {
        throw new Error("offline");
      },
    );
    fill("Legal business name", "Cedar Ridge Hospice LLC");
    leaveLegalName();

    expect(await screen.findByText(/could not check availability/i)).toBeTruthy();
  });

  it("keeps the suggested subdomain through the Re-verify round trip", async () => {
    mount(() =>
      json(403, { error: { code: "STEP_UP_REQUIRED", message: "step up", correlationId: "c" } }),
    );
    fillAll();
    fireEvent.click(screen.getByRole("button", { name: "Provision tenant" }));
    fireEvent.click(await screen.findByRole("link", { name: "Re-verify" }));
    cleanup();

    mount(() => json(202, {}));

    expect(slugInput().value).toBe("cedar-ridge-hospice");
    // Restored values count as typed: a later name edit does not overwrite them.
    fill("Legal business name", "Another Name Entirely");
    expect(slugInput().value).toBe("cedar-ridge-hospice");
  });
});
