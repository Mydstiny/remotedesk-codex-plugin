import Foundation
import ApplicationServices
import CoreGraphics
import AppKit

func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}
func rect(_ value: CGRect, scale: CGFloat) -> [String: Any] {
    return ["x": value.minX * scale, "y": value.minY * scale, "width": value.width * scale, "height": value.height * scale]
}
func snapshot() -> [String: Any] {
    guard AXIsProcessTrusted() else { return ["available": false, "reason": "denied"] }
    var displays = [CGDirectDisplayID](repeating: 0, count: 32), count: UInt32 = 0
    guard CGGetActiveDisplayList(32, &displays, &count) == .success, count > 0 else { return ["available": false, "reason": "unavailable"] }
    let scales = displays.prefix(Int(count)).map { CGFloat(CGDisplayPixelsWide($0)) / CGDisplayBounds($0).width }
    guard let scale = scales.first, scale.isFinite, scales.allSatisfy({ abs($0 - scale) < 0.001 }) else {
        // A single global physical-pixel plane is not defined by AX on mixed-DPI displays.
        return ["available": false, "reason": "unsupported"]
    }
    let captureRects = displays.prefix(Int(count)).map { rect(CGDisplayBounds($0), scale: scale) }
    let desktopRect = displays.prefix(Int(count)).map { CGDisplayBounds($0) }.reduce(CGRect.null) { $0.union($1) }
    let desktop = "macos:console:\(getuid())"
    let system = AXUIElementCreateSystemWide()
    guard let raw = attribute(system, kAXFocusedUIElementAttribute), CFGetTypeID(raw) == AXUIElementGetTypeID() else {
        return ["available": false, "reason": "unavailable"]
    }
    let element = unsafeBitCast(raw, to: AXUIElement.self)
    var focusedPid: pid_t = 0
    guard AXUIElementGetPid(element, &focusedPid) == .success else { return ["available": false, "reason": "unavailable"] }
    guard let frontmost = NSWorkspace.shared.frontmostApplication,
        frontmost.processIdentifier == focusedPid,
        frontmost.bundleIdentifier != "com.apple.loginwindow" else {
        return ["available": false, "reason": "unavailable"]
    }
    guard let role = attribute(element, kAXRoleAttribute) as? String else { return ["available": false, "reason": "unavailable"] }
    var settable = DarwinBoolean(false)
    let textRole = ["AXTextField", "AXTextArea", "AXComboBox"].contains(role)
    if textRole && AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &settable) != .success {
        return ["available": false, "reason": "unavailable"]
    }
    let editable = textRole && settable.boolValue
    let nonTextRole = ["AXButton", "AXCheckBox", "AXRadioButton", "AXMenuItem", "AXLink"].contains(role)
    let focusKind = editable ? "editable" : (textRole ? "readOnly" : (nonTextRole ? "nonText" : "unknown"))
    guard let enabled = attribute(element, kAXEnabledAttribute) as? Bool else { return ["available": false, "reason": "unavailable"] }
    var result: [String: Any] = ["available": true, "desktopId": desktop, "coordinateUnit": "physicalPx",
        "captureRects": captureRects, "desktopRect": rect(desktopRect, scale: scale), "focusKind": focusKind,
        "editable": editable, "readOnly": !editable, "enabled": enabled,
        "visible": true, "inputKind": (attribute(element, kAXSubroleAttribute) as? String) == "AXSecureTextField" ? "password" : "text"]
    var pid: pid_t = 0
    AXUIElementGetPid(element, &pid)
    result["focusToken"] = "\(pid):\(CFHash(element))" // Hashing/epoch isolation is performed again in the service.
    var point = CGPoint.zero, size = CGSize.zero
    if let position = attribute(element, kAXPositionAttribute), CFGetTypeID(position) == AXValueGetTypeID(),
       let dimensions = attribute(element, kAXSizeAttribute), CFGetTypeID(dimensions) == AXValueGetTypeID() {
        AXValueGetValue(unsafeBitCast(position, to: AXValue.self), .cgPoint, &point)
        AXValueGetValue(unsafeBitCast(dimensions, to: AXValue.self), .cgSize, &size)
        result["controlRect"] = rect(CGRect(origin: point, size: size), scale: scale)
    }
    if let selected = attribute(element, kAXSelectedTextRangeAttribute), CFGetTypeID(selected) == AXValueGetTypeID() {
        var range = CFRange(location: 0, length: 0)
        AXValueGetValue(unsafeBitCast(selected, to: AXValue.self), .cfRange, &range)
        // No selected text is read. Noncollapsed selection bounds are not a caret.
        if range.length == 0 {
            var bounds: CFTypeRef?
            if AXUIElementCopyParameterizedAttributeValue(element, kAXBoundsForRangeParameterizedAttribute as CFString, selected, &bounds) == .success,
               let bounds = bounds, CFGetTypeID(bounds) == AXValueGetTypeID() {
                var value = CGRect.zero
                AXValueGetValue(unsafeBitCast(bounds, to: AXValue.self), .cgRect, &value)
                result["caretRect"] = rect(value, scale: scale)
            }
        }
    }
    return result
}
while readLine() != nil {
    autoreleasepool {
        let value = snapshot()
        if let data = try? JSONSerialization.data(withJSONObject: value), let line = String(data: data, encoding: .utf8) {
            print(line); fflush(stdout)
        } else { print("{\"available\":false,\"reason\":\"unavailable\"}"); fflush(stdout) }
    }
}
