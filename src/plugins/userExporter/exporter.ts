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
    attachments: any[];
    embeds: any[];
    reactions: any[];
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
    earlyFinishFlags.set(userId, true);
    notify();
}

// Lets the modal's "Save Progress" button force a checkpoint write on demand.
export function saveUserProgress(userId: string) {
    jobs.get(userId)?.saveProgress?.();
}

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

const SEARCH_PAGE_SIZE = 25;
const BASE_DELAY = 3500;
const ELEVATED_DELAY = 5000;
const COOLDOWN_INTERVAL = 10;
const COOLDOWN_DURATION = 10000;
const MAX_RETRIES = 5;
const MAX_SEARCH_OFFSET = 2000;
const RATE_LIMIT_THRESHOLD = 10;

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

                    const serverDelay = e?.body?.retry_after
                        ? Number(e.body.retry_after) * 1000
                        : e?.headers?.["retry-after"]
                            ? Number(e.headers["retry-after"]) * 1000
                            : 0;
                    const backoff = Math.max(serverDelay, getRetryDelay(attempt));
                    const waitSec = Math.round(backoff / 1000);
                    console.log(`UserExporter: Rate limited, waiting ${waitSec}s before retry (attempt ${attempt + 1}/${MAX_RETRIES})`);
                    await delay(backoff);
                    continue;
                }

                if (attempt === MAX_RETRIES - 1) {
                    console.log(`UserExporter: Failed after ${MAX_RETRIES} retries for channel ${channelId}, skipping`);
                    return collected;
                }

                const backoff = getRetryDelay(attempt);
                const waitSec = Math.round(backoff / 1000);
                console.log(`UserExporter: Request error, waiting ${waitSec}s before retry (attempt ${attempt + 1}/${MAX_RETRIES})`);
                await delay(backoff);
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

            if (options.startDate) {
                const msgDate = new Date(msg.timestamp);
                if (msgDate < new Date(options.startDate)) continue;
            }
            if (options.endDate) {
                const msgDate = new Date(msg.timestamp);
                if (msgDate > new Date(options.endDate)) continue;
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
        if (offset >= total) break;

        // Cooldown every 10 pages
        if (successfulPages % COOLDOWN_INTERVAL === 0) {
            console.log("UserExporter: Cooling down for 10s after 250 messages...");
            await delay(COOLDOWN_DURATION);
        }

        // Use elevated delay if too many 429s have accumulated
        const currentDelay = rateLimitState.total429s > RATE_LIMIT_THRESHOLD ? ELEVATED_DELAY : BASE_DELAY;
        await delay(currentDelay);
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

export function downloadFile(content: string, filename: string, mimeType: string) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
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
                downloadFile(JSON.stringify(json, null, 2), filename + ".json", "application/json");
            } else {
                const html = renderHtml(options.user, results, totalMessages, guildCount);
                downloadFile(html, filename + ".html", "text/html");
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
