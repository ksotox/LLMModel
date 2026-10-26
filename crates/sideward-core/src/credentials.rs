//! Optional Apple ID password storage in the OS keychain (macOS Keychain, Windows Credential
//! Manager, Secret Service / keyutils on Linux). Needed for unattended `refresh`/`daemon`.

use anyhow::Result;

#[cfg(feature = "keyring")]
const SERVICE: &str = "sideward";

/// Password from `SIDEWARD_PASSWORD`, falling back to the keychain.
pub fn get_password(apple_id: &str) -> Result<Option<String>> {
    if let Ok(password) = std::env::var("SIDEWARD_PASSWORD")
        && !password.is_empty()
    {
        return Ok(Some(password));
    }
    keychain_get(apple_id)
}

#[cfg(feature = "keyring")]
fn keychain_get(apple_id: &str) -> Result<Option<String>> {
    let entry = keyring::Entry::new(SERVICE, &apple_id.to_lowercase())?;
    match entry.get_password() {
        Ok(p) => Ok(Some(p)),
        Err(keyring::Error::NoEntry) => Ok(None),
        // A missing keychain backend (e.g. headless Linux) shouldn't break logins
        Err(e) => {
            tracing::debug!("Keychain unavailable: {e}");
            Ok(None)
        }
    }
}

#[cfg(not(feature = "keyring"))]
fn keychain_get(_apple_id: &str) -> Result<Option<String>> {
    Ok(None)
}

#[cfg(feature = "keyring")]
pub fn save_password(apple_id: &str, password: &str) -> Result<()> {
    keyring::Entry::new(SERVICE, &apple_id.to_lowercase())?.set_password(password)?;
    Ok(())
}

#[cfg(not(feature = "keyring"))]
pub fn save_password(_apple_id: &str, _password: &str) -> Result<()> {
    anyhow::bail!("Built without keychain support; set SIDEWARD_PASSWORD instead")
}

#[cfg(feature = "keyring")]
pub fn delete_password(apple_id: &str) -> Result<()> {
    match keyring::Entry::new(SERVICE, &apple_id.to_lowercase())?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.into()),
    }
}

#[cfg(not(feature = "keyring"))]
pub fn delete_password(_apple_id: &str) -> Result<()> {
    Ok(())
}
