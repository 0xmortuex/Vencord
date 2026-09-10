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
import { MAX_SEARCH_OFFSET, SEARCH_PAGE_SIZE, searchAuthorMessages } from "@plugins/chatExporter/guildSearch";
import { saveFile } from "@utils/web";
import type { Embed, MessageAttachment, MessageReaction } from "@vencord/discord-types";
import { ChannelStore, showToast, Toasts } from "@webpack/common";

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

// Concurrency. Each guild has its own search rate-limit bucket, so guilds are
// searched side by side; within a guild the shared bucket limiter in guildSearch
// decides how many of these requests may actually be in flight at once.
const GUILD_CONCURRENCY = 3;
const CHANNEL_CONCURRENCY = 2;
const PAGE_CONCURRENCY = 3;

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

interface DateBounds {
    startBound: Date | null;
    endBound: Date | null;
}

function dateBoundsOf(options: ExportOptions): DateBounds {
    return {
        startBound: options.startDate ? new Date(options.startDate) : null,
        endBound: options.endDate ? endDateBound(options.endDate) : null,
    };
}

function inRange(msg: any, { startBound, endBound }: DateBounds): boolean {
    if (!startBound && !endBound) return true;
    const msgDate = new Date(msg.timestamp);
    if (startBound && msgDate < startBound) return false;
    if (endBound && msgDate >= endBound) return false;
    return true;
}

function toExported(msg: any, channelId: string, options: ExportOptions): ExportedMessage {
    return {
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
    };
}

async function fetchChannelMessages(
    guildId: string,
    channelId: string,
    userId: string,
    options: ExportOptions,
    onPageProgress: (found: number) => void,
    signal: AbortSignal,
    shouldStop: () => boolean,
): Promise<ExportedMessage[]> {
    const bounds = dateBoundsOf(options);
    const { hits } = await searchAuthorMessages({
        guildId,
        authorId: userId,
        channelId,
        minId: bounds.startBound ? dateToSnowflake(bounds.startBound) : undefined,
        maxId: bounds.endBound ? dateToSnowflake(bounds.endBound) : undefined,
        limit: options.messageLimit,
        concurrency: PAGE_CONCURRENCY,
        signal,
        shouldStop,
        onProgress: onPageProgress,
    });
    const collected = hits.filter(msg => inRange(msg, bounds)).map(msg => toExported(msg, channelId, options));
    return options.messageLimit ? collected.slice(0, options.messageLimit) : collected;
}

export interface ExportedChannelData {
    channelId: string;
    channelName: string;
    guildId: string;
    guildName: string;
    messages: ExportedMessage[];
}

