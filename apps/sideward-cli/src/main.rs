mod prompt;

use std::{
    net::IpAddr,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};

use anyhow::{Context, Result, bail};
use clap::{Args, Parser, Subcommand};
use indicatif::{ProgressBar, ProgressStyle};
use sideward_core::{
    Config, Paths, Session,
    account::{self, LoginRequest},
    anisette, credentials,
    device::{self, DiscoverOptions, TransportFilter},
    install::{self, InstallRequest, Progress, ProgressFn},
    ipa::{self, AppOptions},
    registry, wifi,
};
use tracing_subscriber::EnvFilter;

use crate::prompt::CliPrompter;

#[derive(Parser)]
#[command(
    name = "sideward",
    version,
    about = "Sideload iOS apps over USB or Wi-Fi with your Apple ID"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
    /// Data directory (default: platform data dir, or $SIDEWARD_HOME)
    #[arg(
        long,
        global = true,
        env = "SIDEWARD_HOME",
        help_heading = "Global options"
    )]
    data_dir: Option<PathBuf>,
    /// Print JSON instead of text where supported
    #[arg(long, global = true, help_heading = "Global options")]
    json: bool,
    /// More logging (repeat for more)
    #[arg(short, long, global = true, action = clap::ArgAction::Count, help_heading = "Global options")]
    verbose: u8,
}

#[derive(Subcommand)]
enum Command {
    /// List devices reachable over USB and Wi-Fi
    Devices {
        #[command(flatten)]
        transport: TransportArgs,
    },
    /// Sign an IPA with your Apple ID and install it
    Install {
        /// .ipa file or .app folder
        ipa: PathBuf,
        #[command(flatten)]
        target: DeviceArgs,
        #[command(flatten)]
        options: AppOptionArgs,
        #[command(flatten)]
        account: AccountArgs,
        /// Don't keep a copy for `refresh`
        #[arg(long)]
        no_remember: bool,
    },
    /// Sign an IPA and save it instead of installing
    Export {
        ipa: PathBuf,
        /// Output .ipa path
        #[arg(short, long)]
        output: PathBuf,
        #[command(flatten)]
        options: AppOptionArgs,
        #[command(flatten)]
        account: AccountArgs,
    },
    /// Show what's inside an IPA (no login needed)
    Inspect { ipa: PathBuf },
    /// Log in and remember the Apple ID (and optionally the password)
    Login {
        #[command(flatten)]
        account: AccountArgs,
    },
    /// Forget the saved Apple ID password
    Logout {
        #[arg(long)]
        apple_id: Option<String>,
    },
    /// Wi-Fi setup and pairing files
    #[command(subcommand)]
    Wifi(WifiCommand),
    /// Apps Sideward installed, and their expiry
    #[command(subcommand)]
    Apps(AppsCommand),
    /// Re-sign apps that are about to expire
    Refresh {
        #[command(flatten)]
        refresh: RefreshArgs,
        #[command(flatten)]
        account: AccountArgs,
    },
    /// Keep running and refresh apps automatically (over Wi-Fi or USB)
    Daemon {
        /// Hours between checks
        #[arg(long, default_value_t = 6)]
        interval_hours: u64,
        #[command(flatten)]
        refresh: RefreshArgs,
        #[command(flatten)]
        account: AccountArgs,
    },
    /// Development certificates on your account
    #[command(subcommand)]
    Certs(CertsCommand),
    /// App IDs on your account (free accounts get 10 per week)
    #[command(subcommand)]
    Appids(AppIdsCommand),
    /// Anisette servers used for Apple ID login
    #[command(subcommand)]
    Anisette(AnisetteCommand),
}

#[derive(Subcommand)]
enum WifiCommand {
    /// One-time setup over USB: save the pairing and enable Wi-Fi installs
    Setup {
        /// UDID, if several devices are plugged in
        #[arg(short, long)]
        device: Option<String>,
    },
    /// Saved Wi-Fi devices
    List,
    /// Import a pairing file from SideStore, iloader, Jitterbug, etc.
    Import {
        file: PathBuf,
        /// Device address, needed if the file has no UDID
        #[arg(long)]
        ip: Option<IpAddr>,
    },
    /// Export a saved pairing file (for SideStore, StikDebug, another computer...)
    Export { udid: String, output: PathBuf },
    /// Forget a Wi-Fi device
    Forget { udid: String },
}

