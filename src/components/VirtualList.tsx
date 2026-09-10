/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { React, useEffect, useRef, useState } from "@webpack/common";

export interface VirtualListProps<T> {
    items: T[];
    /** Fixed (or typical) height of one row in px. Rows may be taller; the list self-corrects on scroll. */
    rowHeight: number;
    /** Height of the scrolling viewport in px. */
    height: number;
    renderRow: (item: T, index: number) => React.ReactNode;
    keyOf: (item: T, index: number) => string;
    className?: string;
    style?: React.CSSProperties;
    /** Extra rows rendered above/below the viewport to hide pop-in while scrolling. */
    overscan?: number;
}

/**
 * Minimal windowed list: only the rows inside (and just around) the viewport
 * are mounted. Several plugin modals rendered thousands of member/message rows
 * each with an <img> avatar; this keeps the DOM at ~viewport size regardless of
 * list length. Deliberately simple (fixed row estimate, no measurement) so it
 * can't get out of sync with Discord's stores.
 */
export function VirtualList<T>({ items, rowHeight, height, renderRow, keyOf, className, style, overscan = 6 }: VirtualListProps<T>) {
    const ref = useRef<HTMLDivElement>(null);
    const [scrollTop, setScrollTop] = useState(0);

    // Reset to top when the underlying list changes identity (new filter/search).
    useEffect(() => { if (ref.current) ref.current.scrollTop = 0; setScrollTop(0); }, [items]);

    const total = items.length;
    const rh = Math.max(1, rowHeight);
    // Clamp both ends: a stale scrollTop (list shrank under the same identity)
    // must not put start past the end.
    const start = Math.min(total, Math.max(0, Math.floor(scrollTop / rh) - overscan));
    const end = Math.min(total, Math.max(start, Math.ceil((scrollTop + height) / rh) + overscan));
    const slice = items.slice(start, end);

    return (
        <div
            ref={ref}
            className={className}
            style={{ height, overflowY: "auto", position: "relative", ...style }}
            onScroll={e => setScrollTop((e.currentTarget as HTMLDivElement).scrollTop)}
        >
            <div style={{ height: total * rh, position: "relative" }}>
                <div style={{ position: "absolute", top: start * rh, left: 0, right: 0 }}>
                    {slice.map((item, i) => (
                        <div key={keyOf(item, start + i)} style={{ minHeight: rh }}>
                            {renderRow(item, start + i)}
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}
