/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/*
 * VexPluginRam: the pure part. Turns the plugin registry into the list Vex's one-plugin-at-a-time memory test works
 * from, and decides which plugins may be switched off. No Vencord or Discord imports here.
 */

/** The few fields of a Vencord plugin this needs. */
export interface PluginInfo {
    name: string;
    required?: boolean;
    hidden?: boolean;
    dependencies?: string[];
    /** Already worked out by Vencord (pluginRequiresRestart): patches stay in Discord until it reloads. */
    requiresRestart: boolean;
}

export interface PluginRamRow {
    name: string;
    enabled: boolean;
    required: boolean;
    hidden: boolean;
    requiresRestart: boolean;
    /** Plugins this one needs. */
    dependsOn: string[];
    /** Enabled plugins that need this one. */
    neededBy: string[];
    /** Whether Vex may switch it off for a test, and if not, why in one plain sentence. */
    canDisable: boolean;
    reason: string;
}

/** Plugins this module's own page must never switch off: the one that answers Vex, and the one that talks to it. */
export const NEVER_DISABLE = ["VexPluginRam", "VexBridge"] as const;

export function buildList(plugins: Record<string, PluginInfo>, isEnabled: (name: string) => boolean): PluginRamRow[] {
    const names = Object.keys(plugins);
    const neededBy = new Map<string, string[]>();
    for (const n of names) {
        if (!isEnabled(n)) continue;
        for (const dep of plugins[n].dependencies ?? []) {
            const list = neededBy.get(dep) ?? [];
            list.push(n);
            neededBy.set(dep, list);
        }
    }
    return names.sort((a, b) => a.localeCompare(b)).map(name => {
        const p = plugins[name];
        const enabled = isEnabled(name);
        const needed = neededBy.get(name) ?? [];
        let reason = "";
        if (p.required) reason = "Vencord needs it and keeps it on";
        else if ((NEVER_DISABLE as readonly string[]).includes(name)) reason = "Vex uses it for this measurement";
        else if (p.hidden) reason = "it is an internal plugin";
        else if (needed.length) reason = "these plugins need it: " + needed.join(", ");
        return {
            name,
            enabled,
            required: !!p.required,
            hidden: !!p.hidden,
            requiresRestart: p.requiresRestart,
            dependsOn: [...(p.dependencies ?? [])],
            neededBy: needed,
            canDisable: reason === "",
            reason
        };
    });
}

/** Throws the reason in plain words when `name` may not be switched; returns the row otherwise. */
export function checkToggle(rows: PluginRamRow[], name: string, enabled: boolean): PluginRamRow {
    const row = rows.find(r => r.name === name);
    if (!row) throw new Error(`There is no Vencord plugin called ${JSON.stringify(name)}`);
    if (typeof enabled !== "boolean") throw new Error("setEnabled needs true or false");
    // Switching a plugin back on is always allowed (Vex puts back what it turned off), even one that cannot be turned off.
    if (!enabled && !row.canDisable) throw new Error(`${name} cannot be turned off: ${row.reason}`);
    return row;
}
