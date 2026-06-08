/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ExportedMessage } from "./exporter";

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function renderMarkdown(text: string): string {
    let html = escapeHtml(text);

    // Code blocks (multi-line)
    html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, (_match, _lang, code) =>
        `<div style="background:#2b2d31;border-radius:4px;padding:8px 12px;margin:4px 0;font-family:'Consolas','Courier New',monospace;font-size:0.875rem;white-space:pre-wrap;border:1px solid #1e1f22;">${code}</div>`
    );

    // Inline code
    html = html.replace(/`([^`]+)`/g, (_match, code) =>
        `<code style="background:#2b2d31;padding:2px 4px;border-radius:3px;font-family:'Consolas','Courier New',monospace;font-size:0.875rem;">${code}</code>`
    );

    // Bold
    html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    // Italic
    html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");
    html = html.replace(/_(.+?)_/g, "<em>$1</em>");
    // Strikethrough
    html = html.replace(/~~(.+?)~~/g, "<s>$1</s>");
    // Underline
    html = html.replace(/__(.+?)__/g, "<u>$1</u>");

    // Links
    html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
        "<a href=\"$2\" style=\"color:#00aff4;text-decoration:none;\" target=\"_blank\">$1</a>"
    );
    html = html.replace(/(https?:\/\/[^\s<]+)/g,
        "<a href=\"$1\" style=\"color:#00aff4;text-decoration:none;\" target=\"_blank\">$1</a>"
    );

    // Newlines
    html = html.replace(/\n/g, "<br>");

    return html;
}

function formatTimestamp(iso: string): string {
    const d = new Date(iso);
    return d.toLocaleString("en-US", {
        month: "2-digit",
        day: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: true,
    });
}

function getAvatarUrl(author: ExportedMessage["author"]): string {
    if (author.avatar) {
        return `https://cdn.discordapp.com/avatars/${author.id}/${author.avatar}.png?size=64`;
    }
    const index = (BigInt(author.id) >> 22n) % 6n;
    return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
}

function renderAttachments(attachments: any[]): string {
    if (!attachments.length) return "";
    return attachments.map(att => {
        const isImage = att.content_type?.startsWith("image/") ||
            /\.(png|jpg|jpeg|gif|webp)$/i.test(att.filename);
        if (isImage) {
            return `<div style="margin:4px 0;">
                <a href="${escapeHtml(att.url)}" target="_blank">
                    <img src="${escapeHtml(att.url)}" alt="${escapeHtml(att.filename)}"
                        style="max-width:400px;max-height:300px;border-radius:8px;">
                </a>
            </div>`;
        }
        return `<div style="margin:4px 0;padding:8px 12px;background:#2b2d31;border-radius:8px;border:1px solid #1e1f22;">
            <a href="${escapeHtml(att.url)}" style="color:#00aff4;text-decoration:none;" target="_blank">
                📎 ${escapeHtml(att.filename)}${att.size ? ` (${(att.size / 1024).toFixed(1)} KB)` : ""}
            </a>
        </div>`;
    }).join("");
}

function renderEmbeds(embeds: any[]): string {
    if (!embeds.length) return "";
    return embeds.map(embed => {
        const borderColor = embed.color ? `#${embed.color.toString(16).padStart(6, "0")}` : "#4f545c";
        let html = `<div style="margin:4px 0;padding:8px 16px;background:#2b2d31;border-left:4px solid ${borderColor};border-radius:4px;max-width:520px;">`;

        if (embed.author?.name) {
            html += `<div style="font-size:0.875rem;font-weight:600;margin-bottom:4px;">${escapeHtml(embed.author.name)}</div>`;
        }
        if (embed.title) {
            const title = embed.url
                ? `<a href="${escapeHtml(embed.url)}" style="color:#00aff4;text-decoration:none;font-weight:700;">${escapeHtml(embed.title)}</a>`
                : `<span style="font-weight:700;">${escapeHtml(embed.title)}</span>`;
            html += `<div style="margin-bottom:4px;">${title}</div>`;
        }
        if (embed.description) {
            html += `<div style="font-size:0.875rem;color:#dcddde;margin-bottom:8px;">${renderMarkdown(embed.description)}</div>`;
        }
        if (embed.fields?.length) {
            html += "<div style=\"display:flex;flex-wrap:wrap;gap:8px;\">";
            for (const field of embed.fields) {
                const width = field.inline ? "calc(33% - 8px)" : "100%";
                html += `<div style="min-width:0;flex:0 0 ${width};">
                    <div style="font-size:0.75rem;font-weight:700;color:#b9bbbe;margin-bottom:2px;">${escapeHtml(field.name)}</div>
                    <div style="font-size:0.875rem;color:#dcddde;">${renderMarkdown(field.value)}</div>
                </div>`;
            }
            html += "</div>";
        }
        if (embed.image?.url) {
            html += `<div style="margin-top:8px;"><img src="${escapeHtml(embed.image.url)}" style="max-width:100%;border-radius:4px;"></div>`;
        }
        if (embed.thumbnail?.url) {
            html += `<div style="margin-top:8px;"><img src="${escapeHtml(embed.thumbnail.url)}" style="max-width:80px;border-radius:4px;float:right;"></div>`;
        }
        if (embed.footer?.text) {
            html += `<div style="font-size:0.75rem;color:#72767d;margin-top:8px;">${escapeHtml(embed.footer.text)}</div>`;
        }

        html += "</div>";
        return html;
    }).join("");
}

