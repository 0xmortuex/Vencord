/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { deleteCheckpoint, generateJobId, loadCheckpoint } from "@plugins/chatExporter/checkpoint";
import {
    cancelUserJob,
    ChannelSelection,
    earlyFinishJob,
    ExportOptions,
    getUserJob,
    saveUserProgress,
    startUserExport,
    subscribe,
    UserInfo,
} from "@plugins/userExporter/exporter";
import { ModalContent, ModalFooter, ModalHeader, ModalProps, ModalRoot, ModalSize } from "@utils/modal";
import { useForceUpdater } from "@utils/react";
import {
    Button,
    ChannelStore,
    Forms,
    GuildChannelStore,
    GuildMemberStore,
    GuildStore,
    showToast,
    Text,
    Toasts,
    useEffect,
    useMemo,
    useState,
} from "@webpack/common";

interface UserExportModalProps {
    modalProps: ModalProps;
    user: UserInfo;
}

interface GuildEntry {
    id: string;
    name: string;
    channels: Array<{ id: string; name: string; }>;
}

function getMutualGuilds(userId: string): GuildEntry[] {
    const guilds = GuildStore.getGuilds();
    const entries: GuildEntry[] = [];

    for (const guildId in guilds) {
        const member = GuildMemberStore.getMember(guildId, userId);
        if (!member) continue;

        const guild = guilds[guildId];
        const guildChannels = GuildChannelStore.getChannels(guildId);
        const selectable = (guildChannels?.SELECTABLE ?? []) as any[];

        const channels: Array<{ id: string; name: string; }> = [];
        for (const entry of selectable) {
            const ch = entry.channel ?? ChannelStore.getChannel(entry.id);
            if (!ch) continue;
            if (ch.type !== 0 && ch.type !== 5) continue;
            channels.push({ id: ch.id, name: ch.name });
        }

        if (channels.length === 0) continue;

        entries.push({ id: guild.id, name: guild.name, channels });
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));
    return entries;
}