#[derive(Subcommand)]
enum AppsCommand {
    List,
    /// Stop refreshing an app (by bundle id or name) and delete its saved copy
    Forget {
        app: String,
    },
}

#[derive(Subcommand)]
enum CertsCommand {
    List {
        #[command(flatten)]
        account: AccountArgs,
    },
    Revoke {
        serial: String,
        #[command(flatten)]
        account: AccountArgs,
    },
}

#[derive(Subcommand)]
enum AppIdsCommand {
    List {
        #[command(flatten)]
        account: AccountArgs,
    },
    Delete {
        /// The App ID's id (first column of `appids list`)
        id: String,
        #[command(flatten)]
        account: AccountArgs,
    },
}

#[derive(Subcommand)]
enum AnisetteCommand {
    List,
    /// Use this server (URL or hostname)
    Set {
        server: String,
    },
    /// Turn automatic fallback to other servers on or off
    Fallback {
        #[arg(action = clap::ArgAction::Set)]
        enabled: bool,
    },
}

#[derive(Args, Clone)]
struct TransportArgs {
    /// Only USB devices
    #[arg(long, conflicts_with = "wifi")]
    usb: bool,
    /// Only Wi-Fi devices
    #[arg(long)]
    wifi: bool,
    /// Seconds to listen for Wi-Fi devices on the network
    #[arg(long, default_value_t = 3)]
    wifi_timeout: u64,
}

impl TransportArgs {
    fn discover_options(&self) -> DiscoverOptions {
        DiscoverOptions {
            filter: if self.usb {
                TransportFilter::UsbOnly
            } else if self.wifi {
                TransportFilter::WifiOnly
            } else {
                TransportFilter::Any
            },
            wifi_timeout: Duration::from_secs(self.wifi_timeout),
        }
    }
}

#[derive(Args, Clone)]
#[command(next_help_heading = "Device")]
struct DeviceArgs {
    /// Device UDID, name, or IP
    #[arg(short, long)]
    device: Option<String>,
    #[command(flatten)]
    transport: TransportArgs,
    /// Connect straight to this IP over Wi-Fi (skips discovery)
    #[arg(long, conflicts_with = "usb")]
    ip: Option<IpAddr>,
    /// Pairing file to use with --ip (default: any saved pairing that works)
    #[arg(long, requires = "ip")]
    pairing_file: Option<PathBuf>,
}

#[derive(Args, Clone, Default)]
#[command(next_help_heading = "App changes")]
struct AppOptionArgs {
    /// Change the app's home-screen name
    #[arg(long)]
    name: Option<String>,
    /// Change the bundle id (install a second copy of an app)
    #[arg(long)]
    bundle_id: Option<String>,
    /// Change the version string
    #[arg(long)]
    app_version: Option<String>,
    /// Change the minimum iOS version
    #[arg(long)]
    min_ios: Option<String>,
    /// Show the app's Documents folder in the Files app
    #[arg(long)]
    file_sharing: bool,
    /// Allow installing on devices the app doesn't list
    #[arg(long)]
    remove_supported_devices: bool,
    /// Remove app extensions (saves App IDs on free accounts)
    #[arg(long)]
    remove_extensions: bool,
    /// Remove the Apple Watch app
    #[arg(long)]
    remove_watch: bool,
    /// Inject a tweak: .dylib, .framework, .bundle, or .deb (repeatable)
    #[arg(long, value_name = "PATH")]
    inject: Vec<PathBuf>,
    /// Register a separate App ID for each extension
    #[arg(long)]
    register_extensions: bool,
    /// Request the increased memory limit entitlement
    #[arg(long)]
    increased_memory_limit: bool,
}

