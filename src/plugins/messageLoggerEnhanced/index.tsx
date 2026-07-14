/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./style.css";

import { ChatBarButton } from "@api/ChatButtons";
import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import { showNotification } from "@api/Notifications";
import { isPluginEnabled } from "@api/PluginManager";
import { definePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import { openModal } from "@utils/modal";
import definePlugin, { OptionType } from "@utils/types";
import { ChannelStore, FluxDispatcher, GuildStore, Menu, MessageStore, showToast, Toasts, UserStore } from "@webpack/common";

import { GhostMessagesModal } from "./components/GhostMessagesModal";
import { ManageServersButton } from "./components/ServerFilterModal";
import {
    addDeletedMessage,
    CachedMessage,
    cacheMessage,
    cleanOldEntries,
    clearMemoryCache,
    getCachedMessage,
    getCacheStats,
    loadCacheFromDisk,
    persistCacheToDisk,
    removeCachedMessage,
} from "./store";

const logger = new Logger("MessageLoggerEnhanced");

// definePluginSettings (not a raw options object) is what gives us the live
// settings.store proxy - reading option values any other way returns the
// schema defaults instead of what the user configured.
export const settings = definePluginSettings({
    showNotification: {
        type: OptionType.BOOLEAN,
        description: "Show notification on ghost delete",
        default: true,
    },
    logSeenMessages: {
        type: OptionType.BOOLEAN,
        description: "Also log deletes of messages you saw (the ones the built-in MessageLogger shows in red) - turn off to only log deletes from unopened channels",
        default: true,
    },
    cacheDMs: {
        type: OptionType.BOOLEAN,
        description: "Log ghost deletes in DMs and group DMs",
        default: true,
    },
    maxCachedPerGuild: {
        type: OptionType.NUMBER,
        description: "Max cached messages per guild",
        default: 10000,
    },
    daysToKeep: {
        type: OptionType.NUMBER,
        description: "Days to keep deleted messages",
        default: 7,
    },
    ignoreGuildIds: {
        type: OptionType.STRING,
        description: "Ignore guild IDs (comma-separated)",
        default: "",
    },
    ignoreChannelIds: {
        type: OptionType.STRING,
        description: "Ignore channel IDs (comma-separated)",
        default: "",
    },
    ignoreBots: {
        type: OptionType.BOOLEAN,
        description: "Ignore bot and webhook messages (their deletions won't be logged)",
        default: true,
    },
    ignoreSystemMessages: {
        type: OptionType.BOOLEAN,
        description: "Ignore system messages (welcomes, boosts, pins, etc.)",
        default: true,
    },
    ignoreCommands: {
        type: OptionType.BOOLEAN,
        description: "Ignore command messages (messages starting with a command prefix)",
        default: true,
    },
    commandPrefixes: {
        type: OptionType.STRING,
        description: "Command prefixes to ignore (space-separated)",
        default: "! ? . / $ ; - ~",
    },
    ignoreSpam: {
        type: OptionType.BOOLEAN,
        description: "Ignore spam (repeated content from the same author, or the same copypasta from multiple authors, within 60s)",
        default: true,
    },
    manageServers: {
        type: OptionType.COMPONENT,
        description: "Pick which servers ghost logging applies to",
        component: ManageServersButton,
    },
    debugMode: {
        type: OptionType.BOOLEAN,
        description: "Debug mode: show a toast for every step of the DM logging pipeline (for troubleshooting)",
        default: false,
    },
});

// Troubleshooting aid: surfaces each pipeline step as a toast so problems can
// be diagnosed without opening DevTools. DM-scoped to avoid server spam.
function debugToast(text: string) {
    if (settings.store.debugMode) showToast(`[MLE] ${text}`, Toasts.Type.MESSAGE);
}

let persistInterval: ReturnType<typeof setInterval> | null = null;
let cleanupInterval: ReturnType<typeof setInterval> | null = null;

export function parseIgnoreList(str: string): Set<string> {
    return new Set(
        str.split(",")
            .map(s => s.trim())
            .filter(Boolean)
    );
}

// Returns WHY a channel is ignored (or null if it isn't) so debug mode can say
// which rule fired instead of a bare yes/no.
function getChannelIgnoreReason(guildId: string, channelId: string): string | null {
    if (!settings.store.cacheDMs && !guildId) return "DM logging is turned off";

    const ignoreGuilds = parseIgnoreList(settings.store.ignoreGuildIds);
    if (guildId && ignoreGuilds.has(guildId)) return "server is excluded";

    const ignoreChannels = parseIgnoreList(settings.store.ignoreChannelIds);
    if (ignoreChannels.has(channelId)) return "channel is excluded";

    return null;
}

// Discord message types: 0 = DEFAULT, 19 = REPLY. Everything else (7 = user
// join/welcome, 8-11 = boosts, 6 = pin notice, slash-command responses, ...)
// is a system or app message with no ghost-logging value.
const USER_MESSAGE_TYPES = new Set([0, 19]);

// Spam detection: per author, the last few normalized messages (spammers often
// alternate 2-3 lines to defeat a naive last-message check); globally, the same
// copypasta posted by DIFFERENT authors (raid/wave spam). Maps are pruned when
// they grow so a long session doesn't accumulate entries forever.
const SPAM_WINDOW_MS = 60_000;
const SPAM_MAP_LIMIT = 5000;
const RECENT_PER_AUTHOR = 3;
const CROSS_AUTHOR_MIN_LENGTH = 12; // don't treat "lol" / "gm" echoes as a spam wave

const recentByAuthor = new Map<string, { at: number; contents: string[]; }>();
const recentGlobal = new Map<string, { at: number; authorId: string; }>();

function normalizeContent(content: string): string {
    return content.toLowerCase().replace(/\s+/g, " ").trim();
}

function pruneSpamMaps(now: number) {
    if (recentByAuthor.size > SPAM_MAP_LIMIT) {
        for (const [id, entry] of recentByAuthor) {
            if (now - entry.at > SPAM_WINDOW_MS) recentByAuthor.delete(id);
        }
    }
    if (recentGlobal.size > SPAM_MAP_LIMIT) {
        for (const [content, entry] of recentGlobal) {
            if (now - entry.at > SPAM_WINDOW_MS) recentGlobal.delete(content);
        }
    }
}

function isSpam(authorId: string, content: string): boolean {
    const norm = normalizeContent(content);
    if (!norm) return false;

    const now = Date.now();
    pruneSpamMaps(now);

    let spam = false;

    const prev = recentByAuthor.get(authorId);
    const entry = prev && now - prev.at < SPAM_WINDOW_MS ? prev : { at: now, contents: [] };
    if (entry.contents.includes(norm)) spam = true;
    entry.at = now;
    entry.contents.push(norm);
    if (entry.contents.length > RECENT_PER_AUTHOR) entry.contents.shift();
    recentByAuthor.set(authorId, entry);

    if (norm.length >= CROSS_AUTHOR_MIN_LENGTH) {
        const g = recentGlobal.get(norm);
        if (g && g.authorId !== authorId && now - g.at < SPAM_WINDOW_MS) spam = true;
        recentGlobal.set(norm, { at: now, authorId });
    }

    return spam;
}

// Content-based filters: bots/webhooks, system messages (welcomes etc.),
// prefix commands, and repeat spam. Filtering happens at cache time, so a
// filtered message can never show up as a ghost delete either. Returns the
// reason (or null) so debug mode can say which filter fired.
function getContentIgnoreReason(msg: any): string | null {
    const s = settings.store;

    if (s.ignoreBots && (msg.author?.bot || msg.webhook_id)) return "bot/webhook message";
    if (s.ignoreSystemMessages && !USER_MESSAGE_TYPES.has(msg.type ?? 0)) return "system message";

    const content: string = msg.content ?? "";

    if (s.ignoreCommands && content) {
        const prefixes = s.commandPrefixes.split(/\s+/).filter(Boolean);
        const hit = prefixes.find(p => content.startsWith(p));
        if (hit) return `command prefix "${hit}"`;
    }

    if (s.ignoreSpam && content.trim() && isSpam(msg.author?.id ?? "", content)) return "spam (repeated content)";

    return null;
}

function extractCachedMessage(msg: any, channel: any): CachedMessage {
    const author = msg.author ?? {};
    const avatarUrl = author.avatar
        ? `https://cdn.discordapp.com/avatars/${author.id}/${author.avatar}.webp?size=64`
        : `https://cdn.discordapp.com/embed/avatars/${(BigInt(author.id ?? "0") >> 22n) % 6n}.png`;

    return {
        id: msg.id,
        content: msg.content ?? "",
        authorId: author.id ?? "",
        authorUsername: author.global_name ?? author.username ?? "Unknown",
        authorAvatar: avatarUrl,
        channelId: msg.channel_id,
        guildId: channel?.guild_id ?? "",
        timestamp: msg.timestamp ?? new Date().toISOString(),
        attachments: (msg.attachments ?? []).map((a: any) => ({
            url: a.url ?? a.proxy_url ?? "",
            filename: a.filename ?? "unknown",
        })),
        embeds: msg.embeds ?? [],
    };
}

// Human-readable channel label. DM channels have no `name`, so derive one from
// the recipients instead of rendering a blank "#".
export function getChannelLabel(channelId: string): string {
    const channel = ChannelStore.getChannel(channelId);
    if (!channel) return channelId;
    if (channel.name) return `#${channel.name}`;

    const recipients = (channel.recipients ?? [])
        .map((id: string) => UserStore.getUser(id))
        .filter(Boolean)
        .map(u => u!.globalName || u!.username);
    return recipients.length ? `@${recipients.join(", ")}` : channelId;
}

function openGhostModal(channelId?: string) {
    openModal(modalProps => (
        <GhostMessagesModal modalProps={modalProps} initialChannelId={channelId} />
    ));
}

function onMessageCreate(event: any) {
    try {
        const msg = event.message;
        if (!msg?.id || !msg.channel_id) return;

        const channel = ChannelStore.getChannel(msg.channel_id);
        const guildId = channel?.guild_id ?? "";
        const isDm = !guildId;

        const channelReason = getChannelIgnoreReason(guildId, msg.channel_id);
        if (channelReason) {
            if (isDm) debugToast(`DM message NOT cached: ${channelReason}`);
            return;
        }
        const contentReason = getContentIgnoreReason(msg);
        if (contentReason) {
            if (isDm) debugToast(`DM message NOT cached: ${contentReason}`);
            return;
        }

        const cached = extractCachedMessage(msg, channel);
        const maxPerGuild = settings.store.maxCachedPerGuild;
        cacheMessage(cached, maxPerGuild);
        if (isDm) debugToast(`cached DM message from ${cached.authorUsername}`);
    } catch (e) {
        logger.error("Error caching message", e);
        debugToast(`ERROR caching message: ${(e as any)?.message}`);
    }
}

function handleDelete(messageId: string, eventChannelId?: string) {
    try {
        const eventChannel = eventChannelId ? ChannelStore.getChannel(eventChannelId) : null;
        const eventIsDm = !!eventChannel && !eventChannel.guild_id;

        const cached = getCachedMessage(messageId);
        if (!cached) {
            if (eventIsDm) debugToast("DM delete received but the message was never cached");
            return;
        }
        if (eventIsDm) debugToast("DM delete received for a cached message");

        // Re-check the ignore lists at delete time too: a server excluded
        // AFTER some of its messages were cached must not produce ghost
        // entries or notifications from that leftover cache.
        if (getChannelIgnoreReason(cached.guildId, cached.channelId)) {
            removeCachedMessage(messageId);
            return;
        }

        // A message in the local MessageStore (channel loaded/open) is shown in
        // red by the built-in MessageLogger. By default we STILL notify and add
        // it to the ghost log (users want one place with every delete); the
        // logSeenMessages toggle restores pure defer-to-MessageLogger behavior,
        // but only when that plugin is actually enabled - otherwise a DM you
        // glanced at would be logged by neither plugin.
        const existing = MessageStore.getMessage(cached.channelId, messageId);
        if (existing && !settings.store.logSeenMessages && isPluginEnabled("MessageLogger")) {
            if (eventIsDm) debugToast("DM delete deferred to built-in MessageLogger (logSeenMessages is off)");
            return;
        }
        if (eventIsDm) debugToast("logging DM ghost delete now");

        const deleted = { ...cached, deletedAt: Date.now() };
        addDeletedMessage(deleted);
        removeCachedMessage(messageId);

        if (settings.store.showNotification) {
            const guild = cached.guildId ? GuildStore.getGuild(cached.guildId) : null;
            const channelLabel = getChannelLabel(cached.channelId);
            const preview = cached.content.length > 100
                ? cached.content.slice(0, 100) + "..."
                : cached.content || "(no text)";

            showNotification({
                title: `Ghost Delete in ${guild ? `${guild.name} ${channelLabel}` : channelLabel}`,
                body: `${cached.authorUsername}: ${preview}`,
                icon: cached.authorAvatar,
                onClick: () => openGhostModal(cached.channelId),
            });
        }
    } catch (e) {
        logger.error("Error handling delete", e);
    }
}

function onMessageDelete(event: any) {
    if (!event.id) return;
    handleDelete(event.id, event.channelId ?? event.channel_id);
}

function onMessageDeleteBulk(event: any) {
    if (!event.ids?.length) return;
    for (const id of event.ids) {
        handleDelete(id, event.channelId ?? event.channel_id);
    }
}

function TrashIcon() {
    return (
        <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor">
            <path d="M15 3.999V2H9V3.999H3V5.999H21V3.999H15Z" />
            <path d="M5 6.99902V18.999C5 20.101 5.897 20.999 7 20.999H17C18.103 20.999 19 20.101 19 18.999V6.99902H5ZM11 17H9V11H11V17ZM15 17H13V11H15V17Z" />
        </svg>
    );
}

const GhostMessagesButton = ({ isMainChat }: { isMainChat: boolean; }) => {
    if (!isMainChat) return null;

    return (
        <ChatBarButton
            tooltip="Ghost Messages"
            onClick={() => openGhostModal()}
        >
            <TrashIcon />
        </ChatBarButton>
    );
};

const channelContextMenuPatch: NavContextMenuPatchCallback = (children, { channel }) => {
    if (!channel) return;

    const group = findGroupChildrenByChildId("mark-channel-read", children) ?? children;
    group.push(
        <Menu.MenuItem
            id="vc-mle-view-ghost"
            label="View Ghost Messages"
            action={() => openGhostModal(channel.id)}
        />
    );
};

export function toggleGuildIgnore(guildId: string) {
    const ignored = parseIgnoreList(settings.store.ignoreGuildIds);
    if (ignored.has(guildId)) ignored.delete(guildId);
    else ignored.add(guildId);
    settings.store.ignoreGuildIds = [...ignored].join(",");
}

// Right-click a server to toggle ghost logging for it, instead of hand-editing
// the comma-separated ID list in settings.
const guildContextMenuPatch: NavContextMenuPatchCallback = (children, { guild }: { guild: { id: string; } | undefined; }) => {
    if (!guild?.id) return;

    children.push(
        <Menu.MenuGroup>
            <Menu.MenuCheckboxItem
                id="vc-mle-log-guild"
                label="Log Ghost Messages"
                checked={!parseIgnoreList(settings.store.ignoreGuildIds).has(guild.id)}
                action={() => toggleGuildIgnore(guild.id)}
            />
        </Menu.MenuGroup>
    );
};

export default definePlugin({
    name: "MessageLoggerEnhanced",
    description: "Catches deleted messages even in channels you haven't opened by caching all gateway messages in the background.",
    authors: [Devs.UnknownHacker9991],
    dependencies: ["ChatInputButtonAPI"],
    settings,

    contextMenus: {
        "channel-context": channelContextMenuPatch,
        "thread-context": channelContextMenuPatch,
        "gdm-context": channelContextMenuPatch,
        "guild-context": guildContextMenuPatch,
    },

    chatBarButton: {
        icon: TrashIcon,
        render: GhostMessagesButton,
    },

    async start() {
        await loadCacheFromDisk();
        await cleanOldEntries(settings.store.daysToKeep);

        FluxDispatcher.subscribe("MESSAGE_CREATE", onMessageCreate);
        FluxDispatcher.subscribe("MESSAGE_DELETE", onMessageDelete);
        FluxDispatcher.subscribe("MESSAGE_DELETE_BULK", onMessageDeleteBulk);

        debugToast(`started - watching messages (${getCacheStats().messages} restored from disk)`);

        // Persist cache to disk every 5 minutes
        persistInterval = setInterval(() => {
            persistCacheToDisk().catch(e => logger.error("Error persisting cache", e));
        }, 5 * 60 * 1000);

        // Clean old entries daily
        cleanupInterval = setInterval(() => {
            cleanOldEntries(settings.store.daysToKeep).catch(e => logger.error("Error cleaning old entries", e));
        }, 24 * 60 * 60 * 1000);
    },

    stop() {
        FluxDispatcher.unsubscribe("MESSAGE_CREATE", onMessageCreate);
        FluxDispatcher.unsubscribe("MESSAGE_DELETE", onMessageDelete);
        FluxDispatcher.unsubscribe("MESSAGE_DELETE_BULK", onMessageDeleteBulk);

        if (persistInterval) {
            clearInterval(persistInterval);
            persistInterval = null;
        }
        if (cleanupInterval) {
            clearInterval(cleanupInterval);
            cleanupInterval = null;
        }

        // Persist before stopping
        persistCacheToDisk().catch(e => logger.error("Error persisting on stop", e));
        clearMemoryCache();
    },
});
