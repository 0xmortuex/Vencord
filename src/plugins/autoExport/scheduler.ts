/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { DataStore } from "@api/index";
import { showNotification } from "@api/Notifications";
import { ExportOptions } from "@plugins/chatExporter/exporter";
import { getChannelJob, getServerJob, startChannelExport, startServerExport } from "@plugins/chatExporter/exportManager";
import { sleep } from "@utils/misc";
import { ChannelStore, GuildChannelStore } from "@webpack/common";

import { exportMemberMessages } from "./memberMessages";

export type ScheduleType = "channel" | "server" | "members";
export type Frequency = "daily" | "weekly" | "monthly";
export type ExportFormat = "html" | "json" | "csv";

export interface ExportSchedule {
    id: string;
    name: string;
    type: ScheduleType;
    /** channelId for "channel", guildId for "server"/"members" */
    targetId: string;
    targetName: string;
    guildId: string; // "" for DM channels
    guildName: string;

    frequency: Frequency;
    dayOfWeek: number; // 0 (Sunday) - 6, used for weekly
    dayOfMonth: number; // 1-28, used for monthly
    hour: number;
    minute: number;

    format: ExportFormat;
    messageLimit: number | null;
    /**
     * Only export the current period's messages: daily = since yesterday 00:00,
     * weekly = since last Monday 00:00, monthly = since the 1st 00:00.
     * (Field name kept for compatibility with stored schedules.)
     */
    sinceLastRun: boolean;

    /**
     * server: also export these guilds in the same run (sequentially).
     * members: also search these guilds for each member's messages.
     */
    extraGuilds?: Array<{ id: string; name: string; }>;

    /** members: only export messages of members holding at least one of these roles (empty = everyone). */
    includeRoleIds?: string[];
    /** members: skip members holding any of these roles. */
    excludeRoleIds?: string[];
    /** members: only these specific user IDs (empty = everyone). */
    memberIds?: string[];
    /** members: include bot accounts (default true). */
    includeBots?: boolean;

    enabled: boolean;
    lastRunAt: number | null;
    /** Human-readable outcome of the last run, shown in the manage modal. */
    lastResult?: string;
    nextRunAt: number;
}

export interface SchedulePreset {
    id: string;
    name: string;
    frequency: Frequency;
    dayOfWeek: number;
    dayOfMonth: number;
    hour: number;
    minute: number;
    format: ExportFormat;
    messageLimit: number | null;
    sinceLastRun: boolean;
}

export const BUILT_IN_PRESETS: SchedulePreset[] = [
    {
        id: "builtin-daily", name: "Daily 4 AM",
        frequency: "daily", dayOfWeek: 0, dayOfMonth: 1, hour: 4, minute: 0,
        format: "html", messageLimit: null, sinceLastRun: true,
    },
    {
        id: "builtin-weekly", name: "Weekly (Sun 4 AM)",
        frequency: "weekly", dayOfWeek: 0, dayOfMonth: 1, hour: 4, minute: 0,
        format: "html", messageLimit: null, sinceLastRun: true,
    },
    {
        id: "builtin-monthly", name: "Monthly (1st, 4 AM)",
        frequency: "monthly", dayOfWeek: 0, dayOfMonth: 1, hour: 4, minute: 0,
        format: "html", messageLimit: null, sinceLastRun: true,
    },
];

const SCHEDULES_KEY = "vc-auto-export-schedules";
const PRESETS_KEY = "vc-auto-export-presets";

let schedules: ExportSchedule[] = [];
let presets: SchedulePreset[] = [];

const listeners = new Set<() => void>();

function notify() {
    for (const fn of listeners) fn();
}

export function subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
}

