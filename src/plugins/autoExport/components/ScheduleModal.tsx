/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { requestAllMembers } from "@plugins/autoExport/memberMessages";
import {
    addPreset,
    addSchedule,
    BUILT_IN_PRESETS,
    computeNextRun,
    deletePreset,
    ExportFormat,
    ExportSchedule,
    Frequency,
    generateId,
    getPresets,
    SchedulePreset,
    ScheduleType,
    updateSchedule,
} from "@plugins/autoExport/scheduler";
import { ModalCloseButton, ModalContent, ModalFooter, ModalHeader, ModalProps, ModalRoot, ModalSize, openModal } from "@utils/modal";
import { Button, Forms, GuildMemberStore, GuildRoleStore, GuildStore, Select, showToast, Text, TextInput, Toasts, useEffect, useMemo, UserStore, useState } from "@webpack/common";

export interface ScheduleTarget {
    type: ScheduleType;
    targetId: string;
    targetName: string;
    guildId: string;
    guildName: string;
}

const DAY_OPTIONS = [
    { label: "Sunday", value: 0 },
    { label: "Monday", value: 1 },
    { label: "Tuesday", value: 2 },
    { label: "Wednesday", value: 3 },
    { label: "Thursday", value: 4 },
    { label: "Friday", value: 5 },
    { label: "Saturday", value: 6 },
];

const LIMIT_OPTIONS: Array<{ label: string; value: number | null; }> = [
    { label: "Last 100", value: 100 },
    { label: "Last 500", value: 500 },
    { label: "Last 1,000", value: 1000 },
    { label: "Last 5,000", value: 5000 },
    { label: "All messages", value: null },
];

const inputStyle: React.CSSProperties = {
    background: "#1e1f22",
    border: "1px solid #3f4147",
    borderRadius: "4px",
    color: "#dbdee1",
    padding: "6px 8px",
    fontSize: "14px",
};

// Compact searchable checkbox list used for role, member, and server pickers.
function SearchableCheckList({ items, selected, onToggle, placeholder, emptyLabel }: {
    items: Array<{ id: string; label: string; }>;
    selected: Set<string>;
    onToggle: (id: string) => void;
    placeholder: string;
    emptyLabel: string;
}) {
    const [search, setSearch] = useState("");
    const q = search.trim().toLowerCase();
    const filtered = q ? items.filter(i => i.label.toLowerCase().includes(q)) : items;
    const shown = filtered.slice(0, 50);

    return (
        <div style={{ border: "1px solid #3f4147", borderRadius: 4, padding: 8 }}>
            <TextInput value={search} onChange={setSearch} placeholder={placeholder} />
            <div style={{ maxHeight: 150, overflowY: "auto", marginTop: 8, display: "flex", flexDirection: "column", gap: 4 }}>
                {shown.length === 0 ? (
                    <Text variant="text-sm/normal" style={{ color: "var(--text-muted)" }}>{emptyLabel}</Text>
                ) : shown.map(item => (
                    <label key={item.id} style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", color: "#dbdee1", fontSize: 14 }}>
                        <input
                            type="checkbox"
                            checked={selected.has(item.id)}
                            onChange={() => onToggle(item.id)}
                            style={{ width: 16, height: 16, accentColor: "#5865f2", flexShrink: 0 }}
                        />
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.label}</span>
                    </label>
                ))}
                {filtered.length > 50 && (
                    <Text variant="text-xs/normal" style={{ color: "var(--text-muted)" }}>
                        +{filtered.length - 50} more — refine the search to see them
                    </Text>
                )}
            </div>
            <Text variant="text-xs/normal" style={{ color: "var(--text-muted)", marginTop: 4 }}>
                {selected.size} selected
            </Text>
        </div>
    );
}