// Run `fn` over every index 0..count-1 with at most `width` running at once.
async function runPool(count: number, width: number, fn: (index: number) => Promise<void>): Promise<void> {
    let next = 0;
    const worker = async () => {
        while (next < count) await fn(next++);
    };
    await Promise.all(Array.from({ length: Math.min(width, count) }, worker));
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
        const userId = options.user.id;
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
            const shouldStop = () => controller.signal.aborted || earlyFinishFlags.get(userId) === true;
            const bounds = dateBoundsOf(effectiveOptions);
            const minId = bounds.startBound ? dateToSnowflake(bounds.startBound) : undefined;
            const maxId = bounds.endBound ? dateToSnowflake(bounds.endBound) : undefined;

            // Results are kept in the requested channel order regardless of which
            // guild/channel finishes first, so the export file reads the same as
            // a sequential run would.
            const results: Array<ExportedChannelData | null> = channels.map(() => null);
            let channelsDone = 0;

            // Progress counters for channels still in flight, keyed by channel index.
            const inFlightFound = new Map<number, number>();
            const publishProgress = () => {
                let found = 0;
                for (const n of inFlightFound.values()) found += n;
                job.progress = { ...job.progress, totalMessages: totalMessages + found };
                notify();
            };

            const finishChannel = (index: number, ch: ChannelSelection, messages: ExportedMessage[]) => {
                inFlightFound.delete(index);
                totalMessages += messages.length;
                if (messages.length) {
                    results[index] = {
                        channelId: ch.id,
                        channelName: ch.name,
                        guildId: ch.guildId,
                        guildName: ch.guildName,
                        messages,
                    };
                }
                // Record the channel as done and checkpoint. The in-progress marker
                // is only kept if it points at a channel that is still running.
                channelsCompleted.push(ch.id);
                if (latestInProgress?.id === ch.id) latestInProgress = null;
                channelsDone++;
                job.progress = { ...job.progress, channelsDone };
                publishProgress();
                persistCheckpoint(latestInProgress);
            };

            const onChannelProgress = (index: number, ch: ChannelSelection) => {
                let lastCheckpointCount = 0;
                return (found: number) => {
                    inFlightFound.set(index, found);
                    publishProgress();
                    // Search is offset-based (no message cursor), so lastMessageId
                    // stays null; fetchedSoFar drives the banner. Checkpoint roughly
                    // every 1000 messages.
                    latestInProgress = { id: ch.id, name: ch.name, lastMessageId: null, fetchedSoFar: found };
                    if (found - lastCheckpointCount >= 1000) {
                        lastCheckpointCount = found;
                        persistCheckpoint(latestInProgress);
                    }
                };
            };

            // Group the requested channels by guild, keeping first-seen order.
            interface GuildWork { guildId: string; guildName: string; entries: Array<{ index: number; ch: ChannelSelection; }>; }
            const guilds: GuildWork[] = [];
            const byGuild = new Map<string, GuildWork>();
            channels.forEach((ch, index) => {
                let g = byGuild.get(ch.guildId);
                if (!g) {
                    g = { guildId: ch.guildId, guildName: ch.guildName, entries: [] };
                    byGuild.set(ch.guildId, g);
                    guilds.push(g);
                }
                g.entries.push({ index, ch });
            });

            const runGuild = async (g: GuildWork) => {
                if (shouldStop()) return;
                job.progress = { ...job.progress, currentGuild: g.guildName, currentChannel: g.entries[0].ch.name };
                notify();

                const selected = new Map<string, number>(); // channel id -> index into `channels`
                for (const { index, ch } of g.entries) selected.set(ch.id, index);

                // One guild-wide page first. Its total_results tells us whether this
                // user has anything here at all (zero => every selected channel is
                // empty, skip them all - the common case when exporting across every
                // mutual server) and, when the total is small, lets the whole guild
                // be paged once instead of once per channel.
                let mode: "empty" | "guild" | "perChannel" = "perChannel";
                const probe = await searchAuthorMessages({
                    guildId: g.guildId,
                    authorId: userId,
                    minId,
                    maxId,
                    limit: null,
                    concurrency: PAGE_CONCURRENCY,
                    signal: controller.signal,
                    shouldStop,
                    onProgress: found => {
                        // Attribute the running count to the guild's first channel until
                        // the hits are split by channel below.
                        inFlightFound.set(g.entries[0].index, found);
                        publishProgress();
                    },
                    onFirstPage: total => {
                        if (total === 0) {
                            mode = "empty";
                            return false;
                        }
                        // Guild-wide paging is worth it when it needs no more requests than
                        // the one-per-channel minimum, and nothing is lost to the offset cap.
                        const pages = Math.ceil(total / SEARCH_PAGE_SIZE);
                        if (total <= MAX_SEARCH_OFFSET && pages <= g.entries.length) {
                            mode = "guild";
                            return true;
                        }
                        return false;
                    },
                });
                // A probe that fits in one page never reaches onFirstPage; it is a
                // complete guild-wide result too.
                if (mode === "perChannel" && probe.hits.length && probe.hits.length >= probe.total) mode = "guild";
                if (probe.total === 0 && !probe.hits.length) mode = "empty";
                inFlightFound.delete(g.entries[0].index);
                // Cancelled or finishing early: leave these channels unfinished so the
                // checkpoint keeps them.
                if (shouldStop()) return;

                if (mode === "empty") {
                    for (const { index, ch } of g.entries) finishChannel(index, ch, []);
                    return;
                }

                if (mode === "guild") {
                    // Split the guild-wide hits into the selected channels. Thread
                    // messages count towards their parent channel.
                    const perChannel = new Map<number, ExportedMessage[]>();
                    for (const msg of probe.hits) {
                        if (!inRange(msg, bounds)) continue;
                        let index = selected.get(msg.channel_id);
                        if (index === undefined) {
                            const parentId = ChannelStore.getChannel(msg.channel_id)?.parent_id;
                            if (parentId) index = selected.get(parentId);
                        }
                        if (index === undefined) continue;
                        let list = perChannel.get(index);
                        if (!list) {
                            list = [];
                            perChannel.set(index, list);
                        }
                        if (effectiveOptions.messageLimit && list.length >= effectiveOptions.messageLimit) continue;
                        list.push(toExported(msg, channels[index].id, effectiveOptions));
                    }
                    for (const { index, ch } of g.entries) finishChannel(index, ch, perChannel.get(index) ?? []);
                    return;
                }

                await runPool(g.entries.length, CHANNEL_CONCURRENCY, async i => {
                    if (shouldStop()) return;
                    const { index, ch } = g.entries[i];
                    job.progress = { ...job.progress, status: "fetching", currentGuild: ch.guildName, currentChannel: ch.name };
                    notify();

                    let channelMessages: ExportedMessage[] = [];
                    try {
                        channelMessages = await fetchChannelMessages(
                            ch.guildId,
                            ch.id,
                            userId,
                            effectiveOptions,
                            onChannelProgress(index, ch),
                            controller.signal,
                            shouldStop,
                        );
                    } catch (e: any) {
                        // Skip this channel on unrecoverable errors but keep going
                        channelMessages = [];
                    }
                    finishChannel(index, ch, channelMessages);
                });
            };

            await runPool(guilds.length, GUILD_CONCURRENCY, i => runGuild(guilds[i]));

            if (controller.signal.aborted) {
                jobs.delete(options.user.id);
                earlyFinishFlags.delete(options.user.id);
                notify();
                return;
            }

            const earlyFinished = earlyFinishFlags.get(userId) === true && channelsDone < channels.length;
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

            const exported = results.filter((r): r is ExportedChannelData => r !== null);
            const guildCount = new Set(exported.map(r => r.guildId)).size;

            if (effectiveOptions.format === "json") {
                const byGuildOut = new Map<string, { name: string; id: string; channels: ExportedChannelData[]; }>();
                for (const r of exported) {
                    if (!byGuildOut.has(r.guildId)) {
                        byGuildOut.set(r.guildId, { id: r.guildId, name: r.guildName, channels: [] });
                    }
                    byGuildOut.get(r.guildId)!.channels.push(r);
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
                    servers: Array.from(byGuildOut.values()).map(g => ({
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
                const html = renderHtml(options.user, exported, totalMessages, guildCount);
                saveFile(new File([html], filename + ".html", { type: "text/html" }));
            }

            // A full run consumed every requested channel and the combined file is
            // on disk - drop the checkpoint. An early finish leaves it in place so
            // the user can re-run the full set later.
            if (!earlyFinished) deleteCheckpoint(jobId);

            job.progress = { ...job.progress, status: "done", totalMessages };
            notify();
            showToast(
                `Export of @${displayName} complete (${totalMessages} messages from ${exported.length} channels)`,
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
