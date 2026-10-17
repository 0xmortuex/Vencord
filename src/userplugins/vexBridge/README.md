# VexBridge: the Vencord plugin for the Vex browser (T3-005, T3-062)

Built and type-checked against the real Vencord source in this repository (branch `w6-cross-vencord`):
`pnpm exec tsc --noEmit`, `pnpm exec eslint src/userplugins/vexBridge`, `pnpm build` and `pnpm buildWeb` all succeed, and the
plugin is present in `dist/renderer.js`, `dist/vencordDesktopRenderer.js` and the web/extension bundle
(`dist/chromium-unpacked/dist/Vencord.js`). It has NOT been run inside a real Discord yet.

`src/userplugins` is git-ignored upstream; the files here are committed with `git add -f`.

## Job 1: the bridge file (plugin -> Vex)

Writes `vex-bridge.json` (schema `vex-bridge/1`, contract in the Vex repository, `docs/vencord-bridge.md`): your mentions,
replies to your messages (server channels only unless DMs are switched on), and the last messages of the channels you list.
Read-only: it never sends, reacts or edits in Discord and sends nothing over the network.

## Job 2: the Discord status setter (Vex -> plugin), opt-in, off by default

Vex's "Discord status" feature writes `vex-status.json` into the SAME folder (the file format below is the contract; the
plugin never needs the token and Vex never sees it). The plugin polls the file every 15 seconds, only while the setting
"Let Vex set my Discord custom status" is on. With the setting off the file is never read.

```json
{
  "schema": "vex-status/1",
  "seq": 7,
  "issuedAt": 1760000000000,
  "action": "set",
  "text": "Playing Hades",
  "emojiName": "<one unicode emoji>",
  "expiresAt": 1760003600000
}
```

| Field | Rule |
|---|---|
| `schema` | exactly `vex-status/1` |
| `seq` | positive integer, strictly increasing; a command with `seq` not above the last handled one is ignored (also after a restart) |
| `issuedAt` | ms; a command older than 10 minutes is ignored (a leftover file is never replayed) |
| `action` | `"set"` or `"clear"` |
| `text` | set only; trimmed, one line, at most 128 characters |
| `emojiName` | set only, optional; ONE unicode emoji (no `:name:`, no custom emoji). A set needs a text or an emoji |
| `expiresAt` | set only, optional; ms, in the future and at most 7 days ahead; Discord itself clears the status at that time |

Behaviour:

- On `set`: the plugin remembers the status that was there (including "none"), then applies the new one. A second `set`
  while Vex's status is on keeps the ORIGINAL previous status.
- On `clear`, on expiry, when the setting is switched off, or when the plugin stops: the previous status is put back.
  If you changed the status by hand in the meantime, yours wins and nothing is overwritten. A previous status that expired
  meanwhile is not brought back (the status is cleared).
- Errors (bad file, folder permission, Discord API missing) are logged to the console once per distinct message; nothing is
  retried with another mechanism.
- It is applied with Discord's own user-settings action creator (`PreloadedUserSettingsActionCreators.updateAsync("status", ...)`
  setting `customStatus`), the path Discord's own status dialog uses. No token, no REST call.
- Discord's terms: a client mod that changes a status is a gray area; you accept that for your own account. Vex shows this
  note next to its switch.

UNVERIFIED: the exact `updateAsync` call and the `customStatus` proto field names were taken from Vencord's own code and
types and Discord's proto naming, not exercised against a live Discord. If Discord renames them the plugin raises an error
("has no updateAsync; the status was not changed") instead of guessing.

## Install

1. `pnpm install`, then `pnpm build` (Desktop) or `pnpm buildWeb` (the extension used by Vex's Discord panel).
2. Enable the plugin; in its settings list `channelIds`, press "Choose the folder" if you use the web build.
3. Folder:
   - Vencord Desktop: `native.ts` uses `%USERPROFILE%\Documents\VexBridge` (or the `VEX_BRIDGE_DIR` environment variable).
   - Web / Vex's Discord panel: the browser asks for the folder with a click on "Choose the folder", and again after each restart.
4. In Vex pick the same folder (Settings, Community and chat tools, Vencord bridge).

## Files

| File | Purpose |
|---|---|
| `index.tsx` | The plugin: Flux events -> bridge file; status polling and applying; settings |
| `bridgeData.ts` | Pure: builds and serialises the `vex-bridge/1` document within Vex's limits |
| `statusData.ts` | Pure: validates `vex-status/1` commands, snapshot/restore decisions |
| `statusData.test.mjs` | `node --experimental-strip-types src/userplugins/vexBridge/statusData.test.mjs` |
| `native.ts` | Desktop only: atomic write of `vex-bridge.json`; read of `vex-status.json` (plain file, 4 KB max) |
