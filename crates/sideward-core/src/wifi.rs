//! Direct Wi-Fi support.
//!
//! `setup_over_usb` saves the device's pairing record and turns on lockdownd's Wi-Fi listener.
//! After that, Sideward can find the device on the local network over Bonjour
//! (`_apple-mobdev2._tcp`) and talk to it over TCP without usbmuxd, iTunes, or a cable.

use std::{
    collections::{BTreeMap, HashSet},
    net::IpAddr,
    path::Path,
    time::{Duration, Instant},
};

use anyhow::{Context, Result, bail};
use chrono::{DateTime, Utc};
use idevice::{
    IdeviceService,
    lockdown::LockdownClient,
    pairing_file::PairingFile,
    provider::TcpProvider,
    usbmuxd::{Connection, UsbmuxdAddr},
};
use serde::{Deserialize, Serialize};
use tracing::{debug, info};

use crate::{
    device::{Device, read_identity, usbmuxd},
    paths::{Paths, read_json, write_json},
};

const BONJOUR_SERVICE: &str = "_apple-mobdev2._tcp.local.";
const WIRELESS_DOMAIN: &str = "com.apple.mobile.wireless_lockdown";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedWifiDevice {
    pub udid: String,
    pub name: String,
    pub wifi_mac: String,
    pub last_ip: Option<IpAddr>,
    pub saved_at: DateTime<Utc>,
}

pub fn list_saved(paths: &Paths) -> Result<Vec<SavedWifiDevice>> {
    let map: BTreeMap<String, SavedWifiDevice> = read_json(&paths.wifi_devices_file())?;
    Ok(map.into_values().collect())
}

fn save_device(paths: &Paths, device: SavedWifiDevice) -> Result<()> {
    let mut map: BTreeMap<String, SavedWifiDevice> = read_json(&paths.wifi_devices_file())?;
    map.insert(device.udid.clone(), device);
    write_json(&paths.wifi_devices_file(), &map)
}

pub(crate) fn remember_ip(paths: &Paths, udid: &str, ip: IpAddr) -> Result<()> {
    let mut map: BTreeMap<String, SavedWifiDevice> = read_json(&paths.wifi_devices_file())?;
    if let Some(d) = map.get_mut(udid)
        && d.last_ip != Some(ip)
    {
        d.last_ip = Some(ip);
        write_json(&paths.wifi_devices_file(), &map)?;
    }
    Ok(())
}

pub fn load_pairing(paths: &Paths, udid: &str) -> Result<PairingFile> {
    let path = paths.pairing_file(udid);
    PairingFile::read_from_file(&path).with_context(|| {
        format!("No saved pairing for {udid}. Run `sideward wifi setup` with the device plugged in over USB.")
    })
}

fn write_pairing(paths: &Paths, udid: &str, pairing: PairingFile) -> Result<()> {
    std::fs::create_dir_all(paths.pairings_dir())?;
    let bytes = pairing
        .serialize()
        .context("Failed to serialize pairing file")?;
    std::fs::write(paths.pairing_file(udid), bytes)?;
    Ok(())
}

/// Forget a Wi-Fi device and delete its pairing file.
pub fn forget(paths: &Paths, udid: &str) -> Result<bool> {
    let mut map: BTreeMap<String, SavedWifiDevice> = read_json(&paths.wifi_devices_file())?;
    let removed = map.remove(udid).is_some();
    write_json(&paths.wifi_devices_file(), &map)?;
    let _ = std::fs::remove_file(paths.pairing_file(udid));
    Ok(removed)
}

