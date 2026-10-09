// apps/web/src/modules/05-patient/wristband-barcode.ts -- GAP-020: render a wristband payload as barcodes.
//
// The payload is 36 ASCII chars (`WXB1.<26 base32>.<crc>`), so both symbologies carry it: a QR code (primary,
// phone/camera scanners) and a Code 128 (linear laser scanners and keyboard-wedge handhelds, the common hospital
// default). bwip-js (MIT) is imported from its `generic` build, which is tree-shakable per symbology, so only the
// two encoders ship. The SVG is produced from OUR payload by the library (path data only), never from user text.
import * as bwip from "bwip-js/generic";

export interface WristbandBarcodes {
  readonly qrSvg: string;
  readonly linearSvg: string;
}

/** The generic build's per-symbology encoders are typed with a sync/async overload pair; SVG output is sync. */
type SyncEncoder = (opts: unknown, drawing: unknown) => string;

export function renderWristbandBarcodes(payload: string): WristbandBarcodes {
  const qrcode = bwip.qrcode as unknown as SyncEncoder;
  const code128 = bwip.code128 as unknown as SyncEncoder;
  return {
    qrSvg: qrcode({ bcid: "qrcode", text: payload, eclevel: "M" }, bwip.drawingSVG()),
    linearSvg: code128({ bcid: "code128", text: payload, height: 10 }, bwip.drawingSVG()),
  };
}
