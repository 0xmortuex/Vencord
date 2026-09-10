/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import ErrorBoundary from "@components/ErrorBoundary";
import { ModalCloseButton, ModalContent, ModalHeader, ModalProps, ModalRoot, ModalSize, openModal } from "@utils/modal";
import { FluxDispatcher, GuildMemberStore, GuildRoleStore, Text, TextInput, useEffect, useMemo, UserStore, useState, useStateFromStores } from "@webpack/common";

function getRoleDotColor(role: { colorString: string | null; }): string {
    if (!role?.colorString || role.colorString === "#000000") return "var(--interactive-normal)";
    return role.colorString;
}

function getRoleTextColor(role: { colorString: string | null; }): string {
    if (!role?.colorString || role.colorString === "#000000") return "var(--text-normal)";
    return role.colorString;
}

function RoleMembersModalComponent({ guildId, roleId, modalProps, onBack }: { guildId: string; roleId: string; modalProps: ModalProps; onBack?: () => void; }) {
    const role = GuildRoleStore.getRole(guildId, roleId);
    const [search, setSearch] = useState("");
    const [loading, setLoading] = useState(true);
    const [backHovered, setBackHovered] = useState(false);

    // No custom equality: comparing only lengths would suppress updates when a
    // member gains/loses a role while the modal is open (count stays the same).
    const memberIds = useStateFromStores(
        [GuildMemberStore],
        () => GuildMemberStore.getMemberIds(guildId),
    );

    useEffect(() => {
        FluxDispatcher.dispatch({
            type: "GUILD_MEMBERS_REQUEST",
            guildIds: [guildId],
            query: "",
            presences: false
        });

        const timer = setTimeout(() => setLoading(false), 1500);
        return () => clearTimeout(timer);
    }, [guildId]);

    useEffect(() => {
        if (memberIds.length > 0) {
            setLoading(false);
        }
    }, [memberIds.length]);

    const members = useMemo(() => {
        const result: Array<{ userId: string; nick: string | undefined; joinedAt: string | undefined; }> = [];

        for (const userId of memberIds) {
            const member = GuildMemberStore.getMember(guildId, userId);
            if (!member) continue;

            if (roleId === guildId || member.roles.includes(roleId)) {
                result.push({ userId, nick: member.nick, joinedAt: member.joinedAt });
            }
        }

        return result;
    }, [memberIds, guildId, roleId]);

    const filtered = useMemo(() => {
        if (!search) return members;
        const q = search.toLowerCase();
        return members.filter(m => {
            const user = UserStore.getUser(m.userId);
            if (!user) return false;
            const displayName = m.nick ?? user.globalName ?? user.username;
            return displayName.toLowerCase().includes(q) || user.username.toLowerCase().includes(q);
        });
    }, [members, search]);

    const roleName = role?.name ?? "Unknown Role";
    const dotColor = getRoleDotColor(role);
    const textColor = getRoleTextColor(role);

    return (
        <ModalRoot {...modalProps} size={ModalSize.LARGE}>
            <ModalHeader separator={false}>
                <div style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: "12px", flex: 1 }}>
                    {onBack && (
                        <div
                            style={{
                                padding: "8px 16px",
                                borderRadius: "20px",
                                backgroundColor: backHovered ? "var(--brand-500)" : "var(--background-secondary)",
                                border: "1px solid var(--background-modifier-accent)",
                                fontSize: "14px",
                                fontWeight: 600,
                                color: backHovered ? "#fff" : "#ffffff",
                                cursor: "pointer",
                            }}
                            onMouseEnter={() => setBackHovered(true)}
                            onMouseLeave={() => setBackHovered(false)}
                            onClick={() => {
                                modalProps.onClose();
                                onBack();
                            }}
                        >
                            {"\u2190"} Back
                        </div>
                    )}
                    <span
                        style={{
                            width: "16px",
                            height: "16px",
                            minWidth: "16px",
                            borderRadius: "50%",
                            backgroundColor: dotColor,
                        }}
                    />
                    <Text variant="heading-lg/semibold" style={{ color: textColor }}>
                        {roleName}
                    </Text>
                    <Text variant="text-sm/normal" style={{ color: "var(--text-muted)", marginLeft: "4px" }}>
                        {loading ? "Loading..." : `${filtered.length} Member${filtered.length !== 1 ? "s" : ""}`}
                    </Text>
                </div>
                <ModalCloseButton onClick={modalProps.onClose} />
            </ModalHeader>

            <div style={{ padding: "0 16px 12px" }}>
                <TextInput
                    placeholder="Search members..."
                    value={search}
                    onChange={setSearch}
                />
            </div>

            <ModalContent>
                {loading ? (
                    <div style={{ padding: "40px 0", textAlign: "center" }}>
                        <Text variant="text-md/normal">
                            Loading members...
                        </Text>
                    </div>
                ) : filtered.length === 0 ? (
                    <div style={{ padding: "40px 0", textAlign: "center" }}>
                        <Text variant="text-md/normal">
                            {search ? "No members match your search." : "No cached members with this role."}
                        </Text>
                    </div>
                ) : (
                    <div style={{ overflowY: "auto", paddingRight: "8px" }}>
                        {filtered.map(({ userId, nick, joinedAt }) => (
                            <MemberRow
                                key={userId}
                                userId={userId}
                                nick={nick}
                                joinedAt={joinedAt}
                                guildId={guildId}
                            />
                        ))}
                    </div>
                )}
            </ModalContent>
        </ModalRoot>
    );
}

function MemberRow({ userId, nick, joinedAt, guildId }: { userId: string; nick: string | undefined; joinedAt: string | undefined; guildId: string; }) {
    const user = UserStore.getUser(userId);
    if (!user) return null;

    const displayName = nick ?? user.globalName ?? user.username;
    const formattedDate = joinedAt ? formatJoinDate(joinedAt) : "Unknown";

    return (
        <div
            style={{
                display: "flex",
                flexDirection: "row",
                alignItems: "center",
                gap: "12px",
                padding: "10px 14px",
                borderRadius: "8px",
            }}
        >
            <img
                loading="lazy"
                src={user.getAvatarURL(guildId, 32, false)}
                width={32}
                height={32}
                style={{
                    width: "32px",
                    height: "32px",
                    minWidth: "32px",
                    maxWidth: "32px",
                    borderRadius: "50%",
                    objectFit: "cover",
                }}
            />
            <div style={{ display: "flex", flexDirection: "column" }}>
                <span style={{ fontSize: "15px", fontWeight: 700, color: "var(--text-normal)" }}>
                    {displayName}
                </span>
                <span style={{ fontSize: "12px", color: "var(--text-muted)" }}>
                    {user.username !== displayName ? `${user.username} \u00B7 ` : ""}Joined {formattedDate}
                </span>
            </div>
        </div>
    );
}

function formatJoinDate(iso: string): string {
    try {
        const date = new Date(iso);
        return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    } catch {
        return "Unknown";
    }
}

const RoleMembersModal = ErrorBoundary.wrap(RoleMembersModalComponent);

export default function openRoleMembersModal(guildId: string, roleId: string, onBack?: () => void) {
    openModal(modalProps => (
        <RoleMembersModal guildId={guildId} roleId={roleId} modalProps={modalProps} onBack={onBack} />
    ));
}
