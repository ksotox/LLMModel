//! Anisette servers.
//!
//! In October 2026 Apple started rejecting Android-emulated anisette data, which shows up as
//! login errors like -80045 / -80046 ("This action cannot be completed at this time").
//! The servers below emulate a Mac, matching iloader 2.4's list.

/// `(url, label, reliable)`.
pub const SERVERS: &[(&str, &str, bool)] = &[
    ("https://mac-ani.jkcoxson.com", "Jkcoxson (Mac)", true),
    ("https://new.ani.sidestore.io", "SideStore (Mac)", true),
    ("https://ani3.stikstore.app", "StikStore (Mac)", true),
    // Windows-emulating servers work roughly half the time and don't support SMS 2FA
    ("https://ani.jkcoxson.com", "Jkcoxson (Windows)", false),
    ("https://ani2.stikstore.app", "StikStore (Windows)", false),
];

pub const DEFAULT_SERVER: &str = "https://mac-ani.jkcoxson.com";

/// Accept bare hostnames as well as full URLs.
pub fn normalize(server: &str) -> String {
    let server = server.trim().trim_end_matches('/');
    if server.starts_with("http://") || server.starts_with("https://") {
        server.to_string()
    } else {
        format!("https://{server}")
    }
}

/// The preferred server first, then the remaining reliable servers.
pub fn fallback_order(preferred: &str, auto_fallback: bool) -> Vec<String> {
    let preferred = normalize(preferred);
    let mut order = vec![preferred.clone()];
    if auto_fallback {
        order.extend(
            SERVERS
                .iter()
                .filter(|(url, _, reliable)| *reliable && *url != preferred)
                .map(|(url, _, _)| url.to_string()),
        );
    }
    order
}

/// Errors that a different anisette server may fix.
pub fn is_anisette_related(message: &str) -> bool {
    const MARKERS: &[&str] = &[
        "-80045",
        "-80046",
        "-45061",
        "-36607",
        "anisette",
        "client_info",
        "provision",
    ];
    let lower = message.to_lowercase();
    MARKERS.iter().any(|m| lower.contains(m))
}

/// Human hint for well-known Apple auth errors.
pub fn hint_for_error(message: &str) -> Option<&'static str> {
    if message.contains("-22406") {
        Some(
            "Apple rejected the Apple ID or password. Check them, and use your main Apple ID password (not an app-specific one).",
        )
    } else if message.contains("-80045") || message.contains("-80046") {
        Some(
            "Apple rejected the anisette data. Try another server with `sideward anisette set`, or keep auto-fallback on.",
        )
    } else if message.contains("-36607") {
        Some(
            "Apple temporarily blocked this login. Wait a few minutes, or switch anisette servers.",
        )
    } else if message.contains("-20209") {
        Some("This Apple ID is locked. Unlock it at iforgot.apple.com.")
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_hosts() {
        assert_eq!(
            normalize("ani3.stikstore.app/"),
            "https://ani3.stikstore.app"
        );
        assert_eq!(normalize("http://localhost:6969"), "http://localhost:6969");
    }

    #[test]
    fn fallback_puts_preferred_first_without_duplicates() {
        let order = fallback_order("new.ani.sidestore.io", true);
        assert_eq!(order[0], "https://new.ani.sidestore.io");
        assert_eq!(order.iter().filter(|s| s.contains("sidestore")).count(), 1);
        assert!(!order.iter().any(|s| s == "https://ani.jkcoxson.com"));
        assert_eq!(
            fallback_order("x.example", false),
            vec!["https://x.example"]
        );
    }

    #[test]
    fn detects_anisette_errors() {
        assert!(is_anisette_related(
            "Auth error -80046: This action cannot be completed at this time."
        ));
        assert!(!is_anisette_related(
            "Auth error -22406: Incorrect password"
        ));
    }
}
