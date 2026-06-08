/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

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
import {
    Button,
    Forms,
    GuildMemberStore,
    IconUtils,
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

function memberDisplayName(m: MemberInfo): string {
    return m.nick || m.globalName || m.username;
}

function getGuildMembers(guildId: string): MemberInfo[] {
    const ids = GuildMemberStore.getMemberIds(guildId);
    const out: MemberInfo[] = [];

    for (const id of ids) {
        const user = UserStore.getUser(id);
        if (!user) continue;
        const member = GuildMemberStore.getMember(guildId, id);
        out.push({
            id,
            username: user.username,
            globalName: (user as any).globalName ?? null,
            avatarUrl: IconUtils.getUserAvatarURL(user, true),
            nick: member?.nick ?? null,
        });
    }

    out.sort((a, b) => memberDisplayName(a).localeCompare(memberDisplayName(b)));
    return out;
}

export function ServerMemberExportModal({ modalProps, guildId, guildName }: ServerMemberExportModalProps) {
    const members = useMemo(() => getGuildMembers(guildId), [guildId]);

    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [search, setSearch] = useState("");

    const [format, setFormat] = useState<"html" | "json">("html");
    const [messageLimit, setMessageLimit] = useState<number | null>(500);
    const [combineFiles, setCombineFiles] = useState(true);
    const [includeAttachments, setIncludeAttachments] = useState(true);
    const [includeEmbeds, setIncludeEmbeds] = useState(true);
    const [includeReactions, setIncludeReactions] = useState(true);
    const [startDate, setStartDate] = useState("");
    const [endDate, setEndDate] = useState("");

    const [, forceUpdate] = useState(0);
    useEffect(() => subscribe(() => forceUpdate(n => n + 1)), []);

    const job = getMemberExportJob(guildId);
    const progress = job?.progress ?? null;
    const isExporting = progress !== null && (progress.status === "fetching" || progress.status === "rendering");
    const earlyFinishing = isEarlyFinishRequested(guildId);

    const filtered = useMemo(() => {
        const q = search.trim().toLowerCase();
        if (!q) return members;
        return members.filter(m =>
            memberDisplayName(m).toLowerCase().includes(q) ||
            m.username.toLowerCase().includes(q)
        );
    }, [members, search]);

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

    function startExport() {
        if (selectedCount === 0) return;
        const chosen = members.filter(m => selected.has(m.id));
        const options: ExportOptions = {
            guildId,
            guildName,
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

    return (
        <ModalRoot {...modalProps} size={ModalSize.LARGE}>
            <ModalHeader>
                <Text variant="heading-lg/semibold" style={{ flexGrow: 1 }}>
                    Export Member Messages - {guildName}
                </Text>
            </ModalHeader>

            <ModalContent>
                <div style={{ padding: "16px 0" }}>
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

                    {/* Member picker */}
                    <Forms.FormSection style={{ marginTop: "16px" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                            <Forms.FormTitle>
                                Members ({selectedCount} selected, {members.length} loaded)
                            </Forms.FormTitle>
                            <div style={{ display: "flex", gap: "8px" }}>
                                <Button size={Button.Sizes.TINY} look={Button.Looks.LINK} onClick={selectAllFiltered} disabled={isExporting}>
                                    Select All{search ? " Shown" : ""}
                                </Button>
                                <Button size={Button.Sizes.TINY} look={Button.Looks.LINK} onClick={deselectAll} disabled={isExporting}>
                                    Deselect All
                                </Button>
                            </div>
                        </div>

                        <div style={{ margin: "8px 0" }}>
                            <TextInput
                                value={search}
                                onChange={setSearch}
                                placeholder="Search members by name..."
                                disabled={isExporting}
                            />
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
                                            <span style={{ color: "#dbdee1" }}>
                                                {memberDisplayName(m)}
                                                <span style={{ color: "#949ba4", fontSize: "12px" }}> @{m.username}</span>
                                            </span>
                                        </div>
                                    ))}
                                    {filtered.length === 0 && (
                                        <div style={{ padding: "12px", color: "#949ba4", textAlign: "center" }}>
                                            No members match "{search}".
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
