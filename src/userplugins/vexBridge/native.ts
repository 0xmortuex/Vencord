/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/*
 * VexBridge, Vencord Desktop only (runs in the Electron main process through Vencord's native helpers).
 * Folder: the VEX_BRIDGE_DIR environment variable or, if unset, <Documents>/VexBridge.
 * Exactly two file names are touched, and the folder is never listed:
 *   - write(): vex-bridge.json, written atomically (tmp + rename).
 *   - readStatus(): vex-status.json, the Discord status command Vex writes (read only, a plain file under 4 KB).
 */

import { IpcMainInvokeEvent } from "electron";
import { lstat, mkdir, readFile, rename, writeFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";

const FILE = "vex-bridge.json";
const STATUS_FILE = "vex-status.json";
const MAX = 1024 * 1024;
const STATUS_MAX = 4096;

const folder = () => process.env.VEX_BRIDGE_DIR || join(homedir(), "Documents", "VexBridge");

export async function write(_: IpcMainInvokeEvent, text: string) {
    if (typeof text !== "string" || Buffer.byteLength(text) > MAX) throw new Error("VexBridge: refusing to write more than 1 MB");
    const dir = folder();
    await mkdir(dir, { recursive: true });
    const tmp = join(dir, FILE + ".tmp");
    await writeFile(tmp, text, "utf8");
    await rename(tmp, join(dir, FILE));
}

/** The text of vex-status.json, or null when the file does not exist. Anything else wrong is an error. */
export async function readStatus(_: IpcMainInvokeEvent): Promise<string | null> {
    const file = join(folder(), STATUS_FILE);
    let st;
    try {
        st = await lstat(file);
    } catch (e: any) {
        if (e?.code === "ENOENT") return null;
        throw e;
    }
    if (!st.isFile()) throw new Error("VexBridge: vex-status.json is not a plain file");
    if (st.size > STATUS_MAX) throw new Error("VexBridge: vex-status.json is bigger than 4 KB");
    return readFile(file, "utf8");
}
