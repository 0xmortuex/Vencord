/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import { Devs } from "@utils/constants";
import { openModal } from "@utils/modal";
import definePlugin from "@utils/types";
import { Menu } from "@webpack/common";

import { ServerMemberExportModal } from "./components/ServerMemberExportModal";

function openMemberExportModal(guildId: string, guildName: string) {
    openModal(modalProps => (
        <ServerMemberExportModal
            modalProps={modalProps}
            guildId={guildId}
            guildName={guildName}
        />
    ));
}

const guildContextPatch: NavContextMenuPatchCallback = (children, { guild }) => {
    if (!guild) return;

    const group = findGroupChildrenByChildId("privacy", children) ?? children;
    group.push(
        <Menu.MenuItem
            id="vc-export-server-members"
            label="Export Member Messages"
            action={() => openMemberExportModal(guild.id, guild.name)}
        />
    );
};

export default definePlugin({
    name: "ServerMemberExporter",
    description: "Right-click a server to pick members and export their messages (HTML or JSON) with date, limit, and combine filters",
    authors: [Devs.UnknownHacker9991],

    contextMenus: {
        "guild-context": guildContextPatch,
        "guild-header-popout": guildContextPatch,
    },
});
