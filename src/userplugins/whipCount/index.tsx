/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { definePluginSettings } from "@api/Settings";
import { classNameFactory } from "@api/Styles";
import ErrorBoundary from "@components/ErrorBoundary";
import { copyWithToast } from "@utils/discord";
import { ModalCloseButton, ModalContent, ModalFooter, ModalHeader, ModalRoot, ModalSize, openModal } from "@utils/modal";
import definePlugin, { OptionType } from "@utils/types";
import {
    Button, ChannelStore, FluxDispatcher, Forms, GuildMemberStore, GuildRoleStore,
    Menu, RestAPI, Text, useEffect, UserStore, useState
} from "@webpack/common";

const cl = classNameFactory("vc-whip-");

const settings = definePluginSettings({
    role: {
        type: OptionType.STRING,
        description: "The role to count, by name or by ID (e.g. \"Democrat\")",
        default: "Democrat"
    },
    excuseRoles: {
        type: OptionType.STRING,
        description: "Roles that are excused from voting and are left out of the count entirely (Leave of Absence). Names or IDs, comma-separated",
        default: "1347672834809397268"
    },
    windowHours: {
        type: OptionType.NUMBER,
        description: "How long a vote stays open, in hours, measured from when the bill was posted",
        default: 48
    }
});

interface Tally {
    roleName: string;
    total: number;
    voted: Array<{ id: string; label: string; emoji: string; }>;
    notVoted: Array<{ id: string; label: string; }>;
    byEmoji: Array<{ emoji: string; count: number; }>;
    excused: number;
    deadline: number;
}

/** Emoji as the reactions endpoint wants it: name:id for custom, raw for unicode. */
function emojiKey(emoji: { id?: string | null; name: string; }) {
    return emoji.id ? `${emoji.name}:${emoji.id}` : emoji.name;
}

/** Everyone who reacted with one emoji. Paginated; capped so a runaway vote cannot spin. */
async function fetchReactors(channelId: string, messageId: string, emoji: { id?: string | null; name: string; }) {
    const ids: string[] = [];
    let after: string | undefined;

    for (let page = 0; page < 20; page++) {
        const res: any = await RestAPI.get({
            url: `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emojiKey(emoji))}`,
            query: { limit: 100, ...(after ? { after } : {}) }
        });

        const batch: any[] = res?.body ?? [];
        for (const u of batch) ids.push(u.id);
        if (batch.length < 100) break;
        after = batch[batch.length - 1].id;
    }

    return ids;
}

/**
 * Pull the full member list into the client.
 *
 * The store only holds members it has happened to see, so a caucus roster read
 * straight from the cache silently under-reports - the people who have NOT voted
 * are exactly the ones least likely to be cached. Ask the gateway for everyone
 * and wait for the chunks to stop arriving.
 */
function requestAllMembers(guildId: string) {
    return new Promise<void>(resolve => {
        let timer = setTimeout(finish, 4000); // nothing came back at all

        function onChunk(event: any) {
            if ((event.guildId ?? event.guild_id) !== guildId) return;
            clearTimeout(timer);
            timer = setTimeout(finish, 1500); // settle after the last chunk
        }
        function finish() {
            clearTimeout(timer);
            FluxDispatcher.unsubscribe("GUILD_MEMBERS_CHUNK", onChunk);
            resolve();
        }

        FluxDispatcher.subscribe("GUILD_MEMBERS_CHUNK", onChunk);
        FluxDispatcher.dispatch({ type: "GUILD_MEMBERS_REQUEST", guildIds: [guildId], query: "", presences: false });
    });
}

/** The configured role, by id first and then by name (case-insensitive). */
function resolveRole(guildId: string) {
    const ref = (settings.store.role ?? "").trim();
    if (!ref) return null;

    const byId = GuildRoleStore.getRole(guildId, ref);
    if (byId) return byId;

    const all = GuildRoleStore.getSortedRoles?.(guildId) ?? [];
    const lower = ref.toLowerCase();
    return all.find((r: any) => r?.name?.toLowerCase() === lower) ?? null;
}

