/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {
    addDmToFolder,
    deleteFolder,
    Folder,
    getSearchQuery,
    moveFolderDown,
    moveFolderUp,
    setSearchQuery,
    toggleFolderCollapse,
} from "@plugins/dmOrganizer/store";
import { ContextMenuApi, FluxDispatcher, Menu, React, ReadStateStore, useState } from "@webpack/common";

import { openFolderSettingsModal } from "./FolderSettings";

function getUnreadCount(folder: Folder): number {
    let count = 0;
    for (const dmId of folder.dmIds) {
        count += ReadStateStore.getMentionCount(dmId);
    }
    return count;
}

function hasUnread(folder: Folder): boolean {
    return folder.dmIds.some(id => ReadStateStore.hasUnread(id));
}

export function FolderHeader({
    folder,
    showUnreadCounts,
}: {
    folder: Folder;
    showUnreadCounts: boolean;
}) {
    const [searchOpen, setSearchOpen] = useState(false);
    const unreadCount = getUnreadCount(folder);
    const unread = hasUnread(folder);

    const onContextMenu = (e: React.MouseEvent) => {
        ContextMenuApi.openContextMenu(e, () => (
            <Menu.Menu
                navId="vc-dmorg-folder-menu"
                onClose={() => FluxDispatcher.dispatch({ type: "CONTEXT_MENU_CLOSE" })}
                aria-label="DM Organizer Folder Menu"
            >
                <Menu.MenuItem
                    id="vc-dmorg-edit-folder"
                    label="Edit Folder"
                    action={() => openFolderSettingsModal(folder.id)}
                />
                <Menu.MenuItem
                    id="vc-dmorg-move-up"
                    label="Move Up"
                    action={() => moveFolderUp(folder.id)}
                />
                <Menu.MenuItem
                    id="vc-dmorg-move-down"
                    label="Move Down"
                    action={() => moveFolderDown(folder.id)}
                />
                <Menu.MenuSeparator />
                <Menu.MenuItem
                    id="vc-dmorg-delete-folder"
                    color="danger"
                    label="Delete Folder"
                    action={() => deleteFolder(folder.id)}
                />
            </Menu.Menu>
        ));
    };

    const onDragOver = (e: React.DragEvent) => {
        e.preventDefault();
        e.currentTarget.classList.add("vc-dmorg-drop-target");
    };

    const onDragLeave = (e: React.DragEvent) => {
        e.currentTarget.classList.remove("vc-dmorg-drop-target");
    };

    const onDrop = (e: React.DragEvent) => {
        e.preventDefault();
        e.currentTarget.classList.remove("vc-dmorg-drop-target");
        const channelId = e.dataTransfer.getData("vc-dmorg-channel-id");
        if (channelId) {
            addDmToFolder(channelId, folder.id);
        }
    };

    return (
        <div
            className="vc-dmorg-folder"
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
        >
            <div
                className="vc-dmorg-folder-header"
                onClick={() => toggleFolderCollapse(folder.id)}
                onContextMenu={onContextMenu}
            >
                <div
                    className="vc-dmorg-folder-color-bar"
                    style={{ backgroundColor: folder.color }}
                />
                <svg
                    className={`vc-dmorg-collapse-icon ${folder.collapsed ? "" : "vc-dmorg-expanded"}`}
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                >
                    <path
                        fill="currentColor"
                        d="M9.3 5.3a1 1 0 0 0 0 1.4l5.29 5.3-5.3 5.3a1 1 0 1 0 1.42 1.4l6-6a1 1 0 0 0 0-1.4l-6-6a1 1 0 0 0-1.42 0Z"
                    />
                </svg>
                <span className="vc-dmorg-folder-name">{folder.name}</span>
                <div className="vc-dmorg-folder-actions">
                    {showUnreadCounts && unreadCount > 0 && (
                        <span className="vc-dmorg-unread-badge">{unreadCount}</span>
                    )}
                    {showUnreadCounts && unreadCount === 0 && unread && (
                        <span className="vc-dmorg-unread-dot" />
                    )}
                    <span
                        className="vc-dmorg-search-icon"
                        onClick={e => {
                            e.stopPropagation();
                            setSearchOpen(!searchOpen);
                            setSearchQuery(folder.id, "");
                        }}
                    >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                            <path d="M21.707 20.293l-5.395-5.396A7.946 7.946 0 0018 10c0-4.411-3.589-8-8-8S2 5.589 2 10s3.589 8 8 8a7.947 7.947 0 004.897-1.688l5.396 5.395a.998.998 0 001.414 0 .999.999 0 000-1.414zM4 10c0-3.309 2.691-6 6-6s6 2.691 6 6-2.691 6-6 6-6-2.691-6-6z" />
                        </svg>
                    </span>
                </div>
            </div>
            {searchOpen && (
                <div className="vc-dmorg-search-bar">
                    <input
                        type="text"
                        placeholder="Search DMs..."
                        value={getSearchQuery(folder.id)}
                        onChange={e => setSearchQuery(folder.id, e.target.value)}
                        onClick={e => e.stopPropagation()}
                        className="vc-dmorg-search-input"
                    />
                </div>
            )}
        </div>
    );
}
