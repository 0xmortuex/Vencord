/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Devs } from "@utils/constants";
import definePlugin from "@utils/types";
import { Button } from "@webpack/common";

import { collectPluginData, openProfilerModal } from "./components/ProfilerModal";

export default definePlugin({
    name: "PluginProfiler",
    description: "Measures and displays performance impact of all active Vencord plugins",
    authors: [Devs.UnknownHacker9991],

    settingsAboutComponent() {
        return (
            <Button onClick={() => openProfilerModal(collectPluginData())}>
                Open Plugin Profiler
            </Button>
        );
    },
});
