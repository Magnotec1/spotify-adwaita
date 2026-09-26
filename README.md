# spotify-adwaita

A lightweight tool written in Rust to inject code into the Spotify client to eliminate the Wayland blue borders and optionally theme the application to match GNOME

## How it works
On GNOME Wayland, Spotify creates top-level windows using CEF's Views framework (`cef_window_create_top_level`). On Linux, Spotify's window delegate hardcodes `is_frameless = 0` (unlike Windows where it defaults to frameless). This instructs Chromium/CEF to render a fallback client-side titlebar and border using GNOME's blue accent color (`#3584e4`).

`spotify-adwaita` provides a solution:
1. **The Preload Hook ([`src/preload.c`](src/preload.c)):**
   * Flatpak's Spotify launcher unconditionally loads `/app/lib/spotify-preload.so`.
   * We intercept `cef_window_create_top_level` via `LD_PRELOAD`.
   * We patch the window delegate's `is_frameless` callback at offset `0xd0` to return `1` (true).
   * **Result:** Spotify launches completely borderless and titlebarless on native Wayland! No blue outline, no fallback titlebar!
2. **Window Dragging ([`src/preload.c`](src/preload.c) & [`assets/adwaita.js`](assets/adwaita.js)):**
   * Eliminating the native titlebar removes standard window dragging.
   * We hook `on_window_created` (offset `0x80`) to capture CEF's window pointer and its `set_draggable_regions` function (offset `0x320`).
   * Injected JS dynamically marks the top 64px header as draggable while querying interactive elements (buttons, search inputs, profile links) to exclude them from dragging.
   * Coordinates are sent to a local loopback server in `preload.c` and dispatched to CEF's UI thread via `cef_post_task`.
   * **Result:** The window can be dragged naturally from any empty area in the header without interfering with clickable elements!
3. **Window Controls ([`assets/csd.css`](assets/csd.css) & [`assets/adwaita.js`](assets/adwaita.js)):**
   * Reads your desktop's GNOME `button-layout` via `gsettings` (e.g. `appmenu:close` or `:minimize,maximize,close`).
   * Injects matching Libadwaita-styled circular buttons into Spotify's web DOM and dynamically adjusts header padding to avoid overlapping existing elements.
   * Clicking a button sends an IPC request to the preload server (e.g. `/close`) to trigger native window actions.
4. **Flags:**
   * Configures `spotify-flags.conf` for `--ozone-platform=wayland` and `--enable-features=UseOzonePlatform` to ensure wayland usage
5. **Libadwaita Web UI Integration & In-App Settings:**
   * Optionally injects GNOME Adwaita dark theming into `xpui.spa`.
   * Adds a native **Spotify Adwaita** section directly into Spotify's Settings (`/preferences`) with switches to configure:
     * **Open library in expanded mode on startup**: Automatically expands Your Library into the wide multi-column/grid mode on launch.
     * **Startup primary page**: Choose between Default (Home), Your Library (Expanded), or Search.
     * **Intelligent CDN image downscaling**: Downscales 640px cover art to 300px to reduce VRAM consumption and eliminate scroll lag.
     * **Block telemetry and analytics**: Blocks background telemetry beacons (`exp.wg.spotify.com`, `crashdump.spotify.com`, `pixel.spotify.com`, etc.).
     * **Throttle power when window is hidden**: Pauses canvas background video and freezes animations when minimized or hidden.
   * All preferences are stored in `localStorage` and persist across sessions.

## Usage/Installation
```bash
  git clone https://github.com/Magnotec1/spotify-adwaita.git
  cd ./spotify-adwaita
  cargo build --release

  ./target/release/spotify-adwaita apply # Stock spotify without theming, just titlebar fixes
  ./target/release/spotify-adwaita apply --theme # With Libadwaita theming
  ./target/release/spotify-adwaita apply --theme --expand-library # With theming and library expanded on startup

  ./target/release/spotify-adwaita restore --restart # Reset and undo all changes made
```

## Project Structure

```
spotify-adwaita/
├── Cargo.toml
├── assets/
│   ├── adwaita.css       # Libadwaita dark theme, GNOME colors, borderless window styling
│   ├── adwaita.js        # Window controls, dynamic dragging sync, telemetry debloat
│   └── csd.css           # CSD window buttons styling & frame reset
└── src/
    ├── main.rs           # CLI commands & dispatcher (apply, restore, status, restart)
    ├── detector.rs       # Automatic detector for Flatpak and native Spotify paths
    ├── patcher.rs        # Safe, atomic ZIP patcher for xpui.spa with automatic backups
    ├── flags.rs          # Native Wayland Ozone & GPU acceleration flags manager
    ├── preload.rs        # Compiles & manages the borderless LD_PRELOAD library
    └── preload.c         # C hook intercepting CEF window delegate & IPC command server
```