impl AppOptionArgs {
    fn to_options(&self) -> Result<AppOptions> {
        for p in &self.inject {
            if !p.exists() {
                bail!("{} doesn't exist", p.display());
            }
        }
        Ok(AppOptions {
            name: self.name.clone(),
            bundle_id: self.bundle_id.clone(),
            version: self.app_version.clone(),
            min_ios: self.min_ios.clone(),
            file_sharing: self.file_sharing,
            remove_supported_devices: self.remove_supported_devices,
            remove_extensions: self.remove_extensions,
            remove_watch_app: self.remove_watch,
            inject: self
                .inject
                .iter()
                .map(|p| p.canonicalize().unwrap_or_else(|_| p.clone()))
                .collect(),
            register_extensions: self.register_extensions,
            increased_memory_limit: self.increased_memory_limit,
        })
    }
}

#[derive(Args, Clone, Default)]
#[command(next_help_heading = "Apple ID")]
struct AccountArgs {
    /// Apple ID email (default: the last one used)
    #[arg(short = 'u', long, env = "SIDEWARD_APPLE_ID")]
    apple_id: Option<String>,
    /// Anisette server for this login
    #[arg(long)]
    anisette: Option<String>,
    /// Save the password in the system keychain
    #[arg(long)]
    save_password: bool,
    /// When the certificate limit is hit, revoke the oldest one without asking
    #[arg(long)]
    auto_revoke: bool,
}

#[derive(Args, Clone)]
struct RefreshArgs {
    /// Refresh apps expiring within this many days
    #[arg(long, default_value_t = 2)]
    days: i64,
    /// Refresh every remembered app, even if not due
    #[arg(long)]
    all: bool,
    #[command(flatten)]
    transport: TransportArgs,
}

struct Ctx {
    paths: Paths,
    config: Config,
    json: bool,
}

#[tokio::main]
async fn main() {
    let cli = Cli::parse();
    let level = match cli.verbose {
        0 => "warn,sideward=info,sideward_core=info,isideload=info",
        1 => "info,sideward=debug,sideward_core=debug",
        _ => "debug",
    };
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new(level)),
        )
        .with_target(false)
        .with_writer(std::io::stderr)
        .init();

    if let Err(e) = run(cli).await {
        eprintln!("Error: {e:#}");
        std::process::exit(1);
    }
}

