// apps/web/src/modules/02-identity — a QR code drawn in the browser as an SVG, for the authenticator setup step. The text it encodes is the
// `otpauth://` URI, which carries the shared secret: it goes to the library and onto the screen and nowhere else (no request, no
// image URL, no storage), and the label read out to a screen reader never repeats it. qrcode-generator (MIT) only computes the modules;
// the SVG is built here as React elements, so no HTML string is ever injected.
import qrcode from "qrcode-generator";
import { useMemo } from "react";
import type { JSX } from "react";

/** The empty border a scanner needs around the code, in modules (the QR specification asks for four). */
const QUIET_ZONE_MODULES = 4;
/** Drawn size on screen: large enough to scan from a laptop screen, small enough to sit beside the setup key. */
const DISPLAY_PX = 176;
// A scanner reads dark on light whatever the app theme is (a light-on-dark code in dark mode would not scan), so these two are fixed
// on purpose and are not theme tokens. The CSS keywords, not hex values, say "plain black on plain white".
const MODULE_COLOUR = "black";
const BACKGROUND_COLOUR = "white";

export interface QrPath {
  /** Side of the square viewBox, in modules, quiet zone included. */
  readonly size: number;
  /** The dark modules as unit squares (`Mx,yh1v1h-1z`), column `x` and row `y`. */
  readonly path: string;
}

/** The dark modules of a QR code for `text`, or null when the text cannot be encoded (it never throws into a render). */
export function qrPath(text: string): QrPath | null {
  try {
    const code = qrcode(0, "M"); // 0 = smallest version that fits; M = about 15% of the code may be damaged
    code.addData(text);
    code.make();
    const count = code.getModuleCount();
    let path = "";
    for (let row = 0; row < count; row += 1)
      for (let column = 0; column < count; column += 1)
        if (code.isDark(row, column))
          path += `M${column + QUIET_ZONE_MODULES},${row + QUIET_ZONE_MODULES}h1v1h-1z`;
    return { size: count + 2 * QUIET_ZONE_MODULES, path };
  } catch {
    return null;
  }
}

export function QrCode({
  text,
  label,
}: {
  readonly text: string;
  /** What a screen reader says: describe the purpose, never the content. */
  readonly label: string;
}): JSX.Element | null {
  const code = useMemo(() => qrPath(text), [text]);
  if (code === null) return null;
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${code.size} ${code.size}`}
      width={DISPLAY_PX}
      height={DISPLAY_PX}
      shapeRendering="crispEdges"
      style={{ background: BACKGROUND_COLOUR, borderRadius: "0.5rem", flex: "none" }}
    >
      <path d={code.path} fill={MODULE_COLOUR} />
    </svg>
  );
}
