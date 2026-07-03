/**
 * ha-skeleton-card / skeleton-loader.js
 *
 * A single Lovelace resource that eliminates layout-shift ("card pop-in") for
 * custom cards on Home Assistant dashboards, without editing every card's YAML.
 *
 * HOW IT WORKS (see README.md "Mechanism" section for the full write-up):
 *   HA loads Lovelace `type: module` resources via Promise.all-style fire-and-forget
 *   dynamic import() calls - execution order across resources is NOT guaranteed.
 *   So instead of racing to run before every other card's module, this file patches
 *   `customElements.define` once, as early as this module executes. For every
 *   allow-listed tag that gets registered AFTER that point, it:
 *     1. Registers the real card class under a shadow tag `real-<tag>`.
 *     2. Registers a lightweight wrapper element under the original tag name that:
 *        - immediately reserves space using a cached height (shimmer skeleton),
 *        - mounts the real `real-<tag>` element in the wrapper (hidden via opacity until its size stabilizes),
 *        - waits for its size to stabilize (ResizeObserver + debounce + max-wait),
 *        - caches the stable size, then reveals the real card.
 *   Cards whose own `define()` call races ahead of this patch simply render normally
 *   (no skeleton) for that page load - this is a graceful degradation, never a break.
 *
 * NO BUILD STEP: edit the CONFIG block below directly, then load this file as a
 * Lovelace resource with `type: module`. See README.md for full install steps.
 */

// ---------------------------------------------------------------------------
// CONFIG - edit these values to taste. (HACS updates will overwrite this file;
// keep a copy of your customized CONFIG block if you rely on auto-updates.)
// ---------------------------------------------------------------------------
const CONFIG = {
  // Custom card tag names to wrap. Empty by default for safety - you opt in
  // per card. Example: ["bubble-card", "simple-tabs-card", "apexcharts-card"]
  allowTags: ["bubble-card", "simple-tabs-card", "apexcharts-card"],

  // Fallback skeleton height (px) used the first time a card/config combo is
  // ever seen (no cached measurement yet).
  defaultMinHeightPx: 120,

  // How long (ms) a card's measured height must stay unchanged before we
  // consider it "stable" and reveal the real card.
  stabilizeDelayMs: 250,

  // Safety cap (ms): reveal the real card even if it never fully stabilizes,
  // so a continuously-animating card doesn't hide behind a skeleton forever.
  maxWaitMs: 5000,

  // Bump this to invalidate all previously cached heights (e.g. after a
  // config schema change that affects card sizing).
  cacheVersion: 1,

  // Shimmer appearance. Colors default to HA theme variables so it adapts to
  // light/dark themes automatically; override with literal colors if desired.
  shimmer: {
    baseColor: "var(--card-background-color, #1c1c1c)",
    highlightColor: "var(--divider-color, rgba(255,255,255,0.12))",
    speedMs: 1500,
    borderRadius: "var(--ha-card-border-radius, 12px)",
  },
};

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------
const VERSION = "0.1.1";
const LOG_PREFIX = "[ha-skeleton-loader]";
const CACHE_PREFIX = `ha-skeleton-loader:v${CONFIG.cacheVersion}:`;

/** Styled console badge, matching the "NAME + version chip" banners other HA cards print. */
function printBadge(label, value, color) {
  console.info(
    `%c ${label} %c ${value} %c`,
    `background:${color};color:#fff;font-weight:700;border-radius:3px 0 0 3px;padding:2px 6px;`,
    `background:#2b2b2b;color:#fff;border-radius:0 3px 3px 0;padding:2px 6px;`,
    `background:transparent;`
  );
}

/** Stable JSON.stringify (sorted keys) so cache keys don't depend on key order. */
function stableStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

/** Small non-cryptographic hash (djb2) - good enough for cache-key purposes. */
function hashString(str) {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 33) ^ str.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
}

function cacheKeyFor(tag, config) {
  return `${CACHE_PREFIX}${tag}:${hashString(stableStringify(config || {}))}`;
}

function readCache(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch (_err) {
    return null;
  }
}

function writeCache(key, data) {
  try {
    localStorage.setItem(key, JSON.stringify(data));
  } catch (_err) {
    // localStorage full/unavailable - degrade silently, skeleton just falls
    // back to defaultMinHeightPx next time.
  }
}

