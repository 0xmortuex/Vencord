/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { getNote, setNote } from "@plugins/dmOrganizer/store";
import { ModalCloseButton, ModalContent, ModalFooter, ModalHeader, ModalProps, ModalRoot, ModalSize, openModal } from "@utils/modal";
import { Button, React, TextInput, useState } from "@webpack/common";

function AddNoteModalContent({ modalProps, channelId }: { modalProps: ModalProps; channelId: string; }) {
    const [text, setText] = useState(getNote(channelId));

    const onSave = () => {
        setNote(channelId, text);
        modalProps.onClose();
    };

    return (
        <ModalRoot {...modalProps} size={ModalSize.SMALL}>
            <ModalHeader separator={false}>
                <div style={{ color: "#dcddde", fontWeight: 600, fontSize: "20px", flex: 1 }}>
                    Add Note
                </div>
                <ModalCloseButton onClick={modalProps.onClose} />
            </ModalHeader>
            <ModalContent>
                <div style={{ padding: "16px" }}>
                    <TextInput
                        value={text}
                        onChange={setText}
                        placeholder="Type a note for this DM..."
                    />
                </div>
            </ModalContent>
            <ModalFooter>
                <Button onClick={onSave}>Save</Button>
                <Button
                    color={Button.Colors.TRANSPARENT}
                    onClick={modalProps.onClose}
                    style={{ marginLeft: "8px" }}
                >
                    Cancel
                </Button>
            </ModalFooter>
        </ModalRoot>
    );
}

export function openAddNoteModal(channelId: string) {
    openModal(modalProps => (
        <AddNoteModalContent modalProps={modalProps} channelId={channelId} />
    ));
}
