use anyhow::{bail, Context, Result};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

pub fn backup_path(xpui_path: &Path) -> PathBuf {
    xpui_path.with_extension("spa.adw.bak")
}

#[derive(Debug, Clone, Copy)]
pub struct PatchStatus {
    pub is_patched: bool,
    pub has_theme: bool,
}

pub fn get_patch_status(xpui_path: &Path) -> Result<PatchStatus> {
    if !xpui_path.exists() {
        return Ok(PatchStatus {
            is_patched: false,
            has_theme: false,
        });
    }

    let file = File::open(xpui_path)?;
    let mut archive = ZipArchive::new(file)?;

    for i in 0..archive.len() {
        let mut entry = archive.by_index(i)?;
        if entry.name() == "adwaita.css" {
            let mut css = String::new();
            let _ = entry.read_to_string(&mut css);
            let has_theme = css.contains("--adw-window-bg");
            return Ok(PatchStatus {
                is_patched: true,
                has_theme,
            });
        }
    }

    Ok(PatchStatus {
        is_patched: false,
        has_theme: false,
    })
}

#[allow(dead_code)]
pub fn is_patched(xpui_path: &Path) -> Result<bool> {
    get_patch_status(xpui_path).map(|s| s.is_patched)
}

pub fn backup(xpui_path: &Path) -> Result<()> {
    let bak = backup_path(xpui_path);
    if !bak.exists() {
        println!("Creating backup at {:?}", bak);
        fs::copy(xpui_path, &bak)
            .with_context(|| format!("Failed to create backup from {:?} to {:?}", xpui_path, bak))?;
    }
    Ok(())
}

pub fn restore(xpui_path: &Path) -> Result<()> {
    let bak = backup_path(xpui_path);
    if !bak.exists() {
        bail!("No backup found at {:?}. Cannot restore.", bak);
    }

    println!("Restoring backup from {:?}", bak);
    fs::copy(&bak, xpui_path)
        .with_context(|| format!("Failed to restore {:?} from {:?}", xpui_path, bak))?;

    Ok(())
}

pub fn patch(xpui_path: &Path, css_content: &str, js_content: &str) -> Result<()> {
    if !xpui_path.exists() {
        bail!("Target xpui.spa not found at {:?}", xpui_path);
    }

    // 1. Ensure backup exists
    backup(xpui_path)?;

    // 2. Open original archive
    let in_file = File::open(xpui_path)?;
    let mut in_archive = ZipArchive::new(in_file)?;

    // 3. Prepare temporary destination file
    let tmp_path = xpui_path.with_extension("spa.tmp");
    let out_file = File::create(&tmp_path)?;
    let mut out_archive = ZipWriter::new(out_file);

    let deflate_opts =
        SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);

    // 4. Copy existing files, modifying index.html
    for i in 0..in_archive.len() {
        let mut entry = in_archive.by_index(i)?;
        let name = entry.name().to_string();

        // Skip existing injections if re-patching
        if name == "adwaita.css" || name == "adwaita.js" {
            continue;
        }

        let mut data = Vec::new();
        entry.read_to_end(&mut data)?;

        if name == "index.html" {
            let mut html = String::from_utf8(data).context("index.html is not valid UTF-8")?;

            // Inject CSS before </head>
            if !html.contains("spotify-adwaita-css") {
                let css_tag =
                    r#"<link rel="stylesheet" id="spotify-adwaita-css" href="/adwaita.css">"#;
                if let Some(pos) = html.find("</head>") {
                    html.insert_str(pos, css_tag);
                } else {
                    html.push_str(css_tag);
                }
            }

            // Inject JS before </body>
            if !html.contains("spotify-adwaita-js") {
                let js_tag =
                    r#"<script defer="defer" id="spotify-adwaita-js" src="/adwaita.js"></script>"#;
                if let Some(pos) = html.find("</body>") {
                    html.insert_str(pos, js_tag);
                } else {
                    html.push_str(js_tag);
                }
            }

            out_archive.start_file("index.html", deflate_opts)?;
            out_archive.write_all(html.as_bytes())?;
        } else {
            out_archive.start_file(name, deflate_opts)?;
            out_archive.write_all(&data)?;
        }
    }

    // 5. Add custom adwaita.css and adwaita.js
    out_archive.start_file("adwaita.css", deflate_opts)?;
    out_archive.write_all(css_content.as_bytes())?;

    out_archive.start_file("adwaita.js", deflate_opts)?;
    out_archive.write_all(js_content.as_bytes())?;

    out_archive.finish()?;

    // 6. Atomically move temporary file into place
    fs::rename(&tmp_path, xpui_path)
        .with_context(|| format!("Failed to move {:?} to {:?}", tmp_path, xpui_path))?;

    Ok(())
}
