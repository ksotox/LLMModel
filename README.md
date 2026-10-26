# Sideward

Sideload iOS apps with your Apple ID over **USB or Wi-Fi**. It's an open-source alternative to Sideloadly, built on [isideload](https://github.com/nab138/isideload), the library behind [iloader](https://github.com/nab138/iloader).

Sideward ships as a desktop app (`sideward-gui`) and a command-line tool (`sideward`). Both run on Windows, macOS and Linux.

## Why another sideloader?

- **Apple ID login that works in 2026.** In October 2026 Apple started rejecting Android-emulated anisette data, which shows up as `Login failed (-80045/-80046): This action cannot be completed at this time`. Sideward uses the same fix as iloader 2.4: Mac-emulating anisette servers, with the client info fetched from the server. If Apple rejects one server, it switches to the next automatically.
- **Wi-Fi without iTunes.** Plug in once and run `wifi setup`. After that, Sideward finds the device on your network over Bonjour and installs over plain TCP using the saved pairing file. Neither usbmuxd nor iTunes has to see the device. Wi-Fi sync through iTunes/Finder (usbmuxd) works too.
- **Auto-refresh.** Free Apple IDs sign apps for 7 days. Sideward remembers what it installed, keeping a copy of the IPA and any tweaks, and `sideward daemon` re-signs apps before they expire, over Wi-Fi or USB.
- **Sideloadly's advanced options:** change name, bundle ID, version, or minimum iOS; enable file sharing; remove device restrictions, extensions, or the Watch app; inject tweaks (`.dylib`, `.framework`, `.bundle`, rootful or rootless `.deb`).
- **Safety checks.** It refuses encrypted App Store IPAs up front, and when your account hits its certificate limit it asks which certificate to revoke.

## Install

Download a build from the repository's Actions artifacts, or build it yourself with Rust 1.88 or newer:

```sh
cargo build --release                 # CLI -> target/release/sideward
cargo build --release -p sideward-gui # app -> target/release/sideward-gui
```

Platform notes:

| Platform | USB | Wi-Fi |
|---|---|---|
| Windows | Install **iTunes from apple.com** (not the Microsoft Store version) for Apple Mobile Device Support | Works without iTunes after `wifi setup` |
| macOS | Built in | Built in |
| Linux | Install and start `usbmuxd` | Works without usbmuxd after `wifi setup` |

## Desktop app

Run `sideward-gui`, sign in, pick a device, and drop an `.ipa` onto the window. When a USB device is selected, **Enable Wi-Fi installs** sets it up for wireless installs. The **My apps** tab shows when each app expires and refreshes them.

## Command line

```sh
sideward login --save-password          # Apple ID; password goes to the OS keychain
sideward devices                        # USB, Wi-Fi (usbmuxd), and Wi-Fi (direct)
sideward install YouTube.ipa            # sign + install to the only/best device
sideward install App.ipa -d "My iPhone" --wifi
sideward install App.ipa --ip 192.168.1.42
```

### Wi-Fi

```sh
sideward wifi setup                     # once, with the device on USB (tap Trust if asked)
sideward devices --wifi                 # finds it on the same network
sideward wifi import pairing.plist      # use a pairing file from SideStore / iloader / Jitterbug
sideward wifi export <UDID> out.plist   # hand the pairing to SideStore, StikDebug, ...
```

Direct Wi-Fi needs the computer and the device on the same network, with the device unlocked at least once since it booted.

### App changes (Sideloadly's "Advanced options")

```sh
sideward install YouTube.ipa \
  --name "YouTube+" --bundle-id com.me.youtube \
  --inject YTLitePlus.deb --inject CydiaSubstrate.framework \
  --file-sharing --remove-extensions
```

| Flag | Effect |
|---|---|
| `--name`, `--bundle-id`, `--app-version`, `--min-ios` | Edit `Info.plist` (extension bundle IDs follow `--bundle-id`) |
| `--file-sharing` | Show the app's Documents in the Files app |
| `--remove-supported-devices` | Drop `UISupportedDevices` |
| `--remove-extensions`, `--remove-watch` | Delete `PlugIns`/`Extensions` or `Watch` |
| `--inject PATH` | Copy into `Frameworks/` and add a load command; `.deb` packages are unpacked and their dylibs, frameworks, and bundles injected; references to `/Library/Frameworks/...` and `/usr/lib/...` are re-pointed at `@rpath` |
| `--register-extensions` | A separate App ID per extension (default: reuse the main one, which saves App IDs) |
| `--increased-memory-limit` | Add the increased-memory-limit entitlement |

Tweaks built against CydiaSubstrate need a substrate framework in the app; inject ElleKit's `CydiaSubstrate.framework` alongside them. Sideward warns you when it's missing.

`sideward export App.ipa -o signed.ipa` signs without installing, and `sideward inspect App.ipa` shows bundle ID, version, extensions, and whether the IPA is encrypted.

### Refreshing apps

```sh
sideward apps list                      # what's installed and when it expires
sideward refresh                        # re-sign apps expiring within 2 days
sideward daemon --interval-hours 6      # keep doing that in the background
```

The daemon logs in with the saved password (`login --save-password`, or `SIDEWARD_PASSWORD`). Apps keep their data when refreshed.

### Account housekeeping

```sh
sideward certs list | sideward certs revoke <serial>
sideward appids list | sideward appids delete <id>   # free accounts: 10 App IDs per week
sideward anisette list | sideward anisette set ani3.stikstore.app
```

## Troubleshooting

| Message | Fix |
|---|---|
| `-80045` / `-80046` "This action cannot be completed at this time" | Anisette data rejected. Leave automatic fallback on, or `sideward anisette set` another Mac server |
| `-22406` | Wrong Apple ID or password. Use your real password, not an app-specific one |
| `-36607` | Apple is rate-limiting this login. Wait a few minutes |
| "Could not reach usbmuxd" | Windows: install iTunes from apple.com. Linux: start `usbmuxd`. Wi-Fi direct still works |
| "This IPA is encrypted" | You have an App Store copy. Use a decrypted IPA |
| Certificate limit | Pick one to revoke when asked, or pass `--auto-revoke` (it prefers Sideward's own old certificate) |

## Where data lives

The platform data directory (`%APPDATA%\sideward`, `~/Library/Application Support/dev.sideward.Sideward`, or `~/.local/share/sideward`), overridable with `SIDEWARD_HOME`. It holds anisette state per server, the signing key and certificate, pairing files, and copies of remembered apps. Passwords are only stored in the OS keychain.

## Layout

```
crates/sideward-core   library: login, devices, Wi-Fi, IPA edits, injection, signing, refresh
apps/sideward-cli      `sideward` command-line tool
apps/sideward-gui      `sideward-gui` desktop app (egui)
```

## Credits

[isideload](https://github.com/nab138/isideload) and [iloader](https://github.com/nab138/iloader) by nab138 (MIT), and [idevice](https://github.com/jkcoxson/idevice) by jkcoxson (MIT). Thanks also to the anisette server operators (jkcoxson, SideStore, StikStore). Sideward isn't affiliated with Apple or Sideloadly.

## License

MIT
