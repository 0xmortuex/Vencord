/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/*
 * VexBridge: two jobs for the Vex browser, both through ONE folder the owner chooses.
 *
 * 1. Writes `vex-bridge.json` (schema vex-bridge/1, docs/vencord-bridge.md in the Vex repository) with the
 *    owner's own mentions, replies to the owner's own messages, and the last messages of chosen channels.
 *    Read-only: it sends, reacts and edits nothing in Discord and sends nothing over the network.
 *
 * 2. Optional (off by default): Vex's "Discord status" feature. Vex writes `vex-status.json` (schema
 *    vex-status/1, see statusData.ts) into the same folder; this plugin sets the owner's custom status from it
 *    through Discord's own user-settings action creators, and puts the previous status back on "clear", on
 *    expiry, when the switch is turned off, or when the plugin stops. The token is never read or exposed.
 *
 * Two ways to reach the folder:
 *   - Vencord Desktop: native.ts (Node: atomic write of one file, read of one small file).
 *   - Web / browser extension (Vex's Discord panel): the File System Access API. Press "Choose the folder"
 *     in the plugin settings (a click is required) and pick the SAME folder as in Vex. The browser asks again
 *     after a restart; until then nothing is written or read and the plugin says so in the console.
 */

import { definePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import { Message } from "@vencord/discord-types";
import { ChannelStore, GuildStore, MessageStore, UserSettingsActionCreators, UserSettingsProtoStore, UserStore } from "@webpack/common";

import { BridgeMessage, buildBridge, serialise } from "./bridgeData";
import { CustomStatusProto, parseStatusCommand, restoreTarget, snapshot, STATUS_FILE, StatusCommand, stillOurs, toProto } from "./statusData";

const logger = new Logger("VexBridge");
const FILE = "vex-bridge.json";
const STATUS_POLL_MS = 15_000;

interface StatusState {
    /** Highest command number handled; a restart never replays an old command. */
    lastSeq: number;
    /** Set while Vex's status is on: what was there before (null: nothing), and what Vex applied. */
    active: { previous: CustomStatusProto | null; applied: CustomStatusProto; } | null;
}

async function chooseFolder() {
    const picker = (globalThis as any).showDirectoryPicker;
    if (!picker) throw new Error("this client has no folder picker; use Vencord Desktop with the native helper");
    dirHandle = await picker({ mode: "readwrite", id: "vex-bridge" });
    scheduleWrite();
}

function FolderButton() {
    return (
        <Button onClick={() => chooseFolder().catch(e => logger.error("could not choose the folder:", e))}>
            Choose the folder
        </Button>
    );
}

const settings = definePluginSettings({
    channelIds: {
        type: OptionType.STRING,
        description: "Channel IDs whose last messages go into the catch-up (comma separated, at most 20)",
        default: ""
    },
    perChannel: {
        type: OptionType.NUMBER,
        description: "Messages kept per channel (1 to 100)",
        default: 50
    },
    includeDms: {
        type: OptionType.BOOLEAN,
        description: "Also write mentions and replies that arrive in direct messages (off: server channels only)",
        default: false
    },
    keep: {
        type: OptionType.NUMBER,
        description: "How many mentions and replies to keep (1 to 200 each)",
        default: 100
    },
    folder: {
        type: OptionType.COMPONENT,
        component: FolderButton
    },
    allowStatus: {
        type: OptionType.BOOLEAN,
        description: "Let Vex set my Discord custom status (text, emoji, expiry) from vex-status.json and restore the old one afterwards. Off: the file is never read. A client mod changing a status is a gray area under Discord's terms; you accept that for your own account.",
        default: false
    },
    statusState: {
        type: OptionType.CUSTOM,
        hidden: true,
        default: { lastSeq: 0, active: null } as StatusState
    }
});

// Remembered in memory for this session: the newest first.
const mentions: BridgeMessage[] = [];
const replies: BridgeMessage[] = [];
let dirHandle: FileSystemDirectoryHandle | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let statusTimer: ReturnType<typeof setInterval> | null = null;
let statusBusy = false;
let lastStatusError = "";

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.floor(Number(n) || lo)));

