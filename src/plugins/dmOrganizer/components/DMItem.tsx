/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { getNote, isPriority } from "@plugins/dmOrganizer/store";
import { React } from "@webpack/common";

export function DMItemWrapper({
    children,
    channelId,
    enableDragAndDrop,
}: {
    children: React.ReactNode;
    channelId: string;
    enableDragAndDrop: boolean;
}) {
    const note = getNote(channelId);
    const priority = isPriority(channelId);

    const onDragStart = (e: React.DragEvent) => {
        e.dataTransfer.setData("vc-dmorg-channel-id", channelId);
        e.dataTransfer.effectAllowed = "move";
    };

    return (
        <div
            className="vc-dmorg-dm-item"
            draggable={enableDragAndDrop}
            onDragStart={enableDragAndDrop ? onDragStart : undefined}
        >
            <div className="vc-dmorg-dm-content">
                {priority && <span className="vc-dmorg-priority-star" title="Priority">&#9733;</span>}
                {children}
            </div>
            {note && (
                <div className="vc-dmorg-dm-note">{note}</div>
            )}
        </div>
    );
}