/** Every configured excused role that exists in this guild, as a set of ids. */
function resolveExcusedRoleIds(guildId: string) {
    const refs = (settings.store.excuseRoles ?? "").split(",").map(r => r.trim()).filter(Boolean);
    const all = GuildRoleStore.getSortedRoles?.(guildId) ?? [];
    const ids = new Set<string>();

    for (const ref of refs) {
        const byId = GuildRoleStore.getRole(guildId, ref);
        if (byId) { ids.add(byId.id); continue; }

        const lower = ref.toLowerCase();
        const byName = all.find((r: any) => r?.name?.toLowerCase() === lower);
        if (byName) ids.add(byName.id);
    }
    return ids;
}

function labelFor(guildId: string, userId: string) {
    const nick = GuildMemberStore.getNick(guildId, userId);
    const user = UserStore.getUser(userId) as any;
    return nick || user?.globalName || user?.username || userId;
}

async function buildTally(message: any): Promise<Tally> {
    const channel = ChannelStore.getChannel(message.channel_id);
    const guildId = channel?.guild_id;
    if (!guildId) throw new Error("This message is not in a server.");

    const role = resolveRole(guildId);
    if (!role) throw new Error(`No role matching "${settings.store.role}" in this server. Set it in the plugin settings.`);

    await requestAllMembers(guildId);

    // Someone on Leave of Absence is not expected to vote, so they are dropped
    // from the roster outright: they must not appear in "not voted", and they
    // must not sit in the denominator making the caucus look short either.
    const excused = resolveExcusedRoleIds(guildId);
    const inRole = GuildMemberStore.getMemberIds(guildId).filter(id =>
        !!GuildMemberStore.getMember(guildId, id)?.roles?.includes(role.id));
    const roster = inRole.filter(id =>
        !GuildMemberStore.getMember(guildId, id)?.roles?.some(r => excused.has(r)));

    // Who reacted, and with what. First reaction wins if someone used several.
    const votedWith = new Map<string, string>();
    const byEmoji: Array<{ emoji: string; count: number; }> = [];

    for (const reaction of message.reactions ?? []) {
        const { name } = reaction.emoji;
        const reactors = await fetchReactors(message.channel_id, message.id, reaction.emoji);

        let count = 0;
        for (const id of reactors) {
            if (!roster.includes(id)) continue; // someone outside the caucus
            count++;
            if (!votedWith.has(id)) votedWith.set(id, name);
        }
        byEmoji.push({ emoji: name, count });
    }

    const voted = roster
        .filter(id => votedWith.has(id))
        .map(id => ({ id, label: labelFor(guildId, id), emoji: votedWith.get(id)! }));
    const notVoted = roster
        .filter(id => !votedWith.has(id))
        .map(id => ({ id, label: labelFor(guildId, id) }));

    const sortByLabel = (a: { label: string; }, b: { label: string; }) => a.label.localeCompare(b.label);
    voted.sort(sortByLabel);
    notVoted.sort(sortByLabel);

    return {
        roleName: role.name,
        total: roster.length,
        excused: inRole.length - roster.length,
        voted,
        notVoted,
        byEmoji,
        deadline: new Date(message.timestamp).getTime() + (settings.store.windowHours ?? 48) * 3600_000
    };
}

