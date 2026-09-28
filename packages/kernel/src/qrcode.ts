/**
 * @hmharness/kernel - qrcode
 * QR Code generation facade. The kernel itself stays zero-dependency; the
 * web/cli packages pull in the `qrcode` npm lib and call through these
 * typed wrappers. When the lib is absent (pure-kernel consumers), the
 * functions throw with a clear message instead of crashing.
 *
 * The previous hand-rolled encoder had format-info and data-placement bugs
 * that made codes unscannable by every phone QR reader (2026-09-29 lesson:
 * QR spec is 100+ pages of exact bit placement - use a proven library).
 */

export interface QrOutput {
  /** ASCII art for terminal display (half-block Unicode). */
  terminal: string;
  /** SVG string for web display. */
  svg: string;
}

/**
 * Generate QR code output for a text (typically a URL).
 * Requires the `qrcode` npm package to be installed in the consuming package.
 */
export async function generateQr(text: string): Promise<QrOutput> {
  let QR: typeof import('qrcode');
  try {
    QR = (await import('qrcode')) as typeof import('qrcode');
  } catch {
    throw new Error('qrcode package not installed - run: npm install qrcode');
  }
  const [terminal, svg] = await Promise.all([
    QR.toString(text, { type: 'terminal', small: true, margin: 1 }),
    QR.toString(text, { type: 'svg', margin: 2, width: 240 }),
  ]);
  return { terminal, svg };
}