let shimmerStyleInjected = false;
function ensureShimmerStyle(shadowRoot) {
  const style = document.createElement("style");
  style.textContent = `
    :host {
      display: block;
      position: relative;
      overflow: hidden;
    }
    .ha-skeleton {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      min-height: inherit;
      border-radius: ${CONFIG.shimmer.borderRadius};
      background: linear-gradient(
        100deg,
        ${CONFIG.shimmer.baseColor} 40%,
        ${CONFIG.shimmer.highlightColor} 50%,
        ${CONFIG.shimmer.baseColor} 60%
      );
      background-size: 200% 100%;
      animation: ha-skeleton-sweep ${CONFIG.shimmer.speedMs}ms ease-in-out infinite;
    }
    @media (prefers-reduced-motion: reduce) {
      .ha-skeleton {
        animation: none;
      }
    }
    @keyframes ha-skeleton-sweep {
      0% { background-position: 200% 0; }
      100% { background-position: -200% 0; }
    }
    .ha-skeleton-real-wrap {
      opacity: 0;
      transition: opacity 180ms ease-in;
    }
    .ha-skeleton-real-wrap.ha-skeleton-revealed {
      opacity: 1;
    }
  `;
  shadowRoot.appendChild(style);
  shimmerStyleInjected = true;
}

/** Detect Lovelace's card-editing UI so we never interfere with the dashboard editor. */
function isInEditMode(el) {
  return !!el.closest?.("hui-card-options, hui-card-edit-dialog, hui-dialog-edit-card");
}

/**
 * Builds the wrapper element class for a given original tag/class pair.
 * One class is created per tag (classes can't be shared across custom element
 * registrations), capturing `tag` and `RealClass` via closure.
 */
function createWrapperClass(tag, RealClass) {
  const realTag = `real-${tag}`;

  return class HaSkeletonWrapper extends HTMLElement {
    constructor() {
      super();
      this._config = null;
      this._hass = null;
      this._realCard = null;
      this._revealed = false;
      this._resizeObserver = null;
      this._stabilizeTimer = null;
      this._maxWaitTimer = null;
      this._cacheKey = null;

      this.attachShadow({ mode: "open" });
    }

    setConfig(config) {
      if (isInEditMode(this)) {
        // In the dashboard editor: skip the skeleton entirely so the card
        // picker / editor preview behaves exactly like the real card.
        this._config = config;
        this._renderBypass();
        return;
      }

      this._config = config;
      this._cacheKey = cacheKeyFor(tag, config);
      this._render();
    }

    set hass(hass) {
      this._hass = hass;
      if (this._realCard) {
        this._realCard.hass = hass;
      }
    }

    get hass() {
      return this._hass;
    }

    getCardSize() {
      const cached = readCache(this._cacheKey || "");
      if (cached && typeof cached.cardSize === "number") {
        return cached.cardSize;
      }
      if (this._realCard && typeof this._realCard.getCardSize === "function") {
        try {
          return this._realCard.getCardSize();
        } catch (_err) {
          /* fall through */
        }
      }
      const heightPx = (cached && cached.heightPx) || CONFIG.defaultMinHeightPx;
      return Math.max(1, Math.round(heightPx / 50));
    }

    getGridOptions() {
      if (this._realCard && typeof this._realCard.getGridOptions === "function") {
        try {
          return this._realCard.getGridOptions();
        } catch (_err) {
          /* fall through */
        }
      }
      const cached = readCache(this._cacheKey || "");
      const heightPx = (cached && cached.heightPx) || CONFIG.defaultMinHeightPx;
      return { rows: Math.max(1, Math.round(heightPx / 56)) };
    }

    connectedCallback() {
      if (this._config && !this._realCard && !this._bypassed) {
        this._render();
      }
    }

    disconnectedCallback() {
      this._cleanupObservers();
    }

    _cleanupObservers() {
      this._resizeObserver?.disconnect();
      this._resizeObserver = null;
      clearTimeout(this._stabilizeTimer);
      this._stabilizeTimer = null;
      clearTimeout(this._maxWaitTimer);
      this._maxWaitTimer = null;
    }

    // Edit-mode / editor preview: render the real card directly, no skeleton.
    _renderBypass() {
      this._cleanupObservers();
      this._bypassed = true;
      this.shadowRoot.innerHTML = "";
      this._realCard = document.createElement(realTag);
      this._realCard.setConfig(this._config);
      // Insert into the DOM before assigning `hass` - some cards subscribe to
      // websocket events (history, logbook, etc.) as soon as `hass` is set,
      // and doing that while still detached can lead to duplicate/orphaned
      // subscriptions (observed as "Subscription not found" errors). Setting
      // hass after connection mirrors how Lovelace itself sequences this.
      this.shadowRoot.appendChild(this._realCard);
      if (this._hass) this._realCard.hass = this._hass;
    }

    _render() {
      this._cleanupObservers();
      this._bypassed = false;
      this.shadowRoot.innerHTML = "";
      if (!shimmerStyleInjected) {
        // Style is injected per-instance (shadow roots don't share styles),
        // flag only silences a would-be duplicate top-level <style> log.
      }
      ensureShimmerStyle(this.shadowRoot);

      const cached = readCache(this._cacheKey);
      const heightPx = (cached && cached.heightPx) || CONFIG.defaultMinHeightPx;

      this.style.display = "block";
      this.style.minHeight = `${heightPx}px`;

      this._skeletonEl = document.createElement("div");
      this._skeletonEl.className = "ha-skeleton";
      this._skeletonEl.style.minHeight = `${heightPx}px`;
      this.shadowRoot.appendChild(this._skeletonEl);

      this._realWrap = document.createElement("div");
      this._realWrap.className = "ha-skeleton-real-wrap";

      this._realCard = document.createElement(realTag);
      try {
        this._realCard.setConfig(this._config);
      } catch (err) {
        console.error(`${LOG_PREFIX} setConfig failed for <${tag}>`, err);
      }
      this._realWrap.appendChild(this._realCard);
      this.shadowRoot.appendChild(this._realWrap);
      // Assign hass only after the real card is connected to the DOM (see
      // note in _renderBypass for why ordering matters here).
      if (this._hass) this._realCard.hass = this._hass;

      this._observeStabilization(heightPx);
    }

    _observeStabilization(initialHeightPx) {
      let lastHeight = -1;
      let settled = false;

      const commit = () => {
        if (settled) return;
        settled = true;
        this._resizeObserver?.disconnect();
        clearTimeout(this._stabilizeTimer);
        clearTimeout(this._maxWaitTimer);

        const finalHeight = this._realCard.getBoundingClientRect().height || initialHeightPx;
        let cardSize;
        try {
          cardSize =
            typeof this._realCard.getCardSize === "function"
              ? this._realCard.getCardSize()
              : undefined;
        } catch (_err) {
          cardSize = undefined;
        }
        writeCache(this._cacheKey, { heightPx: finalHeight, cardSize });

        this.style.minHeight = "";
        this._skeletonEl.remove();
        this._realWrap.classList.add("ha-skeleton-revealed");
        this._revealed = true;
      };

      this._resizeObserver = new ResizeObserver((entries) => {
        const h = entries[0]?.contentRect?.height;
        if (h === undefined) return;
        if (Math.abs(h - lastHeight) > 0.5) {
          lastHeight = h;
          clearTimeout(this._stabilizeTimer);
          this._stabilizeTimer = setTimeout(commit, CONFIG.stabilizeDelayMs);
        }
      });
      this._resizeObserver.observe(this._realCard);

      // Kick an initial check in case the card renders instantly and never
      // fires a resize (e.g. fixed-height cards).
      this._stabilizeTimer = setTimeout(commit, CONFIG.stabilizeDelayMs);
      this._maxWaitTimer = setTimeout(commit, CONFIG.maxWaitMs);
    }
  };
}

