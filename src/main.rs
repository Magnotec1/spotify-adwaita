mod detector;
mod flags;
mod patcher;
mod preload;

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use std::process::Command;

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
    /// Apply Libadwaita theme, fix Wayland blue borders, and inject performance patches
    Apply {
        /// Automatically restart Spotify after applying changes
        #[arg(short, long)]
        restart: bool,
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
    Command::new("flatpak")
        .args(["run", "com.spotify.Client"])
        .spawn()
        .context("Failed to launch Spotify via Flatpak")?;
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

            let patched = patcher::is_patched(&install.xpui_spa_path).unwrap_or(false);
            println!("UI Patched:        {}", if patched { "YES (Libadwaita injected)" } else { "NO (Vanilla)" });

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
        Commands::Apply { restart } => {
            println!("Applying Spotify Adwaita...");

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
            patcher::patch(&install.xpui_spa_path, ADWAITA_CSS, &js_with_layout)?;
            println!("✓ Patched xpui.spa with Libadwaita styles, CSD header, and telemetry debloat");

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
