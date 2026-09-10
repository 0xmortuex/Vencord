/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {
    deleteSchedule,
    describeNextRun,
    describeSchedule,
    ExportSchedule,
    getCurrentRun,
    getSchedules,
    runSchedule,
    subscribe,
    updateSchedule,
} from "@plugins/autoExport/scheduler";
import { ModalCloseButton, ModalContent, ModalFooter, ModalHeader, ModalProps, ModalRoot, ModalSize, openModal } from "@utils/modal";
import { useForceUpdater } from "@utils/react";
import { Alerts, Button, showToast, Text, Toasts, useEffect } from "@webpack/common";

import { openScheduleModal } from "./ScheduleModal";

function targetLabel(s: ExportSchedule): string {
    const extra = s.extraGuilds?.length ? ` +${s.extraGuilds.length} server${s.extraGuilds.length !== 1 ? "s" : ""}` : "";
    if (s.type === "channel") return `#${s.targetName}${s.guildName ? ` — ${s.guildName}` : " — DM"}`;
    if (s.type === "server") return `${s.targetName}${extra} — all text channels`;
    const filtered = s.includeRoleIds?.length || s.excludeRoleIds?.length || s.memberIds?.length || s.includeBots === false;
    return `${s.targetName}${extra} — member messages${filtered ? " (filtered)" : ""}`;
}

function formatLastRun(s: ExportSchedule): string {
    if (!s.lastRunAt) return "never";
    return new Date(s.lastRunAt).toLocaleString();
}

function ManageSchedulesModalComponent({ modalProps }: { modalProps: ModalProps; }) {
    const forceUpdate = useForceUpdater();
    useEffect(() => subscribe(forceUpdate), []);

    const schedules = getSchedules();
    const run = getCurrentRun();

    return (
        <ModalRoot {...modalProps} size={ModalSize.LARGE}>
            <ModalHeader separator={false}>
                <div style={{ display: "flex", flexDirection: "column", flex: 1 }}>
                    <Text variant="heading-lg/semibold">Auto-Export Schedules</Text>
                    <Text variant="text-sm/normal" style={{ color: "var(--text-muted)", marginTop: 2 }}>
                        {schedules.length} schedule{schedules.length !== 1 ? "s" : ""} — right-click a channel or server to add one
                    </Text>
                </div>
                <ModalCloseButton onClick={modalProps.onClose} />
            </ModalHeader>

            <ModalContent>
                {run && (
                    <div style={{
                        padding: 12,
                        marginTop: 8,
                        background: "#1e1f22",
                        borderRadius: 8,
                    }}>
                        <Text variant="text-md/semibold">Running: {run.scheduleName}</Text>
                        <Text variant="text-sm/normal" style={{ color: "var(--text-muted)", marginTop: 2 }}>
                            {run.detail}
                        </Text>
                        {run.total > 0 && (
                            <>
                                <div style={{
                                    width: "100%",
                                    height: 8,
                                    background: "#111214",
                                    borderRadius: 4,
                                    overflow: "hidden",
                                    marginTop: 8,
                                }}>
                                    <div style={{
                                        width: `${Math.min(100, (run.done / run.total) * 100)}%`,
                                        height: "100%",
                                        background: "#5865f2",
                                        borderRadius: 4,
                                        transition: "width 0.3s ease",
                                    }} />
                                </div>
                                <Text variant="text-xs/normal" style={{ color: "var(--text-muted)", marginTop: 4 }}>
                                    {run.done}/{run.total} ({Math.round((run.done / run.total) * 100)}%)
                                </Text>
                            </>
                        )}
                    </div>
                )}
                {schedules.length === 0 ? (
                    <div style={{ padding: "40px 0", textAlign: "center" }}>
                        <Text variant="text-md/normal">
                            No schedules yet. Right-click a channel → "Schedule Auto-Export", or a server for full-server / member-messages schedules.
                        </Text>
                    </div>
                ) : (
                    schedules.map(s => (
                        <div
                            key={s.id}
                            style={{
                                display: "flex",
                                alignItems: "center",
                                gap: 12,
                                padding: "10px 4px",
                                borderBottom: "1px solid var(--background-modifier-accent)",
                                opacity: s.enabled ? 1 : 0.5,
                            }}
                        >
                            <input
                                type="checkbox"
                                checked={s.enabled}
                                onChange={e => updateSchedule(s.id, { enabled: e.target.checked })}
                                style={{ width: 18, height: 18, accentColor: "#5865f2", flexShrink: 0 }}
                            />

                            <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
                                <Text variant="text-md/semibold" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                    {s.name}
                                </Text>
                                <Text variant="text-xs/normal" style={{ color: "var(--text-muted)" }}>
                                    {targetLabel(s)} · {describeSchedule(s)} · {s.format.toUpperCase()}
                                    {s.sinceLastRun ? " · this period only" : ""}
                                </Text>
                                <Text variant="text-xs/normal" style={{ color: "var(--text-muted)" }}>
                                    Next: {s.enabled ? describeNextRun(s) : "disabled"} · Last run: {formatLastRun(s)}
                                </Text>
                                {s.lastResult && (
                                    <Text variant="text-xs/normal" style={{ color: s.lastResult.startsWith("Failed") || s.lastResult.startsWith("Did not") ? "var(--text-danger)" : "var(--text-muted)" }}>
                                        Last result: {s.lastResult}
                                    </Text>
                                )}
                            </div>

                            <Button
                                size={Button.Sizes.SMALL}
                                look={Button.Looks.OUTLINED}
                                color={Button.Colors.PRIMARY}
                                disabled={run !== null}
                                onClick={() => {
                                    showToast(`Running "${s.name}" now...`, Toasts.Type.MESSAGE);
                                    runSchedule(s);
                                }}
                            >
                                {run?.scheduleId === s.id ? "Running..." : "Run Now"}
                            </Button>
                            <Button
                                size={Button.Sizes.SMALL}
                                look={Button.Looks.OUTLINED}
                                color={Button.Colors.PRIMARY}
                                onClick={() => openScheduleModal({
                                    type: s.type,
                                    targetId: s.targetId,
                                    targetName: s.targetName,
                                    guildId: s.guildId,
                                    guildName: s.guildName,
                                }, s)}
                            >
                                Edit
                            </Button>
                            <Button
                                size={Button.Sizes.SMALL}
                                color={Button.Colors.RED}
                                onClick={() => {
                                    Alerts.show({
                                        title: "Delete Schedule",
                                        body: `Delete "${s.name}"? This does not touch any exported files.`,
                                        confirmText: "Delete",
                                        cancelText: "Cancel",
                                        onConfirm: () => deleteSchedule(s.id),
                                    });
                                }}
                            >
                                Delete
                            </Button>
                        </div>
                    ))
                )}
            </ModalContent>

            <ModalFooter>
                <Button look={Button.Looks.LINK} color={Button.Colors.PRIMARY} onClick={modalProps.onClose}>
                    Close
                </Button>
            </ModalFooter>
        </ModalRoot>
    );
}

export function openManageSchedulesModal() {
    openModal(modalProps => <ManageSchedulesModalComponent modalProps={modalProps} />);
}

export function ManageSchedulesButton() {
    return (
        <Button onClick={openManageSchedulesModal}>
            Manage Schedules
        </Button>
    );
}
