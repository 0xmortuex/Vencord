/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Shared checkpoint store for ChatExporter and UserExporter.
//
// The expensive part of an export is the per-channel API calls. Each channel's
// file is already written to Downloads the moment that channel finishes, so a
// checkpoint only needs to remember *progress metadata* (which channels are
// done, the job config to resume with) - never the message data itself.

const CHECKPOINT_VERSION = 1;
const KEY_PREFIX = "vencord-exporter-checkpoint-";

export type CheckpointType = "server" | "channel" | "user";

export interface CheckpointChannel {
    id: string;
    name: string;
    guildId: string;
    guildName: string;
}

export interface InProgressChannel {
    id: string;
    name: string;
    lastMessageId: string | null;
    fetchedSoFar: number;
}

export interface CheckpointData {
    version: number;
    jobId: string;
    type: CheckpointType;
    targetId: string;
    targetName: string;
    format: "html" | "json";
    messageLimit: number | null;
    combineFiles: boolean;
    startDate: string | null;
    endDate: string | null;
    channelsRequested: CheckpointChannel[];
    channelsCompleted: string[]; // channel IDs that finished and saved to disk
    inProgressChannel: InProgressChannel | null;
    startedAt: string; // ISO timestamp
    lastCheckpointAt: string; // ISO timestamp
    totalMessagesProcessed: number;
}

export function generateJobId(type: CheckpointType, targetId: string): string {
    switch (type) {
        case "server":
            return `chatExporter-guild-${targetId}`;
        case "channel":
            return `chatExporter-channel-${targetId}`;
        case "user":
            return `userExporter-user-${targetId}`;
    }
}

function keyFor(jobId: string): string {
    return KEY_PREFIX + jobId;
}

export function saveCheckpoint(jobId: string, data: CheckpointData): void {
    try {
        const payload: CheckpointData = {
            ...data,
            version: CHECKPOINT_VERSION,
            jobId,
            lastCheckpointAt: new Date().toISOString(),
        };
        localStorage.setItem(keyFor(jobId), JSON.stringify(payload));
    } catch (e) {
        // localStorage may be full, disabled, or unavailable (e.g. private mode).
        console.warn("[Exporter] Failed to save checkpoint:", e);
    }
}

export function loadCheckpoint(jobId: string): CheckpointData | null {
    try {
        const raw = localStorage.getItem(keyFor(jobId));
        if (!raw) return null;

        const parsed = JSON.parse(raw) as CheckpointData;

        // Drop checkpoints written by an incompatible/older version of the schema.
        if (!parsed || parsed.version !== CHECKPOINT_VERSION) {
            console.warn(`[Exporter] Ignoring checkpoint ${jobId} with version ${parsed?.version}`);
            deleteCheckpoint(jobId);
            return null;
        }

        // Guard against a corrupted payload missing the fields we rely on.
        if (!Array.isArray(parsed.channelsRequested) || !Array.isArray(parsed.channelsCompleted)) {
            console.warn(`[Exporter] Ignoring corrupted checkpoint ${jobId}`);
            deleteCheckpoint(jobId);
            return null;
        }

        return parsed;
    } catch (e) {
        console.warn("[Exporter] Failed to load checkpoint:", e);
        return null;
    }
}

export function deleteCheckpoint(jobId: string): void {
    try {
        localStorage.removeItem(keyFor(jobId));
    } catch (e) {
        console.warn("[Exporter] Failed to delete checkpoint:", e);
    }
}

export function listCheckpoints(): CheckpointData[] {
    const out: CheckpointData[] = [];
    try {
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (!key || !key.startsWith(KEY_PREFIX)) continue;
            const jobId = key.slice(KEY_PREFIX.length);
            const cp = loadCheckpoint(jobId);
            if (cp) out.push(cp);
        }
    } catch (e) {
        console.warn("[Exporter] Failed to list checkpoints:", e);
    }
    return out;
}
