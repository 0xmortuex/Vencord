/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./style.css";

import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import * as DataStore from "@api/DataStore";
import definePlugin from "@utils/types";
import { FluxDispatcher, GuildStore, Menu } from "@webpack/common";

import { openInactivityModal } from "./components/InactivityModal";

export const STORAGE_KEY = "vc-inactivity-tracker";
const MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

export interface TrackerData {
    [guildId: string]: {
        [userId: string]: number;
    };
}

async function loadData(): Promise<TrackerData> {
    try {
        return (await DataStore.get<TrackerData>(STORAGE_KEY)) ?? {};
    } catch {
        return {};
    }
}

function saveData(data: TrackerData) {
    // DataStore is async/IndexedDB-backed, so persist in the background. The
    // in-memory `trackerData` stays the synchronous source of truth for the
    // live MESSAGE_CREATE updates.
    DataStore.set(STORAGE_KEY, data).catch(e =>
        console.error("[InactivityTracker] Failed to persist data:", e));
}

function cleanOldEntries(data: TrackerData): TrackerData {
    const cutoff = Date.now() - MAX_AGE_MS;
    for (const guildId in data) {
        for (const userId in data[guildId]) {
            if (data[guildId][userId] < cutoff) {
                delete data[guildId][userId];
            }
        }
        if (Object.keys(data[guildId]).length === 0) {
            delete data[guildId];
        }
    }
    return data;
}

let trackerData: TrackerData = {};

function handleMessageCreate(event: any) {
    const { message } = event;
    if (!message?.author?.id || !message?.guild_id) return;
    if (message.author.bot) return;

    const guildId = message.guild_id;
    const userId = message.author.id;

    if (!trackerData[guildId]) {
        trackerData[guildId] = {};
    }

    trackerData[guildId][userId] = Date.now();
    saveData(trackerData);
}

function makeContextMenuPatch(getGuildId: (props: any) => string | undefined): NavContextMenuPatchCallback {
    return (children, props) => {
        const guildId = getGuildId(props);
        if (!guildId) return;

        const guild = GuildStore.getGuild(guildId);
        if (!guild) return;

        children.push(
            <Menu.MenuGroup>
                <Menu.MenuItem
                    id="vc-view-inactive-members"
                    label="View Inactive Members"
                    action={() => openInactivityModal(guildId)}
                />
            </Menu.MenuGroup>
        );
    };
}

const guildContextMenuPatch = makeContextMenuPatch(props => props?.guild?.id);
const guildHeaderPopoutPatch = makeContextMenuPatch(props => props?.guild?.id);

export default definePlugin({
    name: "InactivityTracker",
    description: "Tracks when each member last sent a message in the current server and shows who's been inactive.",
    authors: [{ name: "UnknownHacker9991", id: 0n }],

    contextMenus: {
        "guild-context": guildContextMenuPatch,
        "guild-header-popout": guildHeaderPopoutPatch,
    },

    async start() {
        trackerData = cleanOldEntries(await loadData());
        saveData(trackerData);
        FluxDispatcher.subscribe("MESSAGE_CREATE", handleMessageCreate);
    },

    stop() {
        FluxDispatcher.unsubscribe("MESSAGE_CREATE", handleMessageCreate);
    },

    getTrackerData(): TrackerData {
        return trackerData;
    },
});

export { trackerData };
