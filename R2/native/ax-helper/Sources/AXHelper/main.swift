import Foundation
import Cocoa

setbuf(stdout, nil) // line-flush JSON to parent (Electron) immediately

let app = NSApplication.shared
let manager = Manager()
manager.start()

// Background reader for stdin commands from Electron main process.
// Each line is a JSON object like {"cmd":"siteHint","pid":1234,"site":"chatgpt"}.
DispatchQueue.global(qos: .utility).async {
    while let line = readLine(strippingNewline: true) {
        guard let data = line.data(using: .utf8) else { continue }
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
        DispatchQueue.main.async {
            manager.handleCommand(obj)
        }
    }
}

NSApp.setActivationPolicy(.accessory) // no Dock icon
app.run()
