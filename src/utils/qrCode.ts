import qrcode from 'qrcode-generator'

/**
 * Render `text` as a QR code data URL (GIF), generated fully offline so wallet
 * addresses never leave the device. `cellSize` is pixels per module.
 * typeNumber 0 lets the encoder pick the smallest version that fits.
 */
export function qrDataUrl(text: string, cellSize = 5, margin = 4): string {
  const qr = qrcode(0, 'M')
  qr.addData(text)
  qr.make()
  return qr.createDataURL(cellSize, margin)
}
