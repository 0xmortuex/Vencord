/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { DataStore } from "@api/index";
import type { Embed } from "@vencord/discord-types";

export interface CachedMessage {
    id: string;
    content: string;
    authorId: string;
    authorUsername: string;
    authorAvatar: string;
    channelId: string;
    guildId: string;
    timestamp: string;
    attachments: { url: string; filename: string; }[];
    embeds: Embed[];
}

export interface DeletedMessage extends CachedMessage {
    deletedAt: number;
}

const CACHE_PREFIX = "vc-mle-cache-";
const DELETED_KEY = "vc-mle-deleted";
const MAX_DELETED = 5000;

// In-memory cache for fast lookups
const memoryCache = new Map<string, Map<string, CachedMessage>>();

export function getGuildCache(guildId: string): Map<string, CachedMessage> {
    if (!memoryCache.has(guildId)) {
        memoryCache.set(guildId, new Map());
    }
    return memoryCache.get(guildId)!;
}

export function cacheMessage(msg: CachedMessage, maxPerGuild: number) {
    const guildId = msg.guildId || "DM";
    const cache = getGuildCache(guildId);
    cache.set(msg.id, msg);

    // Enforce rolling limit
    if (cache.size > maxPerGuild) {
        const oldest = cache.keys().next().value;
        if (oldest) cache.delete(oldest);
    }
}

export function getCachedMessage(messageId: string): CachedMessage | undefined {
    for (const cache of memoryCache.values()) {
        const msg = cache.get(messageId);
        if (msg) return msg;
    }
    return undefined;
}

export function removeCachedMessage(messageId: string) {
    for (const cache of memoryCache.values()) {
        if (cache.delete(messageId)) return;
    }
}

export async function persistCacheToDisk() {
    for (const [guildId, cache] of memoryCache.entries()) {
        const obj: Record<string, CachedMessage> = {};
        for (const [id, msg] of cache.entries()) {
            obj[id] = msg;
        }
        await DataStore.set(CACHE_PREFIX + guildId, obj);
    }
}

export async function loadCacheFromDisk() {
    const allKeys = await DataStore.entries();
    for (const [key, value] of allKeys) {
        if (typeof key === "string" && key.startsWith(CACHE_PREFIX)) {
            const guildId = key.slice(CACHE_PREFIX.length);
            const cache = getGuildCache(guildId);
            const data = value as Record<string, CachedMessage>;
            for (const [id, msg] of Object.entries(data)) {
                cache.set(id, msg);
            }
        }
    }
}

export async function getDeletedMessages(): Promise<DeletedMessage[]> {
    return (await DataStore.get(DELETED_KEY)) ?? [];
}

// All mutations go through DataStore.update, which runs get+set inside a single
// IndexedDB transaction. A MESSAGE_DELETE_BULK burst fires these concurrently;
// separate get/set calls would each read the same pre-bulk list and the last
// write would silently drop every other entry.
export async function addDeletedMessage(msg: DeletedMessage) {
    await DataStore.update<DeletedMessage[]>(DELETED_KEY, deleted => {
        const list = deleted ?? [];
        list.push(msg);
        if (list.length > MAX_DELETED) list.splice(0, list.length - MAX_DELETED);
        return list;
    });
}

export async function removeDeletedMessage(messageId: string) {
    await DataStore.update<DeletedMessage[]>(DELETED_KEY, deleted =>
        (deleted ?? []).filter(m => m.id !== messageId));
}

export async function cleanOldEntries(maxDays: number) {
    const cutoff = Date.now() - maxDays * 24 * 60 * 60 * 1000;
    await DataStore.update<DeletedMessage[]>(DELETED_KEY, deleted =>
        (deleted ?? []).filter(m => m.deletedAt > cutoff));
}

export async function clearDeletedMessages() {
    await DataStore.set(DELETED_KEY, []);
}

export function clearMemoryCache() {
    memoryCache.clear();
}

export function getCacheStats(): { channels: number; messages: number; } {
    let messages = 0;
    for (const cache of memoryCache.values()) messages += cache.size;
    return { channels: memoryCache.size, messages };
}
