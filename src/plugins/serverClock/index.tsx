/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./style.css";

import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import { addMemberListDecorator, removeMemberListDecorator } from "@api/MemberListDecorators";
import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import { Devs } from "@utils/constants";
import { openModal } from "@utils/modal";
import definePlugin, { OptionType } from "@utils/types";
import { GuildMemberStore, GuildRoleStore, Menu, SelectedGuildStore, UserStore } from "@webpack/common";

import { SetTimezoneModal } from "./components/SetTimezoneModal";
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
// Abbreviation table = built-ins + the user's "extraAbbreviations" setting
// ("abbr=Zone/Name or abbr=+5.5, ..."), rebuilt only when that text changes.
let abbrevSrc: string | null = null;
let abbrevMap: Record<string, number | string> = TIMEZONE_ABBREVIATIONS;
let abbrevRegex: RegExp | null = null;
function abbreviations(): { map: Record<string, number | string>; regex: RegExp; } {
    const src = String(settings.store.extraAbbreviations ?? "");
    if (abbrevRegex && src === abbrevSrc) return { map: abbrevMap, regex: abbrevRegex };
    const map: Record<string, number | string> = { ...TIMEZONE_ABBREVIATIONS };
    for (const part of src.split(",")) {
        const [k, v] = part.split("=").map(x => x?.trim());
        if (!k || !v) continue;
        const num = Number(v);
        map[k.toLowerCase()] = Number.isFinite(num) ? num : v;
    }
    const escaped = Object.keys(map).sort((a, b) => b.length - a.length).map(k => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    abbrevMap = map; abbrevSrc = src;
    abbrevRegex = new RegExp(`(?<=^|[^a-zA-Z])(${escaped.join("|")})(?=$|[^a-zA-Z])`, "i");
    return { map, regex: abbrevRegex };
}

// Manual per-user overrides from the "overrides" setting: "userId=value, ...".
// value = IANA zone, fixed offset ("+3", "-5.5") or a known abbreviation.
let overrideSrc: string | null = null;
let overrideMap = new Map<string, string>();
function manualOverrides(): Map<string, string> {
    const src = String(settings.store.overrides ?? "");
    if (src === overrideSrc) return overrideMap;
    const map = new Map<string, string>();
    for (const part of src.split(",")) {
        const [id, v] = part.split("=").map(x => x?.trim());
        if (id && v) map.set(id, v);
    }
    overrideSrc = src; overrideMap = map;
    return map;
}
export function getOverride(userId: string): string | null {
    return manualOverrides().get(userId) ?? null;
}
export function setOverride(userId: string, value: string | null) {
    const map = new Map(manualOverrides());
    if (value) map.set(userId, value); else map.delete(userId);
    settings.store.overrides = [...map.entries()].map(([k, v]) => `${k}=${v}`).join(", ");
    timezoneCache.clear();
}
function resolveManual(value: string): TimezoneResult | null {
    const v = value.trim();
    if (!v) return null;
    if (/^[+-]?\d{1,2}(?:\.\d+)?$/.test(v)) return { offset: parseFloat(v), name: `UTC${v.startsWith("-") ? "" : "+"}${v.replace(/^\+/, "")}` };
    if (v.includes("/")) { try { return { offset: currentOffsetOf(v), name: v }; } catch { return null; } }
    const zone = abbreviations().map[v.toLowerCase()];
    if (zone === undefined) return null;
    return { offset: typeof zone === "number" ? zone : currentOffsetOf(zone), name: v.toUpperCase() };
}

function matchTimezoneInText(text: string): TimezoneResult | null {
    const offsetMatch = text.match(OFFSET_REGEX);
    if (offsetMatch) {
        const offset = parseFloat(offsetMatch[1]);
        return { offset, name: offsetMatch[0] };
    }

    const { map, regex } = abbreviations();
    const abbrMatch = text.match(regex);
    if (abbrMatch) {
        const matched = abbrMatch[1];
        const zone = map[matched.toLowerCase()];
        const offset = typeof zone === "number" ? zone : currentOffsetOf(zone);
        return { offset, name: matched.toUpperCase() };
    }

    return null;
}

function parseTimezone(guildId: string, userId: string): TimezoneResult | null {
    const key = getCacheKey(guildId, userId);
    if (timezoneCache.has(key)) return timezoneCache.get(key)!;
    // A manual override always wins over anything parsed from names/roles.
    const manualValue = manualOverrides().get(userId);
    if (manualValue) {
        const manual = resolveManual(manualValue);
        timezoneCache.set(key, manual);
        return manual;
    }

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
        onChange: (v: boolean) => { if (v) installMemberListDecorator(); else removeMemberListDecorator("ServerClock"); },
    },
    showInPopouts: {
        type: OptionType.BOOLEAN,
        description: "Show in user popouts",
        default: true,
    },
    showInProfiles: {
        type: OptionType.BOOLEAN,
        description: "Show in user profiles",
        default: true,
    },
    use24Hour: {
        type: OptionType.BOOLEAN,
        description: "Use 24-hour format",
        default: true,
    },
    highlightNight: {
        type: OptionType.BOOLEAN,
        description: "Dim the clock (🌙) when it's night for them - so you know before you ping",
        default: true,
    },
    nightStart: {
        type: OptionType.NUMBER,
        description: "Night starts at (hour, 0-23)",
        default: 22,
    },
    nightEnd: {
        type: OptionType.NUMBER,
        description: "Night ends at (hour, 0-23)",
        default: 8,
    },
    overrides: {
        type: OptionType.STRING,
        description: "Manual timezones: userId=value, userId=value (right-click a user → \"Set timezone\" edits this for you). value = IANA zone, +3 / -5.5, or an abbreviation.",
        default: "",
        onChange: () => timezoneCache.clear(),
    },
    extraAbbreviations: {
        type: OptionType.STRING,
        description: "Extra abbreviations: abbr=Zone/Name or abbr=+5.5, comma-separated (e.g. brt=America/Sao_Paulo, sast=2)",
        default: "",
        onChange: () => timezoneCache.clear(),
    },
});

