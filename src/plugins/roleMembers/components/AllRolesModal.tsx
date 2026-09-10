/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import ErrorBoundary from "@components/ErrorBoundary";
import { VirtualList } from "@components/VirtualList";
import { ModalCloseButton, ModalContent, ModalHeader, ModalProps, ModalRoot, ModalSize, openModal } from "@utils/modal";
import { FluxDispatcher, GuildMemberStore, GuildRoleStore, GuildStore, Text, TextInput, useEffect, useMemo, useRef, UserStore, useState, useStateFromStores } from "@webpack/common";

const SEPARATOR_PATTERN = /^[\u2500-\u257F\u2580-\u259F\u25A0-\u25FF\u2600-\u26FF\u2700-\u27BF\u2190-\u21FF\u2B00-\u2BFF\u25AC^.\-+:=_~\s]+$/;

function isSeparatorRole(name: string): boolean {
    return SEPARATOR_PATTERN.test(name.trim());
}

function getRoleColor(role: { colorString: string | null; }): string {
    if (!role.colorString || role.colorString === "#000000") return "var(--interactive-normal)";
    return role.colorString;
}

function getRoleTextColor(role: { colorString: string | null; }): string {
    if (!role.colorString || role.colorString === "#000000") return "var(--text-normal)";
    return role.colorString;
}

