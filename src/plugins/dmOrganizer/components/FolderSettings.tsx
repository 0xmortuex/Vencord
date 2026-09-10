/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {
    createFolder,
    deleteFolder,
    Folder,
    getData,
    updateFolder,
    useDMOrganizer,
} from "@plugins/dmOrganizer/store";
import { ModalCloseButton, ModalContent, ModalFooter, ModalHeader, ModalProps, ModalRoot, ModalSize, openModal } from "@utils/modal";
import { Button, Forms, React, TextInput, useState } from "@webpack/common";

function FolderEditRow({ folder }: { folder: Folder; }) {
    const [name, setName] = useState(folder.name);
    const [color, setColor] = useState(folder.color);

    // Typing a name / dragging the colour picker used to persist to storage and
    // notify every subscriber on EVERY keystroke/move. Keep the inputs instant
    // (local state) and write once, shortly after the user stops; flush on
    // unmount so closing the modal mid-edit never loses the change.
    const pending = React.useRef<Partial<Folder> | null>(null);
    const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const flush = React.useCallback(() => {
        if (timer.current) { clearTimeout(timer.current); timer.current = null; }
        if (pending.current) { updateFolder(folder.id, pending.current); pending.current = null; }
    }, [folder.id]);
    const queueUpdate = React.useCallback((patch: Partial<Folder>) => {
        pending.current = { ...(pending.current ?? {}), ...patch };
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(flush, 400);
    }, [flush]);
    React.useEffect(() => flush, [flush]);

    return (
        <div className="vc-dmorg-settings-row">
            <div
                className="vc-dmorg-settings-color-swatch"
                style={{ backgroundColor: color }}
            >
                <input
                    type="color"
                    value={color}
                    onChange={e => {
                        setColor(e.target.value);
                        queueUpdate({ color: e.target.value });
                    }}
                    className="vc-dmorg-settings-color-input"
                />
            </div>
            <TextInput
                value={name}
                onChange={val => {
                    setName(val);
                    queueUpdate({ name: val });
                }}
                style={{ flex: 1 }}
            />
            <Button
                color={Button.Colors.RED}
                size={Button.Sizes.SMALL}
                onClick={() => deleteFolder(folder.id)}
            >
                Delete
            </Button>
        </div>
    );
}

function FolderSettingsModal({ modalProps, editFolderId }: { modalProps: ModalProps; editFolderId?: string; }) {
    // Subscribe to store changes so deletes/creates re-render this modal too,
    // not just the patched DM list.
    useDMOrganizer();
    const [newName, setNewName] = useState("");
    const [newColor, setNewColor] = useState("#5865f2");
    const { folders } = getData();

    // If editing a single folder, show a simpler view
    if (editFolderId) {
        const folder = folders.find(f => f.id === editFolderId);
        if (!folder) return null;

        return (
            <ModalRoot {...modalProps} size={ModalSize.SMALL}>
                <ModalHeader separator={false}>
                    <div style={{ color: "#dcddde", fontWeight: 600, fontSize: "20px", flex: 1 }}>
                        Edit Folder
                    </div>
                    <ModalCloseButton onClick={modalProps.onClose} />
                </ModalHeader>
                <ModalContent>
                    <div style={{ padding: "16px" }}>
                        <FolderEditRow folder={folder} />
                    </div>
                </ModalContent>
                <ModalFooter>
                    <Button onClick={modalProps.onClose}>Done</Button>
                </ModalFooter>
            </ModalRoot>
        );
    }

    return (
        <ModalRoot {...modalProps} size={ModalSize.MEDIUM}>
            <ModalHeader separator={false}>
                <div style={{ color: "#dcddde", fontWeight: 600, fontSize: "20px", flex: 1 }}>
                    Manage Folders
                </div>
                <ModalCloseButton onClick={modalProps.onClose} />
            </ModalHeader>
            <ModalContent>
                <div style={{ padding: "16px" }}>
                    <Forms.FormTitle>Create New Folder</Forms.FormTitle>
                    <div className="vc-dmorg-settings-row">
                        <div
                            className="vc-dmorg-settings-color-swatch"
                            style={{ backgroundColor: newColor }}
                        >
                            <input
                                type="color"
                                value={newColor}
                                onChange={e => setNewColor(e.target.value)}
                                className="vc-dmorg-settings-color-input"
                            />
                        </div>
                        <TextInput
                            value={newName}
                            onChange={setNewName}
                            placeholder="Folder name..."
                            style={{ flex: 1 }}
                        />
                        <Button
                            size={Button.Sizes.SMALL}
                            disabled={!newName.trim()}
                            onClick={() => {
                                createFolder(newName.trim(), newColor);
                                setNewName("");
                                setNewColor("#5865f2");
                            }}
                        >
                            Create
                        </Button>
                    </div>

                    {folders.length > 0 && (
                        <>
                            <Forms.FormTitle style={{ marginTop: "16px" }}>Existing Folders</Forms.FormTitle>
                            {folders.map(folder => (
                                <FolderEditRow key={folder.id} folder={folder} />
                            ))}
                        </>
                    )}
                </div>
            </ModalContent>
            <ModalFooter>
                <Button onClick={modalProps.onClose}>Done</Button>
            </ModalFooter>
        </ModalRoot>
    );
}

export function openFolderSettingsModal(editFolderId?: string) {
    openModal(modalProps => (
        <FolderSettingsModal modalProps={modalProps} editFolderId={editFolderId} />
    ));
}

export function ManageFoldersButton() {
    return (
        <Button onClick={() => openFolderSettingsModal()}>
            Manage Folders
        </Button>
    );
}
