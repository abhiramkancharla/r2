import Foundation

// Per user spec: capture EVERYTHING by default. Only block banking sites.
// (Incognito/Private-window blocking is still in effect per earlier ground rule.)

let blockedBundleIDs: Set<String> = [
    // Intentionally empty — capture all apps. Banks are blocked via window title.
]

// Window-title patterns that indicate banking sites. Matched case-insensitively
// against the frontmost-window title. Browser tab title appears in window title
// for Chrome/Safari/Arc/Firefox, so this catches banking websites in any browser.
let blockedTitlePatterns: [NSRegularExpression] = {
    let raw = [
        // Major US retail banks
        #"(?i)\bbank\s*of\s*america\b"#,
        #"(?i)\bbankofamerica\b"#,
        #"(?i)\bj\.?p\.?\s*morgan\b"#,
        #"(?i)\bjpmorgan\b"#,
        #"(?i)\bchase\b"#,
        #"(?i)\bwells\s*fargo\b"#,
        #"(?i)\bwellsfargo\b"#,
        #"(?i)\bcitibank\b"#,
        #"(?i)\bcitigroup\b"#,
        #"(?i)\bcapital\s*one\b"#,
        #"(?i)\bcapitalone\b"#,
        #"(?i)\busaa\b"#,
        #"(?i)\bally\s*bank\b"#,
        #"(?i)\bu\.?s\.?\s*bank\b"#,
        #"(?i)\bpnc\s*bank\b"#,
        #"(?i)\btd\s*bank\b"#,
        #"(?i)\btruist\b"#,
        #"(?i)\bbmo\s*(harris|bank)\b"#,
        #"(?i)\bgoldman\s*sachs\b"#,
        #"(?i)\bmarcus\b.*\bgoldman\b"#,
        #"(?i)\bdiscover\s*(bank|card)\b"#,
        // International
        #"(?i)\bhsbc\b"#,
        #"(?i)\bsantander\b"#,
        #"(?i)\bbarclays\b"#,
        #"(?i)\bdeutsche\s*bank\b"#,
        #"(?i)\bbnp\s*paribas\b"#,
        #"(?i)\bsociete\s*generale\b"#,
        #"(?i)\bcredit\s*suisse\b"#,
        #"(?i)\bubs\s*bank\b"#,
        #"(?i)\bing\s*bank\b"#,
        #"(?i)\brbs\b"#,
        #"(?i)\blloyds\b"#,
        #"(?i)\bnatwest\b"#,
        // Incognito/private markers (kept per earlier rule)
        #"(?i)\(Private\b"#,
        #"(?i)Private\s*Browsing"#,
        #"(?i)\(Incognito\b"#
    ]
    return raw.compactMap { try? NSRegularExpression(pattern: $0) }
}()

func isBlockedTitle(_ title: String) -> Bool {
    let ns = title as NSString
    for re in blockedTitlePatterns {
        if re.firstMatch(in: title, range: NSRange(location: 0, length: ns.length)) != nil {
            return true
        }
    }
    return false
}

func isBlockedBundle(_ bundleID: String?) -> Bool {
    guard let id = bundleID else { return false }
    return blockedBundleIDs.contains(id)
}
