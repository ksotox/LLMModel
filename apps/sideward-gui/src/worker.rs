//! Background thread that owns the tokio runtime and the logged-in session. The UI sends
//! [`Cmd`]s and receives [`Event`]s, so the window never blocks on the network or a device.

use std::{net::IpAddr, path::PathBuf, sync::Arc};

use anyhow::Result;
use async_trait::async_trait;
use isideload::{
    auth::apple_account::{TwoFactorCallbackParams, TwoFactorCallbackResponse},
    dev::{certificates::DevelopmentCertificate, teams::DeveloperTeam},
};
use sideward_core::{
    Config, Paths, Prompter, Session,
    account::{self, LoginRequest},
    credentials,
    device::{self, Device, DiscoverOptions},
    install::{self, InstallRequest, Progress, ProgressFn},
    ipa::{self, AppInfo, AppOptions},
    registry::{self, InstalledApp},
    wifi,
};
use tokio::sync::{mpsc, oneshot};

pub enum Cmd {
    Login {
        apple_id: String,
        /// Empty means "use the saved password".
        password: String,
        save_password: bool,
    },
    Discover,
    SetupWifi {
        udid: String,
    },
    ConnectIp {
        ip: IpAddr,
    },
    Inspect(PathBuf),
    Install {
        device: Box<Device>,
        request: InstallRequest,
    },
    Export {
        source: PathBuf,
        options: AppOptions,
        out: PathBuf,
    },
    Refresh {
        force: bool,
    },
    ForgetApp(String),
    SaveConfig(Config),
    Pick(PickKind),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PickKind {
    App,
    Tweak,
    ExportTarget,
}

pub enum Prompt {
    TwoFactor {
        params: TwoFactorCallbackParams,
        reply: oneshot::Sender<TwoFactorCallbackResponse>,
    },
    Team {
        teams: Vec<DeveloperTeam>,
        reply: oneshot::Sender<Option<String>>,
    },
    Certificates {
        certs: Vec<DevelopmentCertificate>,
        reply: oneshot::Sender<Option<Vec<String>>>,
    },
}

pub enum Event {
    Log(String),
    Error(String),
    Config {
        config: Config,
        has_saved_password: bool,
    },
    LoggedIn {
        apple_id: String,
        team: String,
        server: String,
    },
    Devices(Vec<Device>),
    AppInfo(PathBuf, Result<AppInfo, String>),
    Progress(Progress),
    Busy(Option<String>),
    Apps(Vec<InstalledApp>),
    Prompt(Prompt),
    Picked(PickKind, Option<PathBuf>),
}

#[derive(Clone)]
struct Outbox {
    tx: std::sync::mpsc::Sender<Event>,
    ctx: eframe::egui::Context,
}

impl Outbox {
    fn send(&self, event: Event) {
        let _ = self.tx.send(event);
        self.ctx.request_repaint();
    }

    fn error(&self, e: anyhow::Error) {
        self.send(Event::Error(format!("{e:#}")));
    }
}

struct GuiPrompter {
    out: Outbox,
}

#[async_trait]
impl Prompter for GuiPrompter {
    async fn two_factor(
        &self,
        params: TwoFactorCallbackParams,
    ) -> Result<TwoFactorCallbackResponse> {
        let (reply, rx) = oneshot::channel();
        self.out
            .send(Event::Prompt(Prompt::TwoFactor { params, reply }));
        Ok(rx.await.unwrap_or(TwoFactorCallbackResponse::Abort))
    }

    async fn select_team(&self, teams: &[DeveloperTeam]) -> Result<Option<String>> {
        let (reply, rx) = oneshot::channel();
        self.out.send(Event::Prompt(Prompt::Team {
            teams: teams.to_vec(),
            reply,
        }));
        Ok(rx.await.unwrap_or(None))
    }