function renderReactions(reactions: any[]): string {
    if (!reactions.length) return "";
    const items = reactions.map(r => {
        const emoji = r.emoji.id
            ? `<img src="https://cdn.discordapp.com/emojis/${r.emoji.id}.${r.emoji.animated ? "gif" : "png"}?size=16" style="width:16px;height:16px;vertical-align:middle;">`
            : escapeHtml(r.emoji.name);
        return `<span style="display:inline-flex;align-items:center;gap:4px;background:#2b2d31;border:1px solid #1e1f22;border-radius:8px;padding:2px 8px;font-size:0.875rem;">${emoji} <span style="color:#b5bac1;">${r.count}</span></span>`;
    }).join(" ");
    return `<div style="margin-top:4px;display:flex;flex-wrap:wrap;gap:4px;">${items}</div>`;
}

function shouldGroup(prev: ExportedMessage | null, curr: ExportedMessage): boolean {
    if (!prev) return false;
    if (prev.author.id !== curr.author.id) return false;
    const timeDiff = new Date(curr.timestamp).getTime() - new Date(prev.timestamp).getTime();
    return timeDiff < 7 * 60 * 1000; // 7 minutes
}

export function renderHtml(
    messages: ExportedMessage[],
    channelName: string,
    serverName: string
): string {
    let messagesHtml = "";

    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        const prev = i > 0 ? messages[i - 1] : null;
        const grouped = shouldGroup(prev, msg);

        if (grouped) {
            messagesHtml += `<div style="padding:2px 16px 2px 72px;position:relative;" class="vc-ce-msg">
                <span style="display:none;position:absolute;left:16px;top:4px;font-size:0.6875rem;color:#949ba4;width:40px;text-align:right;" class="vc-ce-ts">${new Date(msg.timestamp).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: true })}</span>`;
        } else {
            const displayName = msg.author.globalName || msg.author.username;
            messagesHtml += `<div style="padding:4px 16px;margin-top:16px;display:flex;gap:16px;position:relative;" class="vc-ce-msg">
                <img src="${getAvatarUrl(msg.author)}" style="width:40px;height:40px;border-radius:50%;flex-shrink:0;margin-top:2px;">
                <div style="flex:1;min-width:0;">
                    <div style="display:flex;align-items:baseline;gap:8px;">
                        <span style="font-weight:600;color:#f2f3f5;">${escapeHtml(displayName)}</span>
                        ${msg.author.bot ? "<span style=\"background:#5865f2;color:#fff;font-size:0.625rem;padding:1px 4px;border-radius:3px;font-weight:600;\">BOT</span>" : ""}
                        <span style="font-size:0.75rem;color:#949ba4;">${formatTimestamp(msg.timestamp)}</span>
                        ${msg.edited_timestamp ? "<span style=\"font-size:0.625rem;color:#949ba4;\">(edited)</span>" : ""}
                    </div>`;
        }

        if (!grouped) {
            if (msg.content) {
                messagesHtml += `<div style="color:#dbdee1;line-height:1.375;">${renderMarkdown(msg.content)}</div>`;
            }
            messagesHtml += renderAttachments(msg.attachments);
            messagesHtml += renderEmbeds(msg.embeds);
            messagesHtml += renderReactions(msg.reactions);
            messagesHtml += "</div></div>";
        } else {
            if (msg.content) {
                messagesHtml += `<div style="color:#dbdee1;line-height:1.375;">${renderMarkdown(msg.content)}</div>`;
            }
            messagesHtml += renderAttachments(msg.attachments);
            messagesHtml += renderEmbeds(msg.embeds);
            messagesHtml += renderReactions(msg.reactions);
            messagesHtml += "</div>";
        }
    }

    const exportDate = new Date().toLocaleString();

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(serverName)} - #${escapeHtml(channelName)}</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { background: #313338; color: #dbdee1; font-family: 'gg sans', 'Noto Sans', 'Helvetica Neue', Helvetica, Arial, sans-serif; font-size: 1rem; }
a { color: #00aff4; }
.vc-ce-msg:hover { background: #2e3035; }
.vc-ce-msg:hover .vc-ce-ts { display: inline !important; }
::-webkit-scrollbar { width: 8px; }
::-webkit-scrollbar-track { background: #2b2d31; }
::-webkit-scrollbar-thumb { background: #1a1b1e; border-radius: 4px; }
</style>
</head>
<body>
<div style="background:#1e1f22;padding:16px 16px;border-bottom:1px solid #1e1f22;">
    <h1 style="font-size:1.25rem;font-weight:700;color:#f2f3f5;"># ${escapeHtml(channelName)}</h1>
    <div style="font-size:0.875rem;color:#949ba4;margin-top:4px;">${escapeHtml(serverName)} &mdash; ${messages.length} messages exported</div>
</div>
<div style="padding:8px 0;">
${messagesHtml}
</div>
<div style="text-align:center;padding:24px;color:#949ba4;font-size:0.75rem;border-top:1px solid #1e1f22;margin-top:16px;">
    Generated by ChatExporter &mdash; ${escapeHtml(exportDate)}
</div>
</body>
</html>`;
}