// ---------------------------------------------------------------------------
// Patch customElements.define
// ---------------------------------------------------------------------------
(function installPatch() {
  if (window.__haSkeletonLoaderInstalled) {
    return; // avoid double-patching if the resource is somehow loaded twice
  }
  window.__haSkeletonLoaderInstalled = true;

  const originalDefine = customElements.define.bind(customElements);

  customElements.define = function patchedDefine(tag, ctor, options) {
    if (!CONFIG.allowTags.includes(tag) || customElements.get(tag) || options?.extends) {
      return originalDefine(tag, ctor, options);
    }

    try {
      // Register the real implementation under a shadow name...
      originalDefine(`real-${tag}`, ctor, options);
      // ...and a lightweight wrapper under the original name.
      const WrapperClass = createWrapperClass(tag, ctor);
      originalDefine(tag, WrapperClass);
      printBadge("SKELETON-LOADER", `wrapping <${tag}>`, "#7b5cf0");
    } catch (err) {
      console.error(`${LOG_PREFIX} failed to wrap <${tag}>, falling back to normal registration`, err);
      // Best-effort fallback: register the card normally so it still works.
      if (!customElements.get(tag)) {
        originalDefine(tag, ctor, options);
      }
    }
  };

  printBadge("SKELETON-LOADER", `v${VERSION}`, "#03a9f4");
  if (CONFIG.allowTags.length === 0) {
    console.warn(
      `${LOG_PREFIX} loaded, but allowTags is empty - no cards will be wrapped. ` +
        `Edit the CONFIG.allowTags array in skeleton-loader.js to opt in card tags.`
    );
  } else {
    console.info(`${LOG_PREFIX} watching for: ${CONFIG.allowTags.join(", ")}`);
  }
})();