async fn run(cli: Cli) -> Result<()> {
    sideward_core::init()?;
    let paths = Paths::new(cli.data_dir.clone())?;
    let config = Config::load(&paths)?;
    let mut ctx = Ctx {
        paths,
        config,
        json: cli.json,
    };

    match cli.command {
        Command::Devices { transport } => cmd_devices(&ctx, &transport).await,
        Command::Install {
            ipa,
            target,
            options,
            account,
            no_remember,
        } => {
            let options = options.to_options()?;
            let device = resolve_device(&ctx, &target).await?;
            let mut session = login(&mut ctx, &account, true).await?;
            println!("Installing to {device}");
            let request = InstallRequest {
                source: ipa,
                options,
                remember: !no_remember,
            };
            let progress = ProgressUi::new();
            let outcome = session
                .install(&device, &request, progress.callback())
                .await;
            progress.finish();
            let outcome = outcome?;
            println!(
                "Installed {} ({})",
                outcome.app.name, outcome.installed_bundle_id
            );
            print_expiry(outcome.expires_at);
            if device.transport == device::TransportKind::Usb
                && wifi::load_pairing(&ctx.paths, &device.udid).is_err()
            {
                println!(
                    "Tip: run `sideward wifi setup` now to install and refresh over Wi-Fi next time."
                );
            }
            Ok(())
        }
        Command::Export {
            ipa,
            output,
            options,
            account,
        } => {
            let options = options.to_options()?;
            let mut session = login(&mut ctx, &account, true).await?;
            let progress = ProgressUi::new();
            let outcome = session
                .export(&ipa, &options, &output, progress.callback())
                .await;
            progress.finish();
            let outcome = outcome?;
            println!("Signed {} -> {}", outcome.app.name, output.display());
            print_expiry(outcome.expires_at);
            println!(
                "Note: it only runs on devices registered to {}.",
                session.apple_id
            );
            Ok(())
        }
        Command::Inspect { ipa } => {
            let info = ipa::inspect(&ipa)?;
            if ctx.json {
                println!("{}", serde_json::to_string_pretty(&info)?);
                return Ok(());
            }
            println!("Name:        {}", info.name);
            println!("Bundle ID:   {}", info.bundle_id);
            println!(
                "Version:     {} ({})",
                info.version.as_deref().unwrap_or("?"),
                info.build.as_deref().unwrap_or("?")
            );
            println!("Minimum iOS: {}", info.min_ios.as_deref().unwrap_or("?"));
            println!(
                "Extensions:  {}",
                if info.extensions.is_empty() {
                    "none".into()
                } else {
                    info.extensions.join(", ")
                }
            );
            println!(
                "Watch app:   {}",
                if info.has_watch_app { "yes" } else { "no" }
            );
            println!(
                "Encrypted:   {}",
                if info.encrypted {
                    "yes - this IPA can't be sideloaded until decrypted"
                } else {
                    "no"
                }
            );
            Ok(())
        }
        Command::Login { account } => {
            let session = login(&mut ctx, &account, true).await?;
            println!(
                "Logged in as {} (team {} {}) via {}",
                session.apple_id,
                session.team.name.as_deref().unwrap_or(""),
                session.team.team_id,
                session.anisette_server
            );
            Ok(())
        }
        Command::Logout { apple_id } => {
            let apple_id = apple_id
                .or(ctx.config.apple_id.clone())
                .context("No Apple ID to log out")?;
            credentials::delete_password(&apple_id)?;
            println!("Forgot the saved password for {apple_id}");
            Ok(())
        }
        Command::Wifi(cmd) => cmd_wifi(&ctx, cmd).await,
        Command::Apps(cmd) => cmd_apps(&ctx, cmd),
        Command::Refresh { refresh, account } => {
            let mut session = login(&mut ctx, &account, true).await?;
            run_refresh(&ctx, &mut session, &refresh).await.map(|_| ())
        }
        Command::Daemon {
            interval_hours,
            refresh,
            account,
        } => cmd_daemon(&mut ctx, interval_hours, &refresh, &account).await,
        Command::Certs(cmd) => match cmd {
            CertsCommand::List { account } => {
                let mut session = login(&mut ctx, &account, true).await?;
                for c in session.list_certificates().await? {
                    println!(
                        "{}  {}  {}  expires {}",
                        c.serial_number.as_deref().unwrap_or("?"),
                        c.machine_name.as_deref().unwrap_or("?"),
                        c.name.as_deref().unwrap_or(""),
                        c.expiration_date
                            .map(|d| d.to_xml_format())
                            .unwrap_or_default()
                    );
                }
                Ok(())
            }
            CertsCommand::Revoke { serial, account } => {
                let mut session = login(&mut ctx, &account, true).await?;
                session.revoke_certificate(&serial).await?;
                println!("Revoked {serial}");
                Ok(())
            }
        },
        Command::Appids(cmd) => match cmd {
            AppIdsCommand::List { account } => {
                let mut session = login(&mut ctx, &account, true).await?;
                let resp = session.list_app_ids().await?;
                for a in &resp.app_ids {
                    println!(
                        "{}  {}  {}  expires {}",
                        a.app_id_id,
                        a.identifier,
                        a.name,
                        a.expiration_date
                            .map(|d| d.to_xml_format())
                            .unwrap_or_else(|| "never".into())
                    );
                }
                if let (Some(avail), Some(max)) = (resp.available_quantity, resp.max_quantity) {
                    println!("{avail} of {max} App IDs available");
                }
                Ok(())
            }
            AppIdsCommand::Delete { id, account } => {
                let mut session = login(&mut ctx, &account, true).await?;
                session.delete_app_id(&id).await?;
                println!(
                    "Deleted App ID {id}. (Free accounts still count it against this week's limit.)"
                );
                Ok(())
            }
        },
        Command::Anisette(cmd) => cmd_anisette(&mut ctx, cmd),
    }
}

fn print_expiry(expires_at: Option<chrono::DateTime<chrono::Utc>>) {
    if let Some(expiry) = expires_at {
        let local: chrono::DateTime<chrono::Local> = expiry.into();
        println!(
            "Expires {} - run `sideward refresh` (or `sideward daemon`) before then.",
            local.format("%a %b %e %H:%M")
        );
    }
}

