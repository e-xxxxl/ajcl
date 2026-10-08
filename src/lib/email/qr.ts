import QRCode from "qrcode";
import type { InlineImage } from "./send";

/**
 * A QR code (PNG) for a 6-digit handover code, as an inline email image.
 * The QR holds only the digits, so scanning and typing hit the same check.
 * Returns null if generation fails — the digits printed next to it still work.
 */
export async function qrInlineImage(code: string, contentId: string): Promise<InlineImage | null> {
  try {
    const png = await QRCode.toBuffer(code, {
      type: "png",
      width: 360,
      margin: 2,
      errorCorrectionLevel: "M",
      color: { dark: "#141414", light: "#ffffff" },
    });
    return {
      filename: `${contentId}.png`,
      content: png.toString("base64"),
      contentId,
      contentType: "image/png",
    };
  } catch (err) {
    console.error("[email] QR generation failed", err instanceof Error ? err.message : err);
    return null;
  }
}
