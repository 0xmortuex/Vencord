/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { VirtualList } from "@components/VirtualList";
import { getChannelLabel } from "@plugins/messageLoggerEnhanced";
import { clearDeletedMessages, DeletedMessage, getCacheStats, getDeletedMessages, removeDeletedMessage, removeDeletedMessages, subscribeDeleted } from "@plugins/messageLoggerEnhanced/store";
import { classNameFactory } from "@utils/css";
import { ModalCloseButton, ModalContent, ModalFooter, ModalHeader, ModalProps, ModalRoot, ModalSize } from "@utils/modal";
import { saveFile } from "@utils/web";
import { Alerts, Button, GuildStore, NavigationRouter, Select, showToast, Text, Toasts, useEffect, useMemo, useState } from "@webpack/common";

const cl = classNameFactory("vc-mlenhanced-");

function formatTimestamp(ts: string | number): string {
    const date = new Date(ts);
    return date.toLocaleString();
}

function formatRelative(ts: number): string {
    const diff = Date.now() - ts;
    const minutes = Math.floor(diff / 60000);
    if (minutes < 1) return "Just now";
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days === 1) return "Yesterday";
    if (days < 30) return `${days} days ago`;
    return `${Math.floor(days / 30)} month(s) ago`;
}

function truncate(str: string, max: number): string {
    return str.length > max ? str.slice(0, max) + "..." : str;
}

interface GhostMessagesModalProps {
    modalProps: ModalProps;
    initialChannelId?: string;
}

