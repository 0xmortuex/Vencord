/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { OptionType } from "@utils/types";

// Persisted defaults for every export dialog. Before this, every option was
// transient modal state: someone who always exports JSON with all messages
// re-picked both on every single export.
export const settings = definePluginSettings({
    defaultFormat: {
        type: OptionType.SELECT,
        description: "Default export format",
        options: [
            { label: "HTML", value: "html", default: true },
            { label: "JSON", value: "json" },
        ],
    },
    defaultMessageLimit: {
        type: OptionType.NUMBER,
        description: "Default messages per channel (0 = all messages)",
        default: 1000,
    },
    includeImages: {
        type: OptionType.BOOLEAN,
        description: "Include images/attachments by default",
        default: true,
    },
    includeEmbeds: {
        type: OptionType.BOOLEAN,
        description: "Include embeds by default",
        default: true,
    },
    includeReactions: {
        type: OptionType.BOOLEAN,
        description: "Include reactions by default",
        default: true,
    },
    includePins: {
        type: OptionType.BOOLEAN,
        description: "Include pinned-message markers by default",
        default: true,
    },
    combineServerFiles: {
        type: OptionType.BOOLEAN,
        description: "Server export: combine all channels into one file by default",
        default: false,
    },
    bulkFileMode: {
        type: OptionType.SELECT,
        description: "Bulk export: default file layout",
        options: [
            { label: "One file per server", value: "server", default: true },
            { label: "One file for everything", value: "all" },
            { label: "A file per channel", value: "channel" },
        ],
    },
    filenameTemplate: {
        type: OptionType.STRING,
        description: "Filename template. Tokens: {server} {channel} {date} {time}. Extension is added automatically.",
        default: "{server}-{channel}-{date}",
    },
});

export type ExportFormat = "html" | "json";

/** Message limit from settings: 0 (or invalid) means "all". */
export function defaultLimit(): number | null {
    const n = Number(settings.store.defaultMessageLimit);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

/**
 * Build an export filename (without extension) from the user's template.
 * Unknown/empty tokens collapse cleanly so "{server}-{channel}-{date}" with no
 * channel becomes "Server-2026-01-01", not "Server--2026-01-01".
 */
export function formatFilename(vars: { server?: string; channel?: string; date?: string; time?: string; }): string {
    const safe = (s: string) => s.replace(/[^a-zA-Z0-9-_]/g, "_");
    const now = new Date();
    const date = vars.date ?? now.toISOString().split("T")[0];
    const time = vars.time ?? now.toTimeString().slice(0, 5).replace(":", "-");
    const template = (settings.store.filenameTemplate || "{server}-{channel}-{date}").trim();
    const out = template
        .replace(/\{server\}/g, vars.server ? safe(vars.server) : "")
        .replace(/\{channel\}/g, vars.channel ? safe(vars.channel) : "")
        .replace(/\{date\}/g, date)
        .replace(/\{time\}/g, time)
        .replace(/-{2,}/g, "-")
        .replace(/^-+|-+$/g, "");
    return out || "export";
}