/** "31h 14m" / "14m", or null once the window has passed. */
function timeLeft(deadline: number) {
    const ms = deadline - Date.now();
    if (ms <= 0) return null;

    const hours = Math.floor(ms / 3600_000);
    const minutes = Math.floor((ms % 3600_000) / 60_000);
    return hours >= 1 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function remaining(deadline: number) {
    const left = timeLeft(deadline);
    return left ? `${left} left` : "closed";
}

/** The ping to paste into the channel: mentions first, then the reminder. */
function reminderText(tally: Tally) {
    const mentions = tally.notVoted.map(m => `<@${m.id}>`).join(" ");
    const left = timeLeft(tally.deadline);

    // Never paste a countdown that has already run out - saying "you have (0m)"
    // reads as a live deadline when the vote is in fact over.
    return left
        ? `${mentions} Reminder on the proposal you have (${left}) until you have to vote`
        : `${mentions} Reminder on the proposal — voting has closed`;
}

function WhipCountModal({ message, modalProps }: { message: any; modalProps: any; }) {
    const [tally, setTally] = useState<Tally | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [nonce, setNonce] = useState(0);

    useEffect(() => {
        let cancelled = false;
        setTally(null);
        setError(null);

        buildTally(message)
            .then(t => { if (!cancelled) setTally(t); })
            .catch(e => { if (!cancelled) setError(String(e?.message ?? e)); });

        return () => { cancelled = true; };
    }, [nonce]);

    return (
        <ModalRoot {...modalProps} size={ModalSize.MEDIUM}>
            <ModalHeader>
                <Text variant="heading-lg/semibold" style={{ flexGrow: 1 }}>Whip count</Text>
                <ModalCloseButton onClick={modalProps.onClose} />
            </ModalHeader>

            <ModalContent className={cl("content")}>
                {error && <Forms.FormText style={{ color: "var(--text-danger)" }}>{error}</Forms.FormText>}
                {!error && !tally && <Forms.FormText>Counting… (loading the full member list)</Forms.FormText>}

                {tally && <>
                    <Forms.FormTitle>
                        {tally.roleName} — {tally.voted.length}/{tally.total} voted · {remaining(tally.deadline)}
                        {tally.excused > 0 && ` · ${tally.excused} on leave`}
                    </Forms.FormTitle>

                    {tally.byEmoji.length > 0 && (
                        <Forms.FormText style={{ marginBottom: 12 }}>
                            {tally.byEmoji.map(e => `${e.emoji} ${e.count}`).join("   ")}
                        </Forms.FormText>
                    )}

                    <Forms.FormTitle>Not voted ({tally.notVoted.length})</Forms.FormTitle>
                    <Forms.FormText style={{ whiteSpace: "pre-wrap", marginBottom: 12 }}>
                        {tally.notVoted.length ? tally.notVoted.map(m => m.label).join(", ") : "Everyone has voted."}
                    </Forms.FormText>

                    <Forms.FormTitle>Voted ({tally.voted.length})</Forms.FormTitle>
                    <Forms.FormText style={{ whiteSpace: "pre-wrap" }}>
                        {tally.voted.length ? tally.voted.map(m => `${m.emoji} ${m.label}`).join(", ") : "Nobody yet."}
                    </Forms.FormText>
                </>}
            </ModalContent>

            <ModalFooter>
                <Button
                    disabled={!tally || !tally.notVoted.length}
                    onClick={() => copyWithToast(
                        reminderText(tally!),
                        `Copied reminder for ${tally!.notVoted.length}`
                    )}
                >
                    Copy reminder ping
                </Button>
                <Button
                    look={Button.Looks.LINK}
                    color={Button.Colors.PRIMARY}
                    onClick={() => setNonce(n => n + 1)}
                >
                    Refresh
                </Button>
            </ModalFooter>
        </ModalRoot>
    );
}

const messageContextMenuPatch: NavContextMenuPatchCallback = (children, { message }) => {
    if (!message || !ChannelStore.getChannel(message.channel_id)?.guild_id) return;

    children.push(
        <Menu.MenuItem
            id="vc-whip-count"
            label="Whip count"
            action={() => openModal(modalProps => (
                <WhipCountModal message={message} modalProps={modalProps} />
            ))}
        />
    );
};

export default definePlugin({
    name: "WhipCount",
    description: "Right-click a bill to see who in a role has reacted, who has not, and how long is left to vote.",
    authors: [{ name: "Fadi", id: 0n }],
    settings,
    contextMenus: { "message": messageContextMenuPatch },

    WhipCountModal: ErrorBoundary.wrap(WhipCountModal, { noop: true })
});