function formatJoinDate(iso: string): string {
    try {
        const date = new Date(iso);
        return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    } catch {
        return "Unknown";
    }
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

function AllRolesModalComponent({ guildId, modalProps }: { guildId: string; modalProps: ModalProps; }) {
    const guild = GuildStore.getGuild(guildId);

    // View switching: selectedRoleId controls which view is visible,
    // membersRoleId persists so the members div stays in the DOM when going back
    const [selectedRoleId, setSelectedRoleId] = useState<string | null>(null);
    const [membersRoleId, setMembersRoleId] = useState<string | null>(null);
    const showingMembers = selectedRoleId != null;

    // Scroll preservation
    const rolesListRef = useRef<HTMLDivElement>(null);
    const savedScrollTop = useRef(0);

    // Roles view state
    const [roleSearch, setRoleSearch] = useState("");
    const [hoveredId, setHoveredId] = useState<string | null>(null);

    // Members view state
    const [memberSearch, setMemberSearch] = useState("");
    const [loading, setLoading] = useState(true);
    const [backHovered, setBackHovered] = useState(false);

    const selectedRole = membersRoleId ? GuildRoleStore.getRole(guildId, membersRoleId) : null;

    // Prefetch guild members on mount.
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

    // Roles data
    const roles = useMemo(() => {
        return GuildRoleStore.getSortedRoles(guildId).filter(r => !isSeparatorRole(r.name));
    }, [guildId]);

    const filteredRoles = useMemo(() => {
        if (!roleSearch) return roles;
        const q = roleSearch.toLowerCase();
        return roles.filter(r => r.name.toLowerCase().includes(q));
    }, [roles, roleSearch]);

    // Members data (filtered by membersRoleId so it stays valid even when hidden)
    const members = useMemo(() => {
        if (!membersRoleId) return [];
        const result: Array<{ userId: string; nick: string | undefined; joinedAt: string | undefined; }> = [];

        for (const userId of memberIds) {
            const member = GuildMemberStore.getMember(guildId, userId);
            if (!member) continue;

            if (membersRoleId === guildId || member.roles.includes(membersRoleId)) {
                result.push({ userId, nick: member.nick, joinedAt: member.joinedAt });
            }
        }

        return result;
    }, [memberIds, guildId, membersRoleId]);

    const filteredMembers = useMemo(() => {
        if (!memberSearch) return members;
        const q = memberSearch.toLowerCase();
        return members.filter(m => {
            const user = UserStore.getUser(m.userId);
            if (!user) return false;
            const displayName = m.nick ?? user.globalName ?? user.username;
            return displayName.toLowerCase().includes(q) || user.username.toLowerCase().includes(q);
        });
    }, [members, memberSearch]);

    const selectRole = (roleId: string) => {
        // Save scroll position of the ModalContent scroll container
        const scrollContainer = rolesListRef.current?.parentElement;
        if (scrollContainer) {
            savedScrollTop.current = scrollContainer.scrollTop;
        }
        setSelectedRoleId(roleId);
        setMembersRoleId(roleId);
        setMemberSearch("");
    };

    const goBack = () => {
        setSelectedRoleId(null);
    };

    // Restore roles list scroll position when returning from members view
    useEffect(() => {
        if (!showingMembers) {
            requestAnimationFrame(() => {
                const scrollContainer = rolesListRef.current?.parentElement;
                if (scrollContainer) {
                    scrollContainer.scrollTop = savedScrollTop.current;
                }
            });
        }
    }, [showingMembers]);

    const roleName = selectedRole?.name ?? "Unknown Role";
    const dotColor = selectedRole ? getRoleColor(selectedRole) : "var(--interactive-normal)";
    const textColor = selectedRole ? getRoleTextColor(selectedRole) : "var(--text-normal)";

    return (
        <ModalRoot {...modalProps} size={ModalSize.LARGE}>
            {/* Header — swaps based on view */}
            {showingMembers ? (
                <ModalHeader separator={false}>
                    <div style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: "12px", flex: 1 }}>
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
                            onClick={goBack}
                        >
                            {"\u2190"} Back
                        </div>
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
                            {loading ? "Loading..." : `${filteredMembers.length} Member${filteredMembers.length !== 1 ? "s" : ""}`}
                        </Text>
                    </div>
                    <ModalCloseButton onClick={modalProps.onClose} />
                </ModalHeader>
            ) : (
                <ModalHeader separator={false}>
                    <div style={{ display: "flex", flexDirection: "column", flex: 1 }}>
                        <Text variant="heading-lg/semibold">
                            {guild?.name ?? "Server"} {"\u2014"} Roles
                        </Text>
                        <Text variant="text-sm/normal" style={{ color: "var(--text-muted)", marginTop: "4px" }}>
                            {filteredRoles.length} Role{filteredRoles.length !== 1 ? "s" : ""}
                        </Text>
                    </div>
                    <ModalCloseButton onClick={modalProps.onClose} />
                </ModalHeader>
            )}

            {/* Search bar — swaps based on view */}
            <div style={{ padding: "0 16px 12px" }}>
                {showingMembers ? (
                    <TextInput
                        placeholder="Search members..."
                        value={memberSearch}
                        onChange={setMemberSearch}
                    />
                ) : (
                    <TextInput
                        placeholder="Search roles..."
                        value={roleSearch}
                        onChange={setRoleSearch}
                    />
                )}
            </div>

            {/* Content — both views always in the DOM, toggled via display */}
            <ModalContent>
                {/* Roles list — always mounted, hidden when viewing members */}
                <div ref={rolesListRef} style={{ display: showingMembers ? "none" : "block", overflowY: "auto", paddingRight: "8px" }}>
                    {filteredRoles.length === 0 ? (
                        <div style={{ padding: "40px 0", textAlign: "center" }}>
                            <Text variant="text-md/normal">
                                No roles match your search.
                            </Text>
                        </div>
                    ) : (
                        filteredRoles.map(role => (
                            <div
                                key={role.id}
                                style={{
                                    display: "flex",
                                    flexDirection: "row",
                                    alignItems: "center",
                                    gap: "14px",
                                    padding: "12px 16px",
                                    marginBottom: "3px",
                                    borderRadius: "8px",
                                    backgroundColor: hoveredId === role.id ? "var(--background-modifier-hover)" : "var(--background-secondary)",
                                    cursor: "pointer",
                                }}
                                onMouseEnter={() => setHoveredId(role.id)}
                                onMouseLeave={() => setHoveredId(null)}
                                onClick={() => selectRole(role.id)}
                            >
                                <span
                                    style={{
                                        width: "16px",
                                        height: "16px",
                                        minWidth: "16px",
                                        borderRadius: "50%",
                                        backgroundColor: getRoleColor(role),
                                    }}
                                />
                                <span
                                    style={{
                                        fontSize: "16px",
                                        fontWeight: 600,
                                        color: getRoleTextColor(role),
                                    }}
                                >
                                    {role.name}
                                </span>
                            </div>
                        ))
                    )}
                </div>

                {/* Members list — mounted after first role selection, hidden when viewing roles */}
                {membersRoleId != null && (
                    <div style={{ display: showingMembers ? "block" : "none", overflowY: "auto", paddingRight: "8px" }}>
                        {loading ? (
                            <div style={{ padding: "40px 0", textAlign: "center" }}>
                                <Text variant="text-md/normal">
                                    Loading members...
                                </Text>
                            </div>
                        ) : filteredMembers.length === 0 ? (
                            <div style={{ padding: "40px 0", textAlign: "center" }}>
                                <Text variant="text-md/normal">
                                    {memberSearch ? "No members match your search." : "No cached members with this role."}
                                </Text>
                            </div>
                        ) : (
                            <VirtualList items={filteredMembers} rowHeight={52} height={420} keyOf={m => m.userId} renderRow={({ userId, nick, joinedAt }) => (
                                <MemberRow
                                    userId={userId}
                                    nick={nick}
                                    joinedAt={joinedAt}
                                    guildId={guildId}
                                />
                            )} />
                        )}
                    </div>
                )}
            </ModalContent>
        </ModalRoot>
    );
}

const AllRolesModal = ErrorBoundary.wrap(AllRolesModalComponent);

export default function openAllRolesModal(guildId: string) {
    openModal(modalProps => (
        <AllRolesModal guildId={guildId} modalProps={modalProps} />
    ));
}