function getAvatarUrl(user: UserInfo): string {
    if (user.avatar) {
        return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128`;
    }
    const index = (BigInt(user.id) >> 22n) % 6n;
    return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
}

export function UserExportModal({ modalProps, user }: UserExportModalProps) {
    const mutualGuilds = useMemo(() => getMutualGuilds(user.id), [user.id]);

    const [selectedChannels, setSelectedChannels] = useState<Set<string>>(new Set());
    const [expandedGuilds, setExpandedGuilds] = useState<Set<string>>(new Set());

    const [format, setFormat] = useState<"html" | "json">("html");
    const [messageLimit, setMessageLimit] = useState<number | null>(500);
    const [includeAttachments, setIncludeAttachments] = useState(true);
    const [includeEmbeds, setIncludeEmbeds] = useState(true);
    const [includeReactions, setIncludeReactions] = useState(true);
    const [startDate, setStartDate] = useState("");
    const [endDate, setEndDate] = useState("");

    const forceUpdate = useForceUpdater();
    useEffect(() => subscribe(forceUpdate), []);

    const jobId = generateJobId("user", user.id);

    const job = getUserJob(user.id);
    const progress = job?.progress ?? null;
    const isExporting = progress !== null && (progress.status === "fetching" || progress.status === "rendering");

    // Re-read on every render (subscribe() already forces one on any job state
    // change) so a checkpoint written by a cancelled/failed export shows up
    // without closing and reopening the modal.
    const checkpoint = !isExporting ? loadCheckpoint(jobId) : null;

    const displayName = user.globalName || user.username;

    const guildChannelIds = useMemo(() => {
        const map = new Map<string, string[]>();
        for (const g of mutualGuilds) map.set(g.id, g.channels.map(c => c.id));
        return map;
    }, [mutualGuilds]);

    function toggleChannel(channelId: string) {
        setSelectedChannels(prev => {
            const next = new Set(prev);
            if (next.has(channelId)) next.delete(channelId);
            else next.add(channelId);
            return next;
        });
    }

    function toggleGuildExpanded(guildId: string) {
        setExpandedGuilds(prev => {
            const next = new Set(prev);
            if (next.has(guildId)) next.delete(guildId);
            else next.add(guildId);
            return next;
        });
    }

    function isGuildFullySelected(guildId: string): boolean {
        const ids = guildChannelIds.get(guildId) ?? [];
        if (ids.length === 0) return false;
        return ids.every(id => selectedChannels.has(id));
    }

    function isGuildPartiallySelected(guildId: string): boolean {
        const ids = guildChannelIds.get(guildId) ?? [];
        return ids.some(id => selectedChannels.has(id)) && !isGuildFullySelected(guildId);
    }

    function toggleGuildAllChannels(guildId: string) {
        const ids = guildChannelIds.get(guildId) ?? [];
        setSelectedChannels(prev => {
            const next = new Set(prev);
            if (isGuildFullySelected(guildId)) {
                for (const id of ids) next.delete(id);
            } else {
                for (const id of ids) next.add(id);
            }
            return next;
        });
    }

    function selectAllServers() {
        const next = new Set<string>();
        for (const g of mutualGuilds) {
            for (const c of g.channels) next.add(c.id);
        }
        setSelectedChannels(next);
    }

    function deselectAll() {
        setSelectedChannels(new Set());
    }

    function startExport() {
        if (selectedChannels.size === 0) return;

        const channels: ChannelSelection[] = [];
        for (const g of mutualGuilds) {
            for (const c of g.channels) {
                if (selectedChannels.has(c.id)) {
                    channels.push({
                        id: c.id,
                        name: c.name,
                        guildId: g.id,
                        guildName: g.name,
                    });
                }
            }
        }

        const options: ExportOptions = {
            user,
            channels,
            format,
            messageLimit,
            includeAttachments,
            includeEmbeds,
            includeReactions,
            startDate: startDate || null,
            endDate: endDate || null,
        };

        startUserExport(options);
    }

    function resumeExport() {
        // The exporter pulls channels/format/limit/dates from the checkpoint; we
        // just need to hand it the user object and flip the resume flag.
        startUserExport(
            {
                user,
                channels: [], // overridden by the checkpoint
                format,
                messageLimit,
                includeAttachments,
                includeEmbeds,
                includeReactions,
                startDate: startDate || null,
                endDate: endDate || null,
            },
            true,
        );
    }

    function discardCheckpoint() {
        deleteCheckpoint(jobId);
        forceUpdate();
    }

    function saveProgress() {
        saveUserProgress(user.id);
        showToast("Progress saved. You can close Discord and resume later.", Toasts.Type.SUCCESS);
    }

    function cancelExport() {
        cancelUserJob(user.id);
    }

    const selectedCount = selectedChannels.size;
    const totalChannels = progress?.totalChannels ?? selectedCount;
    const channelsDone = progress?.channelsDone ?? 0;
    const progressPercent = totalChannels ? (channelsDone / totalChannels) * 100 : 0;

    const limitOptions: Array<{ label: string; value: number | null; }> = [
        { label: "Last 100", value: 100 },
        { label: "Last 500", value: 500 },
        { label: "Last 1,000", value: 1000 },
        { label: "Last 5,000", value: 5000 },
        { label: "All", value: null },
    ];

    return (
        <ModalRoot {...modalProps} size={ModalSize.LARGE}>
            <ModalHeader>
                <div style={{ display: "flex", alignItems: "center", gap: "12px", flexGrow: 1 }}>
                    <img
                        src={getAvatarUrl(user)}
                        alt=""
                        style={{ width: "40px", height: "40px", borderRadius: "50%" }}
                    />
                    <div style={{ display: "flex", flexDirection: "column" }}>
                        <Text variant="heading-lg/semibold">
                            Export Messages by @{displayName}
                        </Text>
                        <Text variant="text-xs/normal" style={{ color: "#949ba4" }}>
                            {user.username} &mdash; {mutualGuilds.length} mutual server{mutualGuilds.length !== 1 ? "s" : ""}
                        </Text>
                    </div>
                </div>
            </ModalHeader>

            <ModalContent>
                <div style={{ padding: "16px 0" }}>
                    {/* Resume banner */}
                    {checkpoint && !isExporting && (
                        <div style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "8px",
                            padding: "12px",
                            marginBottom: "16px",
                            background: "#2b2d31",
                            border: "1px solid #3f4147",
                            borderRadius: "8px",
                        }}>
                            <Text variant="text-sm/normal" style={{ color: "#dbdee1", flex: 1 }}>
                                You have an unfinished export from {new Date(checkpoint.startedAt).toLocaleString()}{" "}
                                ({checkpoint.totalMessagesProcessed} messages,{" "}
                                {checkpoint.channelsCompleted.length}/{checkpoint.channelsRequested.length} channels).
                            </Text>
                            <Button size={Button.Sizes.SMALL} color={Button.Colors.BRAND} onClick={resumeExport}>
                                Resume
                            </Button>
                            <Button size={Button.Sizes.SMALL} look={Button.Looks.OUTLINED} color={Button.Colors.PRIMARY} onClick={discardCheckpoint}>
                                Discard
                            </Button>
                        </div>
                    )}

                    {/* Format */}
                    <Forms.FormSection>
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

                    {/* Messages per channel */}
                    <Forms.FormSection style={{ marginTop: "16px" }}>
                        <Forms.FormTitle>Messages Per Channel</Forms.FormTitle>
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

                    {/* Include */}
                    <Forms.FormSection style={{ marginTop: "16px" }}>
                        <Forms.FormTitle>Include</Forms.FormTitle>
                        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                            {[
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

                    {/* Server/channel tree */}
                    <Forms.FormSection style={{ marginTop: "16px" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                            <Forms.FormTitle>
                                Servers &amp; Channels ({selectedCount} channel{selectedCount !== 1 ? "s" : ""} selected)
                            </Forms.FormTitle>
                            <div style={{ display: "flex", gap: "8px" }}>
                                <Button size={Button.Sizes.TINY} look={Button.Looks.LINK} onClick={selectAllServers} disabled={isExporting}>
                                    Select All Servers
                                </Button>
                                <Button size={Button.Sizes.TINY} look={Button.Looks.LINK} onClick={deselectAll} disabled={isExporting}>
                                    Deselect All
                                </Button>
                            </div>
                        </div>

                        {mutualGuilds.length === 0 ? (
                            <div style={{ padding: "16px", color: "#949ba4", textAlign: "center" }}>
                                No mutual servers with this user.
                            </div>
                        ) : (
                            <div style={{
                                maxHeight: "320px",
                                overflowY: "auto",
                                background: "#1e1f22",
                                borderRadius: "4px",
                                padding: "8px",
                                marginTop: "8px",
                            }}>
                                {mutualGuilds.map(g => {
                                    const expanded = expandedGuilds.has(g.id);
                                    const fully = isGuildFullySelected(g.id);
                                    const partial = isGuildPartiallySelected(g.id);
                                    return (
                                        <div key={g.id} style={{ marginBottom: "4px" }}>
                                            <div style={{
                                                display: "flex",
                                                alignItems: "center",
                                                gap: "8px",
                                                padding: "6px 8px",
                                                borderRadius: "4px",
                                                cursor: "pointer",
                                                background: "#2b2d31",
                                            }}>
                                                <input
                                                    type="checkbox"
                                                    checked={fully}
                                                    ref={el => { if (el) el.indeterminate = partial; }}
                                                    onChange={() => toggleGuildAllChannels(g.id)}
                                                    disabled={isExporting}
                                                    style={{ width: "18px", height: "18px", accentColor: "#5865f2" }}
                                                />
                                                <div
                                                    onClick={() => toggleGuildExpanded(g.id)}
                                                    style={{
                                                        flex: 1,
                                                        display: "flex",
                                                        alignItems: "center",
                                                        gap: "6px",
                                                        color: "#f2f3f5",
                                                        fontWeight: 600,
                                                    }}
                                                >
                                                    <span style={{
                                                        display: "inline-block",
                                                        transition: "transform 0.15s",
                                                        transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
                                                    }}>▶</span>
                                                    {g.name}
                                                    <span style={{ color: "#949ba4", fontWeight: 400, fontSize: "12px" }}>
                                                        ({g.channels.length} channel{g.channels.length !== 1 ? "s" : ""})
                                                    </span>
                                                </div>
                                            </div>
                                            {expanded && (
                                                <div style={{ marginLeft: "24px", marginTop: "4px" }}>
                                                    <div style={{ display: "flex", gap: "8px", marginBottom: "4px" }}>
                                                        <Button
                                                            size={Button.Sizes.TINY}
                                                            look={Button.Looks.LINK}
                                                            onClick={() => {
                                                                const ids = guildChannelIds.get(g.id) ?? [];
                                                                setSelectedChannels(prev => {
                                                                    const next = new Set(prev);
                                                                    for (const id of ids) next.add(id);
                                                                    return next;
                                                                });
                                                            }}
                                                            disabled={isExporting}
                                                        >
                                                            Select All Channels
                                                        </Button>
                                                        <Button
                                                            size={Button.Sizes.TINY}
                                                            look={Button.Looks.LINK}
                                                            onClick={() => {
                                                                const ids = guildChannelIds.get(g.id) ?? [];
                                                                setSelectedChannels(prev => {
                                                                    const next = new Set(prev);
                                                                    for (const id of ids) next.delete(id);
                                                                    return next;
                                                                });
                                                            }}
                                                            disabled={isExporting}
                                                        >
                                                            Deselect All
                                                        </Button>
                                                    </div>
                                                    {g.channels.map(c => (
                                                        <div
                                                            key={c.id}
                                                            onClick={() => !isExporting && toggleChannel(c.id)}
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
                                                                checked={selectedChannels.has(c.id)}
                                                                onChange={() => toggleChannel(c.id)}
                                                                disabled={isExporting}
                                                                style={{ width: "16px", height: "16px", accentColor: "#5865f2" }}
                                                            />
                                                            <span style={{ color: "#dbdee1" }}># {c.name}</span>
                                                        </div>
                                                    ))}
                                                </div>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </Forms.FormSection>

                    {/* Progress */}
                    {progress && (
                        <div style={{ marginTop: "16px" }}>
                            <Text variant="text-sm/normal" style={{ color: "#b5bac1" }}>
                                {progress.status === "fetching" && (
                                    <>Searching #{progress.currentChannel} in {progress.currentGuild}... {progress.totalMessages} messages found ({progress.channelsDone}/{progress.totalChannels} channels)</>
                                )}
                                {progress.status === "rendering" && "Generating export file..."}
                                {progress.status === "done" && `Export complete! ${progress.totalMessages} messages from ${progress.channelsDone} channels.`}
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
                            <Button
                                look={Button.Looks.LINK}
                                color={Button.Colors.PRIMARY}
                                onClick={modalProps.onClose}
                            >
                                Close (export continues)
                            </Button>
                            {progress?.status === "fetching" && (
                                <Button
                                    look={Button.Looks.OUTLINED}
                                    color={Button.Colors.PRIMARY}
                                    onClick={saveProgress}
                                    aria-label="Save progress so you can resume this export later"
                                >
                                    Save Progress
                                </Button>
                            )}
                            {progress?.status === "fetching" && (
                                <button
                                    onClick={() => earlyFinishJob(user.id)}
                                    style={{
                                        background: "#f0a030",
                                        color: "#ffffff",
                                        border: "none",
                                        borderRadius: "20px",
                                        padding: "8px 16px",
                                        fontWeight: 600,
                                        fontSize: "14px",
                                        cursor: "pointer",
                                    }}
                                >
                                    Early Finish
                                </button>
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
                                Export {selectedCount} Channel{selectedCount !== 1 ? "s" : ""}
                            </Button>
                        </>
                    )}
                </div>
            </ModalFooter>
        </ModalRoot>
    );
}