export function GhostMessagesModal({ modalProps, initialChannelId }: GhostMessagesModalProps) {
    const [messages, setMessages] = useState<DeletedMessage[]>([]);
    const [filterGuild, setFilterGuild] = useState("");
    const [filterChannel, setFilterChannel] = useState(initialChannelId ?? "");
    const [filterUser, setFilterUser] = useState("");
    const [filterContent, setFilterContent] = useState("");
    const [dateFrom, setDateFrom] = useState("");
    const [dateTo, setDateTo] = useState("");
    const [sortOrder, setSortOrder] = useState<"newest" | "oldest">("newest");

    useEffect(() => {
        getDeletedMessages().then(setMessages);
        // Refresh live: ghost deletes that arrive while the modal is open show up.
        return subscribeDeleted(() => { getDeletedMessages().then(setMessages); });
    }, []);

    const allGuilds = useMemo(() => {
        const map = new Map<string, string>();
        for (const m of messages) {
            const id = m.guildId || "DM";
            if (!map.has(id)) {
                const guild = m.guildId ? GuildStore.getGuild(m.guildId) : null;
                map.set(id, guild?.name ?? "Direct Messages");
            }
        }
        return [...map.entries()];
    }, [messages]);

    const availableChannels = useMemo(() => {
        const map = new Map<string, string>();
        for (const m of messages) {
            if (filterGuild && (m.guildId || "DM") !== filterGuild) continue;
            if (!map.has(m.channelId)) {
                map.set(m.channelId, getChannelLabel(m.channelId));
            }
        }
        return [...map.entries()];
    }, [messages, filterGuild]);

    const filtered = useMemo(() => {
        let result = [...messages];

        if (filterGuild) {
            result = result.filter(m => (m.guildId || "DM") === filterGuild);
        }

        if (filterChannel) {
            result = result.filter(m => m.channelId === filterChannel);
        }

        if (filterUser.trim()) {
            const q = filterUser.toLowerCase();
            result = result.filter(m => m.authorUsername.toLowerCase().includes(q));
        }

        if (filterContent.trim()) {
            const q = filterContent.toLowerCase();
            result = result.filter(m =>
                m.content.toLowerCase().includes(q) ||
                m.attachments.some(a => a.filename.toLowerCase().includes(q)));
        }

        if (dateFrom) {
            const from = new Date(dateFrom).getTime();
            if (Number.isFinite(from)) result = result.filter(m => m.deletedAt >= from);
        }
        if (dateTo) {
            const to = new Date(dateTo).getTime() + 24 * 60 * 60 * 1000; // inclusive day
            if (Number.isFinite(to)) result = result.filter(m => m.deletedAt < to);
        }

        result.sort((a, b) =>
            sortOrder === "newest" ? b.deletedAt - a.deletedAt : a.deletedAt - b.deletedAt
        );

        return result;
    }, [messages, filterGuild, filterChannel, filterUser, filterContent, dateFrom, dateTo, sortOrder]);

    async function handleDelete(id: string) {
        await removeDeletedMessage(id);
        setMessages(prev => prev.filter(m => m.id !== id));
    }

    async function handleClearAll() {
        await clearDeletedMessages();
        setMessages([]);
    }
    async function handleRemoveShown() {
        const ids = filtered.map(m => m.id);
        await removeDeletedMessages(ids);
        const gone = new Set(ids);
        setMessages(prev => prev.filter(m => !gone.has(m.id)));
        showToast(`Removed ${ids.length} ghost message${ids.length === 1 ? "" : "s"}`, Toasts.Type.SUCCESS);
    }
    function exportShown(format: "json" | "txt") {
        const stamp = new Date().toISOString().split("T")[0];
        if (format === "json") {
            saveFile(new File([JSON.stringify(filtered, null, 2)], `ghost-messages-${stamp}.json`, { type: "application/json" }));
        } else {
            const lines = filtered.map(m => {
                const guild = m.guildId ? GuildStore.getGuild(m.guildId)?.name ?? m.guildId : "Direct Messages";
                const where = `${guild} / ${getChannelLabel(m.channelId)}`;
                const att = m.attachments.length ? `\n  [attachments: ${m.attachments.map(a => a.filename).join(", ")}]` : "";
                return `[${formatTimestamp(m.timestamp)}] ${m.authorUsername} in ${where} (deleted ${formatTimestamp(m.deletedAt)})\n  ${m.content || "(no text content)"}${att}`;
            });
            saveFile(new File([lines.join("\n\n")], `ghost-messages-${stamp}.txt`, { type: "text/plain" }));
        }
        showToast(`Exported ${filtered.length} ghost message${filtered.length === 1 ? "" : "s"}`, Toasts.Type.SUCCESS);
    }

    function jumpToChannel(msg: DeletedMessage) {
        const guildPart = msg.guildId || "@me";
        NavigationRouter.transitionTo(`/channels/${guildPart}/${msg.channelId}`);
        modalProps.onClose();
    }

    const guildOptions = [
        { label: "All Servers", value: "" },
        ...allGuilds.map(([id, name]) => ({ label: name, value: id })),
    ];

    const channelOptions = [
        { label: "All Channels", value: "" },
        ...availableChannels.map(([id, label]) => ({ label, value: id })),
    ];

    const sortOptions = [
        { label: "Newest First", value: "newest" as const },
        { label: "Oldest First", value: "oldest" as const },
    ];

    return (
        <ModalRoot {...modalProps} size={ModalSize.LARGE}>
            <ModalHeader separator={false}>
                <div style={{ display: "flex", flexDirection: "column", flex: 1 }}>
                    <Text variant="heading-lg/semibold" className={cl("header")}>
                        Ghost Messages
                    </Text>
                    {/* Live health indicator: if this stays at 0 while messages
                        arrive, the caching pipeline is broken - the number one
                        thing to check when "nothing shows up". */}
                    <Text variant="text-sm/normal" style={{ color: "var(--text-muted)", marginTop: 2 }}>
                        Watching {getCacheStats().messages} cached messages this session
                    </Text>
                </div>
                <ModalCloseButton onClick={modalProps.onClose} />
            </ModalHeader>

            <div className={cl("filters")}>
                <input
                    type="text"
                    placeholder="Filter by username..."
                    value={filterUser}
                    onChange={e => setFilterUser(e.target.value)}
                    className={cl("search")}
                />
                <input
                    type="text"
                    placeholder="Search message text / attachment names..."
                    value={filterContent}
                    onChange={e => setFilterContent(e.target.value)}
                    className={cl("search")}
                />
                <div className={cl("filter-row")} style={{ alignItems: "center", gap: "8px" }}>
                    <Text variant="text-xs/normal" style={{ color: "var(--text-muted)" }}>Deleted between</Text>
                    <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} className={cl("search")} style={{ width: "auto" }} />
                    <Text variant="text-xs/normal" style={{ color: "var(--text-muted)" }}>and</Text>
                    <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} className={cl("search")} style={{ width: "auto" }} />
                    {(dateFrom || dateTo) && (
                        <Button size={Button.Sizes.TINY} look={Button.Looks.LINK} onClick={() => { setDateFrom(""); setDateTo(""); }}>Clear dates</Button>
                    )}
                </div>

                <div className={cl("filter-row")}>
                    <Select
                        options={guildOptions}
                        isSelected={v => v === filterGuild}
                        select={v => { setFilterGuild(v); setFilterChannel(""); }}
                        serialize={v => v}
                        closeOnSelect={true}
                    />

                    <Select
                        options={channelOptions}
                        isSelected={v => v === filterChannel}
                        select={v => setFilterChannel(v)}
                        serialize={v => v}
                        closeOnSelect={true}
                    />

                    <Select
                        options={sortOptions}
                        isSelected={v => v === sortOrder}
                        select={v => setSortOrder(v)}
                        serialize={v => v}
                        closeOnSelect={true}
                    />

                    <Text variant="text-sm/normal" className={cl("count")}>
                        {filtered.length} message{filtered.length !== 1 ? "s" : ""}
                    </Text>
                </div>
            </div>

            <ModalContent>
                {filtered.length === 0 ? (
                    <div className={cl("empty")}>
                        {messages.length === 0
                            ? "No ghost messages caught yet. Deleted messages from unopened channels will appear here."
                            : "No messages match your filters."}
                    </div>
                ) : (
                    <VirtualList items={filtered} rowHeight={150} height={460} keyOf={m => m.id + m.deletedAt} renderRow={msg => {
                        const guild = msg.guildId ? GuildStore.getGuild(msg.guildId) : null;
                        const channelLabel = getChannelLabel(msg.channelId);
                        const guildName = guild?.name ?? "Direct Messages";

                        return (
                            <div key={msg.id + msg.deletedAt} className={cl("card")}>
                                <div className={cl("card-header")}>
                                    {msg.authorAvatar && (
                                        <img
                                            src={msg.authorAvatar}
                                            alt=""
                                            loading="lazy"
                                            className={cl("avatar")}
                                        />
                                    )}
                                    <Text variant="text-md/semibold" className={cl("author")}>
                                        {msg.authorUsername}
                                    </Text>
                                    <Text variant="text-xs/normal" className={cl("channel")}>
                                        {guildName} / {channelLabel}
                                    </Text>
                                    <Text variant="text-xs/normal" className={cl("timestamp")}>
                                        Sent {formatTimestamp(msg.timestamp)}
                                    </Text>
                                </div>

                                <div className={cl("deleted-at")}>
                                    Deleted {formatRelative(msg.deletedAt)}
                                </div>

                                <div className={cl("content")}>
                                    {msg.content
                                        ? truncate(msg.content, 500)
                                        : <span className={cl("no-content")}>(no text content)</span>
                                    }
                                </div>

                                {msg.attachments.length > 0 && (
                                    <div className={cl("attachments")}>
                                        {msg.attachments.map((a, i) => (
                                            <span key={i} className={cl("attachment")}>
                                                {a.filename}
                                            </span>
                                        ))}
                                    </div>
                                )}

                                <div className={cl("actions")}>
                                    <button
                                        className={cl("jump-btn")}
                                        onClick={() => jumpToChannel(msg)}
                                    >
                                        Jump to Channel
                                    </button>
                                    <button
                                        className={cl("delete-btn")}
                                        onClick={() => {
                                            Alerts.show({
                                                title: "Remove Ghost Message",
                                                body: "Remove this entry from the ghost log?",
                                                confirmText: "Remove",
                                                confirmColor: "vc-notification-log-danger-btn",
                                                cancelText: "Cancel",
                                                onConfirm: () => handleDelete(msg.id),
                                            });
                                        }}
                                    >
                                        Remove
                                    </button>
                                </div>
                            </div>
                        );
                    }} />
                )}
            </ModalContent>

            <ModalFooter>
                <div className={cl("footer")}>
                    {filtered.length > 0 && (
                        <>
                            <Button look={Button.Looks.LINK} color={Button.Colors.PRIMARY} onClick={() => exportShown("json")}>
                                Export JSON ({filtered.length})
                            </Button>
                            <Button look={Button.Looks.LINK} color={Button.Colors.PRIMARY} onClick={() => exportShown("txt")}>
                                Export TXT
                            </Button>
                            {filtered.length < messages.length && (
                                <Button
                                    look={Button.Looks.LINK}
                                    color={Button.Colors.RED}
                                    onClick={() => Alerts.show({
                                        title: "Remove Shown Ghost Messages",
                                        body: `Remove the ${filtered.length} entries matching your current filters?`,
                                        confirmText: "Remove shown",
                                        confirmColor: "vc-notification-log-danger-btn",
                                        cancelText: "Cancel",
                                        onConfirm: handleRemoveShown,
                                    })}
                                >
                                    Remove shown ({filtered.length})
                                </Button>
                            )}
                        </>
                    )}
                    {messages.length > 0 && (
                        <Button
                            look={Button.Looks.LINK}
                            color={Button.Colors.RED}
                            onClick={() => {
                                Alerts.show({
                                    title: "Clear All Ghost Messages",
                                    body: "Are you sure? This cannot be undone.",
                                    confirmText: "Clear All",
                                    confirmColor: "vc-notification-log-danger-btn",
                                    cancelText: "Cancel",
                                    onConfirm: handleClearAll,
                                });
                            }}
                        >
                            Clear All
                        </Button>
                    )}
                    <Button look={Button.Looks.LINK} color={Button.Colors.PRIMARY} onClick={modalProps.onClose}>
                        Close
                    </Button>
                </div>
            </ModalFooter>
        </ModalRoot>
    );
}
