/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { Devs } from "@utils/constants";
import { openModal } from "@utils/modal";
import definePlugin from "@utils/types";
import type { User } from "@vencord/discord-types";
import { Menu } from "@webpack/common";

import { UserExportModal } from "./components/UserExportModal";

interface UserContextProps {
    user: User;
}

function openUserExportModal(user: User) {
    openModal(modalProps => (
        <UserExportModal
            modalProps={modalProps}
            user={{
                id: user.id,
                username: user.username,
                globalName: (user as any).globalName ?? null,
                avatar: user.avatar,
            }}
        />
    ));
}

const userContextPatch: NavContextMenuPatchCallback = (children, { user }: UserContextProps) => {
    if (!user) return;

    children.push(
        <Menu.MenuItem
            id="vc-user-exporter"
            label="Export User Messages"
            action={() => openUserExportModal(user)}
        />
    );
};

export default definePlugin({
    name: "UserExporter",
    description: "Export all messages sent by a user across shared servers and channels as HTML or JSON",
    authors: [Devs.UnknownHacker9991],

    contextMenus: {
        "user-context": userContextPatch,
    },
});
