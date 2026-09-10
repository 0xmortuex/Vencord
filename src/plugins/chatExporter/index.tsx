/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./style.css";

import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import { Devs } from "@utils/constants";
import { openModal } from "@utils/modal";
import definePlugin from "@utils/types";
import { ChannelStore, GuildStore, Menu } from "@webpack/common";

import { BulkServerExportModal } from "./components/BulkServerExportModal";
import { ExportModal } from "./components/ExportModal";
import { ServerExportModal } from "./components/ServerExportModal";
import { settings } from "./settings";

function openExportModal(channelId: string) {
    const channel = ChannelStore.getChannel(channelId);
    if (!channel) return;

    const guild = channel.guild_id ? GuildStore.getGuild(channel.guild_id) : null;
    const channelName = channel.name || "DM";
    const serverName = guild?.name || "Direct Messages";

    openModal(modalProps => (
        <ExportModal
            modalProps={modalProps}
            channelId={channelId}
            channelName={channelName}
            serverName={serverName}
        />
    ));
}

function openServerExportModal(guildId: string) {
    const guild = GuildStore.getGuild(guildId);
    if (!guild) return;

    openModal(modalProps => (
        <ServerExportModal
            modalProps={modalProps}
            guildId={guildId}
            guildName={guild.name}
        />
    ));
}

function openBulkServerExportModal(initialGuildId?: string) {
    openModal(modalProps => (
        <BulkServerExportModal
            modalProps={modalProps}
            initialGuildId={initialGuildId}
        />
    ));
}

const channelContextPatch: NavContextMenuPatchCallback = (children, { channel }) => {
    if (!channel) return;

    const group = findGroupChildrenByChildId("mark-channel-read", children) ?? children;
    group.push(
        <Menu.MenuItem
            id="vc-export-chat"
            label="Export Chat"
            action={() => openExportModal(channel.id)}
        />
    );
};

const dmContextPatch: NavContextMenuPatchCallback = (children, { channel }) => {
    if (!channel) return;

    const group = findGroupChildrenByChildId("close-dm", children) ?? children;
    group.push(
        <Menu.MenuItem
            id="vc-export-chat"
            label="Export Chat"
            action={() => openExportModal(channel.id)}
        />
    );
};

const gdmContextPatch: NavContextMenuPatchCallback = (children, { channel }) => {
    if (!channel) return;

    children.push(
        <Menu.MenuItem
            id="vc-export-chat"
            label="Export Chat"
            action={() => openExportModal(channel.id)}
        />
    );
};

const guildContextPatch: NavContextMenuPatchCallback = (children, { guild }) => {
    if (!guild) return;

    const group = findGroupChildrenByChildId("privacy", children) ?? children;
    group.push(
        <Menu.MenuItem
            id="vc-export-server"
            label="Export Server"
            action={() => openServerExportModal(guild.id)}
        />
    );
    group.push(
        <Menu.MenuItem
            id="vc-bulk-export-servers"
            label="Bulk Export Servers…"
            action={() => openBulkServerExportModal(guild.id)}
        />
    );
};

export default definePlugin({
    name: "ChatExporter",
    description: "Export messages from any channel, DM, group chat, or entire server (one or many servers at once) as HTML or JSON files",
    authors: [Devs.UnknownHacker9991],
    settings,

    contextMenus: {
        "channel-context": channelContextPatch,
        "thread-context": channelContextPatch,
        "user-context": dmContextPatch,
        "gdm-context": gdmContextPatch,
        "guild-context": guildContextPatch,
        "guild-header-popout": guildContextPatch,
    },
});
