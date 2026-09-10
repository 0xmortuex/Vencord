/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { searchAuthorMessages } from "@plugins/chatExporter/guildSearch";
import { saveFile } from "@utils/web";
import type { Embed, MessageAttachment, MessageReaction } from "@vencord/discord-types";
import { ChannelStore, showToast, Toasts } from "@webpack/common";

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

// Concurrency. The search endpoint only returns 25 hits per page, so paging
// dominates the runtime: pages of one search are requested side by side, every
// selected server is searched at once (each has its own rate-limit bucket), and
// a couple of members overlap so a member with no messages costs one round trip
// instead of a full stop. The shared bucket limiter in guildSearch decides how
// many of these requests may actually be in flight per server.
const MEMBER_CONCURRENCY = 2;
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

// Search a single guild for one author's messages (no channel_id => all channels).
// `primaryGuildId` keys the abort/early-finish flags; `searchGuild` is the guild
// actually being searched.
async function searchGuildForAuthor(
    searchGuild: { id: string; name: string; },
    primaryGuildId: string,
    userId: string,
    options: ExportOptions,
    onPageProgress: (found: number) => void,
    signal: AbortSignal,
): Promise<ExportedMessage[]> {
    const limit = options.messageLimit;
    const startBound = options.startDate ? new Date(options.startDate) : null;
    const endBound = options.endDate ? endDateBound(options.endDate) : null;

    const { hits } = await searchAuthorMessages({
        guildId: searchGuild.id,
        authorId: userId,
        // Bound the search by date server-side so we don't page through (and then
        // discard) messages outside the requested range.
        minId: startBound ? dateToSnowflake(startBound) : undefined,
        maxId: endBound ? dateToSnowflake(endBound) : undefined,
        limit,
        concurrency: PAGE_CONCURRENCY,
        signal,
        shouldStop: () => earlyFinishFlags.get(primaryGuildId) === true,
        onProgress: onPageProgress,
    });

    const collected: ExportedMessage[] = [];
    for (const msg of hits) {
        if (startBound || endBound) {
            const msgDate = new Date(msg.timestamp);
            if (startBound && msgDate < startBound) continue;
            if (endBound && msgDate >= endBound) continue;
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
    return collected;
}

// Collect one member's messages across every selected server at once (merged in
// the searchGuilds order, capped by the per-member limit). Servers where the
// member isn't present just yield nothing.
async function fetchMemberMessages(
    searchGuilds: Array<{ id: string; name: string; }>,
    primaryGuildId: string,
    userId: string,
    options: ExportOptions,
    onPageProgress: (found: number) => void,
    signal: AbortSignal,
): Promise<ExportedMessage[]> {
    const perGuildFound = searchGuilds.map(() => 0);
    const perGuild = await Promise.all(searchGuilds.map((guild, i) => {
        if (signal.aborted || earlyFinishFlags.get(primaryGuildId)) return [] as ExportedMessage[];
        return searchGuildForAuthor(guild, primaryGuildId, userId, options, found => {
            perGuildFound[i] = found;
            onPageProgress(perGuildFound.reduce((a, b) => a + b, 0));
        }, signal);
    }));
    const collected = perGuild.flat();
    return options.messageLimit ? collected.slice(0, options.messageLimit) : collected;
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
        const date = new Date().toISOString().split("T")[0];
        const guildSafe = options.guildName.replace(/[^a-zA-Z0-9-_]/g, "_");

        // When not combining, each member's file is written to disk as soon as
        // they finish, and the in-memory messages are dropped to free memory.
        // Kept in member order regardless of which member finishes first.
        const collected: Array<ExportedMemberData | null> = options.members.map(() => null);
        let totalMessages = 0;
        let usersDone = 0;

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

        // Members currently being searched, for the progress line and running count.
        const inFlight = new Map<number, { name: string; found: number; }>();
        const publishProgress = () => {
            let found = 0;
            const names: string[] = [];
            for (const m of inFlight.values()) {
                found += m.found;
                names.push(m.name);
            }
            job.progress = {
                ...job.progress,
                status: "fetching",
                currentUser: names.join(", "),
                usersDone,
                totalMessages: totalMessages + found,
            };
            notify();
        };

        try {
            const runMember = async (i: number) => {
                if (controller.signal.aborted || earlyFinishFlags.get(options.guildId)) return;

                const member = options.members[i];
                inFlight.set(i, { name: displayNameOf(member), found: 0 });
                publishProgress();

                let messages: ExportedMessage[] = [];
                try {
                    messages = await fetchMemberMessages(
                        options.searchGuilds,
                        options.guildId,
                        member.id,
                        options,
                        found => {
                            const entry = inFlight.get(i);
                            if (entry) entry.found = found;
                            publishProgress();
                        },
                        controller.signal,
                    );
                } catch {
                    // Skip the member on unrecoverable errors but keep going.
                    messages = [];
                }
                if (controller.signal.aborted) return;

                inFlight.delete(i);
                totalMessages += messages.length;
                usersDone++;

                if (messages.length) {
                    const data: ExportedMemberData = { member, messages };
                    if (options.combineFiles) {
                        collected[i] = data;
                    } else {
                        try {
                            saveMemberToDisk(data);
                        } catch (e: any) {
                            console.error(`[ServerMemberExporter] Failed to save ${displayNameOf(member)}:`, e);
                            showToast(`Failed to save ${displayNameOf(member)}: ${e?.message ?? "unknown error"}`, Toasts.Type.FAILURE);
                        }
                    }
                }

                publishProgress();
            };

            let next = 0;
            const worker = async () => {
                while (next < options.members.length) await runMember(next++);
            };
            await Promise.all(Array.from({ length: Math.min(MEMBER_CONCURRENCY, options.members.length) }, worker));

            const earlyFinished = earlyFinishFlags.get(options.guildId) === true && usersDone < options.members.length;

            if (controller.signal.aborted) {
                jobs.delete(options.guildId);
                earlyFinishFlags.delete(options.guildId);
                notify();
                return;
            }

            job.progress = { ...job.progress, status: "rendering", currentUser: "", usersDone };
            notify();

            const exported = collected.filter((d): d is ExportedMemberData => d !== null);
            if (options.combineFiles) {
                const ext = options.format === "json" ? "json" : "html";
                const mime = options.format === "json" ? "application/json" : "text/html";
                const content = options.format === "json"
                    ? JSON.stringify(buildJson(options, exported), null, 2)
                    : renderHtml(options.guildName, exported);
                saveFile(new File([content], `${guildSafe}-members-${date}.${ext}`, { type: mime }));
            }

            job.progress = { ...job.progress, status: "done", totalMessages };
            notify();

            const usersWithMessages = options.combineFiles
                ? exported.length
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