function nativeHelper(): PluginNative<typeof import("./native")> | undefined {
    return (globalThis as any).VencordNative?.pluginHelpers?.VexBridge;
}

function toBridgeMessage(m: Message): BridgeMessage {
    const channel = ChannelStore.getChannel(m.channel_id);
    const guild = channel?.guild_id ? GuildStore.getGuild(channel.guild_id) : null;
    return {
        id: m.id,
        author: (m.author as any)?.globalName ?? m.author?.username ?? "",
        text: m.content ?? "",
        ts: new Date(m.timestamp as any).getTime(),
        channelId: m.channel_id,
        channelName: channel?.name ?? "",
        guildName: guild?.name ?? "",
        guildId: channel?.guild_id ?? undefined
    };
}

function keepNewest(list: BridgeMessage[], item: BridgeMessage) {
    if (list.some(x => x.id === item.id)) return;
    list.unshift(item);
    list.length = Math.min(list.length, clamp(settings.store.keep, 1, 200));
}

function channelCatchUp() {
    const ids = settings.store.channelIds.split(/[\s,]+/).filter(s => /^\d+$/.test(s)).slice(0, 20);
    const per = clamp(settings.store.perChannel, 1, 100);
    return ids.map(channelId => {
        const channel = ChannelStore.getChannel(channelId);
        const guild = channel?.guild_id ? GuildStore.getGuild(channel.guild_id) : null;
        const messages = (MessageStore.getMessages(channelId)?.toArray?.() ?? []).slice(-per).map(toBridgeMessage);
        return { channelId, name: channel?.name ?? "", guildName: guild?.name ?? "", messages };
    });
}

async function writeFile(text: string) {
    const native = nativeHelper();
    if (native?.write) {
        await native.write(text);
        return;
    }
    if (!dirHandle) throw new Error("no folder chosen yet (plugin settings: Choose the folder)");
    const perm = await (dirHandle as any).queryPermission({ mode: "readwrite" });
    if (perm !== "granted") throw new Error("the folder needs permission again (press Choose the folder)");
    const handle = await dirHandle.getFileHandle(FILE, { create: true });
    const stream = await handle.createWritable(); // written to a swap file and swapped in on close: never half a file
    await stream.write(text);
    await stream.close();
}

/** The text of vex-status.json, or null when Vex has not written one. */
async function readStatusFile(): Promise<string | null> {
    const native = nativeHelper();
    if (native?.readStatus) return native.readStatus();
    if (!dirHandle) throw new Error("no folder chosen yet (plugin settings: Choose the folder)");
    const perm = await (dirHandle as any).queryPermission({ mode: "readwrite" });
    if (perm !== "granted") throw new Error("the folder needs permission again (press Choose the folder)");
    let handle: FileSystemFileHandle;
    try {
        handle = await dirHandle.getFileHandle(STATUS_FILE);
    } catch (e: any) {
        if (e?.name === "NotFoundError") return null;
        throw e;
    }
    const file = await handle.getFile();
    if (file.size > 4096) throw new Error("vex-status.json is bigger than 4 KB");
    return file.text();
}

async function flush() {
    timer = null;
    const me = UserStore.getCurrentUser();
    const doc = buildBridge({
        accountName: (me as any)?.globalName ?? me?.username ?? "",
        now: Date.now(),
        mentions, replies,
        channels: channelCatchUp()
    });
    try {
        await writeFile(serialise(doc));
    } catch (e) {
        logger.warn("not written:", e);
    }
}

// A burst of messages is one write, a few seconds after the last one.
function scheduleWrite() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, 4000);
}

// ---- Discord status ------------------------------------------------------------------------------------------

function currentCustomStatus(): Partial<CustomStatusProto> | null {
    return (UserSettingsProtoStore.settings as any)?.status?.customStatus ?? null;
}

/** Sets (proto) or clears (null) the custom status through Discord's own settings action creator. */
async function applyCustomStatus(proto: CustomStatusProto | null) {
    const creators = UserSettingsActionCreators.PreloadedUserSettingsActionCreators as any;
    if (typeof creators?.updateAsync !== "function") {
        throw new Error("Discord's user-settings action creator has no updateAsync; the status was not changed");
    }
    await creators.updateAsync("status", (status: any) => {
        status.customStatus = proto ?? undefined;
    }, 0);
}

