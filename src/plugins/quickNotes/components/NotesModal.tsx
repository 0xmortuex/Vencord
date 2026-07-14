/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { DataStore } from "@api/index";
import { classNameFactory } from "@utils/css";
import { ModalCloseButton, ModalContent, ModalFooter, ModalHeader, ModalProps, ModalRoot, ModalSize } from "@utils/modal";
import { Alerts, Button, NavigationRouter, Select, Text, useEffect, useMemo, useState } from "@webpack/common";

import { Note, STORAGE_KEY } from "..";

const cl = classNameFactory("vc-quicknotes-");

const TAG_COLORS: Record<string, string> = {
    Important: "#ed4245",
    TODO: "#faa61a",
    CUSA: "#5865f2",
    Reference: "#3ba55c",
};

function getTagColor(tag: string): string {
    return TAG_COLORS[tag] ?? "#9b59b6";
}

function formatSavedAt(timestamp: number): string {
    const diff = Date.now() - timestamp;
    const minutes = Math.floor(diff / 60000);
    if (minutes < 1) return "Just now";
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days === 1) return "Yesterday";
    if (days < 30) return `${days} days ago`;
    const months = Math.floor(days / 30);
    return `${months} month${months > 1 ? "s" : ""} ago`;
}

export function NotesModal({ modalProps }: { modalProps: ModalProps; }) {
    const [notes, setNotes] = useState<Note[]>([]);
    const [search, setSearch] = useState("");
    const [filterTag, setFilterTag] = useState("");
    const [filterGuild, setFilterGuild] = useState("");
    const [sortOrder, setSortOrder] = useState<"newest" | "oldest">("newest");

    useEffect(() => {
        DataStore.get(STORAGE_KEY).then((data: Note[] | undefined) => {
            setNotes(data ?? []);
        });
    }, []);

    const allTags = useMemo(() => [...new Set(notes.map(n => n.tag).filter(Boolean))], [notes]);
    const allGuilds = useMemo(() => {
        const map = new Map<string, string>();
        for (const n of notes) {
            if (n.guildId && n.guildName) map.set(n.guildId, n.guildName);
        }
        return [...map.entries()];
    }, [notes]);

    const filtered = useMemo(() => {
        let result = [...notes];

        if (search.trim()) {
            const q = search.toLowerCase();
            result = result.filter(n =>
                n.content.toLowerCase().includes(q) ||
                n.authorName.toLowerCase().includes(q) ||
                n.channelName.toLowerCase().includes(q)
            );
        }

        if (filterTag) {
            result = result.filter(n => n.tag === filterTag);
        }

        if (filterGuild) {
            result = result.filter(n => n.guildId === filterGuild);
        }

        result.sort((a, b) =>
            sortOrder === "newest" ? b.savedAt - a.savedAt : a.savedAt - b.savedAt
        );

        return result;
    }, [notes, search, filterTag, filterGuild, sortOrder]);

    async function deleteNote(id: string) {
        setNotes(prev => prev.filter(n => n.id !== id));
        // Filter inside DataStore.update (one IndexedDB transaction) rather than
        // writing back this component's snapshot - a note saved from the context
        // menu while the panel is open would be wiped by a stale-array write.
        await DataStore.update<Note[]>(STORAGE_KEY, stored =>
            (stored ?? []).filter(n => n.id !== id));
    }

    function jumpToMessage(note: Note) {
        const guildPart = note.guildId || "@me";
        NavigationRouter.transitionTo(`/channels/${guildPart}/${note.channelId}/${note.messageId}`);
        modalProps.onClose();
    }

    const tagOptions = [
        { label: "All Tags", value: "" },
        ...allTags.map(t => ({ label: t, value: t })),
    ];

    const guildOptions = [
        { label: "All Servers", value: "" },
        ...allGuilds.map(([id, name]) => ({ label: name, value: id })),
    ];

    const sortOptions = [
        { label: "Newest First", value: "newest" as const },
        { label: "Oldest First", value: "oldest" as const },
    ];

    return (
        <ModalRoot {...modalProps} size={ModalSize.LARGE}>
            <ModalHeader separator={false}>
                <Text variant="heading-lg/semibold" className={cl("header")}>
                    Quick Notes
                </Text>
                <ModalCloseButton onClick={modalProps.onClose} />
            </ModalHeader>

            <div className={cl("filters")}>
                <input
                    type="text"
                    placeholder="Search notes..."
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    className={cl("search")}
                />

                <div className={cl("filter-row")}>
                    <Select
                        options={tagOptions}
                        isSelected={v => v === filterTag}
                        select={v => setFilterTag(v)}
                        serialize={v => v}
                        closeOnSelect={true}
                    />

                    <Select
                        options={guildOptions}
                        isSelected={v => v === filterGuild}
                        select={v => setFilterGuild(v)}
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
                        {filtered.length} note{filtered.length !== 1 ? "s" : ""}
                    </Text>
                </div>
            </div>

            <ModalContent>
                {filtered.length === 0 ? (
                    <div className={cl("empty")}>
                        {notes.length === 0 ? "No notes yet. Right-click a message to save one!" : "No notes match your filters."}
                    </div>
                ) : (
                    filtered.map(note => (
                        <div key={note.id} className={cl("card")}>
                            <div className={cl("card-header")}>
                                <img
                                    src={note.authorAvatar || undefined}
                                    alt=""
                                    className={cl("avatar")}
                                />
                                <Text variant="text-md/semibold" className={cl("author")}>
                                    {note.authorName}
                                </Text>
                                <Text variant="text-xs/normal" className={cl("channel")}>
                                    {note.guildName ? `${note.guildName} / #${note.channelName}` : `#${note.channelName}`}
                                </Text>
                                {note.tag && (
                                    <span
                                        className={cl("tag")}
                                        style={{ background: getTagColor(note.tag) }}
                                    >
                                        {note.tag}
                                    </span>
                                )}
                                <Text variant="text-xs/normal" className={cl("saved-at")}>
                                    Saved {formatSavedAt(note.savedAt)}
                                </Text>
                            </div>

                            <div className={cl("content")}>
                                {note.content || <span className={cl("no-content")}>(no text content)</span>}
                            </div>

                            <div className={cl("actions")}>
                                <button
                                    className={cl("jump-btn")}
                                    onClick={() => jumpToMessage(note)}
                                >
                                    Jump to Message
                                </button>
                                <button
                                    className={cl("delete-btn")}
                                    onClick={() => {
                                        Alerts.show({
                                            title: "Delete Note",
                                            body: "Are you sure you want to delete this note?",
                                            confirmText: "Delete",
                                            confirmColor: "vc-notification-log-danger-btn",
                                            cancelText: "Cancel",
                                            onConfirm: () => deleteNote(note.id),
                                        });
                                    }}
                                >
                                    Delete Note
                                </button>
                            </div>
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