export function generateId(): string {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// The in-memory arrays are the synchronous source of truth; DataStore is
// write-behind persistence (same pattern as dmOrganizer's store).
async function persistSchedules() {
    // Any change to the schedule set re-arms the exact next-run timer.
    armNextRun();
    await DataStore.set(SCHEDULES_KEY, schedules);
    notify();
}

async function persistPresets() {
    await DataStore.set(PRESETS_KEY, presets);
    notify();
}

export async function loadAll() {
    schedules = (await DataStore.get<ExportSchedule[]>(SCHEDULES_KEY)) ?? [];
    armNextRun();
    presets = (await DataStore.get<SchedulePreset[]>(PRESETS_KEY)) ?? [];
    // Recompute stale nextRunAt values (schema additions, clock changes).
    for (const s of schedules) {
        if (!s.nextRunAt || Number.isNaN(s.nextRunAt)) s.nextRunAt = computeNextRun(s);
    }
    notify();
}

export function getSchedules(): ExportSchedule[] {
    return schedules;
}

export function getPresets(): SchedulePreset[] {
    return presets;
}

export async function addSchedule(schedule: ExportSchedule) {
    schedules.push(schedule);
    await persistSchedules();
}

export async function updateSchedule(id: string, patch: Partial<ExportSchedule>) {
    const s = schedules.find(s => s.id === id);
    if (!s) return;
    Object.assign(s, patch);
    s.nextRunAt = computeNextRun(s);
    await persistSchedules();
}

export async function deleteSchedule(id: string) {
    schedules = schedules.filter(s => s.id !== id);
    await persistSchedules();
}

export async function addPreset(preset: SchedulePreset) {
    presets.push(preset);
    await persistPresets();
}

export async function deletePreset(id: string) {
    presets = presets.filter(p => p.id !== id);
    await persistPresets();
}

// Next occurrence of the schedule's local time, strictly after `from`.
export function computeNextRun(
    s: Pick<ExportSchedule, "frequency" | "dayOfWeek" | "dayOfMonth" | "hour" | "minute">,
    from = Date.now(),
): number {
    const d = new Date(from);
    d.setHours(s.hour, s.minute, 0, 0);

    if (s.frequency === "daily") {
        if (d.getTime() <= from) d.setDate(d.getDate() + 1);
    } else if (s.frequency === "weekly") {
        let add = (s.dayOfWeek - d.getDay() + 7) % 7;
        if (add === 0 && d.getTime() <= from) add = 7;
        d.setDate(d.getDate() + add);
    } else {
        // dayOfMonth is clamped to 1-28 in the UI so this is safe in every month
        d.setDate(s.dayOfMonth);
        if (d.getTime() <= from) d.setMonth(d.getMonth() + 1, s.dayOfMonth);
    }

    return d.getTime();
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function describeSchedule(s: ExportSchedule): string {
    const time = `${String(s.hour).padStart(2, "0")}:${String(s.minute).padStart(2, "0")}`;
    if (s.frequency === "daily") return `Daily at ${time}`;
    if (s.frequency === "weekly") return `Every ${DAY_NAMES[s.dayOfWeek]} at ${time}`;
    return `Monthly on day ${s.dayOfMonth} at ${time}`;
}

export function describeNextRun(s: ExportSchedule): string {
    const diff = s.nextRunAt - Date.now();
    if (diff <= 0) return "due now";
    const minutes = Math.round(diff / 60000);
    if (minutes < 60) return `in ${minutes}m`;
    const hours = Math.round(minutes / 60);
    if (hours < 48) return `in ${hours}h`;
    return `in ${Math.round(hours / 24)}d`;
}

// ---------------------------------------------------------------------------
// Runner

/** Live progress of the schedule currently being run (null when idle). */
export interface RunStatus {
    scheduleId: string;
    scheduleName: string;
    detail: string;
    done: number;
    /** 0 = indeterminate (no progress bar, just the detail text). */
    total: number;
}

let currentRun: RunStatus | null = null;

export function getCurrentRun(): RunStatus | null {
    return currentRun;
}

/** Called by the export runners while a schedule is running. */
export function reportRunProgress(detail: string, done = 0, total = 0) {
    if (!currentRun) return;
    currentRun = { ...currentRun, detail, done, total };
    notify();
}

let tickInterval: ReturnType<typeof setInterval> | null = null;
let nextRunTimer: ReturnType<typeof setTimeout> | null = null;
let running = false;
let schedulerActive = false;

// Fire exactly when the soonest enabled schedule is due, instead of waking up
// every 30 s forever to ask "anything due?". Re-armed whenever the schedule set
// changes (persistSchedules) and after a run. A slow 5-minute poll remains as a
// safety net (e.g. clock changes / sleep-wake) but does no work when idle.
function armNextRun() {
    if (nextRunTimer) { clearTimeout(nextRunTimer); nextRunTimer = null; }
    if (!schedulerActive) return;
    let soonest = Infinity;
    for (const s of schedules) if (s.enabled && s.nextRunAt < soonest) soonest = s.nextRunAt;
    if (!Number.isFinite(soonest)) return;
    const delay = Math.min(2_147_483_647, Math.max(1_000, soonest - Date.now()));
    nextRunTimer = setTimeout(() => { nextRunTimer = null; tick(); }, delay);
}

export function startScheduler() {
    schedulerActive = true;
    tickInterval = setInterval(tick, 5 * 60_000);
    // Catch up on runs missed while Discord was closed. Small delay so stores
    // (channels, members) are populated before the first export fires.
    setTimeout(tick, 15_000);
    armNextRun();
}

export function stopScheduler() {
    schedulerActive = false;
    if (tickInterval) {
        clearInterval(tickInterval);
        tickInterval = null;
    }
    if (nextRunTimer) {
        clearTimeout(nextRunTimer);
        nextRunTimer = null;
    }
}

async function tick() {
    if (running) return;
    const due = schedules.filter(s => s.enabled && s.nextRunAt <= Date.now());
    if (!due.length) return;

    running = true;
    try {
        // Sequential on purpose: concurrent scheduled exports would compete
        // for the same rate-limit buckets unattended.
        for (const s of due) {
            await runSchedule(s);
        }
    } finally {
        running = false;
    }
}

export async function runSchedule(s: ExportSchedule): Promise<void> {
    const startedAt = Date.now();
    // Advance nextRunAt up front so a failing schedule can't hot-loop.
    s.nextRunAt = computeNextRun(s, startedAt);
    await persistSchedules();

    currentRun = { scheduleId: s.id, scheduleName: s.name, detail: "Starting...", done: 0, total: 0 };
    notify();

    showNotification({
        title: "AutoExport",
        body: `Running "${s.name}" (${describeSchedule(s)})`,
    });

    try {
        // Runners return a summary of what was exported, or null when the run
        // didn't complete (cancelled, errored, or another export was running).
        let summary: string | null;
        if (s.type === "channel") summary = await runChannelExport(s);
        else if (s.type === "server") summary = await runServerExport(s);
        else summary = await exportMemberMessages(s);

        if (summary !== null) {
            s.lastRunAt = startedAt;
            s.lastResult = summary;
            await persistSchedules();
        } else {
            s.lastResult = "Did not complete - will retry on the next scheduled run";
            await persistSchedules();
            showNotification({ title: "AutoExport", body: `"${s.name}" did not complete - will retry on its next scheduled run.` });
        }
    } catch (e: any) {
        console.error("[AutoExport] Schedule run failed:", e);
        s.lastResult = `Failed: ${e?.message ?? "unknown error"}`;
        await persistSchedules();
        showNotification({ title: "AutoExport", body: `"${s.name}" failed: ${e?.message ?? "unknown error"}` });
    } finally {
        currentRun = null;
        notify();
    }
}

// Period-bounded exports use calendar boundaries, not the last run time: the
// window starts at the most recent period boundary (day start / Monday 00:00 /
// 1st of month 00:00, all local time) strictly before the run day. A weekly
// run therefore always covers "last Monday until now" — even when it fires on
// a Monday, in which case it steps back to the previous Monday.
export function sinceDate(s: Pick<ExportSchedule, "frequency" | "sinceLastRun">): string | null {
    if (!s.sinceLastRun) return null;

    const d = new Date();
    d.setHours(0, 0, 0, 0);

    if (s.frequency === "daily") {
        d.setDate(d.getDate() - 1);
    } else if (s.frequency === "weekly") {
        const daysSinceMonday = (d.getDay() + 6) % 7;
        d.setDate(d.getDate() - (daysSinceMonday || 7));
    } else {
        if (d.getDate() === 1) d.setMonth(d.getMonth() - 1);
        d.setDate(1);
    }

    return d.toISOString();
}

async function runChannelExport(s: ExportSchedule): Promise<string | null> {
    if (getChannelJob(s.targetId)) return null; // a manual export is already running

    const options: ExportOptions = {
        channelId: s.targetId,
        format: s.format === "csv" ? "json" : s.format,
        messageLimit: s.messageLimit,
        includeImages: true,
        includeEmbeds: true,
        includeReactions: true,
        includePins: true,
        startDate: sinceDate(s),
        endDate: null,
    };
    startChannelExport(options, s.targetName, s.guildName || "Direct Messages");

    let fetched = 0;
    for (;;) {
        const job = getChannelJob(s.targetId);
        if (!job) return `${fetched} messages from #${s.targetName}`; // cleaned up after completion
        fetched = job.progress.fetched ?? fetched;
        reportRunProgress(
            `#${s.targetName} - ${fetched} messages fetched`,
            job.progress.total ? fetched : 0,
            job.progress.total ?? 0,
        );
        if (job.progress.status === "done") return `${fetched} messages from #${s.targetName}`;
        if (job.progress.status === "error" || job.progress.status === "cancelled") return null;
        await sleep(2000);
    }
}

/** Every guild a server/members schedule covers: the primary plus any extras. */
export function scheduleGuilds(s: ExportSchedule): Array<{ id: string; name: string; }> {
    return [{ id: s.targetId, name: s.guildName }, ...(s.extraGuilds ?? [])];
}

async function runServerExport(s: ExportSchedule): Promise<string | null> {
    const guilds = scheduleGuilds(s);
    let channelsDone = 0;
    let allOk = true;
    // Sequential across guilds - the whole point of scheduling is unattended
    // runs, so never fan out against the rate limiter.
    for (let i = 0; i < guilds.length; i++) {
        const done = await runOneServerExport(guilds[i], s, i, guilds.length);
        if (done === null) allOk = false;
        else channelsDone += done;
    }
    if (!allOk) return null;
    return `${channelsDone} channel${channelsDone !== 1 ? "s" : ""} across ${guilds.length} server${guilds.length !== 1 ? "s" : ""}`;
}

/** Returns the number of channels exported, or null if the guild's run didn't complete. */
async function runOneServerExport(guild: { id: string; name: string; }, s: ExportSchedule, index: number, count: number): Promise<number | null> {
    if (getServerJob(guild.id)) return null;

    const channels = (GuildChannelStore.getChannels(guild.id)?.SELECTABLE ?? [])
        .map((entry: any) => entry.channel ?? ChannelStore.getChannel(entry.id))
        .filter((ch: any) => ch && (ch.type === 0 || ch.type === 5))
        .map((ch: any) => ({ id: ch.id, name: ch.name }));
    if (!channels.length) return null;

    startServerExport({
        guildId: guild.id,
        guildName: guild.name,
        channels,
        format: s.format === "csv" ? "json" : s.format,
        messageLimit: s.messageLimit,
        combineFiles: false, // per-channel files are safer for unattended runs
        startDate: sinceDate(s),
    });

    const prefix = count > 1 ? `[${index + 1}/${count}] ` : "";
    let lastDone = 0;
    for (;;) {
        const job = getServerJob(guild.id);
        if (!job) return lastDone;
        lastDone = job.channelsDone;
        reportRunProgress(
            `${prefix}${guild.name}: #${job.currentChannel || "..."} (${job.channelsDone}/${job.totalChannels} channels) - ${job.progress.fetched ?? 0} messages in current channel`,
            job.channelsDone,
            job.totalChannels,
        );
        if (job.progress.status === "done") return lastDone;
        if (job.progress.status === "error" || job.progress.status === "cancelled") return null;
        await sleep(2000);
    }
}
