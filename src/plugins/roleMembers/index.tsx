/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import ErrorBoundary from "@components/ErrorBoundary";
import { Devs } from "@utils/constants";
import { getCurrentGuild } from "@utils/discord";
import definePlugin from "@utils/types";
import { GuildRoleStore, Menu, SelectedGuildStore, useEffect, useRef } from "@webpack/common";

import openAllRolesModal from "./components/AllRolesModal";
import openRoleMembersModal from "./components/RoleMembersModal";

const devContextMenuPatch: NavContextMenuPatchCallback = (children, { id }: { id: string; }) => {
    const guild = getCurrentGuild();
    if (!guild) return;

    const role = GuildRoleStore.getRole(guild.id, id);
    if (!role) return;

    children.push(
        <Menu.MenuGroup>
            <Menu.MenuItem
                id="vc-role-members"
                label="View Role Members"
                action={() => openRoleMembersModal(guild.id, id)}
            />
        </Menu.MenuGroup>
    );
};

const guildContextMenuPatch: NavContextMenuPatchCallback = (children, { guild }: { guild: any; }) => {
    if (!guild?.id) return;

    children.push(
        <Menu.MenuGroup>
            <Menu.MenuItem
                id="vc-view-all-roles"
                label="View All Roles"
                action={() => openAllRolesModal(guild.id)}
            />
        </Menu.MenuGroup>
    );
};

export default definePlugin({
    name: "RoleMembers",
    description: "Click role pills on profiles and in server settings to see a list of members with that role. Right click a server to view all roles.",
    authors: [Devs.UnknownHacker9991],

    patches: [
        {
            find: "#{intl::COLLAPSE_ROLES}",
            replacement: {
                match: /(?<=\.id\)\),\i\(\))(?=,\i\?)/,
                replace: ",$self.RolePillClickWrapper(arguments[0])"
            }
        },
        {
            find: "#{intl::GUILD_SETTINGS_EDIT_ROLE}",
            replacement: {
                match: /onClick:(\i),/,
                replace: "onClick:(e)=>{if(e.shiftKey){$self.onSettingsRoleClick(arguments[0]);return;}$1(e)},"
            }
        }
    ],

    // There is no patchable onClick on the role pill container itself, so a
    // hidden marker attaches a capturing listener to its parent. The listener is
    // scoped with useEffect cleanup (no dedupe flags on DOM nodes), and guildId
    // is read through a ref at click time so a recycled row never opens the
    // modal for a stale guild.
    RolePillClickWrapper: ErrorBoundary.wrap(({ guild }: { guild: { id: string; } | undefined; }) => {
        const guildIdRef = useRef(guild?.id);
        guildIdRef.current = guild?.id;
        const markerRef = useRef<HTMLSpanElement | null>(null);

        useEffect(() => {
            const parent = markerRef.current?.parentElement;
            if (!parent) return;

            const onClick = (e: MouseEvent) => {
                if (e.button !== 0 || e.ctrlKey || e.shiftKey || e.metaKey || e.altKey) return;
                const guildId = guildIdRef.current;
                if (!guildId) return;

                let el = e.target as HTMLElement | null;
                while (el && el !== parent) {
                    const itemId = el.getAttribute("data-list-item-id");
                    if (itemId?.startsWith("roles-")) {
                        const roleId = itemId.slice("roles-".length);
                        if (roleId) {
                            openRoleMembersModal(guildId, roleId);
                            return;
                        }
                    }
                    el = el.parentElement;
                }
            };

            parent.addEventListener("click", onClick, true);
            return () => parent.removeEventListener("click", onClick, true);
        }, []);

        return <span style={{ display: "none" }} ref={markerRef} />;
    }, { noop: true }),

    onSettingsRoleClick(props: any) {
        const roleId = props?.role?.id;
        const guildId = SelectedGuildStore.getGuildId();
        if (!roleId || !guildId) return;
        openRoleMembersModal(guildId, roleId);
    },

    contextMenus: {
        "dev-context": devContextMenuPatch,
        "guild-context": guildContextMenuPatch,
        "guild-header-popout": guildContextMenuPatch
    }
});

