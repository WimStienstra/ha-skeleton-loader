# ha-skeleton-loader (ha-skeleton-card)

A single Home Assistant Lovelace resource that eliminates layout-shift ("card
pop-in") for slow-rendering custom cards, without editing every card's YAML.
It shows a theme-aware shimmer skeleton reserving the card's last-known height,
then swaps in the real card once its size stabilizes.

No build step - it's plain JavaScript you can read top to bottom.

## Why

Custom cards (charts, tabs, media players, etc.) often render blank or
zero-height on first paint and then "pop" to full size once their JS/data is
ready, causing Cumulative Layout Shift (CLS) and a janky loading experience.
This resource fixes that globally, once, instead of wrapping every card
individually in `type: custom:skeleton-card` YAML.

## How it works

Home Assistant loads Lovelace `type: module` resources via fire-and-forget
dynamic `import()` calls - confirmed by reading
[`load-resources.ts`](https://github.com/home-assistant/frontend/blob/dev/src/panels/lovelace/common/load-resources.ts)
in `home-assistant/frontend`:

```js
resources.forEach((resource) => {
  _loadLovelaceResource(resource, hass); // fired in parallel, not awaited in order
});
```

Cross-resource execution order is **not guaranteed**. So this project does not
try to win a race to run before every other card's script. Instead:

1. It patches `customElements.define` once, as soon as this module executes.
2. For every tag you allow-list (see Configuration below) that gets registered
   **after** that point:
   - The real card class is registered under a shadow tag, `real-<tag>`.
   - A lightweight wrapper element is registered under the original tag name.
     The wrapper immediately shows a shimmer sized from a cached height
     (`localStorage`), mounts the real `real-<tag>` element inside the wrapper's
     shadow DOM (hidden via opacity until its size stabilizes), waits
     for its size to stabilize (`ResizeObserver` + debounce + a max-wait
     safety cap), caches the stable height/`getCardSize()`, then reveals the
     real card.
3. `setConfig`, `hass`, `getCardSize()`, and `getGridOptions()` are forwarded
   to the real card so masonry and sections views behave normally.
4. Home Assistant's own dashboard editor (`hui-card-options` /
   `hui-card-edit-dialog`) is detected and bypassed entirely, so editing,
   the card picker, and card previews are unaffected.

### Known limitation

If a card's own `customElements.define()` call happens to execute **before**
this resource's patch is installed (e.g. a very small/simple card whose
module resolves faster than this file), that card just renders normally with
no skeleton for that page load. This is a graceful degradation, not a
breakage - it can vary between page loads. There is currently no fully
deterministic fix for this, because Lovelace resource load order is not
guaranteed by Home Assistant itself (see above). Listing this resource file
first in your Resources list and keeping it dependency-free/small helps but
does not guarantee it wins every time.

## Install

1. Copy `skeleton-loader.js` into your HA `www/` folder (or install via HACS
   as a custom repository: add this repo URL as an "Integration"/"Lovelace"
   custom repository in HACS, category "Lovelace").
2. In HA: **Settings -> Dashboards -> Resources -> Add Resource**:
   - URL: `/local/skeleton-loader.js` (or the HACS-served path)
   - Resource type: **JavaScript Module**
3. Edit the `CONFIG` block at the top of `skeleton-loader.js` to add the tag
   names of the custom cards you want skeleton-wrapped, e.g.:
   ```js
   allowTags: ["bubble-card", "simple-tabs-card", "apexcharts-card"],
   ```
   The allow-list is empty by default for safety - opt in per card, since
   some cards may make assumptions about their own DOM/shadow structure that
   this wrapper doesn't preserve perfectly.
4. Reload your dashboard (hard refresh) and confirm the wrapped cards show a
   shimmer briefly, then reveal, with no visible layout jump on repeat loads.

> Note: because config is a plain object literal in the file (no separate
> config resource, to avoid the same load-order problem), a HACS update will
> overwrite your `allowTags` customization. Re-apply it after updating, or
> fork the repo.

## Configuration reference

| Key | Default | Meaning |
|---|---|---|
| `allowTags` | `[]` | Custom card tag names to wrap. |
| `defaultMinHeightPx` | `120` | Skeleton height used before any cache exists. |
| `stabilizeDelayMs` | `250` | Quiet period (ms) required before treating a size as final. |
| `maxWaitMs` | `5000` | Hard cap - reveal even if still resizing. |
| `cacheVersion` | `1` | Bump to invalidate all cached heights. |
| `shimmer.baseColor` / `highlightColor` / `speedMs` / `borderRadius` | theme-aware defaults | Shimmer appearance. |

## License

MIT - see `LICENSE`.

## Status / verification

Built and unit-checked (Node syntax + mock-DOM execution) in this repo. **Not
yet verified against a live Home Assistant instance** - there was no running
HA instance available in the environment this was built in. Before relying on
it, please: enable it on a test dashboard, add 2-3 real card tags to
`allowTags`, confirm shimmer -> reveal works with no console errors, confirm
the dashboard editor still works for those cards, and re-run Lighthouse to
confirm CLS improves. Please file issues with your findings.