/// One-time setup over USB: get (or create) a pairing record, enable Wi-Fi connections on the
/// device, and save everything needed to reach it over Wi-Fi later.
pub async fn setup_over_usb(paths: &Paths, udid: Option<&str>) -> Result<SavedWifiDevice> {
    let mut mux = usbmuxd().await?;
    let usb_devices: Vec<_> = mux
        .get_devices()
        .await
        .context("Failed to list devices from usbmuxd")?
        .into_iter()
        .filter(|d| d.connection_type == Connection::Usb)
        .collect();
    let device = match udid {
        Some(udid) => usb_devices
            .into_iter()
            .find(|d| d.udid.eq_ignore_ascii_case(udid))
            .with_context(|| format!("{udid} is not connected over USB"))?,
        None => match usb_devices.len() {
            0 => bail!("No device connected over USB. Wi-Fi setup needs a cable once."),
            1 => usb_devices.into_iter().next().expect("one device"),
            _ => bail!("Several USB devices connected; pick one with --device <udid>"),
        },
    };
    let addr = UsbmuxdAddr::from_env_var().context("Invalid USBMUXD_SOCKET_ADDRESS")?;
    let provider = device.to_provider(addr, "sideward");

    let mut pairing = match mux.get_pair_record(&device.udid).await {
        Ok(p) => p,
        Err(e) => {
            info!(
                "No pairing record in usbmuxd ({e}); pairing now. Unlock the device and tap Trust."
            );
            let buid = mux
                .get_buid()
                .await
                .context("Failed to read the host BUID")?;
            let host_id = uuid::Uuid::new_v4().to_string().to_uppercase();
            let mut lockdown = LockdownClient::connect(&provider).await?;
            let pairing = tokio::time::timeout(
                Duration::from_secs(120),
                lockdown.pair(host_id, buid, Some("Sideward")),
            )
            .await
            .context("Timed out waiting for Trust on the device")?
            .context("Pairing failed. Unlock the device, tap Trust, and try again.")?;
            mux.save_pair_record(&device.udid, pairing.clone().serialize()?)
                .await
                .context("Failed to save the pairing record to usbmuxd")?;
            pairing
        }
    };
    pairing.udid = Some(device.udid.clone());

    let mut lockdown = LockdownClient::connect(&provider).await?;
    lockdown
        .start_session(&pairing)
        .await
        .context("Failed to start a lockdown session. Unlock the device and try again.")?;
    lockdown
        .set_value("EnableWifiDebugging", true.into(), Some(WIRELESS_DOMAIN))
        .await
        .context("Failed to enable Wi-Fi connections on the device")?;
    let name = lockdown
        .get_value(Some("DeviceName"), None)
        .await?
        .as_string()
        .unwrap_or("iOS device")
        .to_string();

    let saved = SavedWifiDevice {
        udid: device.udid.clone(),
        name,
        wifi_mac: pairing.wifi_mac_address.to_lowercase(),
        last_ip: None,
        saved_at: Utc::now(),
    };
    write_pairing(paths, &device.udid, pairing)?;
    save_device(paths, saved.clone())?;
    Ok(saved)
}

/// Import a pairing file made by another tool (SideStore, iloader, Jitterbug, idevice_pair...).
/// If the file has no UDID, `ip` is used to ask the device for it.
pub async fn import_pairing(
    paths: &Paths,
    file: &Path,
    ip: Option<IpAddr>,
) -> Result<SavedWifiDevice> {
    let bytes =
        std::fs::read(file).with_context(|| format!("Failed to read {}", file.display()))?;
    let mut pairing = PairingFile::from_bytes(&bytes).context("Not a valid pairing file")?;

    let (udid, name, ip) = match (pairing.udid.clone(), ip) {
        (_, Some(ip)) => {
            let provider = tcp_provider(ip, pairing.clone());
            let (udid, name, _) =
                tokio::time::timeout(Duration::from_secs(10), read_identity(&provider, true))
                    .await
                    .with_context(|| format!("Timed out connecting to {ip}"))?
                    .with_context(|| {
                        format!("The pairing file doesn't work with the device at {ip}")
                    })?;
            (udid, name, Some(ip))
        }
        (Some(udid), None) => (udid, "iOS device".to_string(), None),
        (None, None) => {
            bail!("This pairing file has no UDID; pass --ip so Sideward can ask the device")
        }
    };
    pairing.udid = Some(udid.clone());

    let saved = SavedWifiDevice {
        udid: udid.clone(),
        name,
        wifi_mac: pairing.wifi_mac_address.to_lowercase(),
        last_ip: ip,
        saved_at: Utc::now(),
    };
    write_pairing(paths, &udid, pairing)?;
    save_device(paths, saved.clone())?;
    Ok(saved)
}

/// Copy a saved pairing file out, e.g. for SideStore, StikDebug, or another computer.
pub fn export_pairing(paths: &Paths, udid: &str, out: &Path) -> Result<()> {
    let pairing = load_pairing(paths, udid)?;
    std::fs::write(out, pairing.serialize()?)
        .with_context(|| format!("Failed to write {}", out.display()))?;
    Ok(())
}

fn tcp_provider(ip: IpAddr, pairing: PairingFile) -> TcpProvider {
    TcpProvider {
        addr: ip,
        scope_id: None,
        pairing_file: pairing,
        label: "sideward".to_string(),
    }
}

/// A `_apple-mobdev2._tcp` announcement.
#[derive(Debug, Clone)]
struct Announcement {
    instance: String,
    identifier: Option<Vec<u8>>,
    auth_tag: Option<Vec<u8>>,
    addresses: Vec<IpAddr>,
}

impl Announcement {
    /// Before iOS 26.4 the instance name is `<wifi mac>@<ipv6>`; newer versions publish an
    /// `identifier` and an `authTag` derived from the pairing's HostID.
    fn matches(&self, pairing: &PairingFile) -> bool {
        self.matches_identity(&pairing.wifi_mac_address, &pairing.host_id)
    }

    fn matches_identity(&self, wifi_mac: &str, host_id: &str) -> bool {
        let mac = wifi_mac.to_lowercase();
        if !mac.is_empty() && self.instance.to_lowercase().starts_with(&format!("{mac}@")) {
            return true;
        }
        match (&self.identifier, &self.auth_tag) {
            (Some(identifier), Some(tag)) => {
                idevice::mdns::txt_record_matches(host_id.as_bytes(), identifier, &[tag.as_slice()])
            }
            _ => false,
        }
    }
}

