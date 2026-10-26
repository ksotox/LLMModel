use std::collections::BTreeMap;

use anyhow::Result;
use serde::{Deserialize, Serialize};

use crate::{anisette, paths::Paths};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Config {
    /// Last Apple ID used, so commands don't need `--apple-id` every time.
    pub apple_id: Option<String>,
    pub anisette_server: String,
    /// Try the other Mac anisette servers when Apple rejects the current one.
    pub anisette_auto_fallback: bool,
    /// Remembered team per Apple ID, for accounts that belong to several teams.
    pub teams: BTreeMap<String, String>,
    /// Shown next to the development certificate on Apple's side.
    pub machine_name: String,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            apple_id: None,
            anisette_server: anisette::DEFAULT_SERVER.to_string(),
            anisette_auto_fallback: true,
            teams: BTreeMap::new(),
            machine_name: "Sideward".to_string(),
        }
    }
}

impl Config {
    pub fn load(paths: &Paths) -> Result<Self> {
        crate::paths::read_json(&paths.config_file())
    }

    pub fn save(&self, paths: &Paths) -> Result<()> {
        crate::paths::write_json(&paths.config_file(), self)
    }
}
