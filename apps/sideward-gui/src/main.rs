#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod app;
mod worker;

fn main() -> eframe::Result {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "warn,sideward_core=info,isideload=info".into()),
        )
        .init();
    if let Err(e) = sideward_core::init() {
        eprintln!("Startup failed: {e:#}");
    }

    let options = eframe::NativeOptions {
        viewport: eframe::egui::ViewportBuilder::default()
            .with_title("Sideward")
            .with_inner_size([820.0, 680.0])
            .with_min_inner_size([620.0, 520.0])
            .with_drag_and_drop(true),
        ..Default::default()
    };
    eframe::run_native(
        "Sideward",
        options,
        Box::new(|cc| Ok(Box::new(app::SidewardApp::new(cc)?))),
    )
}
