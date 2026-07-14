/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {
    CheckpointChannel,
    deleteCheckpoint,
    generateJobId,
    InProgressChannel,
    loadCheckpoint,
    saveCheckpoint,
} from "@plugins/chatExporter/checkpoint";
import { saveFile } from "@utils/web";
import type { Embed, MessageAttachment, MessageReaction } from "@vencord/discord-types";
import { RestAPI, showToast, Toasts } from "@webpack/common";

import { renderHtml } from "./htmlRenderer";

export interface ExportedMessage {
    id: string;
    channelId: string;
    content: string;
    author: {
        id: string;
        username: string;
        globalName: string | null;
        avatar: string | null;
        bot: boolean;
    };
    timestamp: string;
    edited_timestamp: string | null;
    attachments: MessageAttachment[];
    embeds: Embed[];
    reactions: MessageReaction[];
    type: number;
}

export interface UserInfo {
    id: string;
    username: string;
    globalName: string | null;
    avatar: string | null;
}

export interface ChannelSelection {
    id: string;
    name: string;
    guildId: string;
    guildName: string;
}

export interface ExportOptions {
    user: UserInfo;
    channels: ChannelSelection[];
    format: "html" | "json";
    messageLimit: number | null;
    includeAttachments: boolean;
    includeEmbeds: boolean;
    includeReactions: boolean;
    startDate: string | null;
    endDate: string | null;
}

export interface ExportProgress {
    status: "fetching" | "rendering" | "done" | "cancelled" | "error";
    currentGuild: string;
    currentChannel: string;
    channelsDone: number;
    totalChannels: number;
    totalMessages: number;
    error?: string;
}

export interface UserExportJob {
    userId: string;
    label: string;
    progress: ExportProgress;
    abortController: AbortController;
    saveProgress?: () => void;
}

type Listener = () => void;

const jobs = new Map<string, UserExportJob>();
const earlyFinishFlags = new Map<string, boolean>();
const listeners = new Set<Listener>();

function notify() {
    for (const fn of listeners) fn();
}

export function subscribe(fn: Listener): () => void {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
}

export function getUserJob(userId: string): UserExportJob | undefined {
    return jobs.get(userId);
}

export function cancelUserJob(userId: string) {
    const job = jobs.get(userId);
    if (job) {
        job.abortController.abort();
        jobs.delete(userId);
        earlyFinishFlags.delete(userId);
        notify();
    }
}

export function earlyFinishJob(userId: string) {
    if (!jobs.has(userId)) return;
    earlyFinishFlags.set(userId, true);
    notify();
}

// Lets the modal's "Save Progress" button force a checkpoint write on demand.
export function saveUserProgress(userId: string) {
    jobs.get(userId)?.saveProgress?.();
}

// Abort-aware sleep: resolves immediately when the export is cancelled so a
// pending cooldown/backoff never keeps a dead job running for seconds.
function pause(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise(resolve => {
        if (signal.aborted) return resolve();
        const timer = setTimeout(finish, ms);
        function finish() {
            signal.removeEventListener("abort", finish);
            clearTimeout(timer);
            resolve();
        }
        signal.addEventListener("abort", finish);
    });
}

// Rate-limit tuning for the guild search API, mirroring ServerMemberExporter:
// burst while Discord's bucket headers say there's room, wait out the bucket
// reset when there isn't, and fall back to a conservative fixed delay once
// real 429s start appearing.
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
function dateToSnowflake(date: Date): string {
    return (BigInt(Math.max(0, date.getTime() - DISCORD_EPOCH)) << 22n).toString();
}

// Date inputs are plain YYYY-MM-DD strings that parse to midnight UTC. The end
// bound must therefore be the start of the NEXT day (exclusive), otherwise every
// message sent during the selected end date gets dropped.
function endDateBound(dateStr: string): Date {
    const d = new Date(dateStr);
    d.setUTCDate(d.getUTCDate() + 1);
    return d;
}

function isRateLimitError(e: any): boolean {
    if (e?.status === 429) return true;
    const msg = String(e?.message ?? e ?? "").toLowerCase();
    return msg.includes("429") || msg.includes("rate limit");
}

