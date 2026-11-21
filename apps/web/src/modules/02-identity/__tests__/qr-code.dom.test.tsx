// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { QrCode, qrPath } from "../qr-code";

// A made-up setup URI with a made-up secret: it belongs to no account.
const SECRET = "JBSWY3DPEHPK3PXP";
const URI = `otpauth://totp/ChartWarden:demo%40example.test?secret=${SECRET}&issuer=ChartWarden`;

afterEach(() => cleanup());

describe("qrPath", () => {
  it("draws a square code with a four-module quiet zone around the data", () => {
    const code = qrPath(URI);
    expect(code).not.toBeNull();
    // version 1 is 21 modules; a longer URI is a larger version, always 4n + 17
    const modules = (code?.size ?? 0) - 8;
    expect((modules - 17) % 4).toBe(0);
    expect(modules).toBeGreaterThanOrEqual(21);
  });

  it("puts the top-left finder pattern's corner at column 0, row 0 (after the quiet zone), not transposed", () => {
    const code = qrPath(URI);
    const squares = [...(code?.path.matchAll(/M(\d+),(\d+)h1v1h-1z/g) ?? [])].map((m) => [
      Number(m[1]),
      Number(m[2]),
    ]);
    const dark = new Set(squares.map(([x, y]) => `${x},${y}`));
    // The finder pattern is a 7x7 ring with a 3x3 centre: its first row is dark from end to end...
    for (let i = 0; i < 7; i += 1) expect(dark.has(`${4 + i},4`)).toBe(true);
    // ...and its second row is dark only at the two edges, so the ring is not filled in.
    expect(dark.has("5,5")).toBe(false);
    expect(dark.has("4,5")).toBe(true);
    expect(dark.has("10,5")).toBe(true);
  });

  it("answers null instead of throwing when the text cannot be encoded", () => {
    expect(qrPath("x".repeat(5000))).toBeNull();
  });
});

describe("QrCode", () => {
  it("is one inline image named for its purpose, never for its content", () => {
    const { container } = render(<QrCode text={URI} label="QR code for adding ChartWarden" />);
    const image = screen.getByRole("img", { name: "QR code for adding ChartWarden" });
    expect(image.tagName.toLowerCase()).toBe("svg");
    expect(image.getAttribute("aria-label")).not.toContain(SECRET);
    // Drawn here, not fetched: no image URL, no link, no embedded markup.
    expect(container.querySelector("image, img, a, foreignObject, script")).toBeNull();
    expect(container.innerHTML).not.toContain(SECRET);
  });

  it("renders nothing when the text cannot be encoded", () => {
    const { container } = render(<QrCode text={"x".repeat(5000)} label="QR" />);
    expect(container.firstChild).toBeNull();
  });
});
