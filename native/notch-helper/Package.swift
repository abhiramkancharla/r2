// swift-tools-version:5.9
import PackageDescription

// Second native sidecar — renders a hover-expanding chat bar attached to
// the macOS notch via DynamicNotchKit. Runs as its own NSApplication so
// the SwiftUI / AppKit stack DynamicNotchKit needs is available.
//
// Communication with Electron is one-way for now: each user send becomes
// a JSON line on stdout. stdin is reserved for future show/hide commands.

let package = Package(
    name: "NotchHelper",
    platforms: [
        .macOS(.v14)            // DynamicNotchKit needs Sonoma+
    ],
    dependencies: [
        .package(url: "https://github.com/MrKai77/DynamicNotchKit.git", from: "1.0.0")
    ],
    targets: [
        .executableTarget(
            name: "NotchHelper",
            dependencies: [
                .product(name: "DynamicNotchKit", package: "DynamicNotchKit")
            ],
            path: "Sources/NotchHelper"
        )
    ]
)
