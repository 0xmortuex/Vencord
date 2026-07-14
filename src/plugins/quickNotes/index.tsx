/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./style.css";

import { ChatBarButton } from "@api/ChatButtons";
import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import { DataStore } from "@api/index";
import { Devs } from "@utils/constants";
import { openModal } from "@utils/modal";
import definePlugin from "@utils/types";
import type { Message } from "@vencord/discord-types";
import { ChannelStore, GuildStore, IconUtils, Menu, UserStore } from "@webpack/common";

import { NotesModal } from "./components/NotesModal";
import { SaveNoteModal } from "./components/SaveNoteModal";

export const STORAGE_KEY = "vc-quick-notes";

export interface Note {
    id: string;
    messageId: string;
    channelId: string;
    guildId: string;
    guildName: string;
    channelName: string;
    authorId: string;
    authorName: string;
    authorAvatar: string;
    content: string;
    tag: string;
    savedAt: number;
}

function generateId(): string {
    return Date.now().toString(36) + Math.random().toString(36);
}

// DataStore.update runs get+set in one IndexedDB transaction, so saving while
// the notes panel (which also writes on delete) is open can't lose entries.
async function saveNote(note: Note) {
    await DataStore.update<Note[]>(STORAGE_KEY, notes => {
        const list = notes ?? [];
        list.push(note);
        return list;
    });
}

function openNotesModal() {
    openModal(modalProps => <NotesModal modalProps={modalProps} />);
}

function openSaveNoteModal(message: Message) {
    const channel = ChannelStore.getChannel(message.channel_id);
    const guild = channel?.guild_id ? GuildStore.getGuild(channel.guild_id) : null;
    const author = UserStore.getUser(message.author.id);

    openModal(modalProps => (
        <SaveNoteModal
            modalProps={modalProps}
            onSave={tag => {
                saveNote({
                    id: generateId(),
                    messageId: message.id,
                    channelId: message.channel_id,
                    guildId: guild?.id ?? "",
                    guildName: guild?.name ?? "Direct Messages",
                    channelName: channel?.name ?? "Unknown",
                    authorId: message.author.id,
                    authorName: author?.globalName ?? message.author.username,
                    authorAvatar: author ? IconUtils.getUserAvatarURL(author, false, 64) : "",
                    content: message.content ?? "",
                    tag,
                    savedAt: Date.now(),
                });
            }}
        />
    ));
}

function NotebookIcon() {
    return (
        <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor">
            <path d="M6 2a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H6zm0 2h12v16H6V4zm2 2v2h8V6H8zm0 4v2h8v-2H8zm0 4v2h5v-2H8z" />
        </svg>
    );
}

const QuickNotesButton = ({ isMainChat }: { isMainChat: boolean; }) => {
    if (!isMainChat) return null;

    return (
        <ChatBarButton
            tooltip="Quick Notes"
            onClick={openNotesModal}
        >
            <NotebookIcon />
        </ChatBarButton>
    );
};

const messageContextMenuPatch: NavContextMenuPatchCallback = (children, { message }: { message: Message; }) => {
    if (!message) return;

    const group = findGroupChildrenByChildId("copy-text", children);
    if (!group) {
        children.push(
            <Menu.MenuGroup>
                <Menu.MenuItem
                    id="vc-save-as-note"
                    label="Save as Note"
                    action={() => openSaveNoteModal(message)}
                />
                <Menu.MenuItem
                    id="vc-view-notes"
                    label="View Notes"
                    action={openNotesModal}
                />
            </Menu.MenuGroup>
        );
        return;
    }

    group.push(
        <Menu.MenuItem
            id="vc-save-as-note"
            label="Save as Note"
            action={() => openSaveNoteModal(message)}
        />,
        <Menu.MenuItem
            id="vc-view-notes"
            label="View Notes"
            action={openNotesModal}
        />
    );
};

export default definePlugin({
    name: "QuickNotes",
    description: "Save messages as notes with tags and view them anytime from a notes panel.",
    authors: [Devs.UnknownHacker9991],
    dependencies: ["ChatInputButtonAPI"],

    contextMenus: {
        "message": messageContextMenuPatch,
    },

    chatBarButton: {
        icon: NotebookIcon,
        render: QuickNotesButton,
    },
});