async fn login(ctx: &mut Ctx, args: &AccountArgs, interactive: bool) -> Result<Session> {
    let apple_id = match args.apple_id.clone().or(ctx.config.apple_id.clone()) {
        Some(id) => id,
        None if interactive => prompt::ask("Apple ID: ").await?,
        None => bail!("No Apple ID; pass --apple-id"),
    };
    let saved = credentials::get_password(&apple_id)?;
    let password = match saved.clone() {
        Some(p) => p,
        None if interactive => prompt::read_password(&format!("Password for {apple_id}: ")).await?,
        None => bail!(
            "No saved password for {apple_id}; run `sideward login --save-password` or set SIDEWARD_PASSWORD"
        ),
    };
    let prompter = Arc::new(CliPrompter { interactive });
    let session = account::login(
        &ctx.paths,
        &mut ctx.config,
        LoginRequest {
            apple_id: apple_id.clone(),
            password: password.clone(),
            anisette_server: args.anisette.clone(),
        },
        prompter,
    )
    .await?;
    session.set_auto_revoke(args.auto_revoke);
    if args.save_password && saved.as_deref() != Some(password.as_str()) {
        match credentials::save_password(&apple_id, &password) {
            Ok(()) => println!("Saved the password to the system keychain."),
            Err(e) => eprintln!("Couldn't save the password: {e:#}"),
        }
    }
    Ok(session)
}

async fn discover(ctx: &Ctx, transport: &TransportArgs) -> Result<Vec<device::Device>> {
    let spinner = ProgressBar::new_spinner().with_message("Looking for devices...");
    spinner.enable_steady_tick(Duration::from_millis(100));
    let devices = device::discover(&ctx.paths, &transport.discover_options()).await;
    spinner.finish_and_clear();
    devices
}

async fn resolve_device(ctx: &Ctx, args: &DeviceArgs) -> Result<device::Device> {
    if let Some(ip) = args.ip {
        if let Some(file) = &args.pairing_file {
            let pairing = idevice::pairing_file::PairingFile::read_from_file(file)
                .with_context(|| format!("Invalid pairing file {}", file.display()))?;
            return device::direct_device(&ctx.paths, ip, pairing).await;
        }
        let saved = wifi::list_saved(&ctx.paths)?;
        // Try the device last seen at this address first
        let mut ordered: Vec<_> = saved.iter().filter(|d| d.last_ip == Some(ip)).collect();
        ordered.extend(saved.iter().filter(|d| d.last_ip != Some(ip)));
        for d in ordered {
            if let Ok(pairing) = wifi::load_pairing(&ctx.paths, &d.udid)
                && let Ok(dev) = device::direct_device(&ctx.paths, ip, pairing).await
            {
                return Ok(dev);
            }
        }
        bail!(
            "None of the saved pairings work with {ip}. Run `sideward wifi setup` over USB, or pass --pairing-file."
        );
    }
    let devices = discover(ctx, &args.transport).await?;
    Ok(device::select(&devices, args.device.as_deref())?.clone())
}

async fn cmd_devices(ctx: &Ctx, transport: &TransportArgs) -> Result<()> {
    let devices = discover(ctx, transport).await?;
    if ctx.json {
        println!("{}", serde_json::to_string_pretty(&devices)?);
        return Ok(());
    }
    if devices.is_empty() {
        println!("No devices found.");
        println!("  USB: plug in, unlock, and tap Trust.");
        println!(
            "  Wi-Fi: run `sideward wifi setup` once with the device on USB; then keep it on the same network."
        );
        return Ok(());
    }
    println!(
        "{:<24} {:<16} {:<16} {:<8} UDID",
        "NAME", "CONNECTION", "ADDRESS", "iOS"
    );
    for d in devices {
        println!(
            "{:<24} {:<16} {:<16} {:<8} {}",
            truncate(&d.name, 24),
            d.transport.label(),
            d.ip.map(|ip| ip.to_string()).unwrap_or_else(|| "-".into()),
            d.ios_version.as_deref().unwrap_or("?"),
            d.udid
        );
    }
    Ok(())
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        format!("{}…", s.chars().take(max - 1).collect::<String>())
    }
}

