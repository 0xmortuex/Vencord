/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { DataStore } from "@api/index";
import { VirtualList } from "@components/VirtualList";
import { classNameFactory } from "@utils/css";
import { ModalCloseButton, ModalContent, ModalHeader, ModalProps, ModalRoot, ModalSize, openModal } from "@utils/modal";
import { saveFile } from "@utils/web";
import { Button, FluxDispatcher, GuildMemberStore, GuildRoleStore, GuildStore, Select, showToast, Text, Toasts, Tooltip, useEffect, useMemo, UserStore, useState } from "@webpack/common";

import { STORAGE_KEY, TrackerData } from "..";

const cl = classNameFactory("vc-inactivitytracker-");

const THRESHOLD_OPTIONS = [
    { label: "3 days", value: 3 },
    { label: "7 days", value: 7 },
    { label: "14 days", value: 14 },
    { label: "30 days", value: 30 },
    { label: "60 days", value: 60 },
    { label: "Custom…", value: -1 },
];

interface MemberEntry {
    userId: string;
    username: string;
    displayName: string;
    avatarUrl: string | null;
    topRoleName: string | null;
    topRoleColor: number | null;
    lastSeen: number | null;
    daysInactive: number | null;
}

function getInactivityClass(daysInactive: number | null): string {
    if (daysInactive === null) return cl("status-unknown");
    if (daysInactive < 3) return cl("status-active");
    if (daysInactive <= 7) return cl("status-warning");
    if (daysInactive <= 14) return cl("status-inactive");
    return cl("status-critical");
}

