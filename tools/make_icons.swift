// 앱 아이콘 만들기: swift tools/make_icons.swift icons
import AppKit
let out = CommandLine.arguments[1]
for size in [180, 192, 512] {
  let s = CGFloat(size)
  let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
  NSColor(red: 0.184, green: 0.435, blue: 0.369, alpha: 1).setFill()
  NSBezierPath(rect: NSRect(x: 0, y: 0, width: s, height: s)).fill()
  // 종이 두 장 (넘기는 모양)
  let pw = s * 0.42, ph = s * 0.56, py = s * 0.22
  NSColor(white: 1, alpha: 0.55).setFill()
  NSBezierPath(roundedRect: NSRect(x: s * 0.50, y: py, width: pw * 0.9, height: ph), xRadius: s * 0.03, yRadius: s * 0.03).fill()
  NSColor.white.setFill()
  NSBezierPath(roundedRect: NSRect(x: s * 0.14, y: py, width: pw, height: ph), xRadius: s * 0.03, yRadius: s * 0.03).fill()
  // 오선
  NSColor(white: 0.25, alpha: 1).setFill()
  for i in 0..<5 {
    NSBezierPath(rect: NSRect(x: s * 0.19, y: py + ph * 0.30 + CGFloat(i) * s * 0.045, width: pw * 0.76, height: max(1, s * 0.008))).fill()
  }
  // 음표 머리 두 개
  NSColor(red: 0.12, green: 0.14, blue: 0.16, alpha: 1).setFill()
  for (x, y) in [(0.26, 0.355), (0.40, 0.445)] {
    let r = NSRect(x: s * CGFloat(x), y: s * CGFloat(y), width: s * 0.07, height: s * 0.05)
    NSBezierPath(ovalIn: r).fill()
    NSBezierPath(rect: NSRect(x: r.maxX - s * 0.012, y: r.midY, width: s * 0.012, height: s * 0.15)).fill()
  }
  NSGraphicsContext.restoreGraphicsState()
  try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: "\(out)/icon-\(size).png"))
}
print("ok")