async fn cmd_wifi(ctx: &Ctx, cmd: WifiCommand) -> Result<()> {
    match cmd {
        WifiCommand::Setup { device } => {
            println!("Setting up Wi-Fi. Keep the device unlocked; tap Trust if asked.");
            let saved = wifi::setup_over_usb(&ctx.paths, device.as_deref()).await?;
            println!("Wi-Fi ready for {} ({}).", saved.name, saved.udid);
            println!("You can unplug it. `sideward devices --wifi` finds it on the same network.");
            Ok(())
        }
        WifiCommand::List => {
            let saved = wifi::list_saved(&ctx.paths)?;
            if ctx.json {
                println!("{}", serde_json::to_string_pretty(&saved)?);
            } else if saved.is_empty() {
                println!("No Wi-Fi devices yet. Run `sideward wifi setup` with a device on USB.");
            } else {
                for d in saved {
                    println!(
                        "{:<24} {}  last seen at {}",
                        truncate(&d.name, 24),
                        d.udid,
                        d.last_ip
                            .map(|ip| ip.to_string())
                            .unwrap_or_else(|| "-".into())
                    );
                }
            }
            Ok(())
        }
        WifiCommand::Import { file, ip } => {
            let saved = wifi::import_pairing(&ctx.paths, &file, ip).await?;
            println!("Imported pairing for {} ({}).", saved.name, saved.udid);
            Ok(())
        }
        WifiCommand::Export { udid, output } => {
            wifi::export_pairing(&ctx.paths, &udid, &output)?;
            println!("Wrote {}", output.display());
            Ok(())
        }
        WifiCommand::Forget { udid } => {
            if wifi::forget(&ctx.paths, &udid)? {
                println!("Forgot {udid}");
            } else {
                println!("{udid} wasn't saved");
            }
            Ok(())
        }
    }
}

fn cmd_apps(ctx: &Ctx, cmd: AppsCommand) -> Result<()> {
    match cmd {
        AppsCommand::List => {
            let apps = registry::list(&ctx.paths)?;
            if ctx.json {
                println!("{}", serde_json::to_string_pretty(&apps)?);
                return Ok(());
            }
            if apps.is_empty() {
                println!("No apps remembered yet.");
                return Ok(());
            }
            let now = chrono::Utc::now();
            println!("{:<22} {:<38} {:<18} EXPIRES", "APP", "BUNDLE ID", "DEVICE");
            for a in apps {
                let expiry = match a.expires_at {
                    Some(e) if e <= now => "expired".to_string(),
                    Some(e) => {
                        let left = e - now;
                        format!("in {}d {}h", left.num_days(), left.num_hours() % 24)
                    }
                    None => "unknown".into(),
                };
                println!(
                    "{:<22} {:<38} {:<18} {}",
                    truncate(&a.name, 22),
                    truncate(&a.bundle_id, 38),
                    truncate(&a.device_name, 18),
                    expiry
                );
            }
            Ok(())
        }
        AppsCommand::Forget { app } => {
            let n = registry::remove(&ctx.paths, &app)?;
            println!("Forgot {n} app(s)");
            Ok(())
        }
    }
}

async fn run_refresh(ctx: &Ctx, session: &mut Session, args: &RefreshArgs) -> Result<usize> {
    let devices = discover(ctx, &args.transport).await?;
    let progress = ProgressUi::new();
    let results = install::refresh(
        session,
        &devices,
        chrono::Duration::days(args.days),
        args.all,
        progress.callback(),
    )
    .await;
    progress.finish();
    let results = results?;
    if results.is_empty() {
        println!("Nothing to refresh.");
    }
    let mut failures = 0;
    for r in &results {
        match &r.result {
            Ok(o) => {
                println!("Refreshed {} on {}", r.app.name, r.app.device_name);
                print_expiry(o.expires_at);
            }
            Err(e) => {
                failures += 1;
                eprintln!(
                    "Failed to refresh {} on {}: {e:#}",
                    r.app.name, r.app.device_name
                );
            }
        }
    }
    Ok(failures)
}