function nightRange(): [number, number] | null {
    if (!settings.store.highlightNight) return null;
    const s = Number(settings.store.nightStart), e = Number(settings.store.nightEnd);
    if (!Number.isFinite(s) || !Number.isFinite(e)) return null;
    return [((s % 24) + 24) % 24, ((e % 24) + 24) % 24];
}

function ServerClockIndicator({ userId, isProfile }: { userId?: string; isProfile?: boolean; }) {
    if (!userId) return null;
    // Checked at render time so the toggles apply immediately (no restart).
    if (isProfile ? !(settings.store.showInPopouts || settings.store.showInProfiles) : !settings.store.showInMemberList) return null;

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
                    nightRange={nightRange()}
                />
            </div>
        );
    }

    return (
        <TimeDisplay
            utcOffset={tz.offset}
            timezoneName={tz.name}
            use24Hour={settings.store.use24Hour}
            nightRange={nightRange()}
            small
        />
    );
}

function installMemberListDecorator() {
    removeMemberListDecorator("ServerClock");
    addMemberListDecorator("ServerClock", ({ user }) =>
        user == null ? null : <ServerClockIndicator userId={user.id} />
    );
}

// Right-click a user → set (or clear) their timezone by hand.
const userContextPatch: NavContextMenuPatchCallback = (children, { user }: { user?: { id: string; username: string; globalName?: string | null; }; }) => {
    if (!user) return;
    const group = findGroupChildrenByChildId("user-profile", children) ?? children;
    group.push(
        <Menu.MenuItem
            id="vc-serverclock-set-timezone"
            label={getOverride(user.id) ? "Change timezone (ServerClock)…" : "Set timezone (ServerClock)…"}
            action={() => openModal(props => (
                <SetTimezoneModal modalProps={props} userId={user.id} name={user.globalName ?? user.username} />
            ))}
        />
    );
};

export default definePlugin({
    name: "ServerClock",
    description: "Shows teammates' local time next to their name based on timezone info in nicknames, display names, or roles (e.g., GMT+3, EST, CET).",
    authors: [Devs.UnknownHacker9991],
    dependencies: ["MemberListDecoratorsAPI"],
    settings,
    contextMenus: { "user-context": userContextPatch },

    patches: [
        {
            find: "#{intl::USER_PROFILE_PRONOUNS}",
            replacement: {
                match: /(?<=children:\[\i," ",\i)(?=\])/,
                replace: ",$self.ServerClockIndicator({userId:arguments[0]?.user?.id,isProfile:true})",
            },
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
        if (settings.store.showInMemberList) installMemberListDecorator();
    },

    stop() {
        timezoneCache.clear();
        removeMemberListDecorator("ServerClock");
    },

    ServerClockIndicator: ErrorBoundary.wrap(ServerClockIndicator, { noop: true }),
});
