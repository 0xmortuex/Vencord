/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { saveFile } from "@utils/web";
import { showToast, Toasts } from "@webpack/common";

import {
    CheckpointChannel,
    CheckpointData,
    deleteCheckpoint,
    generateJobId,
    InProgressChannel,
    loadCheckpoint,
    saveCheckpoint,
} from "./checkpoint";
import { ExportOptions, ExportProgress, fetchMessages } from "./exporter";
import { renderHtml } from "./htmlRenderer";

export interface ExportJob {
    id: string;
    label: string;
    progress: ExportProgress;
    abortController: AbortController;
    saveProgress?: () => void;
}

export interface ServerExportJob {
    id: string;
    label: string;
    progress: ExportProgress;
    currentChannel: string;
    channelsDone: number;
    totalChannels: number;
    abortController: AbortController;
    saveProgress?: () => void;
}

type Listener = () => void;

const channelJobs = new Map<string, ExportJob>();
const serverJobs = new Map<string, ServerExportJob>();
const earlyFinishFlags = new Map<string, boolean>();
const listeners = new Set<Listener>();

function notify() {
    for (const fn of listeners) fn();
}

export function subscribe(fn: Listener): () => void {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
}

export function getChannelJob(channelId: string): ExportJob | undefined {
    return channelJobs.get(channelId);
}

export function getServerJob(guildId: string): ServerExportJob | undefined {
    return serverJobs.get(guildId);
}

export function cancelChannelJob(channelId: string) {
    const job = channelJobs.get(channelId);
    if (job) {
        job.abortController.abort();
        channelJobs.delete(channelId);
        notify();
    }
}

export function cancelServerJob(guildId: string) {
    const job = serverJobs.get(guildId);
    if (job) {
        job.abortController.abort();
        serverJobs.delete(guildId);
        earlyFinishFlags.delete(guildId);
        notify();
    }
}

export function saveChannelProgress(channelId: string) {
    channelJobs.get(channelId)?.saveProgress?.();
}

export function saveServerProgress(guildId: string) {
    serverJobs.get(guildId)?.saveProgress?.();
}

export function requestEarlyFinish(guildId: string) {
    if (!serverJobs.has(guildId)) return;
    earlyFinishFlags.set(guildId, true);
    notify();
}

export function isEarlyFinishRequested(guildId: string): boolean {
    return earlyFinishFlags.get(guildId) === true;
}

// Persist a checkpoint for a single-channel export. A single channel's file is
// only written once it has fully fetched, so "resume" here means cleanly
// restarting the fetch - the checkpoint exists so the modal can offer that and
// show how far the previous attempt got.
function buildChannelCheckpoint(
    options: ExportOptions,
    channelName: string,
    serverName: string,
    startedAt: string,
    inProgress: InProgressChannel | null,
    totalMessagesProcessed: number,
): CheckpointData {
    return {
        version: 1,
        jobId: generateJobId("channel", options.channelId),
        type: "channel",
        targetId: options.channelId,
        targetName: channelName,
        format: options.format,
        messageLimit: options.messageLimit,
        combineFiles: false,
        startDate: options.startDate,
        endDate: options.endDate,
        channelsRequested: [{ id: options.channelId, name: channelName, guildId: "", guildName: serverName }],
        channelsCompleted: [],
        inProgressChannel: inProgress,
        startedAt,
        lastCheckpointAt: startedAt,
        totalMessagesProcessed,
    };
}

