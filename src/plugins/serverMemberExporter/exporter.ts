/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { sleep } from "@utils/misc";
import { saveFile } from "@utils/web";
import type { Embed, MessageAttachment, MessageReaction } from "@vencord/discord-types";
import { ChannelStore, RestAPI, showToast, Toasts } from "@webpack/common";

import { renderHtml } from "./htmlRenderer";

export interface MemberInfo {
    id: string;
    username: string;
    globalName: string | null;
    /** Pre-resolved avatar URL (via IconUtils) so the renderer never builds CDN URLs by hand. */
    avatarUrl: string;
    nick: string | null;
    /** Role IDs this member holds (excluding @everyone), used for the role filter. */
    roles: string[];
    topRoleName: string | null;
    topRoleColor: number | null;
}

export interface ExportedMessage {
    id: string;
    channelId: string;
    channelName: string;
    guildId: string;
    guildName: string;
    content: string;
    timestamp: string;
    edited_timestamp: string | null;
    attachments: MessageAttachment[];
    embeds: Embed[];
    reactions: MessageReaction[];
    type: number;
}

export interface ExportedMemberData {
    member: MemberInfo;
    messages: ExportedMessage[];
}

export interface ExportOptions {
    /** The right-clicked server: source of the member list, job key, and file name. */
    guildId: string;
    guildName: string;
    /** Servers to actually search each member's messages in (always includes the primary). */
    searchGuilds: Array<{ id: string; name: string; }>;
    members: MemberInfo[];
    format: "html" | "json";
    messageLimit: number | null; // per member ACROSS all searchGuilds, null = all (capped by the search offset limit)
    combineFiles: boolean;
    includeAttachments: boolean;
    includeEmbeds: boolean;
    includeReactions: boolean;
    startDate: string | null;
    endDate: string | null;
}

export interface ExportProgress {
    status: "fetching" | "rendering" | "done" | "cancelled" | "error";
    currentUser: string;
    usersDone: number;
    totalUsers: number;
    totalMessages: number;
    error?: string;
}

export interface MemberExportJob {
    guildId: string;
    label: string;
    progress: ExportProgress;
    abortController: AbortController;
}

type Listener = () => void;

const jobs = new Map<string, MemberExportJob>();
const earlyFinishFlags = new Map<string, boolean>();
const listeners = new Set<Listener>();

function notify() {
    for (const fn of listeners) fn();
}

export function subscribe(fn: Listener): () => void {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
}

export function getMemberExportJob(guildId: string): MemberExportJob | undefined {
    return jobs.get(guildId);
}

export function cancelMemberExport(guildId: string) {
    const job = jobs.get(guildId);
    if (job) {
        job.abortController.abort();
        jobs.delete(guildId);
        earlyFinishFlags.delete(guildId);
        notify();
    }
}

export function earlyFinishMemberExport(guildId: string) {
    if (!jobs.has(guildId)) return;
    earlyFinishFlags.set(guildId, true);
    notify();
}

export function isEarlyFinishRequested(guildId: string): boolean {
    return earlyFinishFlags.get(guildId) === true;
}

// Rate-limit tuning for the guild search API. The endpoint only returns 25 hits
// per page, so paging dominates the runtime. We start at an optimistic delay and
// only fall back to the conservative one if the route actually rate-limits us -
// this is ~3x faster than a fixed 3500ms while still self-correcting on 429s.
const SEARCH_PAGE_SIZE = 25;
const FAST_DELAY = 350; // floor between pages while the rate-limit bucket still has room
const BASE_DELAY = 1200; // used only when the response exposes no rate-limit headers
const ELEVATED_DELAY = 3500; // safe fallback once 429s appear
const COOLDOWN_INTERVAL = 40; // pages between safety cooldowns (header pacing usually handles it)
const COOLDOWN_DURATION = 3000;
const MAX_RETRIES = 5;
const MAX_SEARCH_OFFSET = 2000;
const RATE_LIMIT_THRESHOLD = 2; // switch to ELEVATED_DELAY after this many cumulative 429s

// Discord's REST responses may surface headers as a Headers object (.get) or a
// plain lowercased map, depending on the path. Read both shapes defensively.
function readHeader(headers: any, name: string): string | undefined {
    if (!headers) return undefined;
    if (typeof headers.get === "function") return headers.get(name) ?? undefined;
    return headers[name] ?? headers[name.toLowerCase()] ?? undefined;
}