async fn cmd_daemon(
    ctx: &mut Ctx,
    interval_hours: u64,
    refresh: &RefreshArgs,
    account: &AccountArgs,
) -> Result<()> {
    // First login is interactive so 2FA can be answered; later ones must be silent
    let mut session = Some(login(ctx, account, true).await?);
    println!("Refreshing apps every {interval_hours}h. Press Ctrl+C to stop.");
    loop {
        let current = match session.as_mut() {
            Some(s) => s,
            None => match login(ctx, account, false).await {
                Ok(s) => session.insert(s),
                Err(e) => {
                    eprintln!("Login failed, will retry next round: {e:#}");
                    tokio::time::sleep(Duration::from_secs(interval_hours.max(1) * 3600)).await;
                    continue;
                }
            },
        };
        match run_refresh(ctx, current, refresh).await {
            // A failure may be an expired session; log in fresh next round
            Ok(failures) if failures > 0 => session = None,
            Ok(_) => {}
            Err(e) => {
                eprintln!("Refresh failed: {e:#}");
                session = None;
            }
        }
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_secs(interval_hours.max(1) * 3600)) => {}
            _ = tokio::signal::ctrl_c() => {
                println!("Stopping.");
                return Ok(());
            }
        }
    }
}

fn cmd_anisette(ctx: &mut Ctx, cmd: AnisetteCommand) -> Result<()> {
    match cmd {
        AnisetteCommand::List => {
            let current = anisette::normalize(&ctx.config.anisette_server);
            for (url, label, reliable) in anisette::SERVERS {
                let mark = if *url == current { "*" } else { " " };
                let note = if *reliable {
                    ""
                } else {
                    "  (unreliable, no SMS 2FA)"
                };
                println!("{mark} {url:<32} {label}{note}");
            }
            if !anisette::SERVERS.iter().any(|(u, _, _)| *u == current) {
                println!("* {current:<32} custom");
            }
            println!(
                "Automatic fallback: {}",
                if ctx.config.anisette_auto_fallback {
                    "on"
                } else {
                    "off"
                }
            );
            Ok(())
        }
        AnisetteCommand::Set { server } => {
            ctx.config.anisette_server = anisette::normalize(&server);
            ctx.config.save(&ctx.paths)?;
            println!("Using {}", ctx.config.anisette_server);
            Ok(())
        }
        AnisetteCommand::Fallback { enabled } => {
            ctx.config.anisette_auto_fallback = enabled;
            ctx.config.save(&ctx.paths)?;
            println!("Automatic fallback {}", if enabled { "on" } else { "off" });
            Ok(())
        }
    }
}

/// Step lines plus a progress bar for the current step.
struct ProgressUi {
    bar: Arc<Mutex<Option<ProgressBar>>>,
}

impl ProgressUi {
    fn new() -> Self {
        Self {
            bar: Arc::new(Mutex::new(None)),
        }
    }

    fn callback(&self) -> ProgressFn {
        let bar = self.bar.clone();
        Arc::new(move |p| {
            let mut guard = bar.lock().unwrap_or_else(|e| e.into_inner());
            match p {
                Progress::Step(step) => {
                    if let Some(old) = guard.take() {
                        old.finish_and_clear();
                    }
                    let pb = ProgressBar::new(100).with_message(step);
                    pb.set_style(
                        ProgressStyle::with_template(
                            "{spinner} {msg:<32} [{bar:30}] {percent:>3}%",
                        )
                        .expect("valid template")
                        .progress_chars("=> "),
                    );
                    pb.enable_steady_tick(Duration::from_millis(120));
                    *guard = Some(pb);
                }
                Progress::Fraction(f) => {
                    if let Some(pb) = guard.as_ref() {
                        pb.set_position((f.clamp(0.0, 1.0) * 100.0) as u64);
                    }
                }
                Progress::Warning(w) => match guard.as_ref() {
                    Some(pb) => pb.println(format!("Warning: {w}")),
                    None => eprintln!("Warning: {w}"),
                },
            }
        })
    }

    fn finish(&self) {
        if let Some(pb) = self.bar.lock().unwrap_or_else(|e| e.into_inner()).take() {
            pb.finish_and_clear();
        }
    }
}
