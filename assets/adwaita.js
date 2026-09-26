/**
 * Spotify Adwaita - Debloat, Telemetry Blocker & Seamless Top-Right Window Controls
 */

(function () {
    'use strict';

    console.log('[spotify-adwaita] Initializing Libadwaita enhancements...');

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
        '/beacon/'
    ];

    function shouldBlock(url) {
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
    // 2. Power & CPU Throttling for Hidden/Minimized Window
    // -------------------------------------------------------------
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            document.body.classList.add('spotify-adw-hidden');
        } else {
            document.body.classList.remove('spotify-adw-hidden');
        }
    });

    // -------------------------------------------------------------
    // 3. Shift Profile Avatar Container to prevent overlap
    // -------------------------------------------------------------
    function updateProfileOffset() {
        const buttons = document.querySelectorAll('button:not(.adw-window-btn)');
        let rightmost = null;
        let maxX = 0;

        for (const btn of buttons) {
            const rect = btn.getBoundingClientRect();
            // Check buttons in the top header region (top <= 64px)
            if (rect.top >= 0 && rect.top <= 64 && rect.right > maxX && rect.width > 0) {
                maxX = rect.right;
                rightmost = btn;
            }
        }

        if (rightmost && maxX > window.innerWidth - 60) {
            const container = rightmost.parentElement;
            if (container && container.style.paddingRight !== '44px') {
                container.style.paddingRight = '44px';
                container.style.boxSizing = 'border-box';
            }
        }
    }

    // -------------------------------------------------------------
    // 4. Seamless Window Controls Injection
    // -------------------------------------------------------------
    function setupWindowControls() {
        if (document.getElementById('adw-window-controls')) return;

        const layout = window.GNOME_BUTTON_LAYOUT || "appmenu:close";
        const parts = layout.split(':');
        const rightButtons = parts.length > 1 ? parts[1].split(',') : [];

        const container = document.createElement('div');
        container.id = 'adw-window-controls';

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

        for (const b of rightButtons) {
            const clean = b.trim();
            if (['close', 'minimize', 'maximize'].includes(clean)) {
                container.appendChild(createBtn(clean));
            }
        }

        if (container.children.length > 0) {
            document.body.appendChild(container);
            console.log('[spotify-adwaita] Controls injected for layout:', layout);
        }
    }

    // -------------------------------------------------------------
    // 5. Dynamic Draggable Regions (Header drag + Interactive buttons)
    // -------------------------------------------------------------
    let lastRegionsStr = '';

    function syncDraggableRegions() {
        const width = window.innerWidth;
        if (!width || width <= 0) return;

        const regions = [];
        // 1. Full header is draggable by default (top 64px)
        regions.push(`0,0,${width},64,1`);

        // 2. Query all interactive elements in the top 64px to exclude them from dragging
        const elements = document.querySelectorAll(
            'button, input, a, [role="button"], [role="link"], select, textarea, [contenteditable="true"], .adw-window-btn'
        );

        for (const el of elements) {
            const r = el.getBoundingClientRect();
            // Check if element intersects top 64px header area
            if (r.top < 64 && r.bottom > 0 && r.width > 0 && r.height > 0) {
                // Add comfortable padding around interactive elements
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

    function init() {
        setupWindowControls();
        updateProfileOffset();
        syncDraggableRegions();

        // Listen for window resize
        window.addEventListener('resize', syncDraggableRegions);

        // Periodically verify profile offset and interactive buttons
        setInterval(() => {
            updateProfileOffset();
            syncDraggableRegions();
        }, 1000);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
