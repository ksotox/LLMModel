//! Tweak injection: copy dylibs/frameworks/bundles into the app and make the main executable
//! load the tweaks. Accepts `.dylib`, `.framework`, `.bundle`, and jailbreak `.deb` packages
//! (rootful and rootless layouts).

use std::{
    collections::BTreeSet,
    fs,
    io::Read,
    path::{Path, PathBuf},
};

use anyhow::{Context, Result, bail};
use walkdir::WalkDir;

use crate::macho;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InjectItem {
    /// Loaded by the main executable.
    Dylib(PathBuf),
    /// Copied into `Frameworks/`; loaded by whatever links it (e.g. CydiaSubstrate).
    Framework(PathBuf),
    /// Resource bundle copied to the app root, where sideloaded tweaks look for it.
    Bundle(PathBuf),
}

impl InjectItem {
    fn path(&self) -> &Path {
        match self {
            InjectItem::Dylib(p) | InjectItem::Framework(p) | InjectItem::Bundle(p) => p,
        }
    }

    fn file_name(&self) -> String {
        self.path()
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default()
    }
}

#[derive(Debug, Default)]
pub struct InjectReport {
    pub loaded: Vec<String>,
    pub copied: Vec<String>,
    pub warnings: Vec<String>,
}

/// Turn user inputs into injectable items, unpacking `.deb` files into `scratch`.
pub fn collect(inputs: &[PathBuf], scratch: &Path) -> Result<Vec<InjectItem>> {
    let mut items = Vec::new();
    for input in inputs {
        let ext = input
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        match ext.as_str() {
            "dylib" => items.push(InjectItem::Dylib(input.clone())),
            "framework" => items.push(InjectItem::Framework(input.clone())),
            "bundle" => items.push(InjectItem::Bundle(input.clone())),
            "deb" => {
                let name = input
                    .file_stem()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned();
                let dest = scratch.join(format!("deb-{name}"));
                extract_deb(input, &dest)
                    .with_context(|| format!("Failed to unpack {}", input.display()))?;
                let found = scan_package(&dest)?;
                if found.is_empty() {
                    bail!(
                        "{} contains no tweak dylibs, frameworks, or bundles",
                        input.display()
                    );
                }
                items.extend(found);
            }
            _ => bail!(
                "Can't inject {}: expected a .dylib, .framework, .bundle, or .deb",
                input.display()
            ),
        }
    }
    Ok(items)
}

fn extract_deb(deb: &Path, dest: &Path) -> Result<()> {
    let file = fs::File::open(deb)?;
    let mut archive = ar::Archive::new(file);
    while let Some(entry) = archive.next_entry() {
        let mut entry = entry?;
        let id = String::from_utf8_lossy(entry.header().identifier())
            .trim_end_matches('/')
            .to_string();
        if !id.starts_with("data.tar") {
            continue;
        }
        let mut compressed = Vec::new();
        entry.read_to_end(&mut compressed)?;
        let tar_bytes = decompress(&id, &compressed)?;
        fs::create_dir_all(dest)?;
        let mut tar = tar::Archive::new(tar_bytes.as_slice());
        tar.set_preserve_permissions(false);
        // `unpack` refuses entries that escape `dest`
        tar.unpack(dest)?;
        return Ok(());
    }
    bail!("No data.tar member in the package")
}

fn decompress(name: &str, data: &[u8]) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    if name.ends_with(".gz") {
        flate2::read::GzDecoder::new(data).read_to_end(&mut out)?;
    } else if name.ends_with(".xz") {
        lzma_rs::xz_decompress(&mut std::io::BufReader::new(data), &mut out)
            .map_err(|e| anyhow::anyhow!("xz: {e:?}"))?;
    } else if name.ends_with(".lzma") {
        lzma_rs::lzma_decompress(&mut std::io::BufReader::new(data), &mut out)
            .map_err(|e| anyhow::anyhow!("lzma: {e:?}"))?;
    } else if name.ends_with(".zst") {
        out = zstd::decode_all(data)?;
    } else if name == "data.tar" {
        out = data.to_vec();
    } else {
        bail!("Unsupported package compression: {name}");
    }
    Ok(out)
}

