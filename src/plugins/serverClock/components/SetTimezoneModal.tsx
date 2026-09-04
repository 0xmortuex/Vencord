/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ModalCloseButton, ModalContent, ModalFooter, ModalHeader, ModalProps, ModalRoot, ModalSize } from "@utils/modal";
import { Button, Forms, Text, TextInput, useState } from "@webpack/common";

import { getOverride, setOverride } from "..";

interface Props {
    modalProps: ModalProps;
    userId: string;
    name: string;
}

/**
 * Manual per-user timezone. For teammates with no timezone in their nickname or
 * roles, the plugin previously just showed nothing with no way to fix it.
 */
export function SetTimezoneModal({ modalProps, userId, name }: Props) {
    const [value, setValue] = useState(getOverride(userId) ?? "");
    const trimmed = value.trim();

    function save() {
        setOverride(userId, trimmed || null);
        modalProps.onClose();
    }

    return (
        <ModalRoot {...modalProps} size={ModalSize.SMALL}>
            <ModalHeader separator={false}>
                <Text variant="heading-lg/semibold" style={{ flex: 1 }}>Timezone for {name}</Text>
                <ModalCloseButton onClick={modalProps.onClose} />
            </ModalHeader>
            <ModalContent>
                <Forms.FormSection>
                    <Forms.FormTitle>Timezone</Forms.FormTitle>
                    <TextInput
                        value={value}
                        onChange={setValue}
                        placeholder="e.g. Europe/Berlin, +3, -5.5, EST, PST"
                        autoFocus
                        onKeyDown={e => { if (e.key === "Enter") save(); }}
                    />
                    <Forms.FormText style={{ marginTop: "6px", fontSize: "12px", color: "var(--text-muted)" }}>
                        An IANA zone name (follows daylight saving), a fixed UTC offset, or an abbreviation
                        the plugin knows. Leave empty and save to remove the override.
                    </Forms.FormText>
                </Forms.FormSection>
            </ModalContent>
            <ModalFooter>
                <Button onClick={save}>Save</Button>
                {getOverride(userId) && (
                    <Button look={Button.Looks.LINK} color={Button.Colors.RED} onClick={() => { setOverride(userId, null); modalProps.onClose(); }}>
                        Remove override
                    </Button>
                )}
                <Button look={Button.Looks.LINK} color={Button.Colors.PRIMARY} onClick={modalProps.onClose}>Cancel</Button>
            </ModalFooter>
        </ModalRoot>
    );
}