export function startChannelExport(
    options: ExportOptions,
    channelName: string,
    serverName: string,
) {
    if (channelJobs.has(options.channelId)) return;

    const jobId = generateJobId("channel", options.channelId);
    const startedAt = new Date().toISOString();
    const controller = new AbortController();
    const job: ExportJob = {
        id: options.channelId,
        label: `#${channelName}`,
        progress: { fetched: 0, total: options.messageLimit, status: "fetching" },
        abortController: controller,
    };
    channelJobs.set(options.channelId, job);
    notify();

    // Initial checkpoint so closing/crashing mid-fetch leaves a resumable record.
    saveCheckpoint(jobId, buildChannelCheckpoint(options, channelName, serverName, startedAt, null, 0));

    const onProgress = (p: ExportProgress) => {
        job.progress = p;
        notify();
    };

    let latestInProgress: InProgressChannel | null = null;
    const onCheckpoint = (lastMessageId: string | null, fetchedSoFar: number) => {
        latestInProgress = { id: options.channelId, name: channelName, lastMessageId, fetchedSoFar };
        saveCheckpoint(jobId, buildChannelCheckpoint(
            options, channelName, serverName, startedAt, latestInProgress, fetchedSoFar,
        ));
    };

    // Lets the modal's "Save Progress" button force a checkpoint write on demand.
    job.saveProgress = () => saveCheckpoint(jobId, buildChannelCheckpoint(
        options, channelName, serverName, startedAt, latestInProgress,
        latestInProgress?.fetchedSoFar ?? job.progress.fetched,
    ));

    (async () => {
        try {
            const messages = await fetchMessages(options, onProgress, controller.signal, undefined, onCheckpoint);
            if (controller.signal.aborted) return;

            job.progress = { fetched: messages.length, total: options.messageLimit, status: "rendering" };
            notify();

            const safeName = (serverName + "-" + channelName).replace(/[^a-zA-Z0-9-_]/g, "_");
            const date = new Date().toISOString().split("T")[0];
            const filename = `${safeName}-${date}`;

            if (options.format === "json") {
                saveFile(new File([JSON.stringify(messages, null, 2)], filename + ".json", { type: "application/json" }));
            } else {
                const html = renderHtml(messages, channelName, serverName);
                saveFile(new File([html], filename + ".html", { type: "text/html" }));
            }

            // Export finished and the file is on disk - no reason to keep the checkpoint.
            deleteCheckpoint(jobId);

            job.progress = { fetched: messages.length, total: options.messageLimit, status: "done" };
            notify();
            showToast(`Export of #${channelName} complete (${messages.length} messages)`, Toasts.Type.SUCCESS);
        } catch (e: any) {
            if (!controller.signal.aborted) {
                job.progress = {
                    fetched: job.progress.fetched,
                    total: job.progress.total,
                    status: "error",
                    error: e?.message ?? "Unknown error"
                };
                notify();
                showToast(`Export of #${channelName} failed`, Toasts.Type.FAILURE);
            }
        } finally {
            // Clean up finished jobs after a short delay so the modal can still read final state
            setTimeout(() => {
                if (job.progress.status === "done" || job.progress.status === "error") {
                    channelJobs.delete(options.channelId);
                    notify();
                }
            }, 5000);
        }
    })();
}

interface ServerExportParams {
    guildId: string;
    guildName: string;
    channels: Array<{ id: string; name: string; }>;
    format: "html" | "json";
    messageLimit: number | null;
    combineFiles: boolean;
    /** When set (bulk "one file for everything"), the whole server is built into one
     * string and handed back here INSTEAD of being saved, so the caller can merge every
     * server into a single file. */
    onCombinedContent?: (guildName: string, content: string, format: "html" | "json") => void;
    /** Only export messages newer than this (ISO date/time). Used by AutoExport's incremental runs. */
    startDate?: string | null;
    resumeFromCheckpoint?: boolean;
}

