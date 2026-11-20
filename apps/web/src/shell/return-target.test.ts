// Workflow 09, WP1 — the way back out of a visit or a note is a URL value the user can edit, so it is checked against a fixed list of
// internal screens and never used as given.
import { describe, expect, it } from "vitest";
import { RETURN_PARAM, parseReturnTarget, withReturnTarget } from "./return-target";

describe("parseReturnTarget", () => {
  it.each([
    ["/me/visits", "My Visits"],
    ["/scheduling/visits/visit-1", "the visit"],
    ["/calendar", "Calendar"],
    ["/work/drafts", "My Notes"],
    ["/work/cosignatures", "Cosignature queue"],
    ["/patients/patient-1/encounters", "Encounters"],
  ])("accepts %s", (path, label) => {
    expect(parseReturnTarget(path)).toEqual({ href: path, label });
  });

  it("keeps the filters My Visits understands and drops every other key", () => {
    const target = parseReturnTarget("/me/visits?status=completed&page=2&evil=1&q=Ava");
    // The search text is typed, often a patient's name: it is not a key a way back may carry.
    expect(target?.href).toBe("/me/visits?status=completed&page=2");
  });

  it("keeps the calendar's own view of the day", () => {
    const target = parseReturnTarget("/calendar?view=week&date=2026-08-31&visit=visit-1");
    expect(target?.href).toBe("/calendar?view=week&date=2026-08-31&visit=visit-1");
  });

  it("keeps every filter the calendar keeps in its URL, so a filtered week comes back filtered", () => {
    const written =
      "/calendar?view=week&date=2026-08-31&patient=p-1&visit=v-1&purpose=routine_visit&setting=patient_home" +
      "&status=published&staff=mem-1&inactive=1&density=compact&panel=staff";
    expect(parseReturnTarget(written)?.href).toBe(written);
  });

  it("drops the calendar's New Visit dialog, an unknown key, and a filter value that is hostile or too long", () => {
    const target = parseReturnTarget(
      `/calendar?view=week&newVisit=1&q=Ava&staff=${"a".repeat(300)}&purpose=a%00b&status=published`,
    );
    expect(target?.href).toBe("/calendar?view=week&status=published");
  });

  it("drops a hash and keeps the path as it was written", () => {
    expect(parseReturnTarget("/work/drafts#row-1")?.href).toBe("/work/drafts");
  });

  it("follows one visit back to the list it was opened from", () => {
    const inner = encodeURIComponent("/me/visits?status=published");
    const target = parseReturnTarget(`/scheduling/visits/visit-1?from=${inner}`);
    expect(target?.label).toBe("the visit");
    expect(target?.href).toBe(`/scheduling/visits/visit-1?from=${inner}`);
  });

  it("cuts a chain that is nested deeper than it needs to be", () => {
    const innermost = encodeURIComponent("/me/visits?page=3");
    const middle = encodeURIComponent(`/scheduling/visits/v2?from=${innermost}`);
    const outer = parseReturnTarget(`/scheduling/visits/v1?from=${middle}`);
    expect(outer?.href).toBe(
      `/scheduling/visits/v1?from=${encodeURIComponent("/scheduling/visits/v2")}`,
    );
  });

  it("keeps the visit but drops a hostile origin nested in it", () => {
    const target = parseReturnTarget(
      `/scheduling/visits/visit-1?from=${encodeURIComponent("//evil.example/x")}`,
    );
    expect(target?.href).toBe("/scheduling/visits/visit-1");
  });

  it.each([
    ["nothing", null],
    ["undefined", undefined],
    ["an empty value", ""],
    ["an absolute URL", "https://evil.example/me/visits"],
    ["a protocol-relative host", "//evil.example/me/visits"],
    ["a triple slash", "///evil.example"],
    ["a backslash host", "/\\evil.example"],
    ["a double backslash", "\\\\evil.example"],
    ["a backslash inside the path", "/me/visits\\..\\admin"],
    ["a javascript URL", "javascript:alert(1)"],
    ["a javascript URL behind a slash", "/javascript:alert(1)"],
    ["a data URL", "data:text/html,<script>alert(1)</script>"],
    ["an encoded protocol-relative host", "%2F%2Fevil.example"],
    ["a double-encoded host", "%252F%252Fevil.example"],
    ["an encoded slash in the path", "/%2Fevil.example"],
    ["an encoded slash after a known screen", "/me/visits%2F..%2Fadmin"],
    ["an encoded dot segment", "/me/visits/%2e%2e/%2e%2e/admin"],
    ["a dot segment", "/me/visits/../../admin/users"],
    ["a tab that the browser would strip", "/\t/evil.example"],
    ["a newline", "/me/visits\n/evil"],
    ["a space", "/me/visits evil"],
    ["a control character", "/me/visits\u0000"],
    ["a userinfo host", "/@evil.example"],
    ["a screen that is not offered", "/admin/users"],
    ["a screen with a longer name", "/me/visits-archive"],
    ["a screen with a suffix", "/me/visitsevil"],
    ["a screen with a sub-path", "/me/visits/extra"],
    ["a visit with a sub-path", "/scheduling/visits/visit-1/edit"],
    ["a note record", "/patients/patient-1/encounters/enc-1"],
    ["a visit id with a dot", "/scheduling/visits/a.b"],
    ["a value that is too long", `/me/visits?purpose=${"a".repeat(2000)}`],
  ])("refuses %s", (_name, value) => {
    expect(parseReturnTarget(value as string | null | undefined)).toBeNull();
  });

  it("drops a query value that is too long or carries a control character", () => {
    expect(parseReturnTarget(`/me/visits?purpose=${"a".repeat(300)}&status=completed`)?.href).toBe(
      "/me/visits?status=completed",
    );
    expect(parseReturnTarget("/me/visits?purpose=a%00b&status=completed")?.href).toBe(
      "/me/visits?status=completed",
    );
  });
});

describe("withReturnTarget", () => {
  it("adds the way back as an encoded query value", () => {
    const href = withReturnTarget("/patients/p-1/encounters/e-1", "/me/visits?status=completed");
    expect(href).toBe(
      `/patients/p-1/encounters/e-1?${RETURN_PARAM}=${encodeURIComponent("/me/visits?status=completed")}`,
    );
    const value = new URL(href, "http://x.invalid").searchParams.get(RETURN_PARAM);
    expect(parseReturnTarget(value)?.href).toBe("/me/visits?status=completed");
  });

  it("joins a query that is already there and keeps a hash last", () => {
    const href = withReturnTarget(
      "/patients/p-1/encounters/e-1?x=1#addendum-cosign-a1",
      "/work/cosignatures",
    );
    expect(href).toBe(
      `/patients/p-1/encounters/e-1?x=1&${RETURN_PARAM}=${encodeURIComponent("/work/cosignatures")}#addendum-cosign-a1`,
    );
  });

  it("leaves the link as it was when the origin is not a known screen", () => {
    expect(withReturnTarget("/patients/p-1/encounters/e-1", "//evil.example")).toBe(
      "/patients/p-1/encounters/e-1",
    );
    expect(withReturnTarget("/patients/p-1/encounters/e-1", null)).toBe(
      "/patients/p-1/encounters/e-1",
    );
  });

  it("writes the canonical origin, not the raw one", () => {
    const href = withReturnTarget("/x", "/me/visits?evil=1&status=completed");
    expect(href).toBe(`/x?${RETURN_PARAM}=${encodeURIComponent("/me/visits?status=completed")}`);
  });
});
