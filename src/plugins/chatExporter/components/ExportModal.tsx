/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { deleteCheckpoint, generateJobId, loadCheckpoint } from "@plugins/chatExporter/checkpoint";
import { ExportOptions } from "@plugins/chatExporter/exporter";
import { cancelChannelJob, getChannelJob, saveChannelProgress, startChannelExport, subscribe } from "@plugins/chatExporter/exportManager";
import { defaultLimit, settings } from "@plugins/chatExporter/settings";
import { ModalContent, ModalFooter, ModalHeader, ModalProps, ModalRoot, ModalSize } from "@utils/modal";
import { useForceUpdater } from "@utils/react";
import { Button, Forms, showToast, Text, Toasts, useEffect, useState } from "@webpack/common";

interface ExportModalProps {
    modalProps: ModalProps;
    channelId: string;
    channelName: string;
    serverName: string;
}

export function ExportModal({ modalProps, channelId, channelName, serverName }: ExportModalProps) {
    const [format, setFormat] = useState<"html" | "json">(settings.store.defaultFormat as "html" | "json");
    const [messageLimit, setMessageLimit] = useState<number | null>(defaultLimit);
    const [includeImages, setIncludeImages] = useState(!!settings.store.includeImages);
    const [includeEmbeds, setIncludeEmbeds] = useState(!!settings.store.includeEmbeds);
    const [includeReactions, setIncludeReactions] = useState(!!settings.store.includeReactions);
    const [includePins, setIncludePins] = useState(!!settings.store.includePins);
    const [startDate, setStartDate] = useState("");
    const [endDate, setEndDate] = useState("");
    const forceUpdate = useForceUpdater();

    const jobId = generateJobId("channel", channelId);

    useEffect(() => subscribe(forceUpdate), []);

    const job = getChannelJob(channelId);
    const progress = job?.progress ?? null;
    const isExporting = progress !== null && (progress.status === "fetching" || progress.status === "rendering");

    // Re-read on every render (subscribe() already forces one on any job state
    // change) so a checkpoint written by a cancelled/failed export shows up
    // without closing and reopening the modal.
    const checkpoint = !isExporting ? loadCheckpoint(jobId) : null;

    function buildOptions(): ExportOptions {
        return {
            channelId,
            format,
            messageLimit,
            includeImages,
            includeEmbeds,
            includeReactions,
            includePins,
            startDate: startDate || null,
            endDate: endDate || null,
        };
    }

    function startExport() {
        startChannelExport(buildOptions(), channelName, serverName);
    }

    function resumeExport() {
        // A single channel's file is only written once fully fetched, so resuming
        // restarts the fetch with the checkpoint's format/limit/date settings.
        startChannelExport(
            {
                ...buildOptions(),
                format: checkpoint!.format,
                messageLimit: checkpoint!.messageLimit,
                startDate: checkpoint!.startDate,
                endDate: checkpoint!.endDate,
            },
            channelName,
            serverName,
        );
    }

    function discardCheckpoint() {
        deleteCheckpoint(jobId);
        forceUpdate();
    }

    function saveProgress() {
        saveChannelProgress(channelId);
        showToast("Progress saved. You can close Discord and resume later.", Toasts.Type.SUCCESS);
    }

    function cancelExport() {
        cancelChannelJob(channelId);
    }

    const limitOptions: Array<{ label: string; value: number | null; }> = [
        { label: "Last 100", value: 100 },
        { label: "Last 500", value: 500 },
        { label: "Last 1,000", value: 1000 },
        { label: "Last 5,000", value: 5000 },
        { label: "All messages", value: null },
    ];

    const progressPercent = progress && progress.total
        ? Math.min(100, (progress.fetched / progress.total) * 100)
        : 0;

    return (
        <ModalRoot {...modalProps} size={ModalSize.MEDIUM}>
            <ModalHeader>
                <Text variant="heading-lg/semibold" style={{ flexGrow: 1 }}>
                    Export Chat - #{channelName}
                </Text>
            </ModalHeader>

            <ModalContent>
                <div style={{ padding: "16px 0" }}>
                    {/* Resume banner */}
                    {checkpoint && !isExporting && (
                        <div className="vc-chatexporter-resume-banner">
                            <Text variant="text-sm/normal" style={{ color: "#dbdee1", flex: 1 }}>
                                You have an unfinished export from {new Date(checkpoint.startedAt).toLocaleString()}{" "}
                                ({checkpoint.totalMessagesProcessed} messages fetched before it stopped).
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
                                HTML (Pretty)
                            </Button>
                            <Button
                                size={Button.Sizes.SMALL}
                                look={format === "json" ? Button.Looks.FILLED : Button.Looks.OUTLINED}
                                color={format === "json" ? Button.Colors.BRAND : Button.Colors.PRIMARY}
                                onClick={() => setFormat("json")}
                                disabled={isExporting}
                            >
                                JSON (Raw)
                            </Button>
                        </div>
                    </Forms.FormSection>

                    {/* Message Limit */}
                    <Forms.FormSection style={{ marginTop: "16px" }}>
                        <Forms.FormTitle>Message Limit</Forms.FormTitle>
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

                    {/* Include Options */}
                    <Forms.FormSection style={{ marginTop: "16px" }}>
                        <Forms.FormTitle>Include</Forms.FormTitle>
                        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                            {[
                                { label: "Images/Attachments (URLs)", checked: includeImages, set: setIncludeImages },
                                { label: "Embeds", checked: includeEmbeds, set: setIncludeEmbeds },
                                { label: "Reactions", checked: includeReactions, set: setIncludeReactions },
                                { label: "Pinned messages", checked: includePins, set: setIncludePins },
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

                    {/* Date Range */}
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

                    {/* Progress */}
                    {progress && (
                        <div style={{ marginTop: "16px" }}>
                            <Text variant="text-sm/normal" style={{ color: "#b5bac1" }}>
                                {progress.status === "fetching" && `Fetching messages... ${progress.fetched}${progress.total ? `/${progress.total}` : ""}`}
                                {progress.status === "rendering" && "Generating export file..."}
                                {progress.status === "done" && `Export complete! ${progress.fetched} messages exported.`}
                                {progress.status === "error" && `Error: ${progress.error}`}
                            </Text>
                            {progress.status === "fetching" && progress.total && (
                                <div className="vc-chatexporter-progress-bar">
                                    <div
                                        className="vc-chatexporter-progress-fill"
                                        style={{ width: `${progressPercent}%` }}
                                    />
                                </div>
                            )}
                            {progress.status === "fetching" && !progress.total && (
                                <div className="vc-chatexporter-progress-bar">
                                    <div
                                        className="vc-chatexporter-progress-fill"
                                        style={{ width: "100%", opacity: 0.5 }}
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
                            <Button
                                color={Button.Colors.RED}
                                onClick={cancelExport}
                            >
                                Cancel Export
                            </Button>
                        </>
                    ) : (
                        <>
                            <Button
                                look={Button.Looks.LINK}
                                color={Button.Colors.PRIMARY}
                                onClick={modalProps.onClose}
                            >
                                Close
                            </Button>
                            <Button
                                color={Button.Colors.BRAND}
                                onClick={startExport}
                                disabled={progress?.status === "done"}
                            >
                                Start Export
                            </Button>
                        </>
                    )}
                </div>
            </ModalFooter>
        </ModalRoot>
    );
}
