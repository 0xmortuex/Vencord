/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ModalCloseButton, ModalContent, ModalFooter, ModalHeader, ModalProps, ModalRoot, ModalSize, openModal } from "@utils/modal";
import { useForceUpdater } from "@utils/react";
import type { Guild } from "@vencord/discord-types";
import { Button, GuildStore, IconUtils, Text, TextInput, useMemo, useState } from "@webpack/common";

import { parseIgnoreList, settings, toggleGuildIgnore } from "..";

function GuildIcon({ guild }: { guild: Guild; }) {
    const iconUrl = guild.icon && IconUtils.getGuildIconURL({
        id: guild.id,
        icon: guild.icon,
        canAnimate: false,
        size: 32,
    });

    if (iconUrl) {
        return <img src={iconUrl} alt="" style={{ width: 28, height: 28, borderRadius: "50%", flexShrink: 0 }} />;
    }
    return (
        <div style={{
            width: 28,
            height: 28,
            borderRadius: "50%",
            flexShrink: 0,
            background: "var(--background-secondary)",
            color: "var(--text-normal)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 10,
            fontWeight: 600,
            overflow: "hidden",
        }}>
            {guild.acronym}
        </div>
    );
}

function ServerFilterModal({ modalProps }: { modalProps: ModalProps; }) {
    const [search, setSearch] = useState("");
    const forceUpdate = useForceUpdater();

    const guilds = useMemo(
        () => Object.values(GuildStore.getGuilds()).sort((a, b) => a.name.localeCompare(b.name)),
        [],
    );

    const ignored = parseIgnoreList(settings.store.ignoreGuildIds);

    const query = search.trim().toLowerCase();
    const filtered = query
        ? guilds.filter(g => g.name.toLowerCase().includes(query))
        : guilds;

    // "Log None" only writes the guilds we can see, so IDs of servers you have
    // since left (still in the ignore list) are preserved rather than replaced.
    const setAll = (log: boolean) => {
        const next = parseIgnoreList(settings.store.ignoreGuildIds);
        for (const g of guilds) {
            if (log) next.delete(g.id);
            else next.add(g.id);
        }
        settings.store.ignoreGuildIds = [...next].join(",");
        forceUpdate();
    };

    const loggedCount = guilds.filter(g => !ignored.has(g.id)).length;

    return (
        <ModalRoot {...modalProps} size={ModalSize.MEDIUM}>
            <ModalHeader separator={false}>
                <div style={{ display: "flex", flexDirection: "column", flex: 1 }}>
                    <Text variant="heading-lg/semibold">Ghost Logging — Servers</Text>
                    <Text variant="text-sm/normal" style={{ color: "var(--text-muted)", marginTop: 2 }}>
                        Logging {loggedCount} of {guilds.length} servers
                    </Text>
                </div>
                <ModalCloseButton onClick={modalProps.onClose} />
            </ModalHeader>

            <div style={{ padding: "0 16px 12px", display: "flex", gap: 8 }}>
                <div style={{ flex: 1 }}>
                    <TextInput placeholder="Search servers..." value={search} onChange={setSearch} />
                </div>
                <Button size={Button.Sizes.SMALL} onClick={() => setAll(true)}>
                    Log All
                </Button>
                <Button size={Button.Sizes.SMALL} color={Button.Colors.RED} onClick={() => setAll(false)}>
                    Log None
                </Button>
            </div>

            <ModalContent>
                {filtered.length === 0 ? (
                    <div style={{ padding: "40px 0", textAlign: "center" }}>
                        <Text variant="text-md/normal">No servers match your search.</Text>
                    </div>
                ) : (
                    filtered.map(guild => {
                        const logging = !ignored.has(guild.id);
                        return (
                            <label
                                key={guild.id}
                                style={{
                                    display: "flex",
                                    alignItems: "center",
                                    gap: 12,
                                    padding: "8px 4px",
                                    cursor: "pointer",
                                    borderBottom: "1px solid var(--background-modifier-accent)",
                                }}
                            >
                                <input
                                    type="checkbox"
                                    checked={logging}
                                    onChange={() => {
                                        toggleGuildIgnore(guild.id);
                                        forceUpdate();
                                    }}
                                    style={{ width: 18, height: 18, accentColor: "var(--brand-500)", flexShrink: 0 }}
                                />
                                <GuildIcon guild={guild} />
                                <Text variant="text-md/normal" style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                    {guild.name}
                                </Text>
                                <Text variant="text-xs/normal" style={{ color: logging ? "var(--text-positive, #3ba55c)" : "var(--text-muted)" }}>
                                    {logging ? "Logging" : "Ignored"}
                                </Text>
                            </label>
                        );
                    })
                )}
            </ModalContent>

            <ModalFooter>
                <Button onClick={modalProps.onClose}>Done</Button>
            </ModalFooter>
        </ModalRoot>
    );
}

export function openServerFilterModal() {
    openModal(modalProps => <ServerFilterModal modalProps={modalProps} />);
}

export function ManageServersButton() {
    return (
        <Button onClick={openServerFilterModal}>
            Manage Servers
        </Button>
    );
}
