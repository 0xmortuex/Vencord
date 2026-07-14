/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { getMemberExportJob, MemberInfo, startMemberExport } from "@plugins/serverMemberExporter/exporter";
import { sleep } from "@utils/misc";
import { FluxDispatcher, GuildMemberStore, GuildRoleStore, IconUtils, UserStore } from "@webpack/common";

import { type ExportSchedule, reportRunProgress, sinceDate } from "./scheduler";

// Ask the gateway for the full member list and resolve once chunks stop
// arriving (or after a hard timeout for guilds that are already fully cached
// and send nothing).
export function requestAllMembers(guildId: string): Promise<void> {
    return new Promise(resolve => {
        let timer = setTimeout(finish, 5000);

        function onChunk(event: any) {
            if ((event.guildId ?? event.guild_id) !== guildId) return;
            clearTimeout(timer);
            timer = setTimeout(finish, 1500); // settle after the last chunk
        }

        function finish() {
            clearTimeout(timer);
            FluxDispatcher.unsubscribe("GUILD_MEMBERS_CHUNK", onChunk);
            resolve();
        }

        FluxDispatcher.subscribe("GUILD_MEMBERS_CHUNK", onChunk);
        FluxDispatcher.dispatch({
            type: "GUILD_MEMBERS_REQUEST",
            guildIds: [guildId],
            query: "",
            presences: false,
        });
    });
}

// Resolve a member's highest-positioned role (ignoring @everyone, whose id
// equals the guild id) — same logic as the ServerMemberExporter modal.
function getTopRole(guildId: string, roleIds: string[]): { name: string | null; color: number | null; } {
    let best: { name: string | null; color: number | null; position: number; } = { name: null, color: null, position: -1 };
    for (const roleId of roleIds) {
        if (roleId === guildId) continue;
        const role = GuildRoleStore.getRole(guildId, roleId);
        if (role && role.position > best.position) {
            best = { name: role.name, color: role.color || null, position: role.position };
        }
    }
    return { name: best.name, color: best.color };
}

// Build the members whose messages this schedule exports, applying the
// schedule's role/member/bot filters. Members come from the primary guild;
// extra guilds only widen where their messages are searched.
function buildMembers(s: ExportSchedule): MemberInfo[] {
    const includeRoles = new Set(s.includeRoleIds ?? []);
    const excludeRoles = new Set(s.excludeRoleIds ?? []);
    const onlyIds = new Set(s.memberIds ?? []);
    const includeBots = s.includeBots ?? true;

    const out: MemberInfo[] = [];
    for (const id of GuildMemberStore.getMemberIds(s.targetId)) {
        if (onlyIds.size && !onlyIds.has(id)) continue;

        const user = UserStore.getUser(id);
        const member = GuildMemberStore.getMember(s.targetId, id);
        if (!user || !member) continue;
        if (!includeBots && user.bot) continue;

        const roles = (member.roles ?? []).filter(r => r !== s.targetId);
        if (includeRoles.size && !roles.some(r => includeRoles.has(r))) continue;
        if (excludeRoles.size && roles.some(r => excludeRoles.has(r))) continue;

        const topRole = getTopRole(s.targetId, roles);
        out.push({
            id,
            username: user.username,
            globalName: (user as any).globalName ?? null,
            avatarUrl: IconUtils.getUserAvatarURL(user, true),
            nick: member.nick ?? null,
            roles,
            topRoleName: topRole.name,
            topRoleColor: topRole.color,
        });
    }

    out.sort((a, b) => (a.nick || a.globalName || a.username).localeCompare(b.nick || b.globalName || b.username));
    return out;
}

// Run a "members" schedule through ServerMemberExporter's search pipeline:
// each member's messages are fetched via the guild search API (in the primary
// guild plus any extra guilds) and saved exactly like a manual
// "Export Member Messages" run. Returns a summary of what was exported, or
// null when the run didn't complete.
export async function exportMemberMessages(s: ExportSchedule): Promise<string | null> {
    if (getMemberExportJob(s.targetId)) return null; // a manual export is already running

    reportRunProgress(`Loading member list of ${s.targetName}...`);
    await requestAllMembers(s.targetId);
    const members = buildMembers(s);
    if (!members.length) {
        // Surface why nothing happened - the filters may exclude everyone, or
        // Discord never loaded the member list.
        throw new Error(`No members matched in ${s.targetName} (member list not loaded, or filters exclude everyone)`);
    }

    startMemberExport({
        guildId: s.targetId,
        guildName: s.guildName || s.targetName,
        searchGuilds: [{ id: s.targetId, name: s.guildName || s.targetName }, ...(s.extraGuilds ?? [])],
        members,
        // Old roster schedules could be CSV; message exports are html/json only.
        format: s.format === "csv" ? "json" : s.format,
        messageLimit: s.messageLimit,
        combineFiles: true, // one file per scheduled run
        includeAttachments: true,
        includeEmbeds: true,
        includeReactions: true,
        startDate: sinceDate(s),
        endDate: null,
    });

    let last = { usersDone: 0, totalUsers: members.length, totalMessages: 0 };
    const summary = () => `${last.totalMessages} messages from ${last.usersDone}/${last.totalUsers} members of ${s.targetName}`;

    for (;;) {
        const job = getMemberExportJob(s.targetId);
        if (!job) return summary(); // cleaned up after completion
        const p = job.progress;
        last = { usersDone: p.usersDone, totalUsers: p.totalUsers, totalMessages: p.totalMessages };
        reportRunProgress(
            p.status === "rendering"
                ? "Generating file..."
                : `Searching messages of ${p.currentUser || "..."} (${p.usersDone}/${p.totalUsers} members) - ${p.totalMessages} messages found`,
            p.usersDone,
            p.totalUsers,
        );
        if (p.status === "done") return summary();
        if (p.status === "error" || p.status === "cancelled") return null;
        await sleep(2000);
    }
}
