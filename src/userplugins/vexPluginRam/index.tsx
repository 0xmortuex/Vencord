/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/*
 * VexPluginRam: a small, read-mostly API for the Vex browser's "which plugin costs how much memory" report.
 *
 * It adds ONE page global, `window.VexPluginRam`, with two functions:
 *   list()                      every plugin: name, whether it is on, whether it can be turned off and why not,
 *                               whether turning it off needs a reload, which plugins need it
 *   setEnabled(name, enabled)   saves the on/off choice in Vencord's own settings, exactly what the Plugins page
 *                               saves. It does NOT start or stop anything live: the page is reloaded afterwards, so
 *                               the test sees a page that never had the plugin (patches stay until a reload).
 *
 * Nothing is sent anywhere, no network, no files. It never reads or exposes the token, messages or any plugin's own
 * data. Which plugin owns which part of the bundle is not here: it is the file dist/vencord-plugin-ranges.json that the
 * build writes next to Vencord.js (scripts/build/pluginRanges.mjs).
 */

// This plugin exists to look at every plugin, so it needs the whole registry. @api/PluginManager is the official boundary.
import { isPluginEnabled, pluginRequiresRestart, plugins } from "@api/PluginManager";
import { Settings } from "@api/Settings";
import definePlugin from "@utils/types";

import { buildList, checkToggle, PluginInfo, PluginRamRow } from "./pluginList";

function currentList(): PluginRamRow[] {
    const infos: Record<string, PluginInfo> = {};
    for (const name of Object.keys(plugins)) {
        const p = plugins[name];
        infos[name] = {
            name,
            required: p.required,
            hidden: p.hidden,
            dependencies: p.dependencies,
            requiresRestart: pluginRequiresRestart(p)
        };
    }
    return buildList(infos, isPluginEnabled);
}

const api = {
    version: 1,
    list: currentList,
    setEnabled(name: string, enabled: boolean) {
        const row = checkToggle(currentList(), name, enabled);
        const entry = Settings.plugins[name];
        if (!entry) throw new Error(`${name} has no saved settings yet; open the Plugins page once`);
        entry.enabled = enabled;
        return { name, enabled: !!Settings.plugins[name].enabled, requiresRestart: row.requiresRestart };
    }
};

export default definePlugin({
    name: "VexPluginRam",
    description: "Gives the Vex browser a list of plugins and a safe on/off switch for its per-plugin memory test (no data leaves the page)",
    authors: [{ name: "mortuex", id: 1245799821173067850n }],

    start() {
        (window as any).VexPluginRam = api;
    },

    stop() {
        delete (window as any).VexPluginRam;
    }
});
