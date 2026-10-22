import qrcode from "qrcode-generator";

// E-c: the rescue QR is drawn in the browser, so the rescue link (which carries
// the pet's public token) is never sent to a third-party QR service. The link is
// ASCII (origin + encodeURIComponent(token)), which byte mode encodes unchanged.
// Returns a GIF data URL: usable in <img>, in the print window and for download.
export function qrCodeDataUrl(text: string, cellSize = 8): string {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  return qr.createDataURL(cellSize, cellSize * 4);
}
