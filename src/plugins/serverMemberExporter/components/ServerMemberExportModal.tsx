/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import {
    cancelMemberExport,
    earlyFinishMemberExport,
    ExportOptions,
    getMemberExportJob,
    isEarlyFinishRequested,
    MemberInfo,
    startMemberExport,
    subscribe,
} from "@plugins/serverMemberExporter/exporter";
import { ModalContent, ModalFooter, ModalHeader, ModalProps, ModalRoot, ModalSize } from "@utils/modal";
import { useForceUpdater } from "@utils/react";
import {
    Button,
    Forms,
    GuildMemberStore,
    GuildRoleStore,
    GuildStore,
    IconUtils,
    Select,
    Text,
    TextInput,
    useEffect,
    useMemo,
    UserStore,
    useState,
} from "@webpack/common";

interface ServerMemberExportModalProps {
    modalProps: ModalProps;
    guildId: string;
    guildName: string;
}

// Saved selection preset: which members to export and which servers to search.
// Presets are stored per primary guild since member ids are guild-specific.
interface ExportPreset {
    name: string;
    memberIds: string[];
    guildIds: string[];
}

const PRESETS_KEY = "ServerMemberExporter_presets";

async function loadPresets(guildId: string): Promise<ExportPreset[]> {
    const all = await DataStore.get<Record<string, ExportPreset[]>>(PRESETS_KEY);
    return all?.[guildId] ?? [];
}

async function storePresets(guildId: string, presets: ExportPreset[]): Promise<void> {
    const all = (await DataStore.get<Record<string, ExportPreset[]>>(PRESETS_KEY)) ?? {};
    all[guildId] = presets;
    await DataStore.set(PRESETS_KEY, all);
}

function memberDisplayName(m: MemberInfo): string {
    return m.nick || m.globalName || m.username;
}

function roleColorHex(color: number | null): string | undefined {
    return color ? `#${color.toString(16).padStart(6, "0")}` : undefined;
}

// Resolve a member's highest-positioned role (ignoring @everyone, which every
// member has and whose id equals the guild id).
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

function getGuildMembers(guildId: string): MemberInfo[] {
    const ids = GuildMemberStore.getMemberIds(guildId);
    const out: MemberInfo[] = [];

    for (const id of ids) {
        const user = UserStore.getUser(id);
        if (!user) continue;
        const member = GuildMemberStore.getMember(guildId, id);
        const roles = (member?.roles ?? []).filter(r => r !== guildId);
        const topRole = getTopRole(guildId, roles);
        out.push({
            id,
            username: user.username,
            globalName: (user as any).globalName ?? null,
            avatarUrl: IconUtils.getUserAvatarURL(user, true),
            nick: member?.nick ?? null,
            roles,
            topRoleName: topRole.name,
            topRoleColor: topRole.color,
        });
    }

    out.sort((a, b) => memberDisplayName(a).localeCompare(memberDisplayName(b)));
    return out;
}

interface GuildOption {
    id: string;
    name: string;
}

// All servers you're in, with the right-clicked (primary) server pinned first.
function getAllGuilds(primaryGuildId: string): GuildOption[] {
    const guilds = GuildStore.getGuilds();
    const out: GuildOption[] = [];
    for (const id in guilds) {
        const g = guilds[id];
        if (g) out.push({ id: g.id, name: g.name });
    }
    out.sort((a, b) => {
        if (a.id === primaryGuildId) return -1;
        if (b.id === primaryGuildId) return 1;
        return a.name.localeCompare(b.name);
    });
    return out;
}

interface RoleOption {
    id: string;
    name: string;
    color: number | null;
}

// Roles that at least one loaded member actually holds, sorted highest-first, so
// the filter only lists roles you can meaningfully pick from.
function getFilterableRoles(guildId: string, members: MemberInfo[]): RoleOption[] {
    const present = new Set<string>();
    for (const m of members) for (const r of m.roles) present.add(r);

    const roles: Array<RoleOption & { position: number; }> = [];
    for (const roleId of present) {
        const role = GuildRoleStore.getRole(guildId, roleId);
        if (!role) continue;
        roles.push({ id: roleId, name: role.name, color: role.color || null, position: role.position });
    }
    roles.sort((a, b) => b.position - a.position);
    return roles.map(({ id, name, color }) => ({ id, name, color }));
}