function getRetryDelay(attempt: number): number {
    // attempt 0 = 10s, 1 = 20s, 2 = 40s, 3 = 60s
    const delays = [10000, 20000, 40000, 60000];
    return delays[attempt] ?? 60000;
}

async function fetchChannelMessages(
    guildId: string,
    channelId: string,
    userId: string,
    options: ExportOptions,
    onPageProgress: (found: number) => void,
    signal: AbortSignal,
    rateLimitState: { total429s: number; },
): Promise<ExportedMessage[]> {
    const collected: ExportedMessage[] = [];
    const limit = options.messageLimit;
    let offset = 0;
    let total = Infinity;
    let successfulPages = 0;

    const startBound = options.startDate ? new Date(options.startDate) : null;
    const endBound = options.endDate ? endDateBound(options.endDate) : null;

    while (offset < total) {
        if (signal.aborted || earlyFinishFlags.get(userId)) return collected;
        if (limit && collected.length >= limit) break;
        if (offset > MAX_SEARCH_OFFSET) break;

        const query: Record<string, any> = {
            author_id: userId,
            channel_id: channelId,
            offset,
            include_nsfw: true,
        };
        // Bound the search by date server-side so we don't page through (and then
        // discard) messages outside the requested range.
        if (startBound) query.min_id = dateToSnowflake(startBound);
        if (endBound) query.max_id = dateToSnowflake(endBound);

        let res: any = null;
        let succeeded = false;

        for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
            if (signal.aborted || earlyFinishFlags.get(userId)) return collected;

            try {
                res = await RestAPI.get({
                    url: `/guilds/${guildId}/messages/search`,
                    query,
                    retries: 0,
                });
                succeeded = true;
                break;
            } catch (e: any) {
                if (e?.status === 403 || e?.status === 404) return collected;

                if (isRateLimitError(e)) {
                    rateLimitState.total429s++;

                    // On attempt 4 (5th try, index 4), skip the channel
                    if (attempt >= MAX_RETRIES - 1) {
                        console.log(`UserExporter: Too many 429s for channel ${channelId}, skipping`);
                        return collected;
                    }

                    const retryAfterHeader = readHeader(e?.headers, "retry-after");
                    const serverDelay = e?.body?.retry_after
                        ? Number(e.body.retry_after) * 1000
                        : retryAfterHeader
                            ? Number(retryAfterHeader) * 1000
                            : 0;
                    const backoff = Math.max(serverDelay, getRetryDelay(attempt));
                    const waitSec = Math.round(backoff / 1000);
                    console.log(`UserExporter: Rate limited, waiting ${waitSec}s before retry (attempt ${attempt + 1}/${MAX_RETRIES})`);
                    await pause(backoff, signal);
                    continue;
                }

                if (attempt === MAX_RETRIES - 1) {
                    console.log(`UserExporter: Failed after ${MAX_RETRIES} retries for channel ${channelId}, skipping`);
                    return collected;
                }

                const backoff = getRetryDelay(attempt);
                const waitSec = Math.round(backoff / 1000);
                console.log(`UserExporter: Request error, waiting ${waitSec}s before retry (attempt ${attempt + 1}/${MAX_RETRIES})`);
                await pause(backoff, signal);
            }
        }

        if (!succeeded || !res) return collected;

        successfulPages++;

        const body = res?.body ?? {};
        total = typeof body.total_results === "number" ? body.total_results : 0;
        const hits: any[][] = body.messages ?? [];

        if (!hits.length) break;

        for (const hit of hits) {
            const msg = Array.isArray(hit) ? hit[0] : hit;
            if (!msg) continue;

            if (startBound || endBound) {
                const msgDate = new Date(msg.timestamp);
                if (startBound && msgDate < startBound) continue;
                if (endBound && msgDate >= endBound) continue;
            }

            collected.push({
                id: msg.id,
                channelId,
                content: msg.content ?? "",
                author: {
                    id: msg.author.id,
                    username: msg.author.username,
                    globalName: msg.author.global_name ?? null,
                    avatar: msg.author.avatar,
                    bot: msg.author.bot ?? false,
                },
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
            await pause(COOLDOWN_DURATION, signal);
        }

        await pause(nextDelay(res, rateLimitState.total429s), signal);
    }

    return collected;
}

export interface ExportedChannelData {
    channelId: string;
    channelName: string;
    guildId: string;
    guildName: string;
    messages: ExportedMessage[];
}

export function startUserExport(options: ExportOptions, resumeFromCheckpoint = false) {
    if (jobs.has(options.user.id)) return;

    const jobId = generateJobId("user", options.user.id);

    // When resuming, the checkpoint is the source of truth for the job config so
    // the resumed export matches the one that was interrupted, not whatever the
    // modal's form currently shows. UserExporter writes a single combined file at
    // the very end, so a partial run can't be stitched back together from disk -
    // "resume" here re-runs the whole export with the saved settings. The
    // checkpoint still lets the modal show how far the previous attempt got.
    const checkpoint = resumeFromCheckpoint ? loadCheckpoint(jobId) : null;

    const channels: ChannelSelection[] = checkpoint
        ? checkpoint.channelsRequested.map(c => ({
            id: c.id, name: c.name, guildId: c.guildId, guildName: c.guildName,
        }))
        : options.channels;

    const effectiveOptions: ExportOptions = {
        ...options,
        channels,
        format: checkpoint ? checkpoint.format : options.format,
        messageLimit: checkpoint ? checkpoint.messageLimit : options.messageLimit,
        startDate: checkpoint ? checkpoint.startDate : options.startDate,
        endDate: checkpoint ? checkpoint.endDate : options.endDate,
    };

    const controller = new AbortController();
    const displayName = options.user.globalName || options.user.username;
    const startedAt = checkpoint ? checkpoint.startedAt : new Date().toISOString();
    const channelsRequested: CheckpointChannel[] = channels.map(c => ({
        id: c.id, name: c.name, guildId: c.guildId, guildName: c.guildName,
    }));

    const job: UserExportJob = {
        userId: options.user.id,
        label: `@${displayName}`,
        progress: {
            status: "fetching",
            currentGuild: "",
            currentChannel: "",
            channelsDone: 0,
            totalChannels: channels.length,
            totalMessages: 0,
        },
        abortController: controller,
    };
    jobs.set(options.user.id, job);
    notify();

    (async () => {
        const rateLimitState = { total429s: 0 };
        const channelsCompleted: string[] = [];
        let totalMessages = 0;
        let latestInProgress: InProgressChannel | null = null;

        const persistCheckpoint = (inProgress: InProgressChannel | null) => {
            saveCheckpoint(jobId, {
                version: 1,
                jobId,
                type: "user",
                targetId: options.user.id,
                targetName: displayName,
                format: effectiveOptions.format,
                messageLimit: effectiveOptions.messageLimit,
                combineFiles: true, // UserExporter always writes one combined file
                startDate: effectiveOptions.startDate,
                endDate: effectiveOptions.endDate,
                channelsRequested,
                channelsCompleted,
                inProgressChannel: inProgress,
                startedAt,
                lastCheckpointAt: startedAt,
                totalMessagesProcessed: totalMessages,
            });
        };

        // Write the initial checkpoint up front so an interruption before the
        // first channel finishes still leaves a resumable record.
        persistCheckpoint(null);

        // Lets the modal's "Save Progress" button force a checkpoint write on demand.
        job.saveProgress = () => persistCheckpoint(latestInProgress);

        try {
            const results: ExportedChannelData[] = [];
            let earlyFinished = false;

            for (let i = 0; i < channels.length; i++) {
                if (controller.signal.aborted) break;
                if (earlyFinishFlags.get(options.user.id)) {
                    earlyFinished = true;
                    break;
                }
                const ch = channels[i];

                job.progress = {
                    ...job.progress,
                    status: "fetching",
                    currentGuild: ch.guildName,
                    currentChannel: ch.name,
                };
                notify();

                let lastCheckpointCount = 0;
                let channelMessages: ExportedMessage[] = [];
                try {
                    channelMessages = await fetchChannelMessages(
                        ch.guildId,
                        ch.id,
                        options.user.id,
                        effectiveOptions,
                        found => {
                            job.progress = {
                                ...job.progress,
                                totalMessages: totalMessages + found,
                            };
                            notify();

                            // Search is offset-based (no message cursor), so
                            // lastMessageId stays null; fetchedSoFar drives the
                            // banner. Checkpoint roughly every 1000 messages.
                            latestInProgress = {
                                id: ch.id, name: ch.name, lastMessageId: null, fetchedSoFar: found,
                            };
                            if (found - lastCheckpointCount >= 1000) {
                                lastCheckpointCount = found;
                                persistCheckpoint(latestInProgress);
                            }
                        },
                        controller.signal,
                        rateLimitState,
                    );
                } catch (e: any) {
                    // Skip this channel on unrecoverable errors but keep going
                    channelMessages = [];
                }

                totalMessages += channelMessages.length;

                if (channelMessages.length) {
                    results.push({
                        channelId: ch.id,
                        channelName: ch.name,
                        guildId: ch.guildId,
                        guildName: ch.guildName,
                        messages: channelMessages,
                    });
                }

                // Record the channel as done and checkpoint with no in-progress
                // channel so the banner's completed count stays accurate.
                channelsCompleted.push(ch.id);
                latestInProgress = null;

                job.progress = {
                    ...job.progress,
                    channelsDone: i + 1,
                    totalMessages,
                };
                notify();

                persistCheckpoint(null);
            }

            if (controller.signal.aborted) {
                jobs.delete(options.user.id);
                earlyFinishFlags.delete(options.user.id);
                notify();
                return;
            }

            if (earlyFinished) {
                showToast(
                    `Export finishing early with ${totalMessages} messages collected...`,
                    Toasts.Type.MESSAGE,
                );
            }

            job.progress = { ...job.progress, status: "rendering" };
            notify();

            const safeName = (displayName || "user").replace(/[^a-zA-Z0-9-_]/g, "_");
            const date = new Date().toISOString().split("T")[0];
            const filename = `${safeName}-messages-${date}`;

            const guildCount = new Set(results.map(r => r.guildId)).size;

            if (effectiveOptions.format === "json") {
                const byGuild = new Map<string, { name: string; id: string; channels: ExportedChannelData[]; }>();
                for (const r of results) {
                    if (!byGuild.has(r.guildId)) {
                        byGuild.set(r.guildId, { id: r.guildId, name: r.guildName, channels: [] });
                    }
                    byGuild.get(r.guildId)!.channels.push(r);
                }
                const json = {
                    user: {
                        id: options.user.id,
                        username: options.user.username,
                        globalName: options.user.globalName,
                        avatar: options.user.avatar,
                    },
                    exportedAt: new Date().toISOString(),
                    totalMessages,
                    servers: Array.from(byGuild.values()).map(g => ({
                        id: g.id,
                        name: g.name,
                        channels: g.channels.map(c => ({
                            id: c.channelId,
                            name: c.channelName,
                            messages: c.messages,
                        })),
                    })),
                };
                saveFile(new File([JSON.stringify(json, null, 2)], filename + ".json", { type: "application/json" }));
            } else {
                const html = renderHtml(options.user, results, totalMessages, guildCount);
                saveFile(new File([html], filename + ".html", { type: "text/html" }));
            }

            // A full run consumed every requested channel and the combined file is
            // on disk - drop the checkpoint. An early finish leaves it in place so
            // the user can re-run the full set later.
            if (!earlyFinished) deleteCheckpoint(jobId);

            job.progress = { ...job.progress, status: "done", totalMessages };
            notify();
            showToast(
                `Export of @${displayName} complete (${totalMessages} messages from ${results.length} channels)`,
                Toasts.Type.SUCCESS
            );
        } catch (e: any) {
            if (!controller.signal.aborted) {
                job.progress = {
                    ...job.progress,
                    status: "error",
                    error: e?.message ?? "Unknown error",
                };
                notify();
                showToast(`Export of @${displayName} failed`, Toasts.Type.FAILURE);
            }
        } finally {
            earlyFinishFlags.delete(options.user.id);
            setTimeout(() => {
                const current = jobs.get(options.user.id);
                if (current && (current.progress.status === "done" || current.progress.status === "error")) {
                    jobs.delete(options.user.id);
                    notify();
                }
            }, 5000);
        }
    })();
}
