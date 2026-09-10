/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classNameFactory } from "@api/Styles";
import { cancelBulkExport, getBulkJob, startBulkExport, subscribeBulk } from "@plugins/chatExporter/bulkManager";
import { getServerJob, subscribe } from "@plugins/chatExporter/exportManager";
import { defaultLimit, settings } from "@plugins/chatExporter/settings";
import { ModalContent, ModalFooter, ModalHeader, ModalProps, ModalRoot, ModalSize } from "@utils/modal";
import { useForceUpdater } from "@utils/react";
import { Button, Forms, GuildStore, showToast, Text, TextInput, Toasts, useEffect, useMemo, useState } from "@webpack/common";

const cl = classNameFactory("vc-chatexporter-");

interface BulkServerExportModalProps {
    modalProps: ModalProps;
    /** The server the user right-clicked — pre-selected as a convenience. */
    initialGuildId?: string;
}

interface GuildRow {
    id: string;
    name: string;
}

export function BulkServerExportModal({ modalProps, initialGuildId }: BulkServerExportModalProps) {
    const guilds: GuildRow[] = useMemo(
        () => Object.values(GuildStore.getGuilds())
            .map((g: any) => ({ id: g.id, name: g.name as string }))
            .sort((a, b) => a.name.localeCompare(b.name)),
        [],
    );

    const [selected, setSelected] = useState<Set<string>>(
        () => new Set(initialGuildId ? [initialGuildId] : []),
    );
    const [query, setQuery] = useState("");
    const [format, setFormat] = useState<"html" | "json">(settings.store.defaultFormat as "html" | "json");
    const [messageLimit, setMessageLimit] = useState<number | null>(defaultLimit);
    const [combineMode, setCombineMode] = useState<"server" | "all" | "channel">(settings.store.bulkFileMode as "server" | "all" | "channel");
    const [startDate, setStartDate] = useState("");
    const [endDate, setEndDate] = useState("");
    const forceUpdate = useForceUpdater();

    // Re-render on both bulk-level and per-server progress changes.
    useEffect(() => subscribeBulk(forceUpdate), []);
    useEffect(() => subscribe(forceUpdate), []);

    const job = getBulkJob();
    const isExporting = !!job && job.status === "running";

    const filtered = useMemo(() => {
        const q = query.trim().toLowerCase();
        return q ? guilds.filter(g => g.name.toLowerCase().includes(q)) : guilds;
    }, [guilds, query]);

    const selectedCount = selected.size;

    function toggle(id: string) {
        setSelected(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
        });
    }

    function selectAllVisible() {
        setSelected(prev => {
            const next = new Set(prev);
            for (const g of filtered) next.add(g.id);
            return next;
        });
    }

    function selectNone() {
        setSelected(new Set());
    }

    function start() {
        const targets = guilds.filter(g => selected.has(g.id)).map(g => ({ id: g.id, name: g.name }));
        if (!targets.length) return;
        startBulkExport({ targets, format, messageLimit, combineMode, startDate: startDate || null, endDate: endDate || null });
        showToast(`Bulk exporting ${targets.length} server${targets.length !== 1 ? "s" : ""}…`, Toasts.Type.MESSAGE);
    }

    const total = job?.targets.length ?? 0;
    const serverJob = job ? getServerJob(job.currentGuildId) : undefined;

    return (
        <ModalRoot {...modalProps} size={ModalSize.LARGE}>
            <ModalHeader>
                <Text variant="heading-lg/semibold" style={{ flexGrow: 1 }}>
                    Bulk Export Servers
                </Text>
            </ModalHeader>

            <ModalContent>
                <div style={{ padding: "16px 0" }}>
                    {/* Format */}
                    <Forms.FormSection>
                        <Forms.FormTitle>Format</Forms.FormTitle>
                        <div style={{ display: "flex", gap: "8px" }}>
                            {(["html", "json"] as const).map(f => (
                                <Button
                                    key={f}
                                    size={Button.Sizes.SMALL}
                                    look={format === f ? Button.Looks.FILLED : Button.Looks.OUTLINED}
                                    color={format === f ? Button.Colors.BRAND : Button.Colors.PRIMARY}
                                    onClick={() => setFormat(f)}
                                    disabled={isExporting}
                                >
                                    {f.toUpperCase()}
                                </Button>
                            ))}
                        </div>
                    </Forms.FormSection>

                    {/* Message limit per channel */}
                    <Forms.FormSection style={{ marginTop: "16px" }}>
                        <Forms.FormTitle>Messages Per Channel</Forms.FormTitle>
                        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                            {[
                                { label: "100", value: 100 },
                                { label: "500", value: 500 },
                                { label: "1,000", value: 1000 },
                                { label: "All", value: null as number | null },
                            ].map(opt => (
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

                    {/* Date Range */}
                    <Forms.FormSection style={{ marginTop: "16px" }}>
                        <Forms.FormTitle>Date Range (optional)</Forms.FormTitle>
                        <div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
                        <div>
                            <label style={{ fontSize: "12px", color: "#949ba4", display: "block", marginBottom: "4px" }}>Start</label>
                            <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} disabled={isExporting}
                                style={{ background: "#1e1f22", border: "1px solid #3f4147", borderRadius: "4px", color: "#dbdee1", padding: "6px 8px", fontSize: "14px" }} />
                        </div>
                        <div>
                            <label style={{ fontSize: "12px", color: "#949ba4", display: "block", marginBottom: "4px" }}>End</label>
                            <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} disabled={isExporting}
                                style={{ background: "#1e1f22", border: "1px solid #3f4147", borderRadius: "4px", color: "#dbdee1", padding: "6px 8px", fontSize: "14px" }} />
                        </div>
                        </div>
                    </Forms.FormSection>
                    {/* Output layout */}
                    <Forms.FormSection style={{ marginTop: "16px" }}>
                        <Forms.FormTitle>Files</Forms.FormTitle>
                        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                            {([
                                { v: "server", label: "One file per server" },
                                { v: "all", label: "One file for everything" },
                                { v: "channel", label: "A file per channel" },
                            ] as const).map(opt => (
                                <Button
                                    key={opt.v}
                                    size={Button.Sizes.SMALL}
                                    look={combineMode === opt.v ? Button.Looks.FILLED : Button.Looks.OUTLINED}
                                    color={combineMode === opt.v ? Button.Colors.BRAND : Button.Colors.PRIMARY}
                                    onClick={() => setCombineMode(opt.v)}
                                    disabled={isExporting}
                                >
                                    {opt.label}
                                </Button>
                            ))}
                        </div>
                        <Forms.FormText style={{ marginTop: "6px", fontSize: "11px", color: "#949ba4" }}>
                            {combineMode === "server" && "Each server downloads as its own combined file."}
                            {combineMode === "all" && "Every server is merged into a single download."}
                            {combineMode === "channel" && "Every channel downloads as its own file."}
                        </Forms.FormText>
                    </Forms.FormSection>

                    {/* Server picker */}
                    <Forms.FormSection style={{ marginTop: "16px" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                            <Forms.FormTitle>Servers ({selectedCount}/{guilds.length} selected)</Forms.FormTitle>
                            <div style={{ display: "flex", gap: "8px" }}>
                                <Button size={Button.Sizes.TINY} look={Button.Looks.LINK} onClick={selectAllVisible} disabled={isExporting}>
                                    Select All{query ? " (shown)" : ""}
                                </Button>
                                <Button size={Button.Sizes.TINY} look={Button.Looks.LINK} onClick={selectNone} disabled={isExporting}>
                                    Select None
                                </Button>
                            </div>
                        </div>
                        <TextInput
                            placeholder="Search servers…"
                            value={query}
                            onChange={setQuery}
                            disabled={isExporting}
                            style={{ marginBottom: "8px" }}
                        />
                        <div className={cl("channel-list")}>
                            {filtered.map(g => (
                                <div
                                    key={g.id}
                                    className={cl("channel-item")}
                                    onClick={() => !isExporting && toggle(g.id)}
                                >
                                    <input
                                        type="checkbox"
                                        checked={selected.has(g.id)}
                                        onChange={() => toggle(g.id)}
                                        disabled={isExporting}
                                        style={{ width: "18px", height: "18px", accentColor: "#5865f2" }}
                                    />
                                    <span style={{ color: "#dbdee1" }}>{g.name}</span>
                                </div>
                            ))}
                            {!filtered.length && (
                                <div style={{ padding: "8px", color: "#b5bac1" }}>No servers match “{query}”.</div>
                            )}
                        </div>
                    </Forms.FormSection>

                    {/* Progress */}
                    {job && (
                        <div style={{ marginTop: "16px" }}>
                            <Text variant="text-sm/normal" style={{ color: "#b5bac1" }}>
                                {job.status === "running" && (
                                    `Exporting server ${job.index + 1}/${total}: ${job.currentName}` +
                                    (serverJob
                                        ? ` — #${serverJob.currentChannel || "…"} (${serverJob.channelsDone}/${serverJob.totalChannels} channels, ${serverJob.progress.fetched} messages)`
                                        : "")
                                )}
                                {job.status === "done" && (
                                    `Bulk export complete — ${job.done - job.failed.length}/${total} servers` +
                                    (job.failed.length ? ` (${job.failed.length} skipped/failed: ${job.failed.join(", ")})` : "")
                                )}
                                {job.status === "cancelled" && "Bulk export cancelled."}
                            </Text>
                            {job.status === "running" && (
                                <div className={cl("progress-bar")}>
                                    <div
                                        className={cl("progress-fill")}
                                        style={{ width: `${total ? (job.done / total) * 100 : 0}%` }}
                                    />
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
                            <Button color={Button.Colors.RED} onClick={cancelBulkExport}>
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
                                onClick={start}
                                disabled={selectedCount === 0}
                            >
                                Export {selectedCount} Server{selectedCount !== 1 ? "s" : ""}
                            </Button>
                        </>
                    )}
                </div>
            </ModalFooter>
        </ModalRoot>
    );
}
