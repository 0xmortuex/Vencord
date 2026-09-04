/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import { Devs } from "@utils/constants";
import definePlugin, { OptionType, StartAt } from "@utils/types";
import { Channel } from "@vencord/discord-types";
import { findCssClassesLazy, findStoreLazy } from "@webpack";
import { Menu, React, UserStore } from "@webpack/common";

import { openAddNoteModal } from "./components/AddNoteModal";
import { DMItemWrapper } from "./components/DMItem";
import { FolderHeader } from "./components/FolderHeader";
import { ManageFoldersButton } from "./components/FolderSettings";
import {
    addDmToFolder,
    Folder,
    getData,
    getSearchQuery,
    isInFolder,
    isPriority,
    loadData,
    removeDmFromFolder,
    togglePriority,
    useDMOrganizer,
} from "./store";

interface ChannelComponentProps {
    children: React.ReactNode;
    channel: Channel;
    selected: boolean;
}

const headerClasses = findCssClassesLazy("privateChannelsHeaderContainer", "headerText");

const PrivateChannelSortStore = findStoreLazy("PrivateChannelSortStore") as { getPrivateChannelIds: () => string[]; };

export const settings = definePluginSettings({
    showUnreadCounts: {
        type: OptionType.BOOLEAN,
        description: "Show unread counts on folder headers",
        default: true,
    },
    enableDragAndDrop: {
        type: OptionType.BOOLEAN,
        description: "Enable drag and drop to organize DMs into folders",
        default: true,
    },
    manageFolders: {
        type: OptionType.COMPONENT,
        description: "Create, edit, and delete DM folders",
        component: ManageFoldersButton,
    },
});

// Context menu patches
function createDMContextMenuItems(channelId: string) {
    const { folders } = getData();
    const inFolder = isInFolder(channelId);
    const priority = isPriority(channelId);

    return (
        <Menu.MenuGroup>
            <Menu.MenuItem
                id="vc-dmorg-folders"
                label="Move to Folder"
            >
                {folders.map(folder => (
                    <Menu.MenuItem
                        key={folder.id}
                        id={`vc-dmorg-folder-${folder.id}`}
                        label={folder.name}
                        action={() => addDmToFolder(channelId, folder.id)}
                    />
                ))}
                {folders.length > 0 && inFolder && <Menu.MenuSeparator />}
                {inFolder && (
                    <Menu.MenuItem
                        id="vc-dmorg-remove-from-folder"
                        label="Remove from Folder"
                        color="danger"
                        action={() => removeDmFromFolder(channelId)}
                    />
                )}
                {folders.length === 0 && (
                    <Menu.MenuItem
                        id="vc-dmorg-no-folders"
                        label="No folders yet"
                        disabled={true}
                        action={() => { }}
                    />
                )}
            </Menu.MenuItem>
            <Menu.MenuItem
                id="vc-dmorg-toggle-priority"
                label={priority ? "Unmark Priority" : "Mark as Priority"}
                action={() => togglePriority(channelId)}
            />
            <Menu.MenuItem
                id="vc-dmorg-add-note"
                label="Add Note"
                action={() => openAddNoteModal(channelId)}
            />
        </Menu.MenuGroup>
    );
}

const UserContext: NavContextMenuPatchCallback = (children, props) => {
    const container = findGroupChildrenByChildId("close-dm", children);
    if (container) {
        const idx = container.findIndex((c: any) => c?.props?.id === "close-dm");
        container.splice(idx, 0, createDMContextMenuItems(props.channel.id));
    }
};

const GroupDMContext: NavContextMenuPatchCallback = (children, props) => {
    const container = findGroupChildrenByChildId("leave-channel", children);
    container?.unshift(createDMContextMenuItems(props.channel.id));
};

