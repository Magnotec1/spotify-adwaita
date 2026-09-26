mod detector;
mod flags;
mod patcher;
mod preload;

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use std::process::Command;

const CSD_CSS: &str = include_str!("../assets/csd.css");
const ADWAITA_CSS: &str = include_str!("../assets/adwaita.css");
const ADWAITA_JS: &str = include_str!("../assets/adwaita.js");

#[derive(Parser)]
#[command(name = "spotify-adwaita")]
#[command(about = "Native Libadwaita theming, Wayland border fix, and debloating for Spotify on GNOME", long_about = None)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Apply borderless Wayland fix, native window drag, debloat, and optionally Libadwaita theme
    Apply {
        /// Automatically restart Spotify after applying changes
        #[arg(short, long)]
        restart: bool,

        /// Enable Libadwaita color theming (replaces #000000 with GNOME's #222226)
        #[arg(long, num_args = 0..=1, default_missing_value = "true")]
        theme: Option<bool>,

        /// Explicitly disable Libadwaita color theming (preserve Spotify's vanilla black colors)
        #[arg(long, conflicts_with = "theme")]
        no_theme: bool,

        /// Set interface font family (defaults to detected GNOME system font)
        #[arg(long)]
        font: Option<String>,
    },
    /// Restore original Spotify UI and remove Wayland flags
    Restore {
        /// Automatically restart Spotify after restoring
        #[arg(short, long)]
        restart: bool,
    },
    /// Show current installation, patch status, and active flags
    Status,
    /// Gracefully terminate and restart Spotify
    Restart,
}

fn kill_spotify() {
    println!("Stopping Spotify...");
    let _ = Command::new("pkill").arg("-9").arg("-f").arg("spotify").status();
    std::thread::sleep(std::time::Duration::from_millis(600));
}

fn launch_spotify() -> Result<()> {
    println!("Launching Spotify via Flatpak...");
    let status = Command::new("systemd-run")
        .args(["--user", "flatpak", "run", "com.spotify.Client"])
        .status();

    if status.is_err() || !status.as_ref().unwrap().success() {
        Command::new("flatpak")
            .args(["run", "com.spotify.Client"])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .context("Failed to launch Spotify via Flatpak")?;
    }
    Ok(())
}

fn main() -> Result<()> {
    let cli = Cli::parse();

    let install = detector::detect_spotify()
        .context("Could not locate Spotify installation on this system.")?;

    match cli.command {
        Commands::Status => {
            println!("=== Spotify Adwaita Status ===");
            println!("Installation type: {}", if install.is_flatpak { "Flatpak" } else { "Native" });
            println!("xpui.spa path:     {:?}", install.xpui_spa_path);
            println!("Config directory:  {:?}", install.config_dir);

            let sys_font = detector::get_gnome_font();
            println!("System Font:       {}", sys_font);

            let patch_status = patcher::get_patch_status(&install.xpui_spa_path)
                .unwrap_or(patcher::PatchStatus { is_patched: false, has_theme: false });
            if patch_status.is_patched {
                if patch_status.has_theme {
                    println!("UI Patched:        YES (Libadwaita Theme active, #222226 background, #333337 cards)");
                } else {
                    println!("UI Patched:        YES (Vanilla Theme active, #000000 background)");
                }
            } else {
                println!("UI Patched:        NO (Unpatched)");
            }

            let bak = patcher::backup_path(&install.xpui_spa_path);
            println!("UI Backup exists:  {}", if bak.exists() { "YES" } else { "NO" });

            if let Some(preload_path) = preload::get_preload_path(&install.xpui_spa_path) {
                let preload_bak = preload_path.with_extension("so.orig.bak");
                println!("Preload Library:   {:?}", preload_path);
                println!("Preload Hooked:    {}", if preload_bak.exists() { "YES (Borderless Wayland active)" } else { "NO" });
            }

            let active_flags = flags::get_flags(&install.config_dir);
            match active_flags {
                Some(f) => {
                    println!("\nActive spotify-flags.conf:");
                    for line in f.lines() {
                        println!("  {}", line);
                    }
                }
                None => {
                    println!("\nActive spotify-flags.conf: (None)");
                }
            }
        }
        Commands::Apply {
            restart,
            theme,
            no_theme,
            font,
        } => {
            let enable_theme = match (theme, no_theme) {
                (Some(false), _) | (_, true) => false,
                (Some(true), _) => true,
                (None, false) => false,
            };

            let detected_font = detector::get_gnome_font();
            let selected_font = font.unwrap_or(detected_font);

            println!("Applying Spotify Adwaita...");
            if enable_theme {
                println!("  • Libadwaita color theming: ENABLED (replacing #000000 with #222226, cards #333337)");
                println!("  • Interface font:          \"{}\" (GNOME system font)", selected_font);
            } else {
                println!("  • Libadwaita color theming: DISABLED (preserving vanilla Spotify colors)");
                println!("    (Tip: Use `--theme` to enable GNOME #222226 dark theming)");
            }

            // 1. Configure Wayland flags (native Ozone + hardware GPU acceleration)
            flags::configure_flags(&install.config_dir)?;
            println!("✓ Configured Wayland & performance flags in {:?}", install.config_dir);

            // 2. Install borderless Wayland hook into preload library
            if let Some(preload_path) = preload::get_preload_path(&install.xpui_spa_path) {
                preload::build_and_install_preload(&preload_path)?;
                println!("✓ Installed borderless Wayland hook into {:?}", preload_path);
            }

            // 3. Detect GNOME button layout and patch xpui.spa
            let button_layout = detector::get_gnome_button_layout();
            println!("✓ Detected GNOME button-layout: {}", button_layout);

            let js_with_layout = format!("window.GNOME_BUTTON_LAYOUT = {:?};\n{}", button_layout, ADWAITA_JS);
            let font_stack = format!("\"{}\", Cantarell, -apple-system, system-ui, sans-serif", selected_font);
            let theme_css = ADWAITA_CSS.replace("__SYSTEM_FONT__", &font_stack);

            let css_to_inject = if enable_theme {
                format!("{}\n\n{}", CSD_CSS, theme_css)
            } else {
                CSD_CSS.to_string()
            };

            patcher::patch(&install.xpui_spa_path, &css_to_inject, &js_with_layout)?;
            if enable_theme {
                println!("✓ Patched xpui.spa with Libadwaita theme (#222226), #333337 cards, \"{}\" font, and CSD controls", selected_font);
            } else {
                println!("✓ Patched xpui.spa with Wayland CSD controls and telemetry debloat (vanilla theme)");
            }

            println!("\n🎉 Successfully applied Spotify Adwaita!");

            if restart {
                kill_spotify();
                launch_spotify()?;
            } else {
                println!("Run `spotify-adwaita restart` or restart Spotify to enjoy the changes.");
            }
        }
        Commands::Restore { restart } => {
            println!("Restoring original Spotify configuration...");

            // 1. Remove flags
            flags::remove_flags(&install.config_dir)?;
            println!("✓ Removed spotify-flags.conf");

            // 2. Restore preload library
            if let Some(preload_path) = preload::get_preload_path(&install.xpui_spa_path) {
                preload::restore_preload(&preload_path)?;
                println!("✓ Restored original preload library");
            }

            // 3. Restore xpui.spa
            patcher::restore(&install.xpui_spa_path)?;
            println!("✓ Restored original xpui.spa from backup");

            println!("\n✨ Successfully restored vanilla Spotify.");

            if restart {
                kill_spotify();
                launch_spotify()?;
            }
        }
        Commands::Restart => {
            kill_spotify();
            launch_spotify()?;
        }
    }

    Ok(())
}