export function ServerMemberExportModal({ modalProps, guildId, guildName }: ServerMemberExportModalProps) {
    const members = useMemo(() => getGuildMembers(guildId), [guildId]);

    const roles = useMemo(() => getFilterableRoles(guildId, members), [guildId, members]);
    const allGuilds = useMemo(() => getAllGuilds(guildId), [guildId]);

    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [search, setSearch] = useState("");
    const [roleFilter, setRoleFilter] = useState<string | null>(null);
    // Servers to search each member in; the primary (right-clicked) server is always included.
    const [searchGuildIds, setSearchGuildIds] = useState<Set<string>>(() => new Set([guildId]));
    const [guildSearch, setGuildSearch] = useState("");

    const [presets, setPresets] = useState<ExportPreset[]>([]);
    const [presetName, setPresetName] = useState("");

    useEffect(() => {
        let cancelled = false;
        loadPresets(guildId).then(p => !cancelled && setPresets(p));
        return () => { cancelled = true; };
    }, [guildId]);

    const [format, setFormat] = useState<"html" | "json">("html");
    const [messageLimit, setMessageLimit] = useState<number | null>(500);
    const [combineFiles, setCombineFiles] = useState(true);
    const [includeAttachments, setIncludeAttachments] = useState(true);
    const [includeEmbeds, setIncludeEmbeds] = useState(true);
    const [includeReactions, setIncludeReactions] = useState(true);
    const [startDate, setStartDate] = useState("");
    const [endDate, setEndDate] = useState("");

    const forceUpdate = useForceUpdater();
    useEffect(() => subscribe(forceUpdate), []);

    const job = getMemberExportJob(guildId);
    const progress = job?.progress ?? null;
    const isExporting = progress !== null && (progress.status === "fetching" || progress.status === "rendering");
    const earlyFinishing = isEarlyFinishRequested(guildId);

    const filtered = useMemo(() => {
        const q = search.trim().toLowerCase();
        return members.filter(m => {
            if (roleFilter && !m.roles.includes(roleFilter)) return false;
            if (!q) return true;
            return memberDisplayName(m).toLowerCase().includes(q) ||
                m.username.toLowerCase().includes(q);
        });
    }, [members, search, roleFilter]);

    const selectedCount = selected.size;

    function toggleMember(id: string) {
        setSelected(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    }

    function selectAllFiltered() {
        setSelected(prev => {
            const next = new Set(prev);
            for (const m of filtered) next.add(m.id);
            return next;
        });
    }

    function deselectAll() {
        setSelected(new Set());
    }

    const filteredGuilds = useMemo(() => {
        const q = guildSearch.trim().toLowerCase();
        if (!q) return allGuilds;
        return allGuilds.filter(g => g.name.toLowerCase().includes(q));
    }, [allGuilds, guildSearch]);

    function savePreset() {
        const name = presetName.trim();
        if (!name || selectedCount === 0) return;
        const preset: ExportPreset = {
            name,
            memberIds: [...selected],
            guildIds: [...searchGuildIds],
        };
        // Same name overwrites the existing preset.
        const next = [...presets.filter(p => p.name !== name), preset];
        setPresets(next);
        setPresetName("");
        storePresets(guildId, next);
    }

    function applyPreset(preset: ExportPreset) {
        // Only members Discord has loaded can be selected (or exported).
        const loaded = new Set(members.map(m => m.id));
        setSelected(new Set(preset.memberIds.filter(id => loaded.has(id))));

        const known = new Set(allGuilds.map(g => g.id));
        const guilds = new Set(preset.guildIds.filter(id => known.has(id)));
        guilds.add(guildId);
        setSearchGuildIds(guilds);
    }

    function deletePreset(name: string) {
        const next = presets.filter(p => p.name !== name);
        setPresets(next);
        storePresets(guildId, next);
    }

    function toggleSearchGuild(id: string) {
        if (id === guildId) return; // primary server is always included
        setSearchGuildIds(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    }

    function startExport() {
        if (selectedCount === 0) return;
        const chosen = members.filter(m => selected.has(m.id));
        // Search the primary server first, then any extra servers (in the sorted order).
        const searchGuilds = allGuilds.filter(g => searchGuildIds.has(g.id));
        const options: ExportOptions = {
            guildId,
            guildName,
            searchGuilds,
            members: chosen,
            format,
            messageLimit,
            combineFiles,
            includeAttachments,
            includeEmbeds,
            includeReactions,
            startDate: startDate || null,
            endDate: endDate || null,
        };
        startMemberExport(options);
    }

    function cancelExport() {
        cancelMemberExport(guildId);
    }

    const totalUsers = progress?.totalUsers ?? selectedCount;
    const usersDone = progress?.usersDone ?? 0;
    const progressPercent = totalUsers ? (usersDone / totalUsers) * 100 : 0;

    const limitOptions: Array<{ label: string; value: number | null; }> = [
        { label: "Last 100", value: 100 },
        { label: "Last 500", value: 500 },
        { label: "Last 1,000", value: 1000 },
        { label: "All", value: null },
    ];

    const roleOptions: Array<{ label: string; value: string | null; }> = [
        { label: "All roles", value: null },
        ...roles.map(r => ({ label: r.name, value: r.id as string | null })),
    ];

    return (
        <ModalRoot {...modalProps} size={ModalSize.LARGE}>
            <ModalHeader>
                <Text variant="heading-lg/semibold" style={{ flexGrow: 1 }}>
                    Export Member Messages - {guildName}
                </Text>
            </ModalHeader>

            <ModalContent>
                <div style={{ padding: "16px 0" }}>
                    {/* Presets */}
                    <Forms.FormSection>
                        <Forms.FormTitle>Presets</Forms.FormTitle>
                        <Text variant="text-xs/normal" style={{ color: "#949ba4", marginBottom: "6px" }}>
                            Save the current member and server selection, then re-apply it with one click.
                        </Text>
                        {presets.length > 0 && (
                            <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginBottom: "8px" }}>
                                {presets.map(p => (
                                    <div key={p.name} style={{ display: "inline-flex", alignItems: "center", gap: "2px" }}>
                                        <Button
                                            size={Button.Sizes.SMALL}
                                            look={Button.Looks.OUTLINED}
                                            color={Button.Colors.PRIMARY}
                                            onClick={() => applyPreset(p)}
                                            disabled={isExporting}
                                            aria-label={`Apply preset ${p.name}`}
                                        >
                                            {p.name} ({p.memberIds.length} member{p.memberIds.length !== 1 ? "s" : ""}, {p.guildIds.length} server{p.guildIds.length !== 1 ? "s" : ""})
                                        </Button>
                                        <Button
                                            size={Button.Sizes.SMALL}
                                            look={Button.Looks.LINK}
                                            color={Button.Colors.RED}
                                            onClick={() => deletePreset(p.name)}
                                            disabled={isExporting}
                                            aria-label={`Delete preset ${p.name}`}
                                        >
                                            ✕
                                        </Button>
                                    </div>
                                ))}
                            </div>
                        )}
                        <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                            <div style={{ flex: 1 }}>
                                <TextInput
                                    value={presetName}
                                    onChange={setPresetName}
                                    placeholder="Preset name..."
                                    disabled={isExporting}
                                />
                            </div>
                            <Button
                                size={Button.Sizes.SMALL}
                                color={Button.Colors.BRAND}
                                onClick={savePreset}
                                disabled={isExporting || !presetName.trim() || selectedCount === 0}
                            >
                                Save Preset
                            </Button>
                        </div>
                        {selectedCount === 0 && presetName.trim().length > 0 && (
                            <Text variant="text-xs/normal" style={{ color: "#949ba4", marginTop: "4px" }}>
                                Select at least one member below to save a preset.
                            </Text>
                        )}
                    </Forms.FormSection>

                    {/* Format */}
                    <Forms.FormSection style={{ marginTop: "16px" }}>
                        <Forms.FormTitle>Format</Forms.FormTitle>
                        <div style={{ display: "flex", gap: "8px" }}>
                            <Button
                                size={Button.Sizes.SMALL}
                                look={format === "html" ? Button.Looks.FILLED : Button.Looks.OUTLINED}
                                color={format === "html" ? Button.Colors.BRAND : Button.Colors.PRIMARY}
                                onClick={() => setFormat("html")}
                                disabled={isExporting}
                            >
                                HTML
                            </Button>
                            <Button
                                size={Button.Sizes.SMALL}
                                look={format === "json" ? Button.Looks.FILLED : Button.Looks.OUTLINED}
                                color={format === "json" ? Button.Colors.BRAND : Button.Colors.PRIMARY}
                                onClick={() => setFormat("json")}
                                disabled={isExporting}
                            >
                                JSON
                            </Button>
                        </div>
                    </Forms.FormSection>

                    {/* Messages per member */}
                    <Forms.FormSection style={{ marginTop: "16px" }}>
                        <Forms.FormTitle>Messages Per Member</Forms.FormTitle>
                        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                            {limitOptions.map(opt => (
                                <Button
                                    key={opt.label}
                                    size={Button.Sizes.SMALL}
                                    look={messageLimit === opt.value ? Button.Looks.FILLED : Button.Looks.OUTLINED}
                                    color={messageLimit === opt.value ? Button.Colors.BRAND : Button.Colors.PRIMARY}
                                    onClick={() => setMessageLimit(opt.value)}
                                    disabled={isExporting}
                                >
                                    {opt.label}
                                </Button>
                            ))}
                        </div>
                    </Forms.FormSection>

                    {/* Combine + includes */}
                    <Forms.FormSection style={{ marginTop: "16px" }}>
                        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                            {[
                                { label: "Combine all members into one file", checked: combineFiles, set: setCombineFiles },
                                { label: "Attachments (URLs)", checked: includeAttachments, set: setIncludeAttachments },
                                { label: "Embeds", checked: includeEmbeds, set: setIncludeEmbeds },
                                { label: "Reactions", checked: includeReactions, set: setIncludeReactions },
                            ].map(({ label, checked, set }) => (
                                <label key={label} style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer", color: "#dbdee1" }}>
                                    <input
                                        type="checkbox"
                                        checked={checked}
                                        onChange={e => set(e.target.checked)}
                                        disabled={isExporting}
                                        style={{ width: "18px", height: "18px", accentColor: "#5865f2" }}
                                    />
                                    {label}
                                </label>
                            ))}
                        </div>
                    </Forms.FormSection>

                    {/* Date range */}
                    <Forms.FormSection style={{ marginTop: "16px" }}>
                        <Forms.FormTitle>Date Range (optional)</Forms.FormTitle>
                        <div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
                            <div>
                                <label style={{ fontSize: "12px", color: "#949ba4", display: "block", marginBottom: "4px" }}>Start</label>
                                <input
                                    type="date"
                                    value={startDate}
                                    onChange={e => setStartDate(e.target.value)}
                                    disabled={isExporting}
                                    style={{
                                        background: "#1e1f22",
                                        border: "1px solid #3f4147",
                                        borderRadius: "4px",
                                        color: "#dbdee1",
                                        padding: "6px 8px",
                                        fontSize: "14px",
                                    }}
                                />
                            </div>
                            <div>
                                <label style={{ fontSize: "12px", color: "#949ba4", display: "block", marginBottom: "4px" }}>End</label>
                                <input
                                    type="date"
                                    value={endDate}
                                    onChange={e => setEndDate(e.target.value)}
                                    disabled={isExporting}
                                    style={{
                                        background: "#1e1f22",
                                        border: "1px solid #3f4147",
                                        borderRadius: "4px",
                                        color: "#dbdee1",
                                        padding: "6px 8px",
                                        fontSize: "14px",
                                    }}
                                />
                            </div>
                        </div>
                    </Forms.FormSection>

                    {/* Servers to search */}
                    <Forms.FormSection style={{ marginTop: "16px" }}>
                        <Forms.FormTitle>
                            Servers to search ({searchGuildIds.size} selected)
                        </Forms.FormTitle>
                        <Text variant="text-xs/normal" style={{ color: "#949ba4", marginBottom: "6px" }}>
                            Each selected member is searched in every server you tick here. The current server is always included.
                        </Text>
                        <div style={{ marginBottom: "8px" }}>
                            <TextInput
                                value={guildSearch}
                                onChange={setGuildSearch}
                                placeholder="Search servers by name..."
                                disabled={isExporting}
                            />
                        </div>
                        <div style={{
                            maxHeight: "140px",
                            overflowY: "auto",
                            background: "#1e1f22",
                            borderRadius: "4px",
                            padding: "8px",
                        }}>
                            {filteredGuilds.map(g => {
                                const isPrimary = g.id === guildId;
                                return (
                                    <div
                                        key={g.id}
                                        onClick={() => !isExporting && toggleSearchGuild(g.id)}
                                        style={{
                                            display: "flex",
                                            alignItems: "center",
                                            gap: "8px",
                                            padding: "4px 8px",
                                            borderRadius: "4px",
                                            cursor: (isExporting || isPrimary) ? "default" : "pointer",
                                        }}
                                    >
                                        <input
                                            type="checkbox"
                                            checked={searchGuildIds.has(g.id)}
                                            onChange={() => toggleSearchGuild(g.id)}
                                            disabled={isExporting || isPrimary}
                                            style={{ width: "16px", height: "16px", accentColor: "#5865f2" }}
                                        />
                                        <span style={{ color: "#dbdee1" }}>
                                            {g.name}
                                            {isPrimary && <span style={{ color: "#949ba4", fontSize: "12px" }}> (current)</span>}
                                        </span>
                                    </div>
                                );
                            })}
                            {filteredGuilds.length === 0 && (
                                <div style={{ padding: "12px", color: "#949ba4", textAlign: "center" }}>
                                    No servers match your search.
                                </div>
                            )}
                        </div>
                    </Forms.FormSection>

                    {/* Member picker */}
                    <Forms.FormSection style={{ marginTop: "16px" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                            <Forms.FormTitle>
                                Members ({selectedCount} selected, {members.length} loaded)
                            </Forms.FormTitle>
                            <div style={{ display: "flex", gap: "8px" }}>
                                <Button size={Button.Sizes.TINY} look={Button.Looks.LINK} onClick={selectAllFiltered} disabled={isExporting}>
                                    Select All{(search || roleFilter) ? " Shown" : ""}
                                </Button>
                                <Button size={Button.Sizes.TINY} look={Button.Looks.LINK} onClick={deselectAll} disabled={isExporting}>
                                    Deselect All
                                </Button>
                            </div>
                        </div>

                        <div style={{ display: "flex", gap: "8px", margin: "8px 0", alignItems: "center" }}>
                            <div style={{ flex: 1 }}>
                                <TextInput
                                    value={search}
                                    onChange={setSearch}
                                    placeholder="Search members by name..."
                                    disabled={isExporting}
                                />
                            </div>
                            {roles.length > 0 && (
                                <div style={{ minWidth: "200px" }}>
                                    <Select
                                        options={roleOptions}
                                        isSelected={v => v === roleFilter}
                                        select={(v: string | null) => setRoleFilter(v)}
                                        serialize={v => String(v)}
                                        closeOnSelect={true}
                                    />
                                </div>
                            )}
                        </div>

                        {members.length === 0 ? (
                            <div style={{ padding: "16px", color: "#949ba4", textAlign: "center" }}>
                                No members loaded. Open the server's member list (scroll it) so Discord loads members, then reopen this.
                            </div>
                        ) : (
                            <>
                                <div style={{
                                    maxHeight: "260px",
                                    overflowY: "auto",
                                    background: "#1e1f22",
                                    borderRadius: "4px",
                                    padding: "8px",
                                }}>
                                    {filtered.map(m => (
                                        <div
                                            key={m.id}
                                            onClick={() => !isExporting && toggleMember(m.id)}
                                            style={{
                                                display: "flex",
                                                alignItems: "center",
                                                gap: "8px",
                                                padding: "4px 8px",
                                                borderRadius: "4px",
                                                cursor: isExporting ? "default" : "pointer",
                                            }}
                                        >
                                            <input
                                                type="checkbox"
                                                checked={selected.has(m.id)}
                                                onChange={() => toggleMember(m.id)}
                                                disabled={isExporting}
                                                style={{ width: "16px", height: "16px", accentColor: "#5865f2" }}
                                            />
                                            <img src={m.avatarUrl} alt="" style={{ width: "24px", height: "24px", borderRadius: "50%" }} />
                                            <span style={{ color: "#dbdee1", flex: 1 }}>
                                                {memberDisplayName(m)}
                                                <span style={{ color: "#949ba4", fontSize: "12px" }}> @{m.username}</span>
                                            </span>
                                            {m.topRoleName && (
                                                <span style={{
                                                    display: "inline-flex",
                                                    alignItems: "center",
                                                    gap: "4px",
                                                    fontSize: "12px",
                                                    color: roleColorHex(m.topRoleColor) ?? "#949ba4",
                                                }}>
                                                    <span style={{
                                                        width: "8px",
                                                        height: "8px",
                                                        borderRadius: "50%",
                                                        background: roleColorHex(m.topRoleColor) ?? "#949ba4",
                                                    }} />
                                                    {m.topRoleName}
                                                </span>
                                            )}
                                        </div>
                                    ))}
                                    {filtered.length === 0 && (
                                        <div style={{ padding: "12px", color: "#949ba4", textAlign: "center" }}>
                                            No members match the current filters.
                                        </div>
                                    )}
                                </div>
                                <Text variant="text-xs/normal" style={{ color: "#949ba4", marginTop: "6px" }}>
                                    Only members Discord has loaded are shown. Scroll the server's member list to load more.
                                </Text>
                            </>
                        )}
                    </Forms.FormSection>

                    {/* Progress */}
                    {progress && (
                        <div style={{ marginTop: "16px" }}>
                            <Text variant="text-sm/normal" style={{ color: "#b5bac1" }}>
                                {progress.status === "fetching" && (earlyFinishing
                                    ? `Finishing up... (${usersDone}/${totalUsers} members) - ${progress.totalMessages} messages`
                                    : `Exporting ${progress.currentUser}... (${usersDone}/${totalUsers} members) - ${progress.totalMessages} messages`)}
                                {progress.status === "rendering" && "Generating files..."}
                                {progress.status === "done" && `Export complete! ${progress.totalMessages} messages from ${usersDone} members.`}
                                {progress.status === "cancelled" && "Export cancelled."}
                                {progress.status === "error" && `Error: ${progress.error}`}
                            </Text>
                            {(progress.status === "fetching" || progress.status === "rendering") && (
                                <div style={{
                                    width: "100%",
                                    height: "8px",
                                    background: "#1e1f22",
                                    borderRadius: "4px",
                                    overflow: "hidden",
                                    marginTop: "8px",
                                }}>
                                    <div style={{
                                        width: `${progressPercent}%`,
                                        height: "100%",
                                        background: "#5865f2",
                                        borderRadius: "4px",
                                        transition: "width 0.3s ease",
                                    }} />
                                </div>
                            )}
                        </div>
                    )}
                </div>
            </ModalContent>

            <ModalFooter>
                <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end", width: "100%" }}>
                    {isExporting ? (
                        <>
                            <Button look={Button.Looks.LINK} color={Button.Colors.PRIMARY} onClick={modalProps.onClose}>
                                Close (export continues)
                            </Button>
                            {progress?.status === "fetching" && (
                                <Button
                                    look={Button.Looks.OUTLINED}
                                    color={Button.Colors.PRIMARY}
                                    onClick={() => earlyFinishMemberExport(guildId)}
                                    disabled={earlyFinishing}
                                    aria-label="Stop fetching and save what's been collected so far"
                                >
                                    {earlyFinishing ? "Finishing up..." : "Finish Early"}
                                </Button>
                            )}
                            <Button color={Button.Colors.RED} onClick={cancelExport}>
                                Cancel Export
                            </Button>
                        </>
                    ) : (
                        <>
                            <Button look={Button.Looks.LINK} color={Button.Colors.PRIMARY} onClick={modalProps.onClose}>
                                Close
                            </Button>
                            <Button
                                color={Button.Colors.BRAND}
                                onClick={startExport}
                                disabled={selectedCount === 0 || progress?.status === "done"}
                            >
                                Export {selectedCount} Member{selectedCount !== 1 ? "s" : ""}
                            </Button>
                        </>
                    )}
                </div>
            </ModalFooter>
        </ModalRoot>
    );
}
