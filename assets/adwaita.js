/**
 * Spotify Adwaita - Debloat, Telemetry Blocker & Seamless Window Controls
 */

(function () {
    'use strict';

    console.log('[spotify-adwaita] Initializing Libadwaita enhancements...');

    // -------------------------------------------------------------
    // 0. Configuration Management & Settings System
    // -------------------------------------------------------------
    const CONFIG_KEY = 'spotify-adwaita:config';

    const SETTINGS_DEFINITIONS = [
        {
            id: 'startupPage',
            type: 'select',
            label: 'Startup primary page',
            description: 'Select the default page or expanded view displayed when Spotify opens',
            default: 'home',
            options: [
                { value: 'home', label: 'Default (Home)' },
                { value: 'search', label: 'Search / Browse' },
                { value: 'library', label: 'Your Library (Expanded)' },
                { value: 'now-playing', label: 'Now Playing (Expanded)' }
            ],
            onChange: (val) => {
                if (val === 'search') {
                    collapseNowPlaying();
                    document.querySelector('[data-testid="browse-button"], [data-testid="search-icon"], [data-testid="search-input"]')?.click();
                } else if (val === 'home') {
                    collapseNowPlaying();
                    document.querySelector('[data-testid="home-button"]')?.click();
                } else if (val === 'library') {
                    collapseNowPlaying();
                    expandLibrary();
                } else if (val === 'now-playing') {
                    expandNowPlaying();
                }
            }
        },
        {
            id: 'downscaleImages',
            type: 'switch',
            label: 'Intelligent CDN image downscaling',
            description: 'Downscale 640px cover art to 300px to reduce VRAM consumption and eliminate scroll lag',
            default: true,
            onChange: (val) => {
                if (val) {
                    scanAndDownscaleDom();
                } else {
                    const imgs = document.querySelectorAll('img');
                    for (let i = 0; i < imgs.length; i++) {
                        const img = imgs[i];
                        if (img.src && img.src.includes('ab67616d00001e02')) {
                            img.src = img.src.replace('ab67616d00001e02', 'ab67616d0000b273');
                        }
                        if (img.src && img.src.includes('ab67616100005174')) {
                            img.src = img.src.replace('ab67616100005174', 'ab6761610000e5eb');
                        }
                    }
                }
            }
        },
        {
            id: 'blockTelemetry',
            type: 'switch',
            label: 'Block telemetry and analytics',
            description: 'Prevent background telemetry, crash reporting, and tracking requests to improve privacy and performance',
            default: true
        },
        {
            id: 'throttleHiddenPower',
            type: 'switch',
            label: 'Throttle power when window is hidden',
            description: 'Pause background canvas videos and freeze CSS animations when the Spotify window is hidden or minimized',
            default: true,
            onChange: (val) => {
                if (!val) {
                    document.body.classList.remove('spotify-adw-hidden');
                    document.querySelectorAll('video').forEach(v => {
                        if (v._adwWasPlaying) {
                            delete v._adwWasPlaying;
                            try { v.play(); } catch (_) {}
                        }
                    });
                }
            }
        }
    ];

    function loadConfig() {
        const defaults = {};
        for (const s of SETTINGS_DEFINITIONS) {
            defaults[s.id] = s.default;
        }
        if (typeof window.__ADW_DEFAULT_CONFIG === 'object' && window.__ADW_DEFAULT_CONFIG) {
            Object.assign(defaults, window.__ADW_DEFAULT_CONFIG);
        }
        try {
            const raw = localStorage.getItem(CONFIG_KEY);
            if (raw) {
                const parsed = JSON.parse(raw);
                if (parsed.startupPage === 'default') parsed.startupPage = 'home';
                if (parsed.expandLibraryOnStartup && (!parsed.startupPage || parsed.startupPage === 'home')) {
                    parsed.startupPage = 'library';
                }
                delete parsed.expandLibraryOnStartup;
                return Object.assign({}, defaults, parsed);
            }
        } catch (_) {}
        return Object.assign({}, defaults);
    }

    let config = loadConfig();

    function syncSettingsInputs() {
        const section = document.getElementById('adw-settings-section');
        if (!section) return;
        for (const s of SETTINGS_DEFINITIONS) {
            const el = section.querySelector(`#adw-setting-${s.id}`);
            if (!el) continue;
            if (s.type === 'switch') {
                el.checked = !!config[s.id];
            } else if (s.type === 'select') {
                el.value = config[s.id] || s.default;
            }
        }
    }

    async function syncConfigFromDisk() {
        try {
            const resp = await fetch('http://127.0.0.1:45454/get_config');
            if (resp.ok) {
                const diskConfig = await resp.json();
                if (diskConfig && typeof diskConfig === 'object' && Object.keys(diskConfig).length > 0) {
                    if (diskConfig.startupPage === 'default') diskConfig.startupPage = 'home';
                    if (diskConfig.expandLibraryOnStartup && (!diskConfig.startupPage || diskConfig.startupPage === 'home')) {
                        diskConfig.startupPage = 'library';
                    }
                    delete diskConfig.expandLibraryOnStartup;
                    config = Object.assign({}, config, diskConfig);
                    try {
                        localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
                    } catch (_) {}
                    syncSettingsInputs();
                }
            }
        } catch (_) {}
    }

    function saveConfig(patch) {
        config = Object.assign({}, config, patch);
        const jsonStr = JSON.stringify(config);
        try {
            localStorage.setItem(CONFIG_KEY, jsonStr);
        } catch (_) {}
        // Persist immediately to disk via preload server
        fetch(`http://127.0.0.1:45454/save_config?data=${encodeURIComponent(jsonStr)}`, { mode: 'no-cors' }).catch(() => {});
        syncSettingsInputs();
    }

    window.__spotifyAdwaita = {
        getConfig: () => Object.assign({}, config),
        saveConfig,
        syncConfigFromDisk,
        expandLibrary: () => expandLibrary(),
        collapseLibrary: () => collapseLibrary(),
        expandNowPlaying: () => expandNowPlaying(),
        collapseNowPlaying: () => collapseNowPlaying(),
        definitions: SETTINGS_DEFINITIONS
    };

    // -------------------------------------------------------------
    // 1. Telemetry & Analytics Blocker (Performance Improvement)
    // -------------------------------------------------------------
    const BLOCKED_DOMAINS = [
        'exp.wg.spotify.com',
        'pixel.spotify.com',
        'crashdump.spotify.com',
        '/telemetry/',
        '/event-service/',
        '/v1/events',
        '/melody/v1/log',
        '/melody/v1/batch',
        '/logging/',
        '/beacon/',
        'analytics.spotify.com',
        'sentry.io',
        'google-analytics.com',
        'doubleclick.net'
    ];

    function shouldBlock(url) {
        if (!config.blockTelemetry) return false;
        if (!url) return false;
        const str = String(url);
        return BLOCKED_DOMAINS.some(domain => str.includes(domain));
    }

    const originalFetch = window.fetch;
    window.fetch = function (resource, init) {
        const url = (typeof resource === 'string') ? resource : (resource ? resource.url : '');
        if (shouldBlock(url)) {
            return Promise.resolve(new Response('{"status":"ok"}', {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            }));
        }
        return originalFetch.apply(this, arguments);
    };

    const originalOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
        this._isBlocked = shouldBlock(url);
        return originalOpen.apply(this, arguments);
    };

    const originalSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function () {
        if (this._isBlocked) {
            Object.defineProperty(this, 'status', { value: 200, writable: false });
            Object.defineProperty(this, 'readyState', { value: 4, writable: false });
            Object.defineProperty(this, 'responseText', { value: '{"status":"ok"}', writable: false });
            if (typeof this.onreadystatechange === 'function') this.onreadystatechange();
            if (typeof this.onload === 'function') this.onload(new Event('load'));
            return;
        }
        return originalSend.apply(this, arguments);
    };

    // -------------------------------------------------------------
    // 2. Intelligent CDN Image Downscaling (Memory & Scroll Performance)
    // Downscales 640x640 thumbnails to 300x300 (same as Spotify Web Player).
    // Saves ~78% uncompressed VRAM and eliminates downsampling lag.
    // -------------------------------------------------------------
    window.__ADW_DOWNSCALE_COUNT__ = 0;

    function downscaleImageUrl(url) {
        if (!config.downscaleImages) return url;
        if (typeof url === 'string') {
            if (url.includes('ab67616d0000b273')) {
                window.__ADW_DOWNSCALE_COUNT__++;
                return url.replace('ab67616d0000b273', 'ab67616d00001e02');
            }
            if (url.includes('ab6761610000e5eb')) {
                window.__ADW_DOWNSCALE_COUNT__++;
                return url.replace('ab6761610000e5eb', 'ab67616100005174');
            }
        }
        return url;
    }

    try {
        const imgDesc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
        if (imgDesc && imgDesc.set) {
            Object.defineProperty(HTMLImageElement.prototype, 'src', {
                set: function (val) {
                    return imgDesc.set.call(this, downscaleImageUrl(val));
                },
                get: function () {
                    return imgDesc.get.call(this);
                },
                configurable: true
            });
        }

        const originalSetAttribute = Element.prototype.setAttribute;
        Element.prototype.setAttribute = function (name, value) {
            if (name === 'src' && this instanceof HTMLImageElement) {
                value = downscaleImageUrl(value);
            }
            return originalSetAttribute.call(this, name, value);
        };
    } catch (_) {}

    window.__ADW_VERIFY_IMAGES__ = function () {
        const imgs = Array.from(document.querySelectorAll('img'));
        const downscaled = imgs.filter(i => i.src && (i.src.includes('1e02') || i.src.includes('5174') || i.src.includes('4851')));
        const fullres = imgs.filter(i => i.src && (i.src.includes('b273') || i.src.includes('e5eb')));
        const stats = {
            totalImages: imgs.length,
            downscaled300px: downscaled.length,
            fullres640px: fullres.length,
            interceptCount: window.__ADW_DOWNSCALE_COUNT__,
            firstFiveSampleUrls: imgs.slice(0, 5).map(i => i.src)
        };
        console.log('[spotify-adwaita] Image Stats:', JSON.stringify(stats, null, 2));
        return stats;
    };

    function scanAndDownscaleDom() {
        if (!config.downscaleImages) return;
        const imgs = document.querySelectorAll('img');
        for (let i = 0; i < imgs.length; i++) {
            const img = imgs[i];
            if (img.src && img.src.includes('ab67616d0000b273')) {
                img.src = img.src.replace('ab67616d0000b273', 'ab67616d00001e02');
            }
            if (img.src && img.src.includes('ab6761610000e5eb')) {
                img.src = img.src.replace('ab6761610000e5eb', 'ab67616100005174');
            }
        }
    }

    // -------------------------------------------------------------
    // 3. Neuter Sentry & Error Tracing Overhead
    // -------------------------------------------------------------
    try {
        window.__SENTRY__ = window.__SENTRY__ || {};
        window.__SENTRY__.hub = {
            getClient: () => null,
            captureException: () => {},
            captureMessage: () => {},
            addBreadcrumb: () => {},
            setUser: () => {},
            setTag: () => {},
            setExtra: () => {}
        };
    } catch (_) {}

    // -------------------------------------------------------------
    // 3. Power & CPU Throttling for Hidden/Minimized Window
    // -------------------------------------------------------------
    document.addEventListener('visibilitychange', () => {
        if (!config.throttleHiddenPower) return;
        if (document.hidden) {
            document.body.classList.add('spotify-adw-hidden');
            // Pause any playing canvas background video while window is hidden
            document.querySelectorAll('video').forEach(v => {
                if (!v.paused) {
                    v._adwWasPlaying = true;
                    try { v.pause(); } catch (_) {}
                }
            });
        } else {
            document.body.classList.remove('spotify-adw-hidden');
            // Resume canvas video when window is visible again
            document.querySelectorAll('video').forEach(v => {
                if (v._adwWasPlaying) {
                    delete v._adwWasPlaying;
                    try { v.play(); } catch (_) {}
                }
            });
        }
    });

    // Helper: locate the top header container
    function getHeaderContainer() {
        return document.getElementById('global-nav-bar') ||
               document.querySelector('[data-testid="global-nav-bar"], header, .Root__top-bar, .Root__globalNav');
    }

    // -------------------------------------------------------------
    // 4. Shift Header UI Containers to prevent window control overlap
    // -------------------------------------------------------------
    function updateHeaderOffsets() {
        const nav = getHeaderContainer();
        // Query buttons strictly inside header container to prevent layout thrashing
        const buttons = nav ? nav.querySelectorAll('button:not(.adw-window-btn)') : [];

        // 1. Right window controls padding
        const rightControls = document.getElementById('adw-window-controls');
        let neededRightPadding = 0;
        if (rightControls) {
            const btns = rightControls.querySelectorAll('.adw-window-btn');
            if (btns.length > 0) {
                const rect = rightControls.getBoundingClientRect();
                if (rect.width > 0) {
                    neededRightPadding = Math.ceil(window.innerWidth - rect.left) + 4;
                } else {
                    neededRightPadding = 14 + btns.length * 26 + (btns.length - 1) * 8 + 4;
                }
            }
        }

        let rightmost = null;
        let maxX = 0;
        for (const btn of buttons) {
            const rect = btn.getBoundingClientRect();
            // Header buttons in top 64px region
            if (rect.top >= 0 && rect.top <= 64 && rect.right > maxX && rect.width > 0) {
                maxX = rect.right;
                rightmost = btn;
            }
        }

        if (rightmost) {
            const container = rightmost.parentElement;
            if (container) {
                if (neededRightPadding > 0) {
                    const padStr = `${neededRightPadding}px`;
                    if (container.style.paddingRight !== padStr) {
                        container.style.paddingRight = padStr;
                        container.style.boxSizing = 'border-box';
                    }
                } else if (container.style.paddingRight) {
                    container.style.paddingRight = '';
                }
            }
        } else if (nav && nav.lastElementChild) {
            const container = nav.lastElementChild;
            if (neededRightPadding > 0) {
                const padStr = `${neededRightPadding}px`;
                if (container.style.paddingRight !== padStr) {
                    container.style.paddingRight = padStr;
                    container.style.boxSizing = 'border-box';
                }
            } else if (container.style.paddingRight) {
                container.style.paddingRight = '';
            }
        }

        // 2. Left window controls padding
        const leftControls = document.getElementById('adw-window-controls-left');
        let neededLeftPadding = 0;
        if (leftControls) {
            const btns = leftControls.querySelectorAll('.adw-window-btn');
            if (btns.length > 0) {
                const rect = leftControls.getBoundingClientRect();
                if (rect.width > 0) {
                    neededLeftPadding = Math.ceil(rect.right) + 4;
                } else {
                    neededLeftPadding = 14 + btns.length * 26 + (btns.length - 1) * 8 + 4;
                }
            }
        }

        if (neededLeftPadding > 0) {
            let leftmost = null;
            let minX = Infinity;
            for (const btn of buttons) {
                const rect = btn.getBoundingClientRect();
                if (rect.top >= 0 && rect.top <= 64 && rect.left < minX && rect.width > 0) {
                    minX = rect.left;
                    leftmost = btn;
                }
            }

            if (leftmost) {
                const container = leftmost.parentElement;
                if (container) {
                    const padStr = `${neededLeftPadding}px`;
                    if (container.style.paddingLeft !== padStr) {
                        container.style.paddingLeft = padStr;
                        container.style.boxSizing = 'border-box';
                    }
                }
            } else if (nav && nav.firstElementChild) {
                const container = nav.firstElementChild;
                const padStr = `${neededLeftPadding}px`;
                if (container.style.paddingLeft !== padStr) {
                    container.style.paddingLeft = padStr;
                    container.style.boxSizing = 'border-box';
                }
            }
        }
    }

    // -------------------------------------------------------------
    // 5. Seamless Window Controls Injection
    // -------------------------------------------------------------
    function setupWindowControls() {
        const layout = window.GNOME_BUTTON_LAYOUT || "appmenu:close";
        const parts = layout.split(':');
        const leftParts = parts[0] ? parts[0].split(',') : [];
        const rightParts = parts.length > 1 ? parts[1].split(',') : [];

        function parseButtons(partList) {
            return partList
                .map(s => s.trim())
                .filter(b => ['close', 'minimize', 'maximize'].includes(b));
        }

        const leftButtons = parseButtons(leftParts);
        const rightButtons = parseButtons(rightParts);

        function createBtn(type) {
            const btn = document.createElement('button');
            btn.className = `adw-window-btn ${type}`;
            btn.title = type.charAt(0).toUpperCase() + type.slice(1);
            btn.tabIndex = -1;

            if (type === 'close') {
                btn.innerHTML = `
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                        <path d="M4 4h1.03125c.253906.011719.511719.128906.6875.3125L8 6.59375l2.3125-2.28125c.265625-.230469.445312-.304688.6875-.3125h1v1c0 .285156-.035156.550781-.25.75L9.46875 8.03125l2.25 2.25c.1875.1875.28125.453125.28125.71875v1h-1c-.265625 0-.53125-.09375-.71875-.28125L8 9.4375l-2.28125 2.28125C5.53125 11.90625 5.265625 12 5 12H4v-1c0-.265625.09375-.53125.28125-.71875l2.28125-2.25L4.28125 5.75C4.070312 5.554688 3.976562 5.28125 4 5zm0 0"/>
                    </svg>`;
                btn.onclick = (e) => {
                    e.stopPropagation();
                    fetch('http://127.0.0.1:45454/close', { mode: 'no-cors' }).catch(() => {});
                };
            } else if (type === 'minimize') {
                btn.innerHTML = `
                    <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
                        <rect y="7" width="16" height="2" rx="1"/>
                    </svg>`;
                btn.onclick = (e) => {
                    e.stopPropagation();
                    fetch('http://127.0.0.1:45454/minimize', { mode: 'no-cors' }).catch(() => {});
                };
            } else if (type === 'maximize') {
                btn.innerHTML = `
                    <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
                        <path d="M3 3h10v10H3V3zm1 1v8h8V4H4z"/>
                    </svg>`;
                btn.onclick = (e) => {
                    e.stopPropagation();
                    fetch('http://127.0.0.1:45454/toggle_maximize', { mode: 'no-cors' }).catch(() => {});
                };
            }
            return btn;
        }

        if (leftButtons.length > 0 && !document.getElementById('adw-window-controls-left')) {
            const leftContainer = document.createElement('div');
            leftContainer.id = 'adw-window-controls-left';
            for (const b of leftButtons) {
                leftContainer.appendChild(createBtn(b));
            }
            document.body.appendChild(leftContainer);
            console.log('[spotify-adwaita] Controls injected for left layout:', leftButtons);
        }

        if (rightButtons.length > 0 && !document.getElementById('adw-window-controls')) {
            const rightContainer = document.createElement('div');
            rightContainer.id = 'adw-window-controls';
            for (const b of rightButtons) {
                rightContainer.appendChild(createBtn(b));
            }
            document.body.appendChild(rightContainer);
            console.log('[spotify-adwaita] Controls injected for right layout:', rightButtons);
        }
    }

    // -------------------------------------------------------------
    // 6. Dynamic Draggable Regions (Header drag + Interactive buttons)
    // -------------------------------------------------------------
    let lastRegionsStr = '';

    function syncDraggableRegions() {
        const width = window.innerWidth;
        if (!width || width <= 0) return;

        const regions = [];
        // 1. Full header is draggable by default (top 64px)
        regions.push(`0,0,${width},64,1`);

        // 2. Query interactive elements ONLY in header container to eliminate layout thrashing
        const nav = getHeaderContainer();
        const headerElements = nav
            ? Array.from(nav.querySelectorAll('button, input, a, [role="button"], [role="link"], select, textarea, [contenteditable="true"]'))
            : [];

        const csdButtons = Array.from(document.querySelectorAll('.adw-window-btn'));
        const interactive = headerElements.concat(csdButtons);

        for (const el of interactive) {
            const r = el.getBoundingClientRect();
            // Check if element intersects top 64px header area
            if (r.top < 64 && r.bottom > 0 && r.width > 0 && r.height > 0) {
                const x = Math.max(0, Math.floor(r.left) - 1);
                const y = Math.max(0, Math.floor(r.top) - 1);
                const w = Math.ceil(r.width) + 2;
                const h = Math.ceil(r.height) + 2;
                regions.push(`${x},${y},${w},${h},0`);
            }
        }

        const regionsStr = regions.join(';');
        if (regionsStr === lastRegionsStr) return; // avoid unnecessary network calls
        lastRegionsStr = regionsStr;

        fetch(`http://127.0.0.1:45454/regions?r=${regionsStr}`, { mode: 'no-cors' }).catch(() => {});
    }

    // -------------------------------------------------------------
    // 7. Library Mode & Startup Expansion
    // -------------------------------------------------------------
    function isLibraryExpanded() {
        const minimizeBtn = Array.from(document.querySelectorAll('button')).find(b => {
            const aria = (b.getAttribute('aria-label') || '').toLowerCase();
            return aria.includes('minimize your library') || aria.includes('reduce your library');
        });
        if (minimizeBtn) return true;
        const nav = document.querySelector('nav, [aria-label="Your Library"], [data-testid="your-library-x"]');
        if (nav && nav.getBoundingClientRect().width > 500) return true;
        return false;
    }

    function expandLibrary() {
        if (isLibraryExpanded()) return true;

        const nav = document.querySelector('nav, [aria-label="Your Library"], [data-testid="your-library-x"]');
        if (nav && nav.getBoundingClientRect().width < 120) {
            const openBtn = Array.from(nav.querySelectorAll('button')).find(b => {
                const aria = (b.getAttribute('aria-label') || '').toLowerCase();
                return aria.includes('expand your library') || aria.includes('open your library');
            });
            if (openBtn) openBtn.click();
        }

        const expandBtn = Array.from(document.querySelectorAll('button')).find(b => {
            const aria = (b.getAttribute('aria-label') || '').toLowerCase();
            return (aria === 'expand your library' || aria === 'enlarge your library' || aria.includes('expand your library')) &&
                   b.closest('nav, [aria-label="Your Library"], [data-testid="your-library-x"]');
        });

        if (expandBtn) {
            expandBtn.click();
            return true;
        }

        return false;
    }

    function collapseLibrary() {
        const minimizeBtn = Array.from(document.querySelectorAll('button')).find(b => {
            const aria = (b.getAttribute('aria-label') || '').toLowerCase();
            return aria.includes('minimize your library') || aria.includes('reduce your library');
        });
        if (minimizeBtn) {
            minimizeBtn.click();
            return true;
        }
        return false;
    }

    function isNowPlayingExpanded() {
        const minimizeBtn = Array.from(document.querySelectorAll('button')).find(b => {
            const aria = (b.getAttribute('aria-label') || '').toLowerCase();
            return aria.includes('minimize now playing') || aria.includes('exit full screen');
        });
        if (minimizeBtn) return true;
        return !!document.querySelector('main .NowPlayingView, [data-testid="now-playing-view"]');
    }

    function expandNowPlaying() {
        if (isNowPlayingExpanded()) return true;

        // 1. If cinema mode expand button is visible (e.g. sidebar is already open), click it
        const expandBtn = Array.from(document.querySelectorAll('button')).find(b => {
            const aria = (b.getAttribute('aria-label') || '').toLowerCase();
            return aria.includes('expand now playing');
        });
        if (expandBtn) {
            expandBtn.click();
            return true;
        }

        // 2. Otherwise open Now Playing view from bottom bar, then trigger expand
        const npvBtn = document.querySelector('[data-testid="control-button-npv"], button[aria-label*="Now playing view"], [data-testid="cover-art-button"]');
        if (npvBtn) {
            npvBtn.click();
            setTimeout(() => {
                const btn = Array.from(document.querySelectorAll('button')).find(b => {
                    const aria = (b.getAttribute('aria-label') || '').toLowerCase();
                    return aria.includes('expand now playing');
                });
                if (btn) btn.click();
            }, 250);
            return true;
        }

        return false;
    }

    function collapseNowPlaying() {
        const minimizeBtn = Array.from(document.querySelectorAll('button')).find(b => {
            const aria = (b.getAttribute('aria-label') || '').toLowerCase();
            return aria.includes('minimize now playing') || aria.includes('exit full screen');
        });
        if (minimizeBtn) {
            minimizeBtn.click();
            return true;
        }
        return false;
    }

    let startupPreferencesApplied = false;

    function applyStartupPreferences() {
        if (startupPreferencesApplied) return;

        if (config.startupPage === 'library') {
            let attempts = 0;
            const expandTimer = setInterval(() => {
                attempts++;
                if (expandLibrary() || attempts >= 30) {
                    clearInterval(expandTimer);
                }
            }, 200);
        } else if (config.startupPage === 'now-playing') {
            let npAttempts = 0;
            const npTimer = setInterval(() => {
                npAttempts++;
                if (expandNowPlaying() || npAttempts >= 30) {
                    clearInterval(npTimer);
                }
            }, 200);
        } else if (config.startupPage === 'search') {
            let searchAttempts = 0;
            const searchTimer = setInterval(() => {
                searchAttempts++;
                const searchTarget = document.querySelector('[data-testid="browse-button"], [data-testid="search-icon"], [data-testid="search-input"], [aria-label="Search"], [aria-label="Browse"]');
                if (searchTarget) {
                    searchTarget.click();
                    clearInterval(searchTimer);
                } else if (searchAttempts >= 30) {
                    clearInterval(searchTimer);
                }
            }, 200);
        } else if (config.startupPage === 'home') {
            let homeAttempts = 0;
            const homeTimer = setInterval(() => {
                homeAttempts++;
                const homeBtn = document.querySelector('[data-testid="home-button"], [aria-label="Home"]');
                if (homeBtn) {
                    homeBtn.click();
                    clearInterval(homeTimer);
                } else if (homeAttempts >= 30) {
                    clearInterval(homeTimer);
                }
            }, 200);
        }

        startupPreferencesApplied = true;
    }

    // -------------------------------------------------------------
    // 8. Custom Spotify Adwaita Settings Page Section
    // -------------------------------------------------------------
    function checkAndInjectSettings() {
        const page = document.querySelector('[data-testid="settings-page"]');
        if (!page) return;
        if (document.getElementById('adw-settings-section')) {
            syncSettingsInputs();
            return;
        }

        const section = document.createElement('div');
        section.id = 'adw-settings-section';
        section.className = 'fNaaQ0Cp8Yzy19j8 adw-settings-container';

        let innerHtml = `
            <div class="adw-settings-header">
                <h2 class="e-10451-text encore-text-body-medium-bold encore-internal-color-text-base adw-settings-title" data-encore-id="text">Spotify Adwaita</h2>
            </div>
        `;

        for (const s of SETTINGS_DEFINITIONS) {
            const currentVal = config[s.id];
            innerHtml += `
                <div class="qV_CxbowaNkMarye adw-setting-row" data-setting-id="${s.id}">
                    <div class="FLjFgCRmVaE0WSqc YiisLjvymVYZFCzm adw-setting-info">
                        <label class="e-10451-text encore-text-body-small encore-internal-color-text-base adw-setting-label" data-encore-id="text" for="adw-setting-${s.id}">${s.label}</label>
                        <span class="e-10451-text encore-text-marginal encore-internal-color-text-subdued adw-setting-desc" data-encore-id="text">${s.description}</span>
                    </div>
                    <div class="hgljrmQksnQei4xj adw-setting-control">
            `;

            if (s.type === 'switch') {
                innerHtml += `
                    <label class="_nD_jYvjV80Rf8sX" style="cursor: pointer;">
                        <input id="adw-setting-${s.id}" class="vTxmx3oTF8tWUPD7" type="checkbox" ${currentVal ? 'checked' : ''}>
                        <span class="hzLQN8eYDPYyn1km"><span class="t3q6uAPe7y0rAqRK"></span></span>
                    </label>
                `;
            } else if (s.type === 'select') {
                innerHtml += `
                    <span>
                        <select class="lu9EejNhmuMFF3oS adw-select" id="adw-setting-${s.id}">
                            ${s.options.map(opt => `<option value="${opt.value}" ${currentVal === opt.value ? 'selected' : ''}>${opt.label}</option>`).join('')}
                        </select>
                    </span>
                `;
            }

            innerHtml += `
                    </div>
                </div>
            `;
        }

        section.innerHTML = innerHtml;

        // Bind events
        for (const s of SETTINGS_DEFINITIONS) {
            const el = section.querySelector(`#adw-setting-${s.id}`);
            if (!el) continue;
            if (s.type === 'switch') {
                el.addEventListener('change', (e) => {
                    const checked = e.target.checked;
                    saveConfig({ [s.id]: checked });
                    if (typeof s.onChange === 'function') {
                        s.onChange(checked);
                    }
                });
            } else if (s.type === 'select') {
                el.addEventListener('change', (e) => {
                    const val = e.target.value;
                    saveConfig({ [s.id]: val });
                    if (typeof s.onChange === 'function') {
                        s.onChange(val);
                    }
                });
            }
        }

        // Integrate with settings search filter
        const searchInput = page.querySelector('input[placeholder*="Search"], input[type="text"]');
        if (searchInput) {
            const rows = section.querySelectorAll('.adw-setting-row');
            const filterSettings = () => {
                const q = (searchInput.value || '').trim().toLowerCase();
                if (!q) {
                    section.style.display = '';
                    rows.forEach(r => r.style.display = '');
                    return;
                }
                let visibleCount = 0;
                rows.forEach(r => {
                    const text = (r.innerText || '').toLowerCase();
                    if (text.includes(q) || 'spotify adwaita'.includes(q)) {
                        r.style.display = '';
                        visibleCount++;
                    } else {
                        r.style.display = 'none';
                    }
                });
                section.style.display = visibleCount > 0 ? '' : 'none';
            };
            searchInput.addEventListener('input', filterSettings);
        }

        // Insert section right after "Startup and window behaviour" section or at bottom
        const allSections = Array.from(page.children);
        const startupSec = allSections.find(c => c.innerText && c.innerText.includes('Startup and window behaviour'));
        if (startupSec && startupSec.nextSibling) {
            page.insertBefore(section, startupSec.nextSibling);
        } else {
            page.appendChild(section);
        }
    }

    function init() {
        syncConfigFromDisk();
        setupWindowControls();
        updateHeaderOffsets();
        syncDraggableRegions();
        checkAndInjectSettings();
        applyStartupPreferences();

        let animFrameId = null;
        function scheduleUpdate() {
            if (animFrameId) return;
            animFrameId = requestAnimationFrame(() => {
                animFrameId = null;
                updateHeaderOffsets();
                syncDraggableRegions();
                checkAndInjectSettings();
            });
        }

        // Listen for window resize
        window.addEventListener('resize', scheduleUpdate);

        // Targeted MutationObserver:
        // Monitors header, window controls, settings page, and library container
        const observer = new MutationObserver((mutations) => {
            let relevant = false;
            for (let i = 0; i < mutations.length; i++) {
                const t = mutations[i].target;
                if (!t || !t.closest) continue;
                if (t.closest('#global-nav-bar, [data-testid="global-nav-bar"], header, .Root__top-bar, .Root__globalNav, #adw-window-controls, #adw-window-controls-left, [data-testid="settings-page"], nav, [aria-label="Your Library"], [data-testid="your-library-x"]')) {
                    relevant = true;
                    break;
                }
            }
            if (relevant) {
                scheduleUpdate();
            }
        });

        observer.observe(document.body, { childList: true, subtree: true });

        // Route change / SPA navigation events
        window.addEventListener('popstate', () => {
            scheduleUpdate();
            setTimeout(checkAndInjectSettings, 100);
        });
        window.addEventListener('hashchange', () => {
            scheduleUpdate();
            setTimeout(checkAndInjectSettings, 100);
        });

        // Double-click header bar to toggle maximize
        document.addEventListener('dblclick', (e) => {
            if (e.clientY <= 64) {
                if (e.target.closest('button, input, a, select, textarea, [role="button"], [role="link"], .adw-window-btn')) {
                    return;
                }
                fetch('http://127.0.0.1:45454/toggle_maximize', { mode: 'no-cors' }).catch(() => {});
            }
        });

        scanAndDownscaleDom();

        // Periodic fallback safety & image downscale check
        setInterval(() => {
            scheduleUpdate();
            scanAndDownscaleDom();
            checkAndInjectSettings();
        }, 2000);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();

