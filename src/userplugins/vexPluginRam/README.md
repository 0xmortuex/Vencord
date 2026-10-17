# VexPluginRam: per-plugin memory support for the Vex browser

Branch `w6-plugin-ram` (from `w6-cross-vencord`). Type-checked against the real Vencord source here: `pnpm exec tsc --noEmit`,
`pnpm exec eslint src/userplugins/vexPluginRam scripts/build`, `pnpm build` and `pnpm buildWeb` succeed, and the plugin is in the
web/extension bundle (`dist/chromium-unpacked/dist/Vencord.js`). It has NOT been run inside a real Discord yet.

`src/userplugins` is git-ignored upstream; these files are committed with `git add -f`.

Vex's Discord panel runs Discord with Vencord as a Chrome extension. All plugins live in ONE renderer, so Chromium reports one
number for them. The Vex report "Why is Discord big?" splits it two ways, and this folder plus one build step give it what it needs.

## 1. The build writes who owns which part of the bundle (`scripts/build/pluginRanges.mjs`)

`pnpm buildWeb` now also writes `dist/vencord-plugin-ranges.json` into the unpacked extension (next to `Vencord.js`, so also
inside `extension-chrome.zip`). It is made from the build's own source map:

```
{ "schema": "vex-plugin-ranges/1", "bundle": "dist/Vencord.js", "bundleBytes": N, "bundleSha256": "...",
  "owners": ["", "MessageLogger", ...],         owner 0 ("") is Vencord core and libraries (not a plugin)
  "runs": [line, col, owner, line, col, owner, ...] }   0-based, sorted; a run lasts until the next one starts
```

Vex's sampling heap profiler says "this much was allocated at line L, column C of Vencord.js"; the bundle is minified, so the lookup
is a binary search over `runs`. Vex checks the size and sha256 before it trusts the file (a manifest from another build is refused).
Watch mode (`pnpm watch`) does not write it (its source maps are inline). Only source paths are read: no source text, no settings,
no token. Test: `node scripts/build/pluginRanges.test.mjs` (decoder, owners, lookups, and the real bundle when `dist/` has one).

## 2. The `VexPluginRam` plugin (`window.VexPluginRam`)

| Call | Does |
|---|---|
| `list()` | every plugin: `name, enabled, required, hidden, requiresRestart, dependsOn, neededBy, canDisable, reason` |
| `setEnabled(name, enabled)` | saves the on/off choice in Vencord's own settings (what the Plugins page saves); starts and stops NOTHING live |

Turning a plugin off is refused (with the reason in plain words) for required plugins, internal (hidden) plugins, plugins other
enabled plugins need, and for VexPluginRam and VexBridge themselves. Turning one back on is always allowed. After `setEnabled` the
page is reloaded by Vex, so the test sees a page that never had the plugin; patches stay in Discord until a reload, which is
why nothing is stopped live. No network, no files, no token, no messages. It uses the registry through `@api/PluginManager`
(the profiler-style whole-registry access that review asks to be commented: the comment is in `index.tsx`).

Test: `node --experimental-strip-types src/userplugins/vexPluginRam/pluginList.test.mjs`.

## What this cannot tell Vex

The line map says which plugin's CODE ran when memory was allocated. Code Vencord patches into Discord's own modules is
evaluated as part of Discord's modules, so memory allocated there counts as Discord's. Native memory (images, emoji, video) is not
JavaScript heap and is not attributed per plugin.