fn browse(timeout: Duration) -> Result<Vec<Announcement>> {
    let daemon = mdns_sd::ServiceDaemon::new().context("Failed to start mDNS")?;
    let receiver = daemon
        .browse(BONJOUR_SERVICE)
        .context("Failed to browse for devices")?;
    let deadline = Instant::now() + timeout;
    let mut found: BTreeMap<String, Announcement> = BTreeMap::new();
    while let Some(remaining) = deadline.checked_duration_since(Instant::now()) {
        let Ok(event) = receiver.recv_timeout(remaining) else {
            break;
        };
        if let mdns_sd::ServiceEvent::ServiceResolved(service) = event {
            let instance = service
                .fullname
                .strip_suffix(BONJOUR_SERVICE)
                .unwrap_or(&service.fullname)
                .trim_end_matches('.')
                .to_string();
            let mut addresses: Vec<IpAddr> =
                service.addresses.iter().map(|a| a.to_ip_addr()).collect();
            // IPv4 first: link-local IPv6 needs a scope id we don't track
            addresses.sort_by_key(|a| (!a.is_ipv4(), a.to_string()));
            let prop = |key: &str| {
                service
                    .txt_properties
                    .get_property_val(key)
                    .flatten()
                    .map(<[u8]>::to_vec)
            };
            debug!("Bonjour: {instance} at {addresses:?}");
            found.insert(
                service.fullname.clone(),
                Announcement {
                    instance,
                    identifier: prop("identifier"),
                    auth_tag: prop("authTag"),
                    addresses,
                },
            );
        }
    }
    let _ = daemon.shutdown();
    Ok(found.into_values().collect())
}

/// Find saved Wi-Fi devices on the local network.
pub(crate) async fn find_direct_devices(paths: &Paths, timeout: Duration) -> Result<Vec<Device>> {
    let saved = list_saved(paths)?;
    if saved.is_empty() {
        return Ok(Vec::new());
    }
    let announcements = tokio::task::spawn_blocking(move || browse(timeout)).await??;

    let mut found = Vec::new();
    let mut claimed: HashSet<IpAddr> = HashSet::new();
    for device in saved {
        let Ok(pairing) = load_pairing(paths, &device.udid) else {
            continue;
        };
        // Try announcements that match this pairing first, then the last address that worked,
        // then any announcement nobody claimed (covers devices whose tag we couldn't decode)
        let mut candidates: Vec<IpAddr> = Vec::new();
        for a in announcements.iter().filter(|a| a.matches(&pairing)) {
            candidates.extend(a.addresses.iter().copied().filter(IpAddr::is_ipv4));
        }
        candidates.extend(device.last_ip);
        for a in announcements.iter().filter(|a| !a.matches(&pairing)) {
            candidates.extend(a.addresses.iter().copied().filter(IpAddr::is_ipv4));
        }
        let mut seen = HashSet::new();
        candidates.retain(|ip| seen.insert(*ip) && !claimed.contains(ip));

        for ip in candidates {
            let provider = tcp_provider(ip, pairing.clone());
            match tokio::time::timeout(Duration::from_secs(3), read_identity(&provider, true)).await
            {
                Ok(Ok((udid, name, version))) if udid == device.udid => {
                    claimed.insert(ip);
                    remember_ip(paths, &udid, ip).ok();
                    found.push(Device::direct(udid, name, Some(version), ip));
                    break;
                }
                Ok(Ok(_)) => {}
                Ok(Err(e)) => debug!("{ip} is not {}: {e:#}", device.udid),
                Err(_) => debug!("{ip} timed out"),
            }
        }
    }
    Ok(found)
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;

    fn announcement(
        instance: &str,
        identifier: Option<&[u8]>,
        auth_tag: Option<Vec<u8>>,
    ) -> Announcement {
        Announcement {
            instance: instance.into(),
            identifier: identifier.map(<[u8]>::to_vec),
            auth_tag,
            addresses: vec![],
        }
    }

    #[test]
    fn matches_legacy_mac_instance_names() {
        let a = announcement("C8:3C:85:12:34:56@fe80::ca3c:85ff:fe12:3456", None, None);
        assert!(a.matches_identity("c8:3c:85:12:34:56", "HOST"));
        assert!(!a.matches_identity("c8:3c:85:00:00:00", "HOST"));
        assert!(!a.matches_identity("", "HOST"));
    }

    #[test]
    fn matches_ios_26_auth_tags() {
        let host_id = "5D3E8B2A-0000-4000-8000-123456789ABC";
        let identifier = b"abc123";
        let tag = idevice::mdns::derive_auth_tag(host_id.as_bytes(), identifier);
        let encoded = base64::engine::general_purpose::STANDARD
            .encode(tag)
            .into_bytes();
        let a = announcement("iPhone", Some(identifier), Some(encoded));
        assert!(a.matches_identity("", host_id));
        assert!(!a.matches_identity("", "SOME-OTHER-HOST"));
    }
}
