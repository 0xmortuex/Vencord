/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { DataStore } from "@api/index";
import { useForceUpdater } from "@utils/react";
import { useEffect, UserStore } from "@webpack/common";

const STORAGE_KEY = "vc-dm-organizer";

export interface Folder {
    id: string;
    name: string;
    color: string;
    collapsed: boolean;
    order: number;
    dmIds: string[];
}

export interface DMOrganizerData {
    folders: Folder[];
    priorities: string[];
    notes: Record<string, string>;
}

const defaultData: DMOrganizerData = {
    folders: [],
    priorities: [],
    notes: {},
};

let data: DMOrganizerData = { ...defaultData };

// A Set (not a single slot) so several components can subscribe at once - with
// one slot, the settings modal registering would silently disconnect the DM
// list, and whichever unmounted last would leave a dead updater behind.
const listeners = new Set<() => void>();

function notifyChange() {
    for (const fn of listeners) fn();
}

function getUserKey(): string {
    const userId = UserStore.getCurrentUser()?.id;
    return `${STORAGE_KEY}-${userId ?? "unknown"}`;
}

export async function loadData(): Promise<void> {
    const stored = await DataStore.get(getUserKey());
    data = stored ?? { ...defaultData, folders: [], priorities: [], notes: {} };
    notifyChange();
}

export async function saveData(): Promise<void> {
    await DataStore.set(getUserKey(), data);
    notifyChange();
}

export function getData(): DMOrganizerData {
    return data;
}

export function useDMOrganizer() {
    const forceUpdate = useForceUpdater();
    useEffect(() => {
        listeners.add(forceUpdate);
        return () => { listeners.delete(forceUpdate); };
    }, [forceUpdate]);
}

// Per-folder search queries live here (not in DOM state) so the row-filtering
// logic in index.tsx can read them and re-render on change.
const searchQueries = new Map<string, string>();

export function getSearchQuery(folderId: string): string {
    return searchQueries.get(folderId) ?? "";
}

export function setSearchQuery(folderId: string, query: string) {
    if (query) searchQueries.set(folderId, query);
    else searchQueries.delete(folderId);
    notifyChange();
}

// Folder operations
export function generateId(): string {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export async function createFolder(name: string, color: string): Promise<Folder> {
    const folder: Folder = {
        id: generateId(),
        name,
        color,
        collapsed: false,
        order: data.folders.length,
        dmIds: [],
    };
    data.folders.push(folder);
    await saveData();
    return folder;
}

export async function updateFolder(id: string, updates: Partial<Pick<Folder, "name" | "color">>): Promise<void> {
    const folder = data.folders.find(f => f.id === id);
    if (!folder) return;
    Object.assign(folder, updates);
    await saveData();
}

export async function deleteFolder(id: string): Promise<void> {
    data.folders = data.folders.filter(f => f.id !== id);
    await saveData();
}

export async function toggleFolderCollapse(id: string): Promise<void> {
    const folder = data.folders.find(f => f.id === id);
    if (!folder) return;
    folder.collapsed = !folder.collapsed;
    await saveData();
}

export async function addDmToFolder(channelId: string, folderId: string): Promise<void> {
    // Remove from any existing folder first
    for (const folder of data.folders) {
        folder.dmIds = folder.dmIds.filter(id => id !== channelId);
    }
    const folder = data.folders.find(f => f.id === folderId);
    if (!folder) return;
    folder.dmIds.push(channelId);
    await saveData();
}

export async function removeDmFromFolder(channelId: string): Promise<void> {
    for (const folder of data.folders) {
        folder.dmIds = folder.dmIds.filter(id => id !== channelId);
    }
    await saveData();
}

export function getFolderForDm(channelId: string): Folder | undefined {
    return data.folders.find(f => f.dmIds.includes(channelId));
}

export function isInFolder(channelId: string): boolean {
    return data.folders.some(f => f.dmIds.includes(channelId));
}

// Folder reordering
export async function moveFolderUp(id: string): Promise<void> {
    const idx = data.folders.findIndex(f => f.id === id);
    if (idx <= 0) return;
    [data.folders[idx - 1], data.folders[idx]] = [data.folders[idx], data.folders[idx - 1]];
    await saveData();
}

export async function moveFolderDown(id: string): Promise<void> {
    const idx = data.folders.findIndex(f => f.id === id);
    if (idx === -1 || idx >= data.folders.length - 1) return;
    [data.folders[idx], data.folders[idx + 1]] = [data.folders[idx + 1], data.folders[idx]];
    await saveData();
}

// Priority operations
export function isPriority(channelId: string): boolean {
    return data.priorities.includes(channelId);
}

export async function togglePriority(channelId: string): Promise<void> {
    if (data.priorities.includes(channelId)) {
        data.priorities = data.priorities.filter(id => id !== channelId);
    } else {
        data.priorities.push(channelId);
    }
    await saveData();
}

// Note operations
export function getNote(channelId: string): string {
    return data.notes[channelId] ?? "";
}

export async function setNote(channelId: string, text: string): Promise<void> {
    if (text.trim()) {
        data.notes[channelId] = text.trim();
    } else {
        delete data.notes[channelId];
    }
    await saveData();
}
