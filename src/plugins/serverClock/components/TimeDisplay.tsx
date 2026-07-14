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

export function TimeDisplay({ utcOffset, timezoneName, use24Hour, small }: TimeDisplayProps) {
    const [time, setTime] = React.useState(() => formatTime(utcOffset, use24Hour));

    React.useEffect(() => {
        setTime(formatTime(utcOffset, use24Hour));

        const interval = setInterval(() => {
            setTime(formatTime(utcOffset, use24Hour));
        }, 60000);

        return () => clearInterval(interval);
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
    const tooltipText = isAbbreviation ? `${timezoneName} (${utcLabel})` : utcLabel;

    return (
        <Tooltip text={tooltipText}>
            {tooltipProps => (
                <span
                    {...tooltipProps}
                    className={cl("time", { small: !!small })}
                >
                    {"\uD83D\uDD50"} {time}
                </span>
            )}
        </Tooltip>
    );
}
