/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./style.css";

import { addMemberListDecorator, removeMemberListDecorator } from "@api/MemberListDecorators";
import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import { Devs } from "@utils/constants";
import definePlugin, { OptionType } from "@utils/types";
import { GuildMemberStore, GuildRoleStore, SelectedGuildStore, UserStore } from "@webpack/common";

import { TimeDisplay } from "./components/TimeDisplay";

// Abbreviations for zones that observe DST map to an IANA zone name so the
// live offset is computed for the current date - a fixed "pst: -8" would be an
// hour off for half the year. Fixed-offset zones stay plain numbers.
const TIMEZONE_ABBREVIATIONS: Record<string, number | string> = {
    est: "America/New_York",
    edt: "America/New_York",
    cst: "America/Chicago",
    cdt: "America/Chicago",
    mst: "America/Denver",
    mdt: "America/Denver",
    pst: "America/Los_Angeles",
    pdt: "America/Los_Angeles",
    cet: "Europe/Berlin",
    cest: "Europe/Berlin",
    eet: "Europe/Bucharest",
    eest: "Europe/Bucharest",
    aest: "Australia/Sydney",
    aedt: "Australia/Sydney",
    ist: 5.5,
    jst: 9,
    kst: 9,
    wib: 7,
    trt: 3,
};

// Current UTC offset (fractional hours) of an IANA zone, DST included.
function currentOffsetOf(timeZone: string): number {
    const part = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
        .formatToParts(new Date())
        .find(p => p.type === "timeZoneName")?.value ?? "";
    const m = part.match(/([+-])(\d{2}):(\d{2})/);
    if (!m) return 0; // "GMT" with no numeric part = UTC
    const sign = m[1] === "-" ? -1 : 1;
    return sign * (Number(m[2]) + Number(m[3]) / 60);
}

const OFFSET_REGEX = /\b(?:GMT|UTC)\s*([+-]?\d{1,2}(?:\.\d+)?)\b/i;

interface TimezoneResult {
    offset: number;
    name: string;
}

const timezoneCache = new Map<string, TimezoneResult | null>();

function getCacheKey(guildId: string, userId: string): string {
    return `${guildId}:${userId}`;
}

// Longer keys first so e.g. "CEST" is matched as cest, not rejected at "ces".
const ABBREVIATION_REGEX = new RegExp(
    `(?<=^|[^a-zA-Z])(${Object.keys(TIMEZONE_ABBREVIATIONS).sort((a, b) => b.length - a.length).join("|")})(?=$|[^a-zA-Z])`,
    "i"
);

function matchTimezoneInText(text: string): TimezoneResult | null {
    const offsetMatch = text.match(OFFSET_REGEX);
    if (offsetMatch) {
        const offset = parseFloat(offsetMatch[1]);
        return { offset, name: offsetMatch[0] };
    }

    const abbrMatch = text.match(ABBREVIATION_REGEX);
    if (abbrMatch) {
        const matched = abbrMatch[1];
        const zone = TIMEZONE_ABBREVIATIONS[matched.toLowerCase()];
        const offset = typeof zone === "number" ? zone : currentOffsetOf(zone);
        return { offset, name: matched.toUpperCase() };
    }

    return null;
}

function parseTimezone(guildId: string, userId: string): TimezoneResult | null {
    const key = getCacheKey(guildId, userId);
    if (timezoneCache.has(key)) return timezoneCache.get(key)!;

    const member = GuildMemberStore.getMember(guildId, userId);
    const user = UserStore.getUser(userId);

    // Check nickname first — most servers put timezone info here
    if (member?.nick) {
        const result = matchTimezoneInText(member.nick);
        if (result) {
            timezoneCache.set(key, result);
            return result;
        }
    }

    // Then global display name
    if (user?.globalName) {
        const result = matchTimezoneInText(user.globalName);
        if (result) {
            timezoneCache.set(key, result);
            return result;
        }
    }

    // Then username
    if (user?.username) {
        const result = matchTimezoneInText(user.username);
        if (result) {
            timezoneCache.set(key, result);
            return result;
        }
    }

    // Finally scan role names
    if (member?.roles) {
        for (const roleId of member.roles) {
            const role = GuildRoleStore.getRole(guildId, roleId);
            if (!role?.name) continue;

            const result = matchTimezoneInText(role.name);
            if (result) {
                timezoneCache.set(key, result);
                return result;
            }
        }
    }

    timezoneCache.set(key, null);
    return null;
}

const settings = definePluginSettings({
    showInMemberList: {
        type: OptionType.BOOLEAN,
        description: "Show in member list",
        default: true,
        restartNeeded: true,
    },
    showInPopouts: {
        type: OptionType.BOOLEAN,
        description: "Show in user popouts",
        default: true,
        restartNeeded: true,
    },
    showInProfiles: {
        type: OptionType.BOOLEAN,
        description: "Show in user profiles",
        default: true,
        restartNeeded: true,
    },
    use24Hour: {
        type: OptionType.BOOLEAN,
        description: "Use 24-hour format",
        default: true,
    },
});

function ServerClockIndicator({ userId, isProfile }: { userId?: string; isProfile?: boolean; }) {
    if (!userId) return null;

    const guildId = SelectedGuildStore.getGuildId();
    if (!guildId) return null;

    const tz = parseTimezone(guildId, userId);
    if (!tz) return null;

    if (isProfile) {
        return (
            <div className="vc-serverclock-profile">
                <TimeDisplay
                    utcOffset={tz.offset}
                    timezoneName={tz.name}
                    use24Hour={settings.store.use24Hour}
                />
            </div>
        );
    }

    return (
        <TimeDisplay
            utcOffset={tz.offset}
            timezoneName={tz.name}
            use24Hour={settings.store.use24Hour}
            small
        />
    );
}

export default definePlugin({
    name: "ServerClock",
    description: "Shows teammates' local time next to their name based on timezone info in nicknames, display names, or roles (e.g., GMT+3, EST, CET).",
    authors: [Devs.UnknownHacker9991],
    dependencies: ["MemberListDecoratorsAPI"],
    settings,

    patches: [
        {
            find: "#{intl::USER_PROFILE_PRONOUNS}",
            replacement: {
                match: /(?<=children:\[\i," ",\i)(?=\])/,
                replace: ",$self.ServerClockIndicator({userId:arguments[0]?.user?.id,isProfile:true})",
            },
            predicate: () => settings.store.showInPopouts || settings.store.showInProfiles,
        },
    ],

    // Bust cached results when the data they were parsed from changes -
    // otherwise a nickname edit keeps showing the old (or no) clock until
    // Discord restarts.
    flux: {
        GUILD_MEMBER_UPDATE(e: any) {
            const guildId = e?.guildId ?? e?.guild_id;
            const userId = e?.user?.id;
            if (guildId && userId) timezoneCache.delete(getCacheKey(guildId, userId));
        },
        USER_UPDATE(e: any) {
            const userId = e?.user?.id;
            if (!userId) return;
            const suffix = `:${userId}`;
            for (const key of timezoneCache.keys()) {
                if (key.endsWith(suffix)) timezoneCache.delete(key);
            }
        },
    },

    start() {
        timezoneCache.clear();
        if (settings.store.showInMemberList) {
            addMemberListDecorator("ServerClock", ({ user }) =>
                user == null ? null : <ServerClockIndicator userId={user.id} />
            );
        }
    },

    stop() {
        timezoneCache.clear();
        removeMemberListDecorator("ServerClock");
    },

    ServerClockIndicator: ErrorBoundary.wrap(ServerClockIndicator, { noop: true }),
});