function formatLastSeen(lastSeen: number | null): string {
    if (lastSeen === null) return "Never seen";

    const now = Date.now();
    const diffMs = now - lastSeen;
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays === 0) return "Last seen: Today";
    if (diffDays === 1) return "Last seen: Yesterday";
    if (diffDays < 30) return `Last seen: ${diffDays} days ago`;

    const date = new Date(lastSeen);
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return `Last seen: ${months[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
}

function getDaysInactive(lastSeen: number | null): number | null {
    if (lastSeen === null) return null;
    return Math.floor((Date.now() - lastSeen) / (1000 * 60 * 60 * 24));
}

function getTopRole(guildId: string, userId: string): { name: string | null; color: number | null; } {
    const member = GuildMemberStore.getMember(guildId, userId);
    if (!member?.roles?.length) return { name: null, color: null };

    let topRole: { name: string | null; color: number | null; position: number; } = { name: null, color: null, position: -1 };

    for (const roleId of member.roles) {
        const role = GuildRoleStore.getRole(guildId, roleId);
        if (role && role.position > topRole.position) {
            topRole = { name: role.name, color: role.color || null, position: role.position };
        }
    }

    return { name: topRole.name, color: topRole.color };
}

function buildMemberList(guildId: string, data: TrackerData): MemberEntry[] {
    const guildData = data[guildId] || {};
    const memberIds = GuildMemberStore.getMemberIds(guildId);
    const entries: MemberEntry[] = [];

    for (const userId of memberIds) {
        const user = UserStore.getUser(userId);
        if (!user || user.bot) continue;

        const member = GuildMemberStore.getMember(guildId, userId);
        const lastSeen = guildData[userId] ?? null;
        const topRole = getTopRole(guildId, userId);

        entries.push({
            userId,
            username: user.username,
            displayName: member?.nick || user.globalName || user.username,
            avatarUrl: user.getAvatarURL(guildId, 32),
            topRoleName: topRole.name,
            topRoleColor: topRole.color,
            lastSeen,
            daysInactive: getDaysInactive(lastSeen),
        });
    }

    entries.sort((a, b) => {
        if (a.lastSeen === null && b.lastSeen === null) return 0;
        if (a.lastSeen === null) return -1;
        if (b.lastSeen === null) return 1;
        return a.lastSeen - b.lastSeen;
    });

    return entries;
}

function exportCsv(members: MemberEntry[], guildName: string) {
    const q = (s: string) => '"' + String(s ?? "").replace(/"/g, '""') + '"';
    const rows = ["name,username,user_id,top_role,last_seen,days_inactive"];
    for (const m of members) {
        const lastSeen = m.lastSeen ? new Date(m.lastSeen).toISOString().split("T")[0] : "Never";
        const days = m.daysInactive !== null ? String(m.daysInactive) : "N/A";
        rows.push([q(m.displayName), q(m.username), m.userId, q(m.topRoleName ?? ""), lastSeen, days].join(","));
    }
    const stamp = new Date().toISOString().split("T")[0];
    const safe = guildName.replace(/[^a-zA-Z0-9-_]/g, "_");
    saveFile(new File([rows.join("\n")], `inactive-${safe}-${stamp}.csv`, { type: "text/csv" }));
    showToast(`Downloaded CSV with ${members.length} member${members.length === 1 ? "" : "s"}`, Toasts.Type.SUCCESS);
}

function InactivityModalComponent({ guildId, modalProps }: { guildId: string; modalProps: ModalProps; }) {
    const [threshold, setThreshold] = useState(7);
    const [customDays, setCustomDays] = useState(45);
    const [roleFilter, setRoleFilter] = useState("");
    const [sortBy, setSortBy] = useState<"inactive" | "name" | "role">("inactive");
    const [hideNeverSeen, setHideNeverSeen] = useState(false);
    const [search, setSearch] = useState("");
    const effectiveThreshold = threshold === -1 ? Math.max(0, Math.floor(customDays) || 0) : threshold;
    const [loading, setLoading] = useState(true);
    const [storedData, setStoredData] = useState<TrackerData>({});
    const [memberVersion, setMemberVersion] = useState(0);

    const guild = GuildStore.getGuild(guildId);
    const guildName = guild?.name ?? "Unknown Server";

    useEffect(() => {
        DataStore.get(STORAGE_KEY).then((data: TrackerData | undefined) => {
            setStoredData(data ?? {});
        });

        // Members stream in via GUILD_MEMBERS_CHUNK after the request below;
        // re-derive the list on each chunk instead of hoping a fixed timeout is
        // long enough (large guilds keep chunking well past any fixed delay).
        function onMembersChunk(event: any) {
            if ((event.guildId ?? event.guild_id) !== guildId) return;
            setLoading(false);
            setMemberVersion(v => v + 1);
        }
        FluxDispatcher.subscribe("GUILD_MEMBERS_CHUNK", onMembersChunk);

        FluxDispatcher.dispatch({
            type: "GUILD_MEMBERS_REQUEST",
            guildIds: [guildId],
            query: "",
            presences: false,
        });

        // Fallback for guilds where no chunk ever arrives (already fully cached).
        const timer = setTimeout(() => setLoading(false), 1500);
        return () => {
            clearTimeout(timer);
            FluxDispatcher.unsubscribe("GUILD_MEMBERS_CHUNK", onMembersChunk);
        };
    }, [guildId]);

    const allMembers = useMemo(() => buildMemberList(guildId, storedData), [guildId, storedData, loading, memberVersion]);

    const roleNames = useMemo(
        () => [...new Set(allMembers.map(m => m.topRoleName).filter((r): r is string => !!r))].sort((a, b) => a.localeCompare(b)),
        [allMembers],
    );

    const filteredMembers = useMemo(() => {
        let members = allMembers.filter(m =>
            m.daysInactive === null ? !hideNeverSeen : m.daysInactive >= effectiveThreshold
        );
        if (roleFilter) members = members.filter(m => m.topRoleName === roleFilter);
        if (search.trim()) {
            const q = search.toLowerCase();
            members = members.filter(m =>
                m.displayName.toLowerCase().includes(q) ||
                m.username.toLowerCase().includes(q)
            );
        }
        if (sortBy === "name") members = [...members].sort((a, b) => a.displayName.localeCompare(b.displayName));
        else if (sortBy === "role") members = [...members].sort((a, b) => (a.topRoleName ?? "").localeCompare(b.topRoleName ?? "") || a.displayName.localeCompare(b.displayName));
        return members;
    }, [allMembers, effectiveThreshold, roleFilter, hideNeverSeen, sortBy, search]);

    return (
        <ModalRoot {...modalProps} size={ModalSize.MEDIUM}>
            <ModalHeader separator={false}>
                <Text variant="heading-lg/semibold" style={{ flex: 1 }}>
                    Inactive Members — {guildName}
                </Text>
                <ModalCloseButton onClick={modalProps.onClose} />
            </ModalHeader>

            <div className={cl("controls")}>
                <div className={cl("filter-bar")}>
                    <Text variant="text-sm/medium">Inactive for at least:</Text>
                    <Select
                        options={THRESHOLD_OPTIONS}
                        select={setThreshold}
                        isSelected={v => v === threshold}
                        serialize={v => String(v)}
                        closeOnSelect={true}
                    />
                    {threshold === -1 && (
                        <input
                            type="number" min={0} value={customDays}
                            onChange={e => setCustomDays(Number(e.target.value))}
                            className={cl("search")} style={{ width: "90px" }} aria-label="Custom days"
                        />
                    )}
                </div>
                <div className={cl("filter-bar")}>
                    <Text variant="text-sm/medium">Role:</Text>
                    <Select
                        options={[{ label: "Any role", value: "" }, ...roleNames.map(r => ({ label: r, value: r }))]}
                        select={setRoleFilter}
                        isSelected={v => v === roleFilter}
                        serialize={v => String(v)}
                        closeOnSelect={true}
                    />
                    <Text variant="text-sm/medium">Sort:</Text>
                    <Select
                        options={[{ label: "Longest inactive", value: "inactive" }, { label: "Name", value: "name" }, { label: "Role", value: "role" }]}
                        select={setSortBy}
                        isSelected={v => v === sortBy}
                        serialize={v => String(v)}
                        closeOnSelect={true}
                    />
                    <label style={{ display: "flex", alignItems: "center", gap: "6px", color: "var(--text-normal)", fontSize: "13px", cursor: "pointer" }}>
                        <input type="checkbox" checked={hideNeverSeen} onChange={e => setHideNeverSeen(e.target.checked)} />
                        Hide never-seen
                    </label>
                </div>

                <Text variant="text-sm/normal" className={cl("stats")}>
                    {filteredMembers.length} members inactive for more than {effectiveThreshold} days
                </Text>

                <input
                    type="text"
                    placeholder="Search members..."
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    className={cl("search")}
                />

                <Tooltip text="Download CSV file">
                    {tooltipProps => (
                        <Button
                            {...tooltipProps}
                            look={Button.Looks.OUTLINED}
                            color={Button.Colors.PRIMARY}
                            size={Button.Sizes.SMALL}
                            onClick={() => exportCsv(filteredMembers, guildName)}
                            className={cl("export-btn")}
                        >
                            Export CSV
                        </Button>
                    )}
                </Tooltip>
            </div>

            <ModalContent>
                {loading ? (
                    <div className={cl("empty")}>
                        <Text variant="text-md/normal">
                            Loading members...
                        </Text>
                    </div>
                ) : filteredMembers.length === 0 ? (
                    <div className={cl("empty")}>
                        <Text variant="text-md/normal">
                            No inactive members found.
                        </Text>
                    </div>
                ) : (
                    <VirtualList items={filteredMembers} rowHeight={52} height={420} keyOf={m => m.userId} renderRow={member => (
                        <div className={cl("member-row")}>
                            <img
                                src={member.avatarUrl ?? undefined}
                                alt=""
                                loading="lazy"
                                className={cl("avatar")}
                            />

                            <div className={cl("info")}>
                                <Text variant="text-md/semibold" className={cl("name")}>
                                    {member.displayName}
                                    {member.displayName !== member.username && (
                                        <span className={cl("username")}>
                                            {member.username}
                                        </span>
                                    )}
                                </Text>
                                {member.topRoleName && (
                                    <Text variant="text-xs/normal" style={{
                                        color: member.topRoleColor
                                            ? `#${member.topRoleColor.toString(16).padStart(6, "0")}`
                                            : "var(--text-muted)",
                                    }}>
                                        {member.topRoleName}
                                    </Text>
                                )}
                            </div>

                            <Text
                                variant="text-sm/medium"
                                className={`${cl("last-seen")} ${getInactivityClass(member.daysInactive)}`}
                            >
                                {formatLastSeen(member.lastSeen)}
                            </Text>
                        </div>
                    )} />
                )}
            </ModalContent>
        </ModalRoot>
    );
}

export function openInactivityModal(guildId: string) {
    openModal(modalProps => (
        <InactivityModalComponent guildId={guildId} modalProps={modalProps} />
    ));
}
