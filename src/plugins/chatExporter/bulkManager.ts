/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { sleep } from "@utils/misc";
import { saveFile } from "@utils/web";
import { ChannelStore, GuildChannelStore } from "@webpack/common";

import { cancelServerJob, getServerJob, startServerExport, subscribe } from "./exportManager";

export interface BulkTarget {
    id: string;
    name: string;
}

export interface BulkExportParams {
    targets: BulkTarget[];
    format: "html" | "json";
    messageLimit: number | null;
    /** "server" = one combined file per server; "all" = one file for every server;
     * "channel" = a separate file per channel. */
    combineMode: "server" | "all" | "channel";
    startDate?: string | null;
    endDate?: string | null;
}

export interface BulkExportJob {
    targets: BulkTarget[];
    /** 0-based index of the server currently exporting. */
    index: number;
    currentGuildId: string;
    currentName: string;
    status: "running" | "done" | "cancelled";
    /** Servers finished (completed or failed). */
    done: number;
    /** Names of servers that errored or had no exportable channels. */
    failed: string[];
    startedAt: number;
}

// Cooldown between servers so back-to-back exports don't trip Discord's burst
// limits (the per-channel fetch already paces itself; this spaces out servers).
const SERVER_COOLDOWN_MS = 4000;

let bulkJob: BulkExportJob | null = null;
const listeners = new Set<() => void>();

function notify() { for (const fn of listeners) fn(); }

export function subscribeBulk(fn: () => void): () => void {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
}

export function getBulkJob(): BulkExportJob | null {
    return bulkJob;
}

// Text/announcement channels of a guild, in the same shape ServerExportModal
// feeds startServerExport (bulk = the whole server, every text channel).
function textChannelsOf(guildId: string): BulkTarget[] {
    const guildChannels = GuildChannelStore.getChannels(guildId);
    return ((guildChannels?.SELECTABLE ?? []) as any[])
        .map(entry => {
            const ch = entry.channel ?? ChannelStore.getChannel(entry.id);
            if (!ch) return null;
            if (ch.type !== 0 && ch.type !== 5) return null;
            return { id: ch.id, name: ch.name };
        })
        .filter(Boolean) as BulkTarget[];
}

// Resolve once the single-server job for `guildId` reaches a terminal state.
// startServerExport creates the job synchronously, so we check immediately and
// then on every notify. If the job disappears before we ever saw "done"/"error"
// (user cancelled it), that's "cancelled".
function waitForServer(guildId: string): Promise<"done" | "error" | "cancelled"> {
    return new Promise(resolve => {
        let sawJob = false;
        const settle = (r: "done" | "error" | "cancelled") => { unsub(); resolve(r); };
        const check = () => {
            const job = getServerJob(guildId);
            if (job) {
                sawJob = true;
                if (job.progress.status === "done") return settle("done");
                if (job.progress.status === "error") return settle("error");
            } else if (sawJob) {
                return settle("cancelled");
            }
        };
        const unsub = subscribe(check);
        check();
    });
}

// Export several whole servers one after another. Fire-and-forget: state lives
// in bulkJob and is published via subscribeBulk so the modal can render progress
// even after it's closed and reopened.
export function startBulkExport(params: BulkExportParams) {
    if (bulkJob && bulkJob.status === "running") return;
    if (!params.targets.length) return;

    bulkJob = {
        targets: params.targets,
        index: 0,
        currentGuildId: "",
        currentName: "",
        status: "running",
        done: 0,
        failed: [],
        startedAt: Date.now(),
    };
    notify();

    (async () => {
        const combineFiles = params.combineMode !== "channel";
        // For "one file for everything": each server hands its whole content back
        // here (instead of saving), and we write a single merged file at the end.
        const merged: Array<{ name: string; content: string; }> = [];
        for (let i = 0; i < params.targets.length; i++) {
            if (!bulkJob || bulkJob.status === "cancelled") return;
            const t = params.targets[i];
            bulkJob.index = i;
            bulkJob.currentGuildId = t.id;
            bulkJob.currentName = t.name;
            notify();

            const channels = textChannelsOf(t.id);
            if (!channels.length) {
                bulkJob.failed.push(t.name);
                bulkJob.done++;
                notify();
                continue;
            }

            startServerExport({
                guildId: t.id,
                guildName: t.name,
                channels,
                format: params.format,
                messageLimit: params.messageLimit,
                combineFiles,
                startDate: params.startDate ?? null,
                endDate: params.endDate ?? null,
                onCombinedContent: params.combineMode === "all"
                    ? (guildName, content) => { merged.push({ name: guildName, content }); }
                    : undefined,
            });

            const result = await waitForServer(t.id);
            if (!bulkJob || bulkJob.status === "cancelled") return;
            if (result === "error") bulkJob.failed.push(t.name);
            bulkJob.done++;
            notify();

            if (i < params.targets.length - 1) await sleep(SERVER_COOLDOWN_MS);
        }

        // "One file for everything": merge every collected server into a single file.
        if (params.combineMode === "all" && merged.length && bulkJob && bulkJob.status !== "cancelled") {
            const stamp = new Date().toISOString().split("T")[0];
            const esc = (n: string) => n.replace(/[&<>]/g, c => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"));
            try {
                if (params.format === "json") {
                    // Nest each server's {channel: messages} under its name (no re-parse).
                    const body = merged.map(m => JSON.stringify(m.name) + ": " + m.content).join(",\n");
                    saveFile(new File(["{\n" + body + "\n}"], `all-servers-${stamp}.json`, { type: "application/json" }));
                } else {
                    const body = merged.map(m => `<h1>${esc(m.name)}</h1>\n${m.content}`).join("\n\n<hr>\n\n");
                    saveFile(new File([body], `all-servers-${stamp}.html`, { type: "text/html" }));
                }
            } catch (e) {
                // Merged file too big for one blob — save each collected server on its own
                // so nothing is lost.
                console.error("[ChatExporter] bulk all-in-one merge failed, saving per server:", e);
                for (const m of merged) {
                    try {
                        const ext = params.format === "json" ? "json" : "html";
                        const mime = params.format === "json" ? "application/json" : "text/html";
                        const safe = m.name.replace(/[^a-zA-Z0-9-_]/g, "_");
                        saveFile(new File([m.content], `${safe}-${stamp}.${ext}`, { type: mime }));
                    } catch {}
                }
            }
        }

        if (bulkJob) {
            bulkJob.status = "done";
            notify();
            setTimeout(() => {
                if (bulkJob && (bulkJob.status === "done" || bulkJob.status === "cancelled")) {
                    bulkJob = null;
                    notify();
                }
            }, 8000);
        }
    })();
}

export function cancelBulkExport() {
    if (!bulkJob) return;
    const current = bulkJob.currentGuildId;
    bulkJob.status = "cancelled";
    notify();
    if (current) cancelServerJob(current);
    bulkJob = null;
    notify();
}
