/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// The profiler's whole purpose is to inspect every plugin in the registry, so
// it iterates the full `plugins` map (via the official @api/PluginManager
// boundary rather than Vencord.Plugins).
import { isPluginEnabled, plugins } from "@api/PluginManager";
import ErrorBoundary from "@components/ErrorBoundary";
import { ModalCloseButton, ModalContent, ModalHeader, ModalProps, ModalRoot, ModalSize, openModal } from "@utils/modal";
import { Text, TextInput, useMemo, useState } from "@webpack/common";

export interface PluginProfile {
    name: string;
    patchCount: number;
    contextMenuCount: number;
    hasFluxSubscriptions: boolean;
    impactScore: number;
    impactRating: "Low" | "Medium" | "High";
}

export function collectPluginData(): PluginProfile[] {
    const profiles: PluginProfile[] = [];

    for (const name in plugins) {
        const plugin = plugins[name];
        // isPluginEnabled also covers plugins running purely as dependencies,
        // which a manual settings[name]?.enabled check would miss.
        if (!isPluginEnabled(name)) continue;

        const patchCount = plugin.patches?.length ?? 0;
        const contextMenuCount = Object.keys(plugin.contextMenus ?? {}).length;
        const hasFluxSubscriptions = typeof plugin.flux === "object" && Object.keys(plugin.flux!).length > 0;
        const hasStart = typeof plugin.start === "function";
        const dependencyCount = plugin.dependencies?.length ?? 0;

        const impactScore =
            patchCount * 3 +
            contextMenuCount * 2 +
            (hasFluxSubscriptions ? 5 : 0) +
            (hasStart ? 2 : 0) +
            dependencyCount;

        let impactRating: PluginProfile["impactRating"];
        if (impactScore >= 20) impactRating = "High";
        else if (impactScore >= 8) impactRating = "Medium";
        else impactRating = "Low";

        profiles.push({
            name,
            patchCount,
            contextMenuCount,
            hasFluxSubscriptions,
            impactScore,
            impactRating,
        });
    }

    profiles.sort((a, b) => b.impactScore - a.impactScore);

    return profiles;
}

function impactColor(rating: PluginProfile["impactRating"]): string {
    if (rating === "High") return "#ed4245";
    if (rating === "Medium") return "#fee75c";
    return "#57f287";
}

function ProfilerModalComponent({ profiles: initialProfiles, modalProps }: { profiles: PluginProfile[]; modalProps: ModalProps; }) {
    const [profiles, setProfiles] = useState(initialProfiles);
    const [search, setSearch] = useState("");

    const filtered = useMemo(() => {
        if (!search) return profiles;
        const q = search.toLowerCase();
        return profiles.filter(p => p.name.toLowerCase().includes(q));
    }, [profiles, search]);

    const totalPatches = profiles.reduce((sum, p) => sum + p.patchCount, 0);
    const totalImpactScore = profiles.reduce((sum, p) => sum + p.impactScore, 0);

    return (
        <ModalRoot {...modalProps} size={ModalSize.LARGE}>
            <ModalHeader separator={false}>
                <div style={{ display: "flex", flexDirection: "column", flex: 1 }}>
                    <Text variant="heading-lg/semibold">Plugin Profiler</Text>
                    <Text variant="text-sm/normal" style={{ color: "var(--text-muted)", marginTop: "4px" }}>
                        {profiles.length} plugins enabled, {totalPatches} total patches, {totalImpactScore} total impact score
                    </Text>
                </div>
                <ModalCloseButton onClick={modalProps.onClose} />
            </ModalHeader>

            <div style={{ padding: "0 16px 12px", display: "flex", gap: "8px" }}>
                <div style={{ flex: 1 }}>
                    <TextInput placeholder="Search plugins..." value={search} onChange={setSearch} />
                </div>
                <div
                    style={{
                        padding: "8px 16px",
                        borderRadius: "4px",
                        backgroundColor: "var(--brand-500)",
                        color: "#fff",
                        fontSize: "14px",
                        fontWeight: 600,
                        cursor: "pointer",
                        display: "flex",
                        alignItems: "center",
                    }}
                    onClick={() => setProfiles(collectPluginData())}
                >
                    Refresh
                </div>
            </div>

            <ModalContent>
                <div style={{
                    display: "flex",
                    padding: "8px 16px",
                    borderBottom: "1px solid var(--background-modifier-accent)",
                    fontWeight: 700,
                    fontSize: "12px",
                    color: "var(--text-muted)",
                    textTransform: "uppercase",
                }}>
                    <span style={{ flex: 2 }}>Plugin</span>
                    <span style={{ flex: 1, textAlign: "center" }}>Patches</span>
                    <span style={{ flex: 1, textAlign: "center" }}>Ctx Menus</span>
                    <span style={{ flex: 1, textAlign: "center" }}>Impact Score</span>
                    <span style={{ flex: 1, textAlign: "center" }}>Impact</span>
                </div>

                {filtered.length === 0 ? (
                    <div style={{ padding: "40px 0", textAlign: "center" }}>
                        <Text variant="text-md/normal">No plugins match your search.</Text>
                    </div>
                ) : (
                    filtered.map(p => (
                        <div
                            key={p.name}
                            style={{
                                display: "flex",
                                alignItems: "center",
                                padding: "10px 16px",
                                borderBottom: "1px solid var(--background-modifier-accent)",
                            }}
                        >
                            <div style={{ flex: 2, display: "flex", flexDirection: "column" }}>
                                <span style={{ fontSize: "14px", fontWeight: 600, color: "var(--text-normal)" }}>
                                    {p.name}
                                </span>
                                {p.hasFluxSubscriptions && (
                                    <span style={{ fontSize: "11px", color: "var(--text-muted)" }}>
                                        Flux subscriber
                                    </span>
                                )}
                            </div>
                            <span style={{ flex: 1, textAlign: "center", fontSize: "14px", color: "var(--text-normal)" }}>
                                {p.patchCount}
                            </span>
                            <span style={{ flex: 1, textAlign: "center", fontSize: "14px", color: "var(--text-normal)" }}>
                                {p.contextMenuCount}
                            </span>
                            <span style={{ flex: 1, textAlign: "center", fontSize: "14px", color: "var(--text-normal)" }}>
                                {p.impactScore} pts
                            </span>
                            <span style={{
                                flex: 1,
                                textAlign: "center",
                                fontSize: "13px",
                                fontWeight: 700,
                                color: impactColor(p.impactRating),
                            }}>
                                {p.impactRating}
                            </span>
                        </div>
                    ))
                )}
            </ModalContent>
        </ModalRoot>
    );
}

const ProfilerModal = ErrorBoundary.wrap(ProfilerModalComponent);

export function openProfilerModal(profiles: PluginProfile[]) {
    openModal(modalProps => <ProfilerModal profiles={profiles} modalProps={modalProps} />);
}
