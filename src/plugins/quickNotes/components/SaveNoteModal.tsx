/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classNameFactory } from "@utils/css";
import { ModalCloseButton, ModalContent, ModalFooter, ModalHeader, ModalProps, ModalRoot, ModalSize } from "@utils/modal";
import { Button, Text, useState } from "@webpack/common";

const cl = classNameFactory("vc-quicknotes-");

const PRESET_TAGS = ["Important", "TODO", "CUSA", "Reference"];

interface SaveNoteModalProps {
    modalProps: ModalProps;
    onSave: (tag: string) => void;
}

export function SaveNoteModal({ modalProps, onSave }: SaveNoteModalProps) {
    const [tag, setTag] = useState("");

    return (
        <ModalRoot {...modalProps} size={ModalSize.SMALL}>
            <ModalHeader separator={false}>
                <Text variant="heading-lg/semibold" className={cl("header")}>
                    Save as Note
                </Text>
                <ModalCloseButton onClick={modalProps.onClose} />
            </ModalHeader>

            <ModalContent>
                <div className={cl("save-content")}>
                    <Text variant="text-md/medium" className={cl("save-label")}>
                        Tag / Category (optional)
                    </Text>

                    <input
                        type="text"
                        placeholder="Enter a tag..."
                        value={tag}
                        onChange={e => setTag(e.target.value)}
                        className={cl("tag-input")}
                    />

                    <div className={cl("preset-tags")}>
                        {PRESET_TAGS.map(preset => (
                            <button
                                key={preset}
                                onClick={() => setTag(preset)}
                                className={cl("preset-tag")}
                                data-selected={tag === preset}
                            >
                                {preset}
                            </button>
                        ))}
                    </div>
                </div>
            </ModalContent>

            <ModalFooter>
                <Button
                    onClick={() => {
                        onSave(tag.trim());
                        modalProps.onClose();
                    }}
                >
                    Save Note
                </Button>
                <Button
                    look={Button.Looks.LINK}
                    color={Button.Colors.PRIMARY}
                    onClick={modalProps.onClose}
                >
                    Cancel
                </Button>
            </ModalFooter>
        </ModalRoot>
    );
}
