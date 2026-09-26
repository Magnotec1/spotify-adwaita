use std::path::{Path, PathBuf};
use std::process::Command;

pub struct SpotifyInstallation {
    pub xpui_spa_path: PathBuf,
    pub config_dir: PathBuf,
    pub is_flatpak: bool,
}

pub fn detect_spotify() -> Option<SpotifyInstallation> {
    let home = std::env::var("HOME").ok()?;
    let home_path = Path::new(&home);

    // 1. User Flatpak (most common on modern GNOME / Fedora / Silverblue / Arch)
    let user_flatpak_xpui = home_path.join(
        ".local/share/flatpak/app/com.spotify.Client/x86_64/stable/active/files/extra/share/spotify/Apps/xpui.spa",
    );
    let flatpak_config = home_path.join(".var/app/com.spotify.Client/config");

    if user_flatpak_xpui.exists() {
        return Some(SpotifyInstallation {
            xpui_spa_path: user_flatpak_xpui,
            config_dir: flatpak_config,
            is_flatpak: true,
        });
    }

    // 2. System Flatpak
    let system_flatpak_xpui = PathBuf::from(
        "/var/lib/flatpak/app/com.spotify.Client/x86_64/stable/active/files/extra/share/spotify/Apps/xpui.spa",
    );
    if system_flatpak_xpui.exists() {
        return Some(SpotifyInstallation {
            xpui_spa_path: system_flatpak_xpui,
            config_dir: flatpak_config,
            is_flatpak: true,
        });
    }

    // 3. Native install (/usr/share/spotify or /opt/spotify)
    let native_xpui = PathBuf::from("/usr/share/spotify/Apps/xpui.spa");
    let native_config = home_path.join(".config/spotify");
    if native_xpui.exists() {
        return Some(SpotifyInstallation {
            xpui_spa_path: native_xpui,
            config_dir: native_config,
            is_flatpak: false,
        });
    }

    let opt_xpui = PathBuf::from("/opt/spotify/spotify-client/Data/Apps/xpui.spa");
    if opt_xpui.exists() {
        return Some(SpotifyInstallation {
            xpui_spa_path: opt_xpui,
            config_dir: native_config,
            is_flatpak: false,
        });
    }

    None
}

pub fn get_gnome_button_layout() -> String {
    let output = Command::new("gsettings")
        .args(["get", "org.gnome.desktop.wm.preferences", "button-layout"])
        .output();

    if let Ok(out) = output {
        let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
        // Remove enclosing quotes e.g. "'appmenu:close'" -> "appmenu:close"
        let clean = s.trim_matches('\'').trim_matches('"');
        if !clean.is_empty() {
            return clean.to_string();
        }
    }

    "appmenu:close".to_string()
}

pub fn get_gnome_font() -> String {
    let output = Command::new("gsettings")
        .args(["get", "org.gnome.desktop.interface", "font-name"])
        .output();

    if let Ok(out) = output {
        let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
        let clean = s.trim_matches('\'').trim_matches('"');
        // 'Google Sans 10.5' -> 'Google Sans'
        if let Some(idx) = clean.rfind(' ') {
            let (name, size) = clean.split_at(idx);
            if size.trim().parse::<f32>().is_ok() {
                return name.trim().to_string();
            }
        }
        if !clean.is_empty() {
            return clean.to_string();
        }
    }

    "Cantarell".to_string()
}
