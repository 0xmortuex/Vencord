/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { definePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
import definePlugin, { OptionType } from "@utils/types";
import type { Channel } from "@vencord/discord-types";
import { Menu, UserStore } from "@webpack/common";

import { ManageSchedulesButton, openManageSchedulesModal } from "./components/ManageSchedulesModal";
import { openScheduleModal, ScheduleTarget } from "./components/ScheduleModal";
import { getSchedules, loadAll, startScheduler, stopScheduler } from "./scheduler";

const settings = definePluginSettings({
    manageSchedules: {
        type: OptionType.COMPONENT,
        description: "View, edit, run, and delete your auto-export schedules",
        component: ManageSchedulesButton,
    },
});

function channelTargetOf(channel: Channel): ScheduleTarget {
    // DM channels have no name; label them by recipient like the exporters do.
    let { name } = channel;
    if (!name) {
        const recipients = (channel.recipients ?? [])
            .map((id: string) => UserStore.getUser(id))
            .filter(Boolean)
            .map(u => u!.globalName || u!.username);
        name = recipients.join(", ") || channel.id;
    }
    return {
        type: "channel",
        targetId: channel.id,
        targetName: name,
        guildId: channel.guild_id ?? "",
        guildName: "", // filled by callers that know the guild
    };
}

const channelContextMenuPatch: NavContextMenuPatchCallback = (children, { channel, guild }: { channel: Channel; guild?: { id: string; name: string; }; }) => {
    if (!channel) return;

    const target = channelTargetOf(channel);
    if (guild) target.guildName = guild.name;

    children.push(
        <Menu.MenuGroup>
            <Menu.MenuItem
                id="vc-autoexport-schedule"
                label="Schedule Auto-Export"
                action={() => openScheduleModal(target)}
            />
        </Menu.MenuGroup>
    );
};

const guildContextMenuPatch: NavContextMenuPatchCallback = (children, { guild }: { guild?: { id: string; name: string; }; }) => {
    if (!guild?.id) return;

    const base = { targetId: guild.id, targetName: guild.name, guildId: guild.id, guildName: guild.name };

    children.push(
        <Menu.MenuGroup>
            <Menu.MenuItem id="vc-autoexport-menu" label="Auto-Export">
                <Menu.MenuItem
                    id="vc-autoexport-server"
                    label="Schedule Server Export"
                    action={() => openScheduleModal({ ...base, type: "server" })}
                />
                <Menu.MenuItem
                    id="vc-autoexport-members"
                    label="Schedule Member Messages Export"
                    action={() => openScheduleModal({ ...base, type: "members" })}
                />
                {getSchedules().length > 0 && (
                    <Menu.MenuItem
                        id="vc-autoexport-manage"
                        label="Manage Schedules"
                        action={openManageSchedulesModal}
                    />
                )}
            </Menu.MenuItem>
        </Menu.MenuGroup>
    );
};

export default definePlugin({
    name: "AutoExport",
    description: "Automatically export channels, servers, and member messages on a schedule (daily/weekly/monthly) with reusable presets and incremental since-last-run exports.",
    authors: [Devs.UnknownHacker9991],
    settings,

    contextMenus: {
        "channel-context": channelContextMenuPatch,
        "thread-context": channelContextMenuPatch,
        "gdm-context": channelContextMenuPatch,
        "user-context": channelContextMenuPatch,
        "guild-context": guildContextMenuPatch,
    },

    async start() {
        await loadAll();
        startScheduler();
    },

    stop() {
        stopScheduler();
    },
});