    async fn revoke_certificates(
        &self,
        certs: Vec<DevelopmentCertificate>,
    ) -> Result<Option<Vec<String>>> {
        let (reply, rx) = oneshot::channel();
        self.out
            .send(Event::Prompt(Prompt::Certificates { certs, reply }));
        Ok(rx.await.unwrap_or(None))
    }
}

pub fn spawn(
    ctx: eframe::egui::Context,
) -> Result<(mpsc::UnboundedSender<Cmd>, std::sync::mpsc::Receiver<Event>)> {
    let (cmd_tx, cmd_rx) = mpsc::unbounded_channel();
    let (evt_tx, evt_rx) = std::sync::mpsc::channel();
    let out = Outbox { tx: evt_tx, ctx };
    let paths = Paths::new(None)?;
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    std::thread::Builder::new()
        .name("sideward-worker".into())
        .spawn(move || runtime.block_on(Worker::new(paths, out).run(cmd_rx)))?;
    Ok((cmd_tx, evt_rx))
}

struct Worker {
    paths: Paths,
    config: Config,
    session: Option<Session>,
    out: Outbox,
}

impl Worker {
    fn new(paths: Paths, out: Outbox) -> Self {
        let config = Config::load(&paths).unwrap_or_default();
        Self {
            paths,
            config,
            session: None,
            out,
        }
    }

    fn progress(&self) -> ProgressFn {
        let out = self.out.clone();
        Arc::new(move |p| out.send(Event::Progress(p)))
    }

    fn send_config(&self) {
        let has_saved_password = self
            .config
            .apple_id
            .as_deref()
            .and_then(|id| credentials::get_password(id).ok().flatten())
            .is_some();
        self.out.send(Event::Config {
            config: self.config.clone(),
            has_saved_password,
        });
    }

    fn send_apps(&self) {
        match registry::list(&self.paths) {
            Ok(apps) => self.out.send(Event::Apps(apps)),
            Err(e) => self.out.error(e),
        }
    }

    async fn run(mut self, mut rx: mpsc::UnboundedReceiver<Cmd>) {
        self.send_config();
        self.send_apps();
        self.discover().await;
        while let Some(cmd) = rx.recv().await {
            if let Cmd::Pick(kind) = cmd {
                // File dialogs don't block other work
                let out = self.out.clone();
                tokio::spawn(async move { out.send(Event::Picked(kind, pick(kind).await)) });
                continue;
            }
            let label = match &cmd {
                Cmd::Login { .. } => Some("Logging in"),
                Cmd::Install { .. } => Some("Installing"),
                Cmd::Export { .. } => Some("Exporting"),
                Cmd::Refresh { .. } => Some("Refreshing apps"),
                Cmd::SetupWifi { .. } => Some("Setting up Wi-Fi"),
                Cmd::ConnectIp { .. } => Some("Connecting"),
                _ => None,
            };
            if let Some(label) = label {
                self.out.send(Event::Busy(Some(label.into())));
            }
            if let Err(e) = self.handle(cmd).await {
                self.out.error(e);
            }
            if label.is_some() {
                self.out.send(Event::Busy(None));
            }
        }
    }

    async fn discover(&mut self) {
        match device::discover(&self.paths, &DiscoverOptions::default()).await {
            Ok(devices) => self.out.send(Event::Devices(devices)),
            Err(e) => self.out.error(e),
        }
    }

    async fn ensure_session(&mut self) -> Result<&mut Session> {
        if self.session.is_none() {
            let apple_id = self
                .config
                .apple_id
                .clone()
                .ok_or_else(|| anyhow::anyhow!("Log in with your Apple ID first"))?;
            self.login(apple_id, String::new(), false).await?;
        }
        Ok(self.session.as_mut().expect("logged in"))
    }

    async fn login(
        &mut self,
        apple_id: String,
        password: String,
        save_password: bool,
    ) -> Result<()> {
        let password = if password.is_empty() {
            credentials::get_password(&apple_id)?
                .ok_or_else(|| anyhow::anyhow!("Enter your Apple ID password"))?
        } else {
            password
        };
        let prompter = Arc::new(GuiPrompter {
            out: self.out.clone(),
        });
        let session = account::login(
            &self.paths,
            &mut self.config,
            LoginRequest {
                apple_id: apple_id.clone(),
                password: password.clone(),
                anisette_server: None,
            },
            prompter,
        )
        .await?;
        if save_password && let Err(e) = credentials::save_password(&apple_id, &password) {
            self.out
                .send(Event::Log(format!("Couldn't save the password: {e:#}")));
        }
        self.out.send(Event::LoggedIn {
            apple_id: session.apple_id.clone(),
            team: format!(
                "{} ({})",
                session.team.name.as_deref().unwrap_or("Team"),
                session.team.team_id
            ),
            server: session.anisette_server.clone(),
        });
        self.session = Some(session);
        self.send_config();
        Ok(())
    }