// Pace from Discord's own bucket headers: burst while requests remain, then wait
// exactly until the bucket resets. Falls back to a fixed delay if headers are
// absent, and to the safe elevated delay once we've been 429'd a few times.
function nextDelay(res: any, total429s: number): number {
    if (total429s >= RATE_LIMIT_THRESHOLD) return ELEVATED_DELAY;

    const remainingRaw = readHeader(res?.headers, "x-ratelimit-remaining");
    if (remainingRaw == null) return BASE_DELAY;

    const remaining = Number(remainingRaw);
    if (remaining > 0) return FAST_DELAY;

    const resetRaw = readHeader(res?.headers, "x-ratelimit-reset-after");
    const resetMs = resetRaw != null ? Number(resetRaw) * 1000 : BASE_DELAY;
    return Math.max(FAST_DELAY, resetMs + 100);
}

// Discord snowflakes encode a timestamp, so a date range can be pushed to the
// server as min_id/max_id instead of scanning and discarding out-of-range pages.
const DISCORD_EPOCH = 1420070400000;
function dateToSnowflake(dateStr: string): string {
    const ms = new Date(dateStr).getTime();
    return (BigInt(Math.max(0, ms - DISCORD_EPOCH)) << 22n).toString();
}

function isRateLimitError(e: any): boolean {
    if (e?.status === 429) return true;
    const msg = String(e?.message ?? e ?? "").toLowerCase();
    return msg.includes("429") || msg.includes("rate limit");
}

function getRetryDelay(attempt: number): number {
    // attempt 0 = 10s, 1 = 20s, 2 = 40s, 3+ = 60s
    const delays = [10000, 20000, 40000, 60000];
    return delays[attempt] ?? 60000;
}

// Search a single guild for one author's messages (no channel_id => all channels)
// and append them to `collected`. `primaryGuildId` keys the abort/early-finish
// flags; `searchGuild` is the guild actually being searched.
async function searchGuildForAuthor(
    searchGuild: { id: string; name: string; },
    primaryGuildId: string,
    userId: string,
    options: ExportOptions,
    collected: ExportedMessage[],
    onPageProgress: (found: number) => void,
    signal: AbortSignal,
    rateLimitState: { total429s: number; },
): Promise<void> {
    const limit = options.messageLimit;
    let offset = 0;
    let total = Infinity;
    let successfulPages = 0;

    while (offset < total) {
        if (signal.aborted || earlyFinishFlags.get(primaryGuildId)) return;
        if (limit && collected.length >= limit) return;
        if (offset > MAX_SEARCH_OFFSET) return;

        const query: Record<string, any> = {
            author_id: userId,
            offset,
            include_nsfw: true,
        };
        // Bound the search by date server-side so we don't page through (and then
        // discard) messages outside the requested range.
        if (options.startDate) query.min_id = dateToSnowflake(options.startDate);
        if (options.endDate) query.max_id = dateToSnowflake(options.endDate);

        let res: any = null;
        let succeeded = false;

        for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
            if (signal.aborted || earlyFinishFlags.get(primaryGuildId)) return;

            try {
                res = await RestAPI.get({
                    url: `/guilds/${searchGuild.id}/messages/search`,
                    query,
                    retries: 0,
                });
                succeeded = true;
                break;
            } catch (e: any) {
                // 403/404 => not in this guild or no access; just skip this guild.
                if (e?.status === 403 || e?.status === 404) return;

                if (isRateLimitError(e)) {
                    rateLimitState.total429s++;
                    if (attempt >= MAX_RETRIES - 1) {
                        console.log(`[ServerMemberExporter] Too many 429s for user ${userId} in ${searchGuild.name}, skipping rest`);
                        return;
                    }
                    const serverDelay = e?.body?.retry_after
                        ? Number(e.body.retry_after) * 1000
                        : e?.headers?.["retry-after"]
                            ? Number(e.headers["retry-after"]) * 1000
                            : 0;
                    const backoff = Math.max(serverDelay, getRetryDelay(attempt));
                    console.log(`[ServerMemberExporter] Rate limited, waiting ${Math.round(backoff / 1000)}s (attempt ${attempt + 1}/${MAX_RETRIES})`);
                    await sleep(backoff);
                    continue;
                }

                if (attempt === MAX_RETRIES - 1) {
                    console.log(`[ServerMemberExporter] Failed after ${MAX_RETRIES} retries for user ${userId} in ${searchGuild.name}, skipping`);
                    return;
                }
                await sleep(getRetryDelay(attempt));
            }
        }

        if (!succeeded || !res) return;
        successfulPages++;

        // One-time diagnostic per search so we can confirm header-based pacing is
        // active (remaining/resetAfter present) vs falling back to the fixed delay.
        if (successfulPages === 1) {
            const rem = readHeader(res.headers, "x-ratelimit-remaining");
            const reset = readHeader(res.headers, "x-ratelimit-reset-after");
            console.log(`[ServerMemberExporter] ${searchGuild.name}: ratelimit remaining=${rem ?? "n/a"} resetAfter=${reset ?? "n/a"}`);
        }

        const body = res?.body ?? {};
        total = typeof body.total_results === "number" ? body.total_results : 0;
        const hits: any[][] = body.messages ?? [];
        if (!hits.length) break;

        for (const hit of hits) {
            const msg = Array.isArray(hit) ? hit[0] : hit;
            if (!msg) continue;

            if (options.startDate) {
                const msgDate = new Date(msg.timestamp);
                if (msgDate < new Date(options.startDate)) continue;
            }
            if (options.endDate) {
                const msgDate = new Date(msg.timestamp);
                if (msgDate > new Date(options.endDate)) continue;
            }

            const channel = ChannelStore.getChannel(msg.channel_id);
            collected.push({
                id: msg.id,
                channelId: msg.channel_id,
                channelName: channel?.name ?? msg.channel_id,
                guildId: searchGuild.id,
                guildName: searchGuild.name,
                content: msg.content ?? "",
                timestamp: msg.timestamp,
                edited_timestamp: msg.edited_timestamp,
                attachments: options.includeAttachments ? (msg.attachments ?? []) : [],
                embeds: options.includeEmbeds ? (msg.embeds ?? []) : [],
                reactions: options.includeReactions ? (msg.reactions ?? []) : [],
                type: msg.type,
            });

            if (limit && collected.length >= limit) break;
        }

        onPageProgress(collected.length);

        offset += SEARCH_PAGE_SIZE;
        // Stop without a trailing delay once we've hit the limit or run out.
        if (offset >= total) break;
        if (limit && collected.length >= limit) break;

        if (successfulPages % COOLDOWN_INTERVAL === 0) {
            await sleep(COOLDOWN_DURATION);
        }

        await sleep(nextDelay(res, rateLimitState.total429s));
    }
}