/// Find tweak payloads in an unpacked package. Rootless packages put everything under `var/jb`.
fn scan_package(root: &Path) -> Result<Vec<InjectItem>> {
    let mut items = Vec::new();
    for prefix in ["", "var/jb/"] {
        let base = root.join(prefix);
        let dylibs = base.join("Library/MobileSubstrate/DynamicLibraries");
        if dylibs.is_dir() {
            for entry in sorted_entries(&dylibs)? {
                if entry.extension().is_some_and(|e| e == "dylib") {
                    items.push(InjectItem::Dylib(entry));
                }
            }
        }
        let frameworks = base.join("Library/Frameworks");
        if frameworks.is_dir() {
            for entry in sorted_entries(&frameworks)? {
                if entry.extension().is_some_and(|e| e == "framework") {
                    items.push(InjectItem::Framework(entry));
                }
            }
        }
        // Libraries tweaks link from /usr/lib get shipped alongside and re-pointed at @rpath
        let usr_lib = base.join("usr/lib");
        if usr_lib.is_dir() {
            for entry in sorted_entries(&usr_lib)? {
                if entry.extension().is_some_and(|e| e == "dylib") && entry.is_file() {
                    items.push(InjectItem::Framework(entry));
                }
            }
        }
        let support = base.join("Library/Application Support");
        if support.is_dir() {
            for entry in WalkDir::new(&support).max_depth(2).sort_by_file_name() {
                let entry = entry?;
                if entry.file_type().is_dir()
                    && entry.path().extension().is_some_and(|e| e == "bundle")
                {
                    items.push(InjectItem::Bundle(entry.into_path()));
                }
            }
        }
    }
    Ok(items)
}

fn sorted_entries(dir: &Path) -> Result<Vec<PathBuf>> {
    let mut entries: Vec<PathBuf> = fs::read_dir(dir)?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .collect();
    entries.sort();
    Ok(entries)
}

fn copy_recursive(src: &Path, dst: &Path) -> Result<()> {
    if src.is_dir() {
        for entry in WalkDir::new(src) {
            let entry = entry?;
            let rel = entry.path().strip_prefix(src)?;
            let target = dst.join(rel);
            if entry.file_type().is_dir() {
                fs::create_dir_all(&target)?;
            } else if entry.file_type().is_file() {
                if let Some(parent) = target.parent() {
                    fs::create_dir_all(parent)?;
                }
                fs::copy(entry.path(), &target)?;
            }
        }
    } else {
        if let Some(parent) = dst.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(src, dst)?;
    }
    Ok(())
}

const SUBSTRATE_PATHS: &[&str] = &[
    "/Library/Frameworks/CydiaSubstrate.framework/CydiaSubstrate",
    "/var/jb/Library/Frameworks/CydiaSubstrate.framework/CydiaSubstrate",
    "/usr/lib/libsubstrate.dylib",
    "/var/jb/usr/lib/libsubstrate.dylib",
    "@rpath/libsubstrate.dylib",
    "@rpath/CydiaSubstrate.framework/CydiaSubstrate",
];

/// Where a dependency should point once everything lives in `Frameworks/`.
fn replacement_for(
    dep: &str,
    shipped_dylibs: &BTreeSet<String>,
    shipped_frameworks: &BTreeSet<String>,
) -> Option<Vec<String>> {
    if SUBSTRATE_PATHS.contains(&dep) {
        // Prefer the framework path; the short alias fits in commands that held /usr/lib/libsubstrate.dylib
        return Some(vec![
            "@rpath/CydiaSubstrate.framework/CydiaSubstrate".to_string(),
            "@rpath/libsubstrate.dylib".to_string(),
        ]);
    }
    if dep.starts_with("@") && !dep.starts_with("@rpath/") {
        return None;
    }
    let file_name = dep.rsplit('/').next()?;
    if shipped_dylibs.contains(file_name) && dep != format!("@rpath/{file_name}") {
        return Some(vec![format!("@rpath/{file_name}")]);
    }
    let framework = format!("{file_name}.framework");
    if shipped_frameworks.contains(&framework) && dep.contains(&format!("/{framework}/")) {
        let target = format!("@rpath/{framework}/{file_name}");
        if dep != target {
            return Some(vec![target]);
        }
    }
    None
}

