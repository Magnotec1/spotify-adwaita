# spotify-adwaita

A lightweight tool written in Rust to inject **GNOME Libadwaita styling**, **eliminate the Wayland blue borders**, and **debloat/optimize Spotify on Linux**.

---

## How It Solves the Blue Border (Without X11)

On GNOME Wayland, Spotify creates top-level windows using CEF's Views framework (`cef_window_create_top_level`). On Linux, Spotify's window delegate hardcodes `is_frameless = 0` (unlike Windows where it defaults to frameless). This instructs Chromium/CEF to render a fallback client-side titlebar and border using GNOME's blue accent color (`#3584e4`).

`spotify-adwaita` provides an elegant, 100% native Wayland solution:
1. **The Preload Hook ([`src/preload.c`](file:///home/magnotec/Projects/desktop/spotify-adwaita/src/preload.c)):**
   * Flatpak's Spotify launcher unconditionally loads `/app/lib/spotify-preload.so`.
   * We intercept `cef_window_create_top_level` via `LD_PRELOAD`.
   * We patch the window delegate's `is_frameless` callback at offset `0xd0` to return `1` (true).
   * **Result:** Spotify launches completely borderless and titlebarless on native Wayland! No blue outline, no fallback titlebar!
2. **Native Wayland Ozone Flags:**
   * Configures `spotify-flags.conf` for `--ozone-platform=wayland` and `--enable-features=UseOzonePlatform` with direct GPU rasterization and zero-copy rendering.
3. **Libadwaita Web UI Integration:**
   * Injects GNOME Adwaita dark colors, clean scrollbars, and refined **Friend Activity (Buddy Feed)** cards into `xpui.spa`.
   * Blocks tracking beacons (`exp.wg.spotify.com`, `crashdump.spotify.com`, `pixel.spotify.com`) and throttles background rendering when the window is hidden.

---

## Usage

### 1. View Current Status
```bash
./target/release/spotify-adwaita status
```

### 2. Apply Borderless Hook & Theme
```bash
./target/release/spotify-adwaita apply --restart
```

### 3. Restore 100% Stock Spotify
```bash
./target/release/spotify-adwaita restore --restart
```

### 4. Restart Spotify
```bash
./target/release/spotify-adwaita restart
```

---

## Project Structure

```
spotify-adwaita/
├── Cargo.toml
├── assets/
│   ├── adwaita.css       # Libadwaita dark theme, GNOME colors, borderless window styling
│   └── adwaita.js        # Debloater, telemetry blocker, visibility throttling
└── src/
    ├── main.rs           # CLI commands & dispatcher (apply, restore, status, restart)
    ├── detector.rs       # Automatic detector for Flatpak and native Spotify paths
    ├── patcher.rs        # Safe, atomic ZIP patcher for xpui.spa with automatic backups
    ├── flags.rs          # Native Wayland Ozone & GPU acceleration flags manager
    ├── preload.rs        # Compiles & manages the borderless LD_PRELOAD library
    └── preload.c         # C hook intercepting cef_window_create_top_level & is_frameless
```
