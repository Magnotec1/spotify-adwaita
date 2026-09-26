use anyhow::{Context, Result};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

const PRELOAD_C_SRC: &str = include_str!("preload.c");

pub fn get_preload_path(xpui_path: &Path) -> Option<PathBuf> {
    // Find the `files` directory in the path ancestors
    for ancestor in xpui_path.ancestors() {
        if ancestor.file_name().map_or(false, |name| name == "files") {
            let lib_preload = ancestor.join("lib/spotify-preload.so");
            if lib_preload.parent().map_or(false, |p| p.exists()) {
                return Some(lib_preload);
            }
        }
    }
    None
}

pub fn backup_preload(preload_path: &Path) -> Result<()> {
    let bak = preload_path.with_extension("so.orig.bak");
    if !bak.exists() && preload_path.exists() {
        println!("Backing up original preload library to {:?}", bak);
        fs::copy(preload_path, &bak)
            .with_context(|| format!("Failed to backup preload library at {:?}", preload_path))?;
    }
    Ok(())
}

pub fn restore_preload(preload_path: &Path) -> Result<()> {
    let bak = preload_path.with_extension("so.orig.bak");
    if bak.exists() {
        println!("Restoring original preload library from {:?}", bak);
        fs::copy(&bak, preload_path)
            .with_context(|| format!("Failed to restore preload library from {:?}", bak))?;
    }
    Ok(())
}

pub fn build_and_install_preload(preload_path: &Path) -> Result<()> {
    backup_preload(preload_path)?;

    // Write source to temporary file
    let tmp_c = std::env::temp_dir().join("spotify_adwaita_preload.c");
    fs::write(&tmp_c, PRELOAD_C_SRC)
        .with_context(|| format!("Failed to write preload source to {:?}", tmp_c))?;

    println!("Compiling borderless Wayland hook into {:?}", preload_path);
    let status = Command::new("gcc")
        .args([
            "-shared",
            "-fPIC",
            "-O2",
            "-o",
            preload_path.to_str().unwrap(),
            tmp_c.to_str().unwrap(),
            "-ldl",
            "-lpthread",
        ])
        .status()
        .context("Failed to execute gcc to build preload library")?;

    if !status.success() {
        anyhow::bail!("gcc compilation failed with exit status: {:?}", status);
    }

    let _ = fs::remove_file(tmp_c);
    Ok(())
}
