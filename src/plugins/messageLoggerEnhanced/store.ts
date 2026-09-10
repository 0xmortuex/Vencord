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

// In-memory cache, grouped per guild so the rolling per-guild limit is cheap to
// enforce. `idToGuild` is a reverse index so a delete/edit event resolves its
// message in O(1) instead of scanning every guild's map (which happened on
// every MESSAGE_DELETE, and scaled with the number of servers).
const memoryCache = new Map<string, Map<string, CachedMessage>>();
const idToGuild = new Map<string, string>();
// Guilds whose cache changed since the last persist. persistCacheToDisk used
// to re-serialize EVERY guild's entire cache every 5 minutes; now it only
// writes the ones that actually changed, and nothing at all when idle.
const dirtyGuilds = new Set<string>();

export function getGuildCache(guildId: string): Map<string, CachedMessage> {
    let cache = memoryCache.get(guildId);
    if (!cache) {
        cache = new Map();
        memoryCache.set(guildId, cache);
    }
    return cache;
}

export function cacheMessage(msg: CachedMessage, maxPerGuild: number) {
    const guildId = msg.guildId || "DM";
    const cache = getGuildCache(guildId);
    cache.set(msg.id, msg);
    idToGuild.set(msg.id, guildId);
    dirtyGuilds.add(guildId);

    // Enforce rolling limit (Map iteration order = insertion order = oldest first).
    while (cache.size > maxPerGuild) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        cache.delete(oldest);
        idToGuild.delete(oldest);
    }
}

export function getCachedMessage(messageId: string): CachedMessage | undefined {
    const guildId = idToGuild.get(messageId);
    if (guildId === undefined) return undefined;
    return memoryCache.get(guildId)?.get(messageId);
}

export function removeCachedMessage(messageId: string) {
    const guildId = idToGuild.get(messageId);
    if (guildId === undefined) return;
    idToGuild.delete(messageId);
    const cache = memoryCache.get(guildId);
    if (cache?.delete(messageId)) dirtyGuilds.add(guildId);
}

export async function persistCacheToDisk() {
    if (!dirtyGuilds.size) return;
    const toWrite = [...dirtyGuilds];
    dirtyGuilds.clear();
    // Serialize every dirty guild SYNCHRONOUSLY before the first await: stop()
    // calls clearMemoryCache() right after kicking this off, so reading the
    // live map after an await would find it empty for all but the first guild.
    const snapshots: Array<[string, Record<string, CachedMessage>]> = [];
    for (const guildId of toWrite) {
        const cache = memoryCache.get(guildId);
        if (!cache) continue;
        const obj: Record<string, CachedMessage> = {};
        for (const [id, msg] of cache.entries()) obj[id] = msg;
        snapshots.push([guildId, obj]);
    }
    for (const [guildId, obj] of snapshots) {
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
                idToGuild.set(id, guildId);
            }
        }
    }
}

// --- Deleted-message log -----------------------------------------------------
//
// All mutations go through DataStore.update, which runs get+set inside a single
// IndexedDB transaction, so concurrent writers can't drop each other's entries.
//
// Adds are BATCHED: a MESSAGE_DELETE_BULK (or a fast burst of deletes) used to
// read + rewrite the whole (up to 5000-entry) list once PER message. Now
// deletes queue up and are flushed in one transaction shortly after, so a
// burst of N deletes costs one rewrite instead of N. Every reader/other writer
// flushes the queue first so the log is always consistent.
// Listeners for "the deleted log changed" so an open Ghost Messages modal can
// refresh live instead of only reading once on open.
const deletedListeners = new Set<() => void>();
export function subscribeDeleted(fn: () => void): () => void {
    deletedListeners.add(fn);
    return () => { deletedListeners.delete(fn); };
}
function notifyDeleted() { for (const fn of deletedListeners) { try { fn(); } catch { } } }

const pendingAdds: DeletedMessage[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushing: Promise<void> | null = null;
const FLUSH_DELAY_MS = 750;

async function flushPendingAdds(): Promise<void> {
    // Always drop the pending timer first: if a timer fires while a flush is
    // still in flight, returning early would leave flushTimer set and no later
    // add would ever schedule another flush (queued deletes stranded in memory).
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (flushing) {
        // Wait for the in-flight write, then drain whatever queued meanwhile.
        await flushing;
        return flushPendingAdds();
    }
    if (!pendingAdds.length) return;
    const batch = pendingAdds.splice(0, pendingAdds.length);
    flushing = DataStore.update<DeletedMessage[]>(DELETED_KEY, deleted => {
        const list = deleted ?? [];
        list.push(...batch);
        if (list.length > MAX_DELETED) list.splice(0, list.length - MAX_DELETED);
        return list;
    }).then(() => { flushing = null; notifyDeleted(); }, e => { flushing = null; throw e; });
    return flushing;
}

export async function getDeletedMessages(): Promise<DeletedMessage[]> {
    await flushPendingAdds();
    return (await DataStore.get(DELETED_KEY)) ?? [];
}

export async function addDeletedMessage(msg: DeletedMessage) {
    pendingAdds.push(msg);
    if (!flushTimer) flushTimer = setTimeout(() => { flushPendingAdds().catch(() => {}); }, FLUSH_DELAY_MS);
}

export async function removeDeletedMessage(messageId: string) {
    await flushPendingAdds();
    await DataStore.update<DeletedMessage[]>(DELETED_KEY, deleted =>
        (deleted ?? []).filter(m => m.id !== messageId));
    notifyDeleted();
}

/** Remove many entries in ONE transaction (the modal's "Remove shown"). */
export async function removeDeletedMessages(ids: Iterable<string>) {
    const set = new Set(ids);
    if (!set.size) return;
    await flushPendingAdds();
    await DataStore.update<DeletedMessage[]>(DELETED_KEY, deleted =>
        (deleted ?? []).filter(m => !set.has(m.id)));
    notifyDeleted();
}

export async function cleanOldEntries(maxDays: number) {
    await flushPendingAdds();
    const cutoff = Date.now() - maxDays * 24 * 60 * 60 * 1000;
    await DataStore.update<DeletedMessage[]>(DELETED_KEY, deleted =>
        (deleted ?? []).filter(m => m.deletedAt > cutoff));
    notifyDeleted();
}

export async function clearDeletedMessages() {
    // Drop anything still queued so it can't re-appear after the clear.
    pendingAdds.length = 0;
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    await DataStore.set(DELETED_KEY, []);
    notifyDeleted();
}

/** Flush any queued deletes now (used on plugin stop so nothing is lost). */
export function flushDeletedMessages(): Promise<void> {
    return flushPendingAdds();
}

export function clearMemoryCache() {
    memoryCache.clear();
    idToGuild.clear();
    dirtyGuilds.clear();
}

export function getCacheStats(): { channels: number; messages: number; } {
    return { channels: memoryCache.size, messages: idToGuild.size };
}
