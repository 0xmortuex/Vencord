/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classNameFactory } from "@utils/css";
import { React, Tooltip } from "@webpack/common";

const cl = classNameFactory("vc-serverclock-");

interface TimeDisplayProps {
    utcOffset: number;
    timezoneName: string;
    use24Hour: boolean;
    small?: boolean;
    /** [start, end) hours considered "night" for them; null = no highlight. */
    nightRange?: [number, number] | null;
}

function localHourOf(utcOffset: number): number {
    const now = new Date();
    const utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
    return new Date(utcMs + utcOffset * 3600000).getHours();
}
function isNightHour(h: number, [s, e]: [number, number]): boolean {
    return s <= e ? (h >= s && h < e) : (h >= s || h < e);
}

// One shared minute ticker for every visible clock. Previously each rendered
// member row created its own setInterval(60s) — a 200-member list meant 200
// unsynchronized timers each firing its own setState. Now a single timer,
// aligned to the minute boundary so all clocks flip together, notifies every
// mounted TimeDisplay; the timer only exists while at least one is mounted.
const tickListeners = new Set<() => void>();
let tickTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleTick() {
    if (tickTimer) return;
    const msToNextMinute = 60_000 - (Date.now() % 60_000);
    tickTimer = setTimeout(() => {
        tickTimer = null;
        for (const fn of tickListeners) fn();
        if (tickListeners.size) scheduleTick();
    }, msToNextMinute + 20);
}

function subscribeTick(fn: () => void): () => void {
    tickListeners.add(fn);
    scheduleTick();
    return () => {
        tickListeners.delete(fn);
        if (!tickListeners.size && tickTimer) {
            clearTimeout(tickTimer);
            tickTimer = null;
        }
    };
}

function formatTime(utcOffset: number, use24Hour: boolean): string {
    const now = new Date();
    const utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
    const localMs = utcMs + utcOffset * 3600000;
    const localDate = new Date(localMs);

    const hours = localDate.getHours();
    const minutes = localDate.getMinutes().toString().padStart(2, "0");

    if (use24Hour) {
        return `${hours.toString().padStart(2, "0")}:${minutes}`;
    }

    const period = hours >= 12 ? "PM" : "AM";
    const h12 = hours % 12 || 12;
    return `${h12}:${minutes} ${period}`;
}

export function TimeDisplay({ utcOffset, timezoneName, use24Hour, small, nightRange }: TimeDisplayProps) {
    const [time, setTime] = React.useState(() => formatTime(utcOffset, use24Hour));
    const night = !!nightRange && isNightHour(localHourOf(utcOffset), nightRange);

    React.useEffect(() => {
        setTime(formatTime(utcOffset, use24Hour));
        return subscribeTick(() => setTime(formatTime(utcOffset, use24Hour)));
    }, [utcOffset, use24Hour]);

    let utcLabel: string;
    if (utcOffset === 0) {
        utcLabel = "UTC";
    } else {
        const sign = utcOffset > 0 ? "+" : "-";
        const abs = Math.abs(utcOffset);
        const hours = Math.trunc(abs);
        const minutes = Math.round((abs - hours) * 60);
        utcLabel = minutes > 0
            ? `UTC${sign}${hours}:${minutes.toString().padStart(2, "0")}`
            : `UTC${sign}${hours}`;
    }

    const isAbbreviation = !/^(?:GMT|UTC)/i.test(timezoneName);
    const tooltipText = (isAbbreviation ? `${timezoneName} (${utcLabel})` : utcLabel) + (night ? " · night for them" : "");

    return (
        <Tooltip text={tooltipText}>
            {tooltipProps => (
                <span
                    {...tooltipProps}
                    className={cl("time", { small: !!small, night })}
                >
                    {night ? "🌙" : "🕐"} {time}
                </span>
            )}
        </Tooltip>
    );
}
