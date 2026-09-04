/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./style.css";

import { ChatBarButton } from "@api/ChatButtons";
import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import { DataStore } from "@api/index";
import { definePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
import { openModal } from "@utils/modal";
import definePlugin, { OptionType } from "@utils/types";
import type { Message } from "@vencord/discord-types";
import { ChannelStore, GuildStore, IconUtils, Menu, showToast, Toasts, UserStore } from "@webpack/common";

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
    /** Your own annotation ("why I saved this"), optional. */
    note?: string;
    savedAt: number;
}

export const settings = definePluginSettings({
    presetTags: {
        type: OptionType.STRING,
        description: "Preset tags offered when saving a note (comma-separated)",
        default: "Important, TODO, Reference",
    },
    maxNotes: {
        type: OptionType.NUMBER,
        description: "Maximum notes to keep - the oldest are dropped past this (0 = unlimited)",
        default: 500,
    },
});

export function presetTagList(): string[] {
    return String(settings.store.presetTags ?? "").split(",").map(s => s.trim()).filter(Boolean);
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
        // Cap the list so it can't grow forever (it previously never did).
        const max = Number(settings.store.maxNotes);
        if (Number.isFinite(max) && max > 0 && list.length > max) list.splice(0, list.length - max);
        return list;
    });
    showToast("Note saved", Toasts.Type.SUCCESS);
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
            onSave={(tag, noteText) => {
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
                    note: noteText || undefined,
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
    settings,
    dependencies: ["ChatInputButtonAPI"],

    contextMenus: {
        "message": messageContextMenuPatch,
    },

    chatBarButton: {
        icon: NotebookIcon,
        render: QuickNotesButton,
    },
});