/// Copy `items` into `app_dir` and load the dylibs from the app's main executable.
pub fn inject(app_dir: &Path, executable: &str, items: &[InjectItem]) -> Result<InjectReport> {
    let mut report = InjectReport::default();
    if items.is_empty() {
        return Ok(report);
    }
    let frameworks_dir = app_dir.join("Frameworks");
    fs::create_dir_all(&frameworks_dir)?;

    let mut shipped_dylibs: BTreeSet<String> = BTreeSet::new();
    let mut shipped_frameworks: BTreeSet<String> = BTreeSet::new();
    for entry in fs::read_dir(&frameworks_dir)?.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.ends_with(".framework") {
            shipped_frameworks.insert(name);
        } else if name.ends_with(".dylib") {
            shipped_dylibs.insert(name);
        }
    }

    let mut copied_binaries: Vec<PathBuf> = Vec::new();
    for item in items {
        let name = item.file_name();
        match item {
            InjectItem::Dylib(src) => {
                let dst = frameworks_dir.join(&name);
                copy_recursive(src, &dst)?;
                shipped_dylibs.insert(name.clone());
                copied_binaries.push(dst);
            }
            InjectItem::Framework(src) => {
                let dst = frameworks_dir.join(&name);
                copy_recursive(src, &dst)?;
                if name.ends_with(".framework") {
                    let binary = dst.join(name.trim_end_matches(".framework"));
                    if binary.is_file() {
                        copied_binaries.push(binary);
                    }
                    shipped_frameworks.insert(name.clone());
                } else {
                    copied_binaries.push(dst);
                    shipped_dylibs.insert(name.clone());
                }
                report.copied.push(name);
            }
            InjectItem::Bundle(src) => {
                copy_recursive(src, &app_dir.join(&name))?;
                report.copied.push(name);
            }
        }
    }

    let has_substrate = shipped_frameworks.contains("CydiaSubstrate.framework");
    let mut needs_substrate = false;
    for binary in &copied_binaries {
        let mut data = fs::read(binary)?;
        if !macho::is_macho(&data) {
            continue;
        }
        let deps = macho::linked_dylibs(&data)?;
        let mut changed = false;
        for dep in deps {
            if SUBSTRATE_PATHS.contains(&dep.as_str()) {
                needs_substrate = true;
            }
            let Some(targets) = replacement_for(&dep, &shipped_dylibs, &shipped_frameworks) else {
                continue;
            };
            let mut done = false;
            for target in &targets {
                if &dep == target {
                    done = true;
                    break;
                }
                if macho::change_dylib_path(&mut data, &dep, target).is_ok() {
                    changed = true;
                    done = true;
                    if target == "@rpath/libsubstrate.dylib" && has_substrate {
                        let alias = frameworks_dir.join("libsubstrate.dylib");
                        if !alias.exists() {
                            fs::copy(
                                frameworks_dir.join("CydiaSubstrate.framework/CydiaSubstrate"),
                                alias,
                            )?;
                        }
                    }
                    break;
                }
            }
            if !done {
                report.warnings.push(format!(
                    "{}: couldn't re-point {dep}; it may fail to load",
                    binary.file_name().unwrap_or_default().to_string_lossy()
                ));
            }
        }
        if changed {
            fs::write(binary, data)?;
        }
    }
    if needs_substrate && !has_substrate {
        report.warnings.push(
            "These tweaks need CydiaSubstrate. Also inject CydiaSubstrate.framework (for example from ElleKit), \
             or the app will crash on launch."
                .to_string(),
        );
    }

    let exe_path = app_dir.join(executable);
    let mut exe =
        fs::read(&exe_path).with_context(|| format!("Failed to read {}", exe_path.display()))?;
    macho::add_rpath(&mut exe, "@executable_path/Frameworks")
        .context("Failed to add an rpath to the app executable")?;
    for item in items {
        if let InjectItem::Dylib(_) = item {
            let load_path = format!("@executable_path/Frameworks/{}", item.file_name());
            macho::add_dylib(&mut exe, &load_path, false)
                .with_context(|| format!("Failed to inject {}", item.file_name()))?;
            report.loaded.push(item.file_name());
        }
    }
    fs::write(&exe_path, exe)?;
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_dependencies_to_rpath() {
        let dylibs: BTreeSet<String> = ["libfoo.dylib".to_string()].into();
        let frameworks: BTreeSet<String> = ["Orion.framework".to_string()].into();
        assert_eq!(
            replacement_for("/usr/lib/libfoo.dylib", &dylibs, &frameworks),
            Some(vec!["@rpath/libfoo.dylib".to_string()])
        );
        assert_eq!(
            replacement_for(
                "/Library/Frameworks/Orion.framework/Orion",
                &dylibs,
                &frameworks
            ),
            Some(vec!["@rpath/Orion.framework/Orion".to_string()])
        );
        assert_eq!(
            replacement_for("/usr/lib/libSystem.B.dylib", &dylibs, &frameworks),
            None
        );
        assert_eq!(
            replacement_for("@executable_path/x.dylib", &dylibs, &frameworks),
            None
        );
        assert!(replacement_for("/usr/lib/libsubstrate.dylib", &dylibs, &frameworks).is_some());
    }

    #[test]
    fn injects_into_executable() {
        let dir = tempfile::tempdir().unwrap();
        let app = dir.path().join("Test.app");
        fs::create_dir_all(&app).unwrap();
        fs::write(app.join("Test"), macho::tests::sample_macho(0)).unwrap();

        let tweak = dir.path().join("Tweak.dylib");
        let mut tweak_bin = macho::tests::sample_macho(0);
        macho::add_dylib(
            &mut tweak_bin,
            "/Library/Frameworks/CydiaSubstrate.framework/CydiaSubstrate",
            false,
        )
        .unwrap();
        fs::write(&tweak, tweak_bin).unwrap();

        let report = inject(&app, "Test", &[InjectItem::Dylib(tweak)]).unwrap();
        assert_eq!(report.loaded, vec!["Tweak.dylib"]);
        assert!(report.warnings.iter().any(|w| w.contains("CydiaSubstrate")));

        let exe = fs::read(app.join("Test")).unwrap();
        assert!(
            macho::linked_dylibs(&exe)
                .unwrap()
                .contains(&"@executable_path/Frameworks/Tweak.dylib".to_string())
        );
        let injected = fs::read(app.join("Frameworks/Tweak.dylib")).unwrap();
        assert!(
            macho::linked_dylibs(&injected)
                .unwrap()
                .contains(&"@rpath/CydiaSubstrate.framework/CydiaSubstrate".to_string())
        );
    }

    #[test]
    fn unpacks_rootless_debs() {
        let dir = tempfile::tempdir().unwrap();
        // Build data.tar.gz with a rootless tweak layout
        let mut tar_builder = tar::Builder::new(Vec::new());
        let mut add = |path: &str, data: &[u8]| {
            let mut header = tar::Header::new_gnu();
            header.set_size(data.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            tar_builder.append_data(&mut header, path, data).unwrap();
        };
        add(
            "var/jb/Library/MobileSubstrate/DynamicLibraries/Tweak.dylib",
            b"dylib",
        );
        add(
            "var/jb/Library/MobileSubstrate/DynamicLibraries/Tweak.plist",
            b"filter",
        );
        add(
            "var/jb/Library/Application Support/Tweak.bundle/Info.plist",
            b"bundle",
        );
        let tar_bytes = tar_builder.into_inner().unwrap();
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        std::io::Write::write_all(&mut gz, &tar_bytes).unwrap();
        let gz = gz.finish().unwrap();

        let deb_path = dir.path().join("tweak.deb");
        let mut builder = ar::Builder::new(fs::File::create(&deb_path).unwrap());
        builder
            .append(
                &ar::Header::new(b"debian-binary".to_vec(), 4),
                &b"2.0\n"[..],
            )
            .unwrap();
        builder
            .append(
                &ar::Header::new(b"data.tar.gz".to_vec(), gz.len() as u64),
                gz.as_slice(),
            )
            .unwrap();
        drop(builder);

        let items = collect(&[deb_path], dir.path()).unwrap();
        let names: Vec<String> = items.iter().map(InjectItem::file_name).collect();
        assert_eq!(names, vec!["Tweak.dylib", "Tweak.bundle"]);
    }
}
