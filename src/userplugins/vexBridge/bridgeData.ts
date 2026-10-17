/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/*
 * VexBridge: the pure part. Turns plain message records into the `vex-bridge/1` document that Vex reads
 * (docs/vencord-bridge.md in the Vex repository). No Vencord or Discord imports here.
 */

export const SCHEMA = "vex-bridge/1";
export const LIMITS = { mentions: 200, replies: 200, channels: 20, perChannel: 100, text: 2000, name: 80 } as const;

export interface BridgeMessage {
    id: string;
    author: string;
    text: string;
    ts: number;
    channelId?: string;
    channelName?: string;
    guildName?: string;
    guildId?: string;
}

export interface BridgeChannelInput {
    channelId: string;
    name: string;
    guildName?: string;
    messages: BridgeMessage[];
}

export interface BridgeInput {
    accountName: string;
    now: number;
    mentions: BridgeMessage[];
    replies: BridgeMessage[];
    channels: BridgeChannelInput[];
}

const oneLine = (s: unknown, max: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, max);

/** Only discord.com/channels links are written; Vex drops any other address, so none is invented. */
export function messageUrl(m: BridgeMessage): string {
    if (!m.channelId || !/^\d+$/.test(m.channelId) || !/^\d+$/.test(m.id)) return "";
    const guild = m.guildId && /^\d+$/.test(m.guildId) ? m.guildId : "@me";
    return `https://discord.com/channels/${guild}/${m.channelId}/${m.id}`;
}

function message(m: BridgeMessage, withContext: boolean) {
    const out: Record<string, unknown> = {
        id: String(m.id),
        author: oneLine(m.author, LIMITS.name),
        text: oneLine(m.text, LIMITS.text),
        ts: m.ts
    };
    if (withContext) {
        out.channelId = m.channelId ? String(m.channelId) : "";
        out.channelName = oneLine(m.channelName, LIMITS.name);
        out.guildName = oneLine(m.guildName, LIMITS.name);
        const url = messageUrl(m);
        if (url) out.url = url;
    }
    return out;
}

const usable = (m: BridgeMessage) => !!m && !!m.id && !!oneLine(m.text, 1) && Number.isFinite(m.ts);

/** The document, newest first, within the limits Vex enforces (so nothing is counted as skipped). */
export function buildBridge(input: BridgeInput) {
    const newest = (list: BridgeMessage[], max: number) =>
        list.filter(usable).sort((a, b) => b.ts - a.ts).slice(0, max);
    return {
        schema: SCHEMA,
        generatedAt: input.now,
        account: { name: oneLine(input.accountName, LIMITS.name) },
        mentions: newest(input.mentions, LIMITS.mentions).map(m => message(m, true)),
        replies: newest(input.replies, LIMITS.replies).map(m => message(m, true)),
        channels: input.channels.slice(0, LIMITS.channels).map(c => ({
            channelId: String(c.channelId),
            name: oneLine(c.name, LIMITS.name),
            guildName: oneLine(c.guildName, LIMITS.name),
            messages: c.messages.filter(usable).sort((a, b) => a.ts - b.ts).slice(-LIMITS.perChannel).map(m => message(m, false))
        }))
    };
}

/** Serialised the way it is written: UTF-8 JSON well under Vex's 1 MB limit, or an error (never a cut file). */
export function serialise(doc: ReturnType<typeof buildBridge>, maxBytes = 1024 * 1024): string {
    let text = JSON.stringify(doc);
    // Too big: halve the channel history, then the lists, rather than write a file Vex refuses.
    let d = doc;
    for (let i = 0; i < 6 && new TextEncoder().encode(text).length > maxBytes; i++) {
        d = {
            ...d,
            mentions: d.mentions.slice(0, Math.ceil(d.mentions.length / 2)),
            replies: d.replies.slice(0, Math.ceil(d.replies.length / 2)),
            channels: d.channels.map(c => ({ ...c, messages: c.messages.slice(-Math.ceil(c.messages.length / 2)) }))
        };
        text = JSON.stringify(d);
    }
    if (new TextEncoder().encode(text).length > maxBytes) throw new Error("VexBridge: the data does not fit in 1 MB");
    return text;
}
