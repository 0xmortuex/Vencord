/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Constants, RestAPI } from "@webpack/common";

export interface ExportedMessage {
    id: string;
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
    pinned: boolean;
    type: number;
}

export interface ExportOptions {
    channelId: string;
    format: "html" | "json";
    messageLimit: number | null; // null = all
    includeImages: boolean;
    includeEmbeds: boolean;
    includeReactions: boolean;
    includePins: boolean;
    startDate: string | null;
    endDate: string | null;
}

export interface ExportProgress {
    fetched: number;
    total: number | null;
    status: "fetching" | "rendering" | "done" | "cancelled" | "error";
    error?: string;
}

type ProgressCallback = (progress: ExportProgress) => void;

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

type CheckpointCallback = (lastMessageId: string | null, fetchedSoFar: number) => void;

export async function fetchMessages(
    options: ExportOptions,
    onProgress: ProgressCallback,
    signal: AbortSignal,
    earlyFinishCheck?: () => boolean,
    onCheckpoint?: CheckpointCallback,
): Promise<ExportedMessage[]> {
    const messages: ExportedMessage[] = [];
    let beforeId: string | undefined;
    let done = false;
    let lastCheckpointCount = 0;
    const limit = options.messageLimit;

    while (!done) {
        if (signal.aborted) {
            onProgress({ fetched: messages.length, total: limit, status: "cancelled" });
            return messages;
        }
        if (earlyFinishCheck?.()) {
            done = true;
            break;
        }

        const query: Record<string, any> = { limit: 100 };
        if (beforeId) query.before = beforeId;

        let res: any;
        try {
            res = await RestAPI.get({
                url: Constants.Endpoints.MESSAGES(options.channelId),
                query,
                retries: 2
            });
        } catch (e: any) {
            if (e?.status === 429) {
                const retryAfter = e?.body?.retry_after ?? e?.headers?.get?.("retry-after") ?? 2;
                await delay(Number(retryAfter) * 1000);
                continue;
            }
            onProgress({
                fetched: messages.length,
                total: limit,
                status: "error",
                error: `API error: ${e?.status ?? "unknown"}`
            });
            throw e;
        }

        const batch: any[] = res?.body ?? [];
        if (batch.length === 0) {
            done = true;
            break;
        }

        for (const msg of batch) {
            if (signal.aborted) {
                onProgress({ fetched: messages.length, total: limit, status: "cancelled" });
                return messages;
            }
            if (earlyFinishCheck?.()) {
                done = true;
                break;
            }

            // Date filtering
            if (options.startDate) {
                const msgDate = new Date(msg.timestamp);
                if (msgDate < new Date(options.startDate)) {
                    done = true;
                    break;
                }
            }
            if (options.endDate) {
                const msgDate = new Date(msg.timestamp);
                if (msgDate > new Date(options.endDate)) continue;
            }

            const exported: ExportedMessage = {
                id: msg.id,
                content: msg.content,
                author: {
                    id: msg.author.id,
                    username: msg.author.username,
                    globalName: msg.author.global_name ?? null,
                    avatar: msg.author.avatar,
                    bot: msg.author.bot ?? false,
                },
                timestamp: msg.timestamp,
                edited_timestamp: msg.edited_timestamp,
                attachments: options.includeImages ? (msg.attachments ?? []) : [],
                embeds: options.includeEmbeds ? (msg.embeds ?? []) : [],
                reactions: options.includeReactions ? (msg.reactions ?? []) : [],
                pinned: msg.pinned ?? false,
                type: msg.type,
            };

            if (!options.includePins && msg.pinned) {
                exported.pinned = false;
            }

            messages.push(exported);

            if (limit && messages.length >= limit) {
                done = true;
                break;
            }
        }

        beforeId = batch[batch.length - 1].id;

        onProgress({
            fetched: messages.length,
            total: limit,
            status: "fetching"
        });

        // Persist progress metadata every ~1000 messages so a long-running
        // channel can report how far it got before an interruption.
        if (onCheckpoint && messages.length - lastCheckpointCount >= 1000) {
            lastCheckpointCount = messages.length;
            onCheckpoint(beforeId ?? null, messages.length);
        }

        // Only delay if we got a full batch (more messages likely exist)
        if (!done && batch.length === 100) {
            await delay(300);
        }
    }

    // Messages are fetched newest-first, reverse to chronological order
    messages.reverse();

    onProgress({
        fetched: messages.length,
        total: limit,
        status: "rendering"
    });

    return messages;
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
