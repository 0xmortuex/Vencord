/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { CheckpointData, deleteCheckpoint, generateJobId, loadCheckpoint } from "@plugins/chatExporter/checkpoint";
import { cancelServerJob, getServerJob, isEarlyFinishRequested, requestEarlyFinish, saveServerProgress, startServerExport, subscribe } from "@plugins/chatExporter/exportManager";
import { ModalContent, ModalFooter, ModalHeader, ModalProps, ModalRoot, ModalSize } from "@utils/modal";
import { Button, ChannelStore, Forms, GuildChannelStore, showToast, Text, Toasts, useEffect, useState } from "@webpack/common";

interface ServerExportModalProps {
    modalProps: ModalProps;
    guildId: string;
    guildName: string;
}

interface ChannelInfo {
    id: string;
    name: string;
    selected: boolean;
}

export function ServerExportModal({ modalProps, guildId, guildName }: ServerExportModalProps) {
    const guildChannels = GuildChannelStore.getChannels(guildId);
    const textChannels: ChannelInfo[] = (guildChannels.SELECTABLE ?? [])
        .map((entry: any) => {
            const ch = entry.channel ?? ChannelStore.getChannel(entry.id);
            if (!ch) return null;
            if (ch.type !== 0 && ch.type !== 5) return null;
            return { id: ch.id, name: ch.name, selected: false };
        })
        .filter(Boolean) as ChannelInfo[];

    const [channels, setChannels] = useState<ChannelInfo[]>(textChannels);
    const [format, setFormat] = useState<"html" | "json">("html");
    const [messageLimit, setMessageLimit] = useState<number | null>(1000);
    const [combineFiles, setCombineFiles] = useState(false);
    const [, forceUpdate] = useState(0);

    const jobId = generateJobId("server", guildId);
    const [checkpoint, setCheckpoint] = useState<CheckpointData | null>(() => loadCheckpoint(jobId));

    useEffect(() => subscribe(() => forceUpdate(n => n + 1)), []);

    const job = getServerJob(guildId);
    const progress = job?.progress ?? null;
    const currentChannel = job?.currentChannel ?? "";
    const channelsDone = job?.channelsDone ?? 0;
    const selectedCount = channels.filter(c => c.selected).length;
    const isExporting = progress !== null && (progress.status === "fetching" || progress.status === "rendering");

    function toggleChannel(id: string) {
        setChannels(prev => prev.map(c => c.id === id ? { ...c, selected: !c.selected } : c));
    }

    function selectAll() {
        setChannels(prev => prev.map(c => ({ ...c, selected: true })));
    }

    function selectNone() {
        setChannels(prev => prev.map(c => ({ ...c, selected: false })));
    }

    function startExport() {
        const selected = channels.filter(c => c.selected);
        if (!selected.length) return;
        startServerExport({
            guildId,
            guildName,
            channels: selected.map(c => ({ id: c.id, name: c.name })),
            format,
            messageLimit,
            combineFiles,
        });
    }

    function cancelExport() {
        cancelServerJob(guildId);
    }

    function finishEarly() {
        requestEarlyFinish(guildId);
    }

    function resumeExport() {
        startServerExport({
            guildId,
            guildName,
            channels: [], // overridden by the checkpoint
            format,
            messageLimit,
            combineFiles,
            resumeFromCheckpoint: true,
        });
        setCheckpoint(null);
    }

    function discardCheckpoint() {
        deleteCheckpoint(jobId);
        setCheckpoint(null);
    }

    function saveProgress() {
        saveServerProgress(guildId);
        showToast("Progress saved. You can close Discord and resume later.", Toasts.Type.SUCCESS);
    }

    const totalChannels = job?.totalChannels ?? selectedCount;
    const earlyFinishing = isEarlyFinishRequested(guildId);

    return (
        <ModalRoot {...modalProps} size={ModalSize.LARGE}>
            <ModalHeader>
                <Text variant="heading-lg/semibold" style={{ flexGrow: 1 }}>
                    Export Server - {guildName}
                </Text>
            </ModalHeader>

            <ModalContent>
                <div style={{ padding: "16px 0" }}>
                    {/* Resume banner */}
                    {checkpoint && !isExporting && (
                        <div className="vc-chatexporter-resume-banner">
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

                    {/* Combine option */}
                    <Forms.FormSection style={{ marginTop: "16px" }}>
                        <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer", color: "#dbdee1" }}>
                            <input
                                type="checkbox"
                                checked={combineFiles}
                                onChange={e => setCombineFiles(e.target.checked)}
                                disabled={isExporting}
                                style={{ width: "18px", height: "18px", accentColor: "#5865f2" }}
                            />
                            Combine all channels into one file
                        </label>
                    </Forms.FormSection>

                    {/* Channel list */}
                    <Forms.FormSection style={{ marginTop: "16px" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                            <Forms.FormTitle>Channels ({selectedCount}/{channels.length} selected)</Forms.FormTitle>
                            <div style={{ display: "flex", gap: "8px" }}>
                                <Button size={Button.Sizes.TINY} look={Button.Looks.LINK} onClick={selectAll} disabled={isExporting}>
                                    Select All
                                </Button>
                                <Button size={Button.Sizes.TINY} look={Button.Looks.LINK} onClick={selectNone} disabled={isExporting}>
                                    Select None
                                </Button>
                            </div>
                        </div>
                        <div className="vc-chatexporter-channel-list">
                            {channels.map(ch => (
                                <div
                                    key={ch.id}
                                    className="vc-chatexporter-channel-item"
                                    onClick={() => !isExporting && toggleChannel(ch.id)}
                                >
                                    <input
                                        type="checkbox"
                                        checked={ch.selected}
                                        onChange={() => toggleChannel(ch.id)}
                                        disabled={isExporting}
                                        style={{ width: "18px", height: "18px", accentColor: "#5865f2" }}
                                    />
                                    <span style={{ color: "#dbdee1" }}># {ch.name}</span>
                                </div>
                            ))}
                        </div>
                    </Forms.FormSection>

                    {/* Progress */}
                    {progress && (
                        <div style={{ marginTop: "16px" }}>
                            <Text variant="text-sm/normal" style={{ color: "#b5bac1" }}>
                                {progress.status === "fetching" && (earlyFinishing
                                    ? `Finishing up... (${channelsDone}/${totalChannels} channels) - ${progress.fetched} messages`
                                    : `Exporting #${currentChannel}... (${channelsDone}/${totalChannels} channels) - ${progress.fetched} messages`)}
                                {progress.status === "rendering" && (earlyFinishing ? "Saving collected messages..." : "Generating files...")}
                                {progress.status === "done" && `Export complete! ${totalChannels} channels exported.`}
                                {progress.status === "error" && `Error: ${progress.error}`}
                            </Text>
                            {(progress.status === "fetching" || progress.status === "rendering") && (
                                <div className="vc-chatexporter-progress-bar">
                                    <div
                                        className="vc-chatexporter-progress-fill"
                                        style={{ width: `${totalChannels ? (channelsDone / totalChannels) * 100 : 0}%` }}
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
                            <Button
                                look={Button.Looks.LINK}
                                color={Button.Colors.PRIMARY}
                                onClick={modalProps.onClose}
                            >
                                Close (export continues)
                            </Button>
                            {progress?.status === "fetching" && !combineFiles && (
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
                                <Button
                                    look={Button.Looks.OUTLINED}
                                    color={Button.Colors.PRIMARY}
                                    onClick={finishEarly}
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
                                Export {selectedCount} Channel{selectedCount !== 1 ? "s" : ""}
                            </Button>
                        </>
                    )}
                </div>
            </ModalFooter>
        </ModalRoot>
    );
}