const saveState = (s: StatusState) => { settings.store.statusState = s; };

async function restorePrevious(state: StatusState): Promise<StatusState> {
    const { active } = state;
    if (!active) return state;
    const now = Date.now();
    if (stillOurs(currentCustomStatus(), active.applied, now)) {
        await applyCustomStatus(restoreTarget(active.previous, now));
    } else {
        // The person changed the status by hand while Vex's was on: theirs wins, nothing is overwritten.
        logger.info("status changed by hand; not restoring the old one");
    }
    return { ...state, active: null };
}

async function handleCommand(cmd: StatusCommand, state: StatusState): Promise<StatusState> {
    if (cmd.action === "clear") return { lastSeq: cmd.seq, active: (await restorePrevious(state)).active };
    const now = Date.now();
    // Keep the ORIGINAL previous status when Vex's own status is replaced by another Vex status.
    const ours = !!state.active && stillOurs(currentCustomStatus(), state.active.applied, now);
    const previous = ours ? state.active!.previous : snapshot(currentCustomStatus());
    const applied = toProto(cmd, now);
    await applyCustomStatus(applied);
    return { lastSeq: cmd.seq, active: { previous, applied } };
}

async function pollStatus() {
    if (statusBusy) return;
    statusBusy = true;
    try {
        let state: StatusState = settings.store.statusState;
        if (!settings.store.allowStatus) {
            // The switch was turned off: put the old status back, then never read the file.
            if (state.active) saveState(await restorePrevious(state));
            return;
        }
        const now = Date.now();
        if (state.active && state.active.applied.expiresAtMs !== "0" && now >= Number(state.active.applied.expiresAtMs)) {
            state = await restorePrevious(state);
            saveState(state);
        }
        const text = await readStatusFile();
        if (text === null) return;
        const cmd = parseStatusCommand(text, now);
        if (cmd.seq <= state.lastSeq) return;
        saveState(await handleCommand(cmd, state));
        lastStatusError = "";
    } catch (e: any) {
        // Reported once per distinct message, so a leftover bad file does not flood the console.
        const msg = String(e?.message ?? e);
        if (msg !== lastStatusError) {
            lastStatusError = msg;
            logger.warn("status:", msg);
        }
    } finally {
        statusBusy = false;
    }
}

export default definePlugin({
    name: "VexBridge",
    description: "Writes your mentions, replies and a channel catch-up to vex-bridge.json for the Vex browser, and (opt-in) lets Vex set your custom status",
    authors: [{ name: "mortuex", id: 1245799821173067850n }],
    settings,

    settingsAboutComponent: () => "Choose the same folder in Vex (Settings, Community and chat tools, Vencord bridge).",

    flux: {
        MESSAGE_CREATE({ message, optimistic }: { message: Message; optimistic: boolean; }) {
            if (optimistic || !message?.content) return;
            const me = UserStore.getCurrentUser();
            if (!me || message.author?.id === me.id) return;
            const channel = ChannelStore.getChannel(message.channel_id);
            if (!channel) return;
            if (!channel.guild_id && !settings.store.includeDms) return;

            const mentioned = message.mentions?.some((u: any) => u.id === me.id) || message.mentionEveryone;
            const replyToMe = (message as any).referenced_message?.author?.id === me.id;
            if (replyToMe) keepNewest(replies, toBridgeMessage(message));
            else if (mentioned) keepNewest(mentions, toBridgeMessage(message));
            else return;
            scheduleWrite();
        }
    },

    start() {
        scheduleWrite();
        statusTimer = setInterval(pollStatus, STATUS_POLL_MS);
    },

    async stop() {
        if (timer) clearTimeout(timer);
        timer = null;
        if (statusTimer) clearInterval(statusTimer);
        statusTimer = null;
        try {
            const state: StatusState = settings.store.statusState;
            if (state.active) saveState(await restorePrevious(state));
        } catch (e) {
            logger.error("could not restore the previous status:", e);
        }
        dirHandle = null;
        mentions.length = 0;
        replies.length = 0;
    }
});