    async fn handle(&mut self, cmd: Cmd) -> Result<()> {
        match cmd {
            Cmd::Login {
                apple_id,
                password,
                save_password,
            } => {
                self.session = None;
                self.login(apple_id, password, save_password).await?;
            }
            Cmd::Discover => self.discover().await,
            Cmd::SetupWifi { udid } => {
                let saved = wifi::setup_over_usb(&self.paths, Some(&udid)).await?;
                self.out.send(Event::Log(format!(
                    "Wi-Fi is set up for {}. You can unplug it; keep it on the same network.",
                    saved.name
                )));
                self.discover().await;
            }
            Cmd::ConnectIp { ip } => {
                let mut found = None;
                for saved in wifi::list_saved(&self.paths)? {
                    if let Ok(pairing) = wifi::load_pairing(&self.paths, &saved.udid)
                        && let Ok(dev) = device::direct_device(&self.paths, ip, pairing).await
                    {
                        found = Some(dev);
                        break;
                    }
                }
                let dev = found.ok_or_else(|| {
                    anyhow::anyhow!(
                        "None of the saved pairings work with {ip}. Set up Wi-Fi over USB first."
                    )
                })?;
                self.out.send(Event::Log(format!("Connected to {dev}")));
                self.discover().await;
            }
            Cmd::Inspect(path) => {
                let p = path.clone();
                let info = tokio::task::spawn_blocking(move || ipa::inspect(&p)).await?;
                self.out
                    .send(Event::AppInfo(path, info.map_err(|e| format!("{e:#}"))));
            }
            Cmd::Install { device, request } => {
                let progress = self.progress();
                let session = self.ensure_session().await?;
                let outcome = session.install(&device, &request, progress).await?;
                let mut msg = format!("Installed {} on {}.", outcome.app.name, device.name);
                if let Some(exp) = outcome.expires_at {
                    let local: chrono::DateTime<chrono::Local> = exp.into();
                    msg.push_str(&format!(" Expires {}.", local.format("%a %b %e %H:%M")));
                }
                self.out.send(Event::Log(msg));
                self.send_apps();
            }
            Cmd::Export {
                source,
                options,
                out,
            } => {
                let progress = self.progress();
                let session = self.ensure_session().await?;
                let outcome = session.export(&source, &options, &out, progress).await?;
                self.out.send(Event::Log(format!(
                    "Saved signed {} to {}",
                    outcome.app.name,
                    out.display()
                )));
            }
            Cmd::Refresh { force } => {
                let devices = device::discover(&self.paths, &DiscoverOptions::default()).await?;
                self.out.send(Event::Devices(devices.clone()));
                let progress = self.progress();
                let session = self.ensure_session().await?;
                let results = install::refresh(
                    session,
                    &devices,
                    chrono::Duration::days(2),
                    force,
                    progress,
                )
                .await?;
                if results.is_empty() {
                    self.out.send(Event::Log(
                        "Nothing to refresh (apps not due, or their devices aren't reachable)."
                            .into(),
                    ));
                }
                for r in results {
                    match r.result {
                        Ok(_) => self
                            .out
                            .send(Event::Log(format!("Refreshed {}", r.app.name))),
                        Err(e) => self.out.send(Event::Error(format!(
                            "Refreshing {} failed: {e:#}",
                            r.app.name
                        ))),
                    }
                }
                self.send_apps();
            }
            Cmd::ForgetApp(key) => {
                registry::remove(&self.paths, &key)?;
                self.send_apps();
            }
            Cmd::SaveConfig(config) => {
                // A different anisette server needs a fresh login
                if config.anisette_server != self.config.anisette_server {
                    self.session = None;
                }
                self.config = config;
                self.config.save(&self.paths)?;
                self.send_config();
            }
            Cmd::Pick(_) => unreachable!("handled in run"),
        }
        Ok(())
    }
}

async fn pick(kind: PickKind) -> Option<PathBuf> {
    let dialog = rfd::AsyncFileDialog::new();
    let handle = match kind {
        PickKind::App => {
            dialog
                .add_filter("iOS app", &["ipa", "tipa"])
                .pick_file()
                .await
        }
        PickKind::Tweak => {
            dialog
                .add_filter("Tweak", &["dylib", "deb"])
                .pick_file()
                .await
        }
        PickKind::ExportTarget => {
            dialog
                .add_filter("iOS app", &["ipa"])
                .set_file_name("signed.ipa")
                .save_file()
                .await
        }
    };
    handle.map(|h| h.path().to_path_buf())
}