export function startServerExport(params: ServerExportParams) {
    if (serverJobs.has(params.guildId)) return;

    const jobId = generateJobId("server", params.guildId);

    // When resuming, the checkpoint is the source of truth for the job config so
    // the resumed export matches the one that was interrupted (not the current
    // state of the modal's form).
    const checkpoint = params.resumeFromCheckpoint ? loadCheckpoint(jobId) : null;

    const { guildId } = params;
    const { guildName } = params;
    const channels: Array<{ id: string; name: string; }> = checkpoint
        ? checkpoint.channelsRequested.map(c => ({ id: c.id, name: c.name }))
        : params.channels;
    const format = checkpoint ? checkpoint.format : params.format;
    const messageLimit = checkpoint ? checkpoint.messageLimit : params.messageLimit;
    const combineFiles = checkpoint ? checkpoint.combineFiles : params.combineFiles;
    const startDate = checkpoint ? checkpoint.startDate : (params.startDate ?? null);
    const { onCombinedContent } = params;

    // Checkpoints only make sense when each channel is saved to disk as it
    // finishes. With combineFiles the messages are held in memory and written in
    // one shot at the end, so a partial run can't be resumed - skip persistence.
    const checkpointEnabled = !combineFiles;
    const startedAt = checkpoint ? checkpoint.startedAt : new Date().toISOString();
    const completedSet = new Set<string>(checkpoint ? checkpoint.channelsCompleted : []);
    const channelsRequested: CheckpointChannel[] = channels.map(c => ({
        id: c.id, name: c.name, guildId, guildName,
    }));

    const controller = new AbortController();
    const job: ServerExportJob = {
        id: guildId,
        label: guildName,
        progress: { fetched: 0, total: null, status: "fetching" },
        currentChannel: "",
        channelsDone: completedSet.size,
        totalChannels: channels.length,
        abortController: controller,
    };
    serverJobs.set(guildId, job);
    notify();

    (async () => {
        const date = new Date().toISOString().split("T")[0];
        const safeName = guildName.replace(/[^a-zA-Z0-9-_]/g, "_");

        // When combineFiles is false, entries are saved to disk as they finish and
        // their `messages` is set to null so GC can reclaim the memory.
        const allExports: Array<{ channelName: string; messages: any[] | null; }> = [];
        const channelsCompleted: string[] = [...completedSet];
        const failedChannels: string[] = [];
        let totalMessageCount = checkpoint ? checkpoint.totalMessagesProcessed : 0;
        const CONCURRENCY = 3;
        let earlyFinished = false;

        // Channels already saved to disk in a previous session are skipped entirely.
        const channelsToProcess = channels.filter(c => !completedSet.has(c.id));

        const persistCheckpoint = (inProgress: InProgressChannel | null) => {
            if (!checkpointEnabled) return;
            saveCheckpoint(jobId, {
                version: 1,
                jobId,
                type: "server",
                targetId: guildId,
                targetName: guildName,
                format,
                messageLimit,
                combineFiles,
                startDate,
                endDate: null,
                channelsRequested,
                channelsCompleted,
                inProgressChannel: inProgress,
                startedAt,
                lastCheckpointAt: startedAt,
                totalMessagesProcessed: totalMessageCount,
            });
        };

        // Write the initial checkpoint up front so an interruption before the first
        // channel finishes still leaves a resumable record.
        persistCheckpoint(null);

        // Lets the modal's "Save Progress" button force a checkpoint write on demand.
        let latestInProgress: InProgressChannel | null = null;
        job.saveProgress = () => persistCheckpoint(latestInProgress);

        const saveChannelToDisk = (channelName: string, messages: any[]) => {
            const chSafe = channelName.replace(/[^a-zA-Z0-9-_]/g, "_");
            const ext = format === "json" ? "json" : "html";
            const mime = format === "json" ? "application/json" : "text/html";
            const filename = `${safeName}-${chSafe}-${date}.${ext}`;
            const content = format === "json"
                ? JSON.stringify(messages, null, 2)
                : renderHtml(messages, channelName, guildName);
            saveFile(new File([content], filename, { type: mime }));
            console.log(`[ChatExporter] Saved channel ${channelName}: ${messages.length} messages`);
        };

        // Process channels in parallel batches of CONCURRENCY
        for (let i = 0; i < channelsToProcess.length; i += CONCURRENCY) {
            if (controller.signal.aborted) break;
            if (earlyFinishFlags.get(guildId)) {
                earlyFinished = true;
                break;
            }

            const batch = channelsToProcess.slice(i, i + CONCURRENCY);
            const activeNames = batch.map(c => c.name).join(", ");
            job.currentChannel = activeNames;
            notify();

            const results = await Promise.allSettled(
                batch.map(ch => {
                    const options: ExportOptions = {
                        channelId: ch.id,
                        format,
                        messageLimit,
                        includeImages: true,
                        includeEmbeds: true,
                        includeReactions: true,
                        includePins: true,
                        startDate,
                        endDate: null,
                    };
                    return fetchMessages(
                        options,
                        p => { job.progress = p; notify(); },
                        controller.signal,
                        () => earlyFinishFlags.get(guildId) === true,
                        (lastMessageId, fetchedSoFar) => {
                            // Best-effort display of the most recently reporting channel.
                            latestInProgress = { id: ch.id, name: ch.name, lastMessageId, fetchedSoFar };
                            persistCheckpoint(latestInProgress);
                        },
                    ).then(messages => ({ channelId: ch.id, channelName: ch.name, messages }));
                })
            );

            for (let j = 0; j < results.length; j++) {
                const result = results[j];
                if (result.status !== "fulfilled") {
                    // Surface failures (403s, persistent API errors) instead of
                    // silently exporting an incomplete server.
                    const ch = batch[j];
                    console.error(`[ChatExporter] Failed to fetch #${ch.name}:`, result.reason);
                    showToast(`Failed to export #${ch.name}: ${(result.reason as any)?.message ?? "unknown error"}`, Toasts.Type.FAILURE);
                    failedChannels.push(ch.name);
                    continue;
                }
                const exp = result.value;
                totalMessageCount += exp.messages.length;

                if (combineFiles) {
                    allExports.push({ channelName: exp.channelName, messages: exp.messages });
                } else {
                    try {
                        saveChannelToDisk(exp.channelName, exp.messages);
                        // Only record completion once the file is safely on disk.
                        channelsCompleted.push(exp.channelId);
                    } catch (e: any) {
                        console.error(`[ChatExporter] Failed to save channel ${exp.channelName}:`, e);
                        showToast(`Failed to save #${exp.channelName}: ${e?.message ?? "unknown error"}`, Toasts.Type.FAILURE);
                    }
                    // Release memory: keep accounting entry but drop messages
                    allExports.push({ channelName: exp.channelName, messages: null });
                }
            }

            job.channelsDone = completedSet.size + Math.min(i + CONCURRENCY, channelsToProcess.length);
            notify();

            // Checkpoint after each batch finishes and is on disk.
            persistCheckpoint(null);

            if (earlyFinishFlags.get(guildId)) {
                earlyFinished = true;
                break;
            }
        }

        if (controller.signal.aborted) {
            serverJobs.delete(guildId);
            earlyFinishFlags.delete(guildId);
            notify();
            return;
        }

        job.progress = { fetched: 0, total: null, status: "rendering" };
        notify();

        if (combineFiles) {
            const bytesPerMsg = format === "json" ? 1500 : 2500;
            const estimatedBytes = totalMessageCount * bytesPerMsg;
            const MAX_COMBINED_BYTES = 1500 * 1024 * 1024; // ~1.5 GB estimate; the real file is far smaller (2500 B/msg is very pessimistic)
            let useCombined = true;

            if (!onCombinedContent && estimatedBytes > MAX_COMBINED_BYTES) {
                const sizeMB = Math.round(estimatedBytes / (1024 * 1024));
                showToast(
                    `Export too large to combine (${sizeMB} MB estimated). Falling back to per-channel files.`,
                    Toasts.Type.MESSAGE,
                );
                useCombined = false;
            }

            if (useCombined) {
                try {
                    let content: string;
                    if (format === "json") {
                        const combined: Record<string, any[]> = {};
                        for (const exp of allExports) {
                            if (exp.messages) combined[exp.channelName] = exp.messages;
                        }
                        content = JSON.stringify(combined, null, 2);
                    } else {
                        const parts: string[] = [];
                        for (const exp of allExports) {
                            if (!exp.messages) continue;
                            parts.push(renderHtml(exp.messages, exp.channelName, guildName));
                        }
                        content = parts.join("\n\n");
                    }
                    if (onCombinedContent) {
                        // Bulk "one file for everything": hand this server’s whole
                        // content back to the caller to merge, instead of saving it here.
                        onCombinedContent(guildName, content, format);
                    } else {
                        const ext = format === "json" ? "json" : "html";
                        const mime = format === "json" ? "application/json" : "text/html";
                        saveFile(new File([content], `${safeName}-${date}.${ext}`, { type: mime }));
                    }
                    // Free memory only after the combined file has been handed off
                    for (const exp of allExports) exp.messages = null;
                } catch (e: any) {
                    if (e instanceof RangeError) {
                        if (onCombinedContent) {
                            // Too large to merge into the single "everything" file — save
                            // this one server on its own (per channel) so it isn't lost.
                            showToast(
                                `${guildName} is too large to merge — saved as its own files.`,
                                Toasts.Type.MESSAGE,
                            );
                            for (const exp of allExports) {
                                if (exp.messages) { try { saveChannelToDisk(exp.channelName, exp.messages); } catch {} }
                                exp.messages = null;
                            }
                            // handled here — leave useCombined true so the per-channel
                            // block below doesn't run again
                        } else {
                            showToast(
                                "Export too large for single file. Falling back to per-channel files.",
                                Toasts.Type.FAILURE,
                            );
                            useCombined = false;
                        }
                    } else {
                        throw e;
                    }
                }
            }

            if (!useCombined) {
                // Fall back to per-channel save with whatever is still in memory
                for (const exp of allExports) {
                    if (!exp.messages) continue;
                    try {
                        saveChannelToDisk(exp.channelName, exp.messages);
                    } catch (e: any) {
                        console.error(`[ChatExporter] Failed to save channel ${exp.channelName}:`, e);
                    }
                    exp.messages = null;
                }
            }
        }

        // A full run consumed every requested channel - drop the checkpoint. An
        // early finish leaves it in place so the user can resume the remaining
        // channels later.
        if (!earlyFinished) deleteCheckpoint(jobId);

        job.progress = { fetched: 0, total: null, status: "done" };
        notify();
        const completionLabel = earlyFinished
            ? `(stopped early, ${job.channelsDone}/${channels.length} channels)`
            : `(${channels.length - failedChannels.length}/${channels.length} channels)`;
        showToast(
            `Server export of ${guildName} complete ${completionLabel}` +
            (failedChannels.length ? ` — ${failedChannels.length} failed: ${failedChannels.join(", ")}` : ""),
            failedChannels.length ? Toasts.Type.MESSAGE : Toasts.Type.SUCCESS,
        );

        setTimeout(() => {
            if (job.progress.status === "done" || job.progress.status === "error") {
                serverJobs.delete(guildId);
                earlyFinishFlags.delete(guildId);
                notify();
            }
        }, 5000);
    })();
}