// Collect one member's messages across every selected server (merged, capped by
// the per-member limit). Servers where the member isn't present just yield nothing.
async function fetchMemberMessages(
    searchGuilds: Array<{ id: string; name: string; }>,
    primaryGuildId: string,
    userId: string,
    options: ExportOptions,
    onPageProgress: (found: number) => void,
    signal: AbortSignal,
    rateLimitState: { total429s: number; },
): Promise<ExportedMessage[]> {
    const collected: ExportedMessage[] = [];
    for (const guild of searchGuilds) {
        if (signal.aborted || earlyFinishFlags.get(primaryGuildId)) break;
        if (options.messageLimit && collected.length >= options.messageLimit) break;
        await searchGuildForAuthor(guild, primaryGuildId, userId, options, collected, onPageProgress, signal, rateLimitState);
    }
    return collected;
}

function displayNameOf(m: MemberInfo): string {
    return m.nick || m.globalName || m.username;
}

export function startMemberExport(options: ExportOptions) {
    if (jobs.has(options.guildId)) return;

    const controller = new AbortController();
    const job: MemberExportJob = {
        guildId: options.guildId,
        label: options.guildName,
        progress: {
            status: "fetching",
            currentUser: "",
            usersDone: 0,
            totalUsers: options.members.length,
            totalMessages: 0,
        },
        abortController: controller,
    };
    jobs.set(options.guildId, job);
    notify();

    (async () => {
        const rateLimitState = { total429s: 0 };
        const date = new Date().toISOString().split("T")[0];
        const guildSafe = options.guildName.replace(/[^a-zA-Z0-9-_]/g, "_");

        // When not combining, each member's file is written to disk as soon as
        // they finish, and the in-memory messages are dropped to free memory.
        const collected: ExportedMemberData[] = [];
        let totalMessages = 0;
        let earlyFinished = false;

        const saveMemberToDisk = (data: ExportedMemberData) => {
            const nameSafe = displayNameOf(data.member).replace(/[^a-zA-Z0-9-_]/g, "_");
            const ext = options.format === "json" ? "json" : "html";
            const mime = options.format === "json" ? "application/json" : "text/html";
            const filename = `${guildSafe}-${nameSafe}-${date}.${ext}`;
            const content = options.format === "json"
                ? JSON.stringify(buildJson(options, [data]), null, 2)
                : renderHtml(options.guildName, [data]);
            saveFile(new File([content], filename, { type: mime }));
        };

        try {
            for (let i = 0; i < options.members.length; i++) {
                if (controller.signal.aborted) break;
                if (earlyFinishFlags.get(options.guildId)) {
                    earlyFinished = true;
                    break;
                }

                const member = options.members[i];
                job.progress = {
                    ...job.progress,
                    status: "fetching",
                    currentUser: displayNameOf(member),
                };
                notify();

                let messages: ExportedMessage[] = [];
                try {
                    messages = await fetchMemberMessages(
                        options.searchGuilds,
                        options.guildId,
                        member.id,
                        options,
                        found => {
                            job.progress = { ...job.progress, totalMessages: totalMessages + found };
                            notify();
                        },
                        controller.signal,
                        rateLimitState,
                    );
                } catch {
                    // Skip the member on unrecoverable errors but keep going.
                    messages = [];
                }

                totalMessages += messages.length;

                if (messages.length) {
                    const data: ExportedMemberData = { member, messages };
                    if (options.combineFiles) {
                        collected.push(data);
                    } else {
                        try {
                            saveMemberToDisk(data);
                        } catch (e: any) {
                            console.error(`[ServerMemberExporter] Failed to save ${displayNameOf(member)}:`, e);
                            showToast(`Failed to save ${displayNameOf(member)}: ${e?.message ?? "unknown error"}`, Toasts.Type.FAILURE);
                        }
                    }
                }

                job.progress = { ...job.progress, usersDone: i + 1, totalMessages };
                notify();
            }

            if (controller.signal.aborted) {
                jobs.delete(options.guildId);
                earlyFinishFlags.delete(options.guildId);
                notify();
                return;
            }

            job.progress = { ...job.progress, status: "rendering" };
            notify();

            if (options.combineFiles) {
                const ext = options.format === "json" ? "json" : "html";
                const mime = options.format === "json" ? "application/json" : "text/html";
                const content = options.format === "json"
                    ? JSON.stringify(buildJson(options, collected), null, 2)
                    : renderHtml(options.guildName, collected);
                saveFile(new File([content], `${guildSafe}-members-${date}.${ext}`, { type: mime }));
            }

            job.progress = { ...job.progress, status: "done", totalMessages };
            notify();

            const usersWithMessages = options.combineFiles
                ? collected.length
                : job.progress.usersDone;
            const completionLabel = earlyFinished
                ? `(stopped early, ${job.progress.usersDone}/${options.members.length} members)`
                : `(${options.members.length} members)`;
            showToast(
                `Exported ${totalMessages} messages from ${usersWithMessages} member${usersWithMessages !== 1 ? "s" : ""} of ${options.guildName} ${completionLabel}`,
                Toasts.Type.SUCCESS,
            );
        } catch (e: any) {
            if (!controller.signal.aborted) {
                job.progress = {
                    ...job.progress,
                    status: "error",
                    error: e?.message ?? "Unknown error",
                };
                notify();
                showToast(`Member export of ${options.guildName} failed`, Toasts.Type.FAILURE);
            }
        } finally {
            earlyFinishFlags.delete(options.guildId);
            setTimeout(() => {
                const current = jobs.get(options.guildId);
                if (current && (current.progress.status === "done" || current.progress.status === "error")) {
                    jobs.delete(options.guildId);
                    notify();
                }
            }, 5000);
        }
    })();
}

function buildJson(options: ExportOptions, members: ExportedMemberData[]) {
    return {
        guild: { id: options.guildId, name: options.guildName },
        exportedAt: new Date().toISOString(),
        totalMessages: members.reduce((sum, m) => sum + m.messages.length, 0),
        members: members.map(m => ({
            id: m.member.id,
            username: m.member.username,
            globalName: m.member.globalName,
            nick: m.member.nick,
            topRole: m.member.topRoleName,
            messageCount: m.messages.length,
            messages: m.messages,
        })),
    };
}