function ScheduleModalComponent({ modalProps, target, existing }: {
    modalProps: ModalProps;
    target: ScheduleTarget;
    existing?: ExportSchedule;
}) {
    const [name, setName] = useState(existing?.name ?? `${target.targetName} (${target.type})`);
    const [frequency, setFrequency] = useState<Frequency>(existing?.frequency ?? "weekly");
    const [dayOfWeek, setDayOfWeek] = useState(existing?.dayOfWeek ?? 0);
    const [dayOfMonth, setDayOfMonth] = useState(existing?.dayOfMonth ?? 1);
    const [time, setTime] = useState(
        existing
            ? `${String(existing.hour).padStart(2, "0")}:${String(existing.minute).padStart(2, "0")}`
            : "04:00"
    );
    // Old member-roster schedules could be CSV; message exports are html/json only.
    const [format, setFormat] = useState<ExportFormat>(existing?.format === "csv" ? "json" : existing?.format ?? "html");
    const [messageLimit, setMessageLimit] = useState<number | null>(existing?.messageLimit ?? null);
    const [sinceLastRun, setSinceLastRun] = useState(existing?.sinceLastRun ?? true);
    const [presetName, setPresetName] = useState("");
    const [presetsVersion, setPresetsVersion] = useState(0);

    const [includeRoleIds, setIncludeRoleIds] = useState<Set<string>>(new Set(existing?.includeRoleIds ?? []));
    const [excludeRoleIds, setExcludeRoleIds] = useState<Set<string>>(new Set(existing?.excludeRoleIds ?? []));
    const [memberIds, setMemberIds] = useState<Set<string>>(new Set(existing?.memberIds ?? []));
    const [includeBots, setIncludeBots] = useState(existing?.includeBots ?? true);
    const [extraGuildIds, setExtraGuildIds] = useState<Set<string>>(new Set(existing?.extraGuilds?.map(g => g.id) ?? []));
    const [memberVersion, setMemberVersion] = useState(0);

    const isMembers = target.type === "members";
    const multiServer = target.type === "server" || isMembers;
    const formatOptions: ExportFormat[] = ["html", "json"];
    const allPresets = [...BUILT_IN_PRESETS, ...getPresets()];

    // The member picker needs the full member list; request gateway chunks once.
    useEffect(() => {
        if (isMembers) requestAllMembers(target.targetId).then(() => setMemberVersion(v => v + 1));
    }, [target.targetId]);

    const roleItems = useMemo(() => {
        if (!isMembers) return [];
        return GuildRoleStore.getSortedRoles(target.targetId)
            .filter(r => r.id !== target.targetId) // drop @everyone
            .map(r => ({ id: r.id, label: r.name }));
    }, [target.targetId]);

    const memberItems = useMemo(() => {
        if (!isMembers) return [];
        return GuildMemberStore.getMemberIds(target.targetId)
            .map(id => {
                const user = UserStore.getUser(id);
                if (!user) return null;
                const display = user.globalName || user.username;
                return { id, label: display === user.username ? display : `${display} (${user.username})` };
            })
            .filter(Boolean)
            .sort((a, b) => a!.label.localeCompare(b!.label)) as Array<{ id: string; label: string; }>;
    }, [target.targetId, memberVersion]);

    const guildItems = useMemo(() => {
        if (!multiServer) return [];
        return Object.values(GuildStore.getGuilds())
            .filter(g => g.id !== target.targetId)
            .sort((a, b) => a.name.localeCompare(b.name))
            .map(g => ({ id: g.id, label: g.name }));
    }, [target.targetId]);

    const toggleIn = (setter: React.Dispatch<React.SetStateAction<Set<string>>>) => (id: string) => {
        setter(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    function applyPreset(p: SchedulePreset) {
        setFrequency(p.frequency);
        setDayOfWeek(p.dayOfWeek);
        setDayOfMonth(p.dayOfMonth);
        setTime(`${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`);
        setMessageLimit(p.messageLimit);
        setSinceLastRun(p.sinceLastRun);
        if (formatOptions.includes(p.format)) setFormat(p.format);
    }

    function parseTime(): { hour: number; minute: number; } {
        const [h, m] = time.split(":").map(Number);
        return {
            hour: Number.isFinite(h) ? Math.min(23, Math.max(0, h)) : 4,
            minute: Number.isFinite(m) ? Math.min(59, Math.max(0, m)) : 0,
        };
    }

    async function saveCurrentAsPreset() {
        if (!presetName.trim()) return;
        const { hour, minute } = parseTime();
        await addPreset({
            id: generateId(),
            name: presetName.trim(),
            frequency, dayOfWeek, dayOfMonth, hour, minute,
            format, messageLimit, sinceLastRun,
        });
        setPresetName("");
        setPresetsVersion(v => v + 1);
        showToast("Preset saved", Toasts.Type.SUCCESS);
    }

    async function save() {
        const { hour, minute } = parseTime();
        const base = {
            name: name.trim() || target.targetName,
            frequency, dayOfWeek, dayOfMonth, hour, minute,
            format, messageLimit, sinceLastRun,
            extraGuilds: multiServer
                ? [...extraGuildIds].map(id => ({ id, name: GuildStore.getGuild(id)?.name ?? id }))
                : [],
            includeRoleIds: isMembers ? [...includeRoleIds] : [],
            excludeRoleIds: isMembers ? [...excludeRoleIds] : [],
            memberIds: isMembers ? [...memberIds] : [],
            includeBots,
        };

        if (existing) {
            await updateSchedule(existing.id, base);
        } else {
            const schedule: ExportSchedule = {
                id: generateId(),
                type: target.type,
                targetId: target.targetId,
                targetName: target.targetName,
                guildId: target.guildId,
                guildName: target.guildName,
                enabled: true,
                lastRunAt: null,
                nextRunAt: computeNextRun({ frequency, dayOfWeek, dayOfMonth, hour, minute }),
                ...base,
            };
            await addSchedule(schedule);
        }

        showToast(`Schedule "${base.name}" saved`, Toasts.Type.SUCCESS);
        modalProps.onClose();
    }

    const freqButton = (f: Frequency, label: string) => (
        <Button
            size={Button.Sizes.SMALL}
            look={frequency === f ? Button.Looks.FILLED : Button.Looks.OUTLINED}
            color={frequency === f ? Button.Colors.BRAND : Button.Colors.PRIMARY}
            onClick={() => setFrequency(f)}
        >
            {label}
        </Button>
    );

    return (
        <ModalRoot {...modalProps} size={ModalSize.MEDIUM}>
            <ModalHeader separator={false}>
                <div style={{ display: "flex", flexDirection: "column", flex: 1 }}>
                    <Text variant="heading-lg/semibold">
                        {existing ? "Edit Schedule" : "Schedule Auto-Export"}
                    </Text>
                    <Text variant="text-sm/normal" style={{ color: "var(--text-muted)", marginTop: 2 }}>
                        {target.type === "channel" ? `#${target.targetName}` : target.targetName}
                        {target.guildName && target.type === "channel" ? ` — ${target.guildName}` : ""}
                        {isMembers ? " — member messages" : target.type === "server" ? " — all text channels" : ""}
                    </Text>
                </div>
                <ModalCloseButton onClick={modalProps.onClose} />
            </ModalHeader>

            <ModalContent>
                <div style={{ padding: "8px 0 16px", display: "flex", flexDirection: "column", gap: 16 }}>
                    {/* Presets */}
                    <Forms.FormSection>
                        <Forms.FormTitle>Presets</Forms.FormTitle>
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                            {allPresets.map(p => (
                                <Button
                                    key={p.id + presetsVersion}
                                    size={Button.Sizes.SMALL}
                                    look={Button.Looks.OUTLINED}
                                    color={Button.Colors.PRIMARY}
                                    onClick={() => applyPreset(p)}
                                    onContextMenu={e => {
                                        // Right-click a custom preset to delete it
                                        if (p.id.startsWith("builtin-")) return;
                                        e.preventDefault();
                                        deletePreset(p.id).then(() => setPresetsVersion(v => v + 1));
                                    }}
                                >
                                    {p.name}
                                </Button>
                            ))}
                        </div>
                        <Text variant="text-xs/normal" style={{ color: "var(--text-muted)", marginTop: 4 }}>
                            Click to apply. Right-click a custom preset to delete it.
                        </Text>
                    </Forms.FormSection>

                    {/* Name */}
                    <Forms.FormSection>
                        <Forms.FormTitle>Name</Forms.FormTitle>
                        <TextInput value={name} onChange={setName} placeholder="Schedule name..." />
                    </Forms.FormSection>

                    {/* Frequency */}
                    <Forms.FormSection>
                        <Forms.FormTitle>Frequency</Forms.FormTitle>
                        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                            {freqButton("daily", "Daily")}
                            {freqButton("weekly", "Weekly")}
                            {freqButton("monthly", "Monthly")}

                            {frequency === "weekly" && (
                                <Select
                                    options={DAY_OPTIONS}
                                    isSelected={v => v === dayOfWeek}
                                    select={setDayOfWeek}
                                    serialize={v => String(v)}
                                    closeOnSelect={true}
                                />
                            )}
                            {frequency === "monthly" && (
                                <label style={{ display: "flex", alignItems: "center", gap: 6, color: "#dbdee1", fontSize: 14 }}>
                                    Day
                                    <input
                                        type="number"
                                        min={1}
                                        max={28}
                                        value={dayOfMonth}
                                        onChange={e => setDayOfMonth(Math.min(28, Math.max(1, Number(e.target.value) || 1)))}
                                        style={{ ...inputStyle, width: 56 }}
                                    />
                                </label>
                            )}

                            <label style={{ display: "flex", alignItems: "center", gap: 6, color: "#dbdee1", fontSize: 14 }}>
                                at
                                <input
                                    type="time"
                                    value={time}
                                    onChange={e => setTime(e.target.value)}
                                    style={inputStyle}
                                />
                            </label>
                        </div>
                    </Forms.FormSection>

                    {/* Format */}
                    <Forms.FormSection>
                        <Forms.FormTitle>Format</Forms.FormTitle>
                        <div style={{ display: "flex", gap: 8 }}>
                            {formatOptions.map(f => (
                                <Button
                                    key={f}
                                    size={Button.Sizes.SMALL}
                                    look={format === f ? Button.Looks.FILLED : Button.Looks.OUTLINED}
                                    color={format === f ? Button.Colors.BRAND : Button.Colors.PRIMARY}
                                    onClick={() => setFormat(f)}
                                >
                                    {f.toUpperCase()}
                                </Button>
                            ))}
                        </div>
                    </Forms.FormSection>

                    {/* Message options */}
                    <Forms.FormSection>
                        <Forms.FormTitle>{isMembers ? "Messages Per Member" : "Messages"}</Forms.FormTitle>
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
                            {LIMIT_OPTIONS.map(opt => (
                                <Button
                                    key={opt.label}
                                    size={Button.Sizes.SMALL}
                                    look={messageLimit === opt.value ? Button.Looks.FILLED : Button.Looks.OUTLINED}
                                    color={messageLimit === opt.value ? Button.Colors.BRAND : Button.Colors.PRIMARY}
                                    onClick={() => setMessageLimit(opt.value)}
                                >
                                    {opt.label}
                                </Button>
                            ))}
                        </div>
                        <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", color: "#dbdee1" }}>
                            <input
                                type="checkbox"
                                checked={sinceLastRun}
                                onChange={e => setSinceLastRun(e.target.checked)}
                                style={{ width: 18, height: 18, accentColor: "#5865f2" }}
                            />
                            Only export this period's messages ({frequency === "daily" ? "since yesterday" : frequency === "weekly" ? "since last Monday" : "since the 1st of the month"})
                        </label>
                    </Forms.FormSection>

                    {/* Member filters: pick whose messages get exported */}
                    {isMembers && (
                        <Forms.FormSection>
                            <Forms.FormTitle>Member Filters</Forms.FormTitle>
                            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                                <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", color: "#dbdee1" }}>
                                    <input
                                        type="checkbox"
                                        checked={includeBots}
                                        onChange={e => setIncludeBots(e.target.checked)}
                                        style={{ width: 18, height: 18, accentColor: "#5865f2" }}
                                    />
                                    Include bot accounts
                                </label>

                                <div>
                                    <Text variant="text-sm/semibold" style={{ marginBottom: 4 }}>
                                        Only these roles (none selected = all roles)
                                    </Text>
                                    <SearchableCheckList
                                        items={roleItems}
                                        selected={includeRoleIds}
                                        onToggle={toggleIn(setIncludeRoleIds)}
                                        placeholder="Search roles..."
                                        emptyLabel="No roles found."
                                    />
                                </div>

                                <div>
                                    <Text variant="text-sm/semibold" style={{ marginBottom: 4 }}>
                                        Exclude these roles
                                    </Text>
                                    <SearchableCheckList
                                        items={roleItems}
                                        selected={excludeRoleIds}
                                        onToggle={toggleIn(setExcludeRoleIds)}
                                        placeholder="Search roles..."
                                        emptyLabel="No roles found."
                                    />
                                </div>

                                <div>
                                    <Text variant="text-sm/semibold" style={{ marginBottom: 4 }}>
                                        Only specific members (none selected = everyone)
                                    </Text>
                                    <SearchableCheckList
                                        items={memberItems}
                                        selected={memberIds}
                                        onToggle={toggleIn(setMemberIds)}
                                        placeholder="Search members..."
                                        emptyLabel={memberItems.length ? "No members match." : "Loading members..."}
                                    />
                                </div>

                                {extraGuildIds.size > 0 && (
                                    <Text variant="text-xs/normal" style={{ color: "var(--text-muted)" }}>
                                        Members are picked from {target.targetName}; the extra servers below only
                                        add places where their messages are searched.
                                    </Text>
                                )}
                            </div>
                        </Forms.FormSection>
                    )}

                    {/* Additional servers in the same run */}
                    {multiServer && (
                        <Forms.FormSection>
                            <Forms.FormTitle>
                                {isMembers ? "Also search these servers for each member's messages" : "Also export these servers in the same run"}
                            </Forms.FormTitle>
                            <SearchableCheckList
                                items={guildItems}
                                selected={extraGuildIds}
                                onToggle={toggleIn(setExtraGuildIds)}
                                placeholder="Search servers..."
                                emptyLabel="No other servers."
                            />
                            <Text variant="text-xs/normal" style={{ color: "var(--text-muted)", marginTop: 4 }}>
                                {target.targetName} is always included. Servers are {isMembers ? "searched" : "exported"} one after another, never in parallel.
                            </Text>
                        </Forms.FormSection>
                    )}

                    {/* Save as preset */}
                    <Forms.FormSection>
                        <Forms.FormTitle>Save current settings as preset</Forms.FormTitle>
                        <div style={{ display: "flex", gap: 8 }}>
                            <div style={{ flex: 1 }}>
                                <TextInput value={presetName} onChange={setPresetName} placeholder="Preset name..." />
                            </div>
                            <Button size={Button.Sizes.SMALL} disabled={!presetName.trim()} onClick={saveCurrentAsPreset}>
                                Save Preset
                            </Button>
                        </div>
                    </Forms.FormSection>
                </div>
            </ModalContent>

            <ModalFooter>
                <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", width: "100%" }}>
                    <Button look={Button.Looks.LINK} color={Button.Colors.PRIMARY} onClick={modalProps.onClose}>
                        Cancel
                    </Button>
                    <Button color={Button.Colors.BRAND} onClick={save}>
                        {existing ? "Save Changes" : "Create Schedule"}
                    </Button>
                </div>
            </ModalFooter>
        </ModalRoot>
    );
}

export function openScheduleModal(target: ScheduleTarget, existing?: ExportSchedule) {
    openModal(modalProps => (
        <ScheduleModalComponent modalProps={modalProps} target={target} existing={existing} />
    ));
}
