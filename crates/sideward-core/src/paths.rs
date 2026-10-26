use std::path::{Path, PathBuf};

use anyhow::{Context, Result};

/// On-disk layout of Sideward's data directory.
///
/// Defaults to the platform data dir (e.g. `~/.local/share/sideward`,
/// `%APPDATA%\sideward\data`, `~/Library/Application Support/dev.sideward.Sideward`),
/// overridable with `SIDEWARD_HOME`.
#[derive(Debug, Clone)]
pub struct Paths {
    root: PathBuf,
}

impl Paths {
    pub fn new(root_override: Option<PathBuf>) -> Result<Self> {
        let root =
            match root_override.or_else(|| std::env::var_os("SIDEWARD_HOME").map(PathBuf::from)) {
                Some(root) => root,
                None => directories::ProjectDirs::from("dev", "sideward", "Sideward")
                    .context("Could not determine a data directory; set SIDEWARD_HOME")?
                    .data_dir()
                    .to_path_buf(),
            };
        std::fs::create_dir_all(&root)
            .with_context(|| format!("Failed to create data directory {}", root.display()))?;
        Ok(Self { root })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn config_file(&self) -> PathBuf {
        self.root.join("config.json")
    }

    /// Anisette state is tied to the server that provisioned it, so each server gets its own dir.
    pub fn anisette_dir(&self, server_url: &str) -> PathBuf {
        let host: String = server_url
            .trim_start_matches("https://")
            .trim_start_matches("http://")
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || c == '.' || c == '-' {
                    c
                } else {
                    '_'
                }
            })
            .collect();
        self.root.join("anisette").join(host)
    }

    /// Development certificates and keys created by isideload.
    pub fn signing_dir(&self) -> PathBuf {
        self.root.join("signing")
    }

    pub fn pairings_dir(&self) -> PathBuf {
        self.root.join("pairings")
    }

    pub fn pairing_file(&self, udid: &str) -> PathBuf {
        self.pairings_dir().join(format!("{udid}.plist"))
    }

    pub fn wifi_devices_file(&self) -> PathBuf {
        self.root.join("wifi_devices.json")
    }

    /// Copies of installed IPAs, kept so apps can be refreshed later.
    pub fn apps_dir(&self) -> PathBuf {
        self.root.join("apps")
    }

    pub fn registry_file(&self) -> PathBuf {
        self.root.join("installed.json")
    }

    /// Scratch space for extracting and modifying apps before signing.
    pub fn work_dir(&self) -> PathBuf {
        self.root.join("work")
    }
}

pub(crate) fn read_json<T: serde::de::DeserializeOwned + Default>(path: &Path) -> Result<T> {
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .with_context(|| format!("Failed to parse {}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(T::default()),
        Err(e) => Err(e).with_context(|| format!("Failed to read {}", path.display())),
    }
}

pub(crate) fn write_json<T: serde::Serialize>(path: &Path, value: &T) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(value)?)
        .with_context(|| format!("Failed to write {}", tmp.display()))?;
    std::fs::rename(&tmp, path).with_context(|| format!("Failed to write {}", path.display()))?;
    Ok(())
}
