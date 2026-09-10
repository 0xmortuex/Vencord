/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Embed, MessageAttachment, MessageReaction } from "@vencord/discord-types";
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
    attachments: MessageAttachment[];
    embeds: Embed[];
    reactions: MessageReaction[];
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

// Abort-aware sleep: resolves immediately when the export is cancelled so a
// pending backoff never keeps a dead job running.
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

// Discord snowflakes encode a timestamp; seeding `before` from the end date
// starts pagination exactly at the bound instead of scanning (and discarding)
// every newer message in the channel first.
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

const MAX_CONSECUTIVE_429S = 10;

type CheckpointCallback = (lastMessageId: string | null, fetchedSoFar: number) => void;

// How long to wait before the next page. Uses Discord's rate-limit headers so a
// fetch with budget left in its bucket goes straight to the next 100-message
// page (pages are sequential - each needs the previous one's last id - so the
// round trip itself is the only pacing needed), while a fetch that has used up
// the bucket waits exactly until it resets. Falls back to a fixed delay if the
// headers aren't available.
function rateLimitDelay(res: any): number {
    try {
        const h = res?.headers;
        const get = (k: string) => (typeof h?.get === "function" ? h.get(k) : h?.[k]);
        const remaining = Number(get("x-ratelimit-remaining"));
        const resetAfter = Number(get("x-ratelimit-reset-after"));
        if (Number.isFinite(remaining)) {
            if (remaining > 0) return 0;
            if (Number.isFinite(resetAfter) && resetAfter > 0) return Math.min(10_000, Math.ceil(resetAfter * 1000) + 50);
            return 1000;
        }
    } catch { }
    return 300;
}

export async function fetchMessages(
    options: ExportOptions,
    onProgress: ProgressCallback,
    signal: AbortSignal,
    earlyFinishCheck?: () => boolean,
    onCheckpoint?: CheckpointCallback,
): Promise<ExportedMessage[]> {
    const messages: ExportedMessage[] = [];
    let done = false;
    let lastCheckpointCount = 0;
    let consecutive429s = 0;
    const limit = options.messageLimit;

    const startBound = options.startDate ? new Date(options.startDate) : null;
    const endBound = options.endDate ? endDateBound(options.endDate) : null;

    // Start paging directly at the end bound instead of at the newest message -
    // otherwise every message newer than endDate is fetched just to be discarded.
    let beforeId: string | undefined = endBound ? dateToSnowflake(endBound) : undefined;

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
            consecutive429s = 0;
        } catch (e: any) {
            if (e?.status === 429) {
                if (++consecutive429s >= MAX_CONSECUTIVE_429S) {
                    onProgress({
                        fetched: messages.length,
                        total: limit,
                        status: "error",
                        error: "Rate limited too many times in a row"
                    });
                    throw e;
                }
                // Honor the server's retry_after but grow the wait on repeated
                // 429s - a tiny/zero retry_after must not hot-loop requests.
                const retryAfter = Number(e?.body?.retry_after ?? e?.headers?.get?.("retry-after") ?? 2);
                const backoff = Math.min(60_000, Math.max(retryAfter * 1000, 1000 * 2 ** (consecutive429s - 1)));
                await pause(backoff, signal);
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

            // Date filtering (endBound is mostly enforced by the seeded
            // `before` id already; this catches clock-skewed stragglers)
            if (startBound || endBound) {
                const msgDate = new Date(msg.timestamp);
                if (startBound && msgDate < startBound) {
                    done = true;
                    break;
                }
                if (endBound && msgDate >= endBound) continue;
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

        // Only delay if we got a full batch (more messages likely exist), and
        // only as long as the rate-limit headers say we must.
        if (!done && batch.length === 100) {
            const delay = rateLimitDelay(res);
            if (delay > 0) await pause(delay, signal);
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