export default definePlugin({
    name: "DMOrganizer",
    description: "Organize your DMs into color-coded folders with drag-and-drop, unread counts, search, notes, and priority ordering.",
    authors: [Devs.UnknownHacker9991],
    settings,

    contextMenus: {
        "user-context": UserContext,
        "gdm-context": GroupDMContext,
    },

    patches: [
        {
            find: '"dm-quick-launcher"===',
            replacement: [
                // Filter out folder-organized channels from the main list
                {
                    match: /(?<=channels:\i,)privateChannelIds:(\i)(?=,listRef:)/,
                    replace: "privateChannelIds:$1.filter(c=>!$self.isInFolder(c))"
                },
                // Insert folder sections
                {
                    match: /(?<=renderRow:this\.renderRow,)sections:\[.+?1\)]/,
                    replace: "...$self.makeProps(this,{$&})"
                },
                // Render folder DM rows
                {
                    match: /renderRow(?:",|=)(\i)=>{(?<=renderDM(?:",|=).+?(\i\.\i),\{channel:.+?)/,
                    replace: "$&if($self.isChannelIndex($1.section, $1.row))return $self.renderChannel($1.section,$1.row,$2)();"
                },
                // Render folder headers
                {
                    match: /renderSection(?:",|=)(\i)=>{/,
                    replace: "$&if($self.isCategoryIndex($1.section))return $self.renderCategory($1);"
                },
                // Fix row height for hidden items
                {
                    match: /(\.startsWith\("section-divider"\).+?return 1===)(\i)/,
                    replace: "$1($2-$self.folderCount())"
                },
                {
                    match: /getRowHeight(?:",|=)\((\i),(\i)\)=>{/,
                    replace: "$&if($self.isChannelHidden($1,$2))return 0;"
                },
                // Fix ScrollTo
                {
                    match: /(?<=scrollTo\(\{to:\i\}\):\(\i\+=)(\d+)\*\(.+?(?=,)/,
                    replace: "$self.getScrollOffset(arguments[0],$1,this.props.padding,this.state.preRenderedChildren,$&)"
                },
                {
                    match: /(scrollToChannel\(\i\){.{1,300})(this\.props\.privateChannelIds)/,
                    replace: "$1[...$2,...$self.getAllUncollapsedChannels()]"
                },
            ]
        },
        // Force update hook
        {
            find: ".FRIENDS},\"friends\"",
            replacement: {
                match: /let{showLibrary:\i,/,
                replace: "$self.useDMOrganizer();$&"
            }
        },
        // Fix Alt Up/Down
        {
            find: ".APPLICATION_STORE&&",
            replacement: {
                match: /(?<=\i=__OVERLAY__\?\i:\[\.\.\.\i\(\),\.\.\.)\i/,
                replace: "$self.getAllUncollapsedChannels().concat($&.filter(c=>!$self.isInFolder(c)))"
            }
        },
        // Fix Alt+Shift Up/Down
        {
            find: "=()=>!1,ensureChatIsVisible:",
            replacement: {
                match: /(?<=\i===\i\.ME\?)\i\.\i\.getPrivateChannelIds\(\)/,
                replace: "$self.getAllUncollapsedChannels().concat($&.filter(c=>!$self.isInFolder(c)))"
            }
        },
    ],

    sections: null as number[] | null,
    instance: null as any,

    startAt: StartAt.WebpackReady,

    async start() {
        await loadData();
    },

    flux: {
        CONNECTION_OPEN: loadData,
    },

    useDMOrganizer,
    isInFolder,

    folderCount() {
        return getData().folders.length;
    },

    getSections() {
        return getData().folders.map(f => f.dmIds.length === 0 ? 1 : f.dmIds.length);
    },

    getAllUncollapsedChannels() {
        return getData().folders
            .filter(f => !f.collapsed)
            .flatMap(f => this.getFolderChannels(f));
    },

    makeProps(instance: any, { sections }: { sections: number[]; }) {
        this.instance = instance;
        this.sections = sections;

        const folderSections = this.getSections();
        this.sections.splice(1, 0, ...folderSections);

        if (instance?.props?.privateChannelIds?.length === 0) {
            this.sections[this.sections.length - 1] = 0;
        }

        const sectionHeaderSizePx = folderSections.length * 40;
        const chunkSize = (sectionHeaderSizePx + folderSections.reduce((acc: number, v: number) => acc += v + 44, 0) + 256) * 1.5;

        return {
            sections: this.sections,
            chunkSize,
        };
    },

    isCategoryIndex(sectionIndex: number) {
        return this.sections && sectionIndex > 0 && sectionIndex < this.sections.length - 1;
    },

    isChannelIndex(sectionIndex: number, channelIndex: number) {
        const { folders } = getData();
        const folderIdx = sectionIndex - 1;
        if (folderIdx < 0 || folderIdx >= folders.length) return false;

        const folder = folders[folderIdx];
        return this.isCategoryIndex(sectionIndex) && (folder.dmIds.length === 0 || folder.dmIds[channelIndex] != null);
    },

    isChannelHidden(categoryIndex: number, channelIndex: number) {
        if (categoryIndex === 0) return false;
        if (!this.instance || !this.isChannelIndex(categoryIndex, channelIndex)) return false;

        const { folders } = getData();
        const folder = folders[categoryIndex - 1];
        if (!folder) return false;

        const channels = this.getFolderChannels(folder);
        // Rows past the visible list (closed DMs still in dmIds, or rows
        // filtered out by the folder search) collapse to zero height.
        if (channelIndex >= channels.length) return true;

        return folder.collapsed && this.instance.props.selectedChannelId !== channels[channelIndex];
    },

    channelMatchesSearch(channelId: string, query: string): boolean {
        const channel = this.instance?.props?.channels?.[channelId];
        if (!channel) return false;
        if (channel.name?.toLowerCase().includes(query)) return true;
        return (channel.recipients ?? []).some((uid: string) => {
            const user = UserStore.getUser(uid);
            return !!user && (
                user.username?.toLowerCase().includes(query) ||
                user.globalName?.toLowerCase().includes(query)
            );
        });
    },

    // Discord's list calls this once per rendered ROW (via isChannelHidden and
    // renderChannel), so a folder's channel list was filtered + re-sorted from
    // the full DM list for every row — O(rows × DMs) per render. Cache the
    // result per folder for the duration of the current synchronous render
    // pass; the cache self-clears on the next microtask, so it can never be
    // stale across tasks (store/flux updates always land in a later task).
    _fcCache: new Map<string, string[]>(),
    _fcClearQueued: false,
    getFolderChannels(folder: Folder): string[] {
        const hit = this._fcCache.get(folder.id);
        if (hit) return hit;
        const result = this._computeFolderChannels(folder);
        this._fcCache.set(folder.id, result);
        if (!this._fcClearQueued) {
            this._fcClearQueued = true;
            queueMicrotask(() => { this._fcCache.clear(); this._fcClearQueued = false; });
        }
        return result;
    },

    _computeFolderChannels(folder: Folder): string[] {
        if (folder.dmIds.length === 0) return [];
        const sortedChannels = PrivateChannelSortStore.getPrivateChannelIds();
        const { priorities } = getData();
        const dmIds = new Set(folder.dmIds);
        const prioritySet = new Set(priorities);

        let channels = sortedChannels.filter(c => dmIds.has(c));

        const query = getSearchQuery(folder.id).trim().toLowerCase();
        if (query) {
            channels = channels.filter(c => this.channelMatchesSearch(c, query));
        }

        // Sort priority channels first
        return channels.sort((a, b) => {
            const aPri = prioritySet.has(a) ? 0 : 1;
            const bPri = prioritySet.has(b) ? 0 : 1;
            return aPri - bPri;
        });
    },

    getScrollOffset(channelId: string, rowHeight: number, padding: number, preRenderedChildren: number, originalOffset: number) {
        if (!this.isInFolder(channelId))
            return (
                (rowHeight + padding) * 2
                + rowHeight * this.getAllUncollapsedChannels().length
                + originalOffset
            );

        return rowHeight * (this.getAllUncollapsedChannels().indexOf(channelId) + preRenderedChildren) + padding;
    },

    renderCategory: ErrorBoundary.wrap(({ section }: { section: number; }) => {
        const { folders } = getData();
        const folder = folders[section - 1];
        if (!folder) return null;

        return (
            <FolderHeader
                folder={folder}
                showUnreadCounts={settings.store.showUnreadCounts}
            />
        );
    }, { noop: true }),

    renderChannel(sectionIndex: number, index: number, ChannelComponent: React.ComponentType<ChannelComponentProps>) {
        return ErrorBoundary.wrap(() => {
            const { folders } = getData();
            const folder = folders[sectionIndex - 1];
            if (!folder) return null;

            const channelId = this.getFolderChannels(folder)[index];
            if (!channelId) return null;

            const channel = this.instance.props.channels[channelId];
            if (!channel) return null;

            if (this.isChannelHidden(sectionIndex, index)) return null;

            return (
                <DMItemWrapper
                    channelId={channel.id}
                    enableDragAndDrop={settings.store.enableDragAndDrop}
                >
                    <ChannelComponent
                        channel={channel}
                        selected={this.instance.props.selectedChannelId === channel.id}
                    >
                        {channel.id}
                    </ChannelComponent>
                </DMItemWrapper>
            );
        }, { noop: true });
    },
});
