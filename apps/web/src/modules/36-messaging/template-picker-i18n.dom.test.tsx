// M36 WP 6.4 - the picker in Spanish: lang attributes per segment, a visible EN tag on any English fallback.
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EnTag, Txt } from "./i18n/use-messaging-locale";

describe("Txt", () => {
  it("renders a translated string with lang=es, marked provisional, no EN tag", () => {
    const { container } = render(<Txt k="picker.toggle" locale="es" />);
    const span = container.querySelector("span[lang]");
    expect(span?.getAttribute("lang")).toBe("es");
    expect(span?.getAttribute("data-provisional")).toBe("true");
    expect(screen.queryByText("EN")).toBeNull();
  });
  it("English renders plain with lang=en", () => {
    const { container } = render(<Txt k="picker.toggle" locale="en" />);
    expect(container.querySelector("span")?.getAttribute("lang")).toBe("en");
  });
  it("EnTag is visible text with lang=en", () => {
    render(<EnTag />);
    expect(screen.getByText("EN").getAttribute("lang")).toBe("en");
  });
});

describe("TemplatePicker in Spanish", () => {
  it("labels in es; an unreviewed platform template shows English with a visible EN tag and inserts English", async () => {
    vi.resetModules();
    vi.doMock("./use-saved-replies", () => ({
      useSavedReplies: () => ({
        status: "ready",
        reload: () => {},
        items: [
          {
            id: "p1",
            scope: "platform",
            templateKey: "confirmation.received",
            category: "general",
            title: "Message received",
            body: "Thanks, message received.",
            customized: false,
          },
          {
            id: "o1",
            scope: "org",
            templateKey: null,
            category: "general",
            title: "Nota",
            body: "Texto propio",
            customized: false,
          },
        ],
      }),
    }));
    const { TemplatePicker } = await import("./template-picker");
    const onInsert = vi.fn();
    render(<TemplatePicker locale="es" disabled={false} onInsert={onInsert} onClosed={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Respuestas guardadas/ }));
    expect(screen.getByRole("dialog", { name: "Respuestas guardadas" })).toBeTruthy();
    const options = screen.getAllByRole("option");
    expect(within(options[0] as HTMLElement).getByText("EN").getAttribute("lang")).toBe("en");
    expect(within(options[1] as HTMLElement).queryByText("EN")).toBeNull();
    fireEvent.click(options[0] as HTMLElement);
    expect(onInsert).toHaveBeenCalledWith("Thanks, message received.");
  });
});
