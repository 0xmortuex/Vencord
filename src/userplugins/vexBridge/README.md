# VexBridge: the Vencord plugin for Vex's bridge (T3-005)

Status: **source written, never built or run.** The build and any publishing happen in the owner's own
Vencord checkout (`C:\vencord-dev`, repo `0xmortuex/Vencord`), which is outside this repository. The data shape is
tested here against the real reader (`tests/main/vencordBridgePlugin.test.js`).

## What it does

Writes one file, `vex-bridge.json` (schema `vex-bridge/1`, contract in `docs/vencord-bridge.md`), with:

- mentions of you, replies to your messages (server channels only unless you switch DMs on),
- the last messages of the channels you list (catch-up).

It never sends, reacts or edits in Discord, and sends nothing over the network. Vex reads the file read-only
when you open the bridge screen.

## Install (in your Vencord checkout)

1. Copy the `vexBridge` folder to `<vencord>/src/userplugins/vexBridge`.
2. `pnpm build` for Desktop, or `pnpm buildWeb` for the browser extension used by Vex's Discord panel.
3. Fix anything that drifted (import paths such as `@utils/constants` `Devs`, `@vencord/discord-types`
   `Message`, or the `flux` handler shape): the file was written without compiling it. The author line uses
   `Devs.Ven` as a placeholder; register your own entry first (see the `vencord-plugin-dev` notes).
4. Enable the plugin; set `channelIds` in its settings.
5. Folder:
   - **Vencord Desktop:** `native.ts` writes to `%USERPROFILE%\Documents\VexBridge` (or `VEX_BRIDGE_DIR`).
   - **Web / Vex's Discord panel:** the browser cannot write files by itself. Call the plugin's
     `chooseFolder()` from a button in the plugin settings (a click is required) and pick the folder; the browser
     asks again after each restart. (A settings button is not written yet; it is the first thing to add.)
6. In Vex: Settings, Community and chat tools, Vencord bridge, "Choose the folder" and pick the same folder.

## Files

| File | Purpose |
|---|---|
| `vexBridge/bridgeData.ts` | Pure: builds and serialises the document within Vex's limits (no Vencord imports; tested here). |
| `vexBridge/index.tsx` | The plugin: collects messages from Discord's stores and Flux events, writes through `native.ts` or a folder handle. |
| `vexBridge/native.ts` | Desktop only: atomic write (tmp + rename) of that one file name. |

## Known gaps

- Not compiled; `chooseFolder` has no settings button yet; the web path is unverified against a real Discord page.
- Discord's terms: a client mod is a gray area; the owner accepts that for his own account (see the contract).
