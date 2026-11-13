const NAMED_ENTITIES: Record<string, string> = {
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&#39;": "'",
    "&apos;": "'",
    "&nbsp;": " ",
};

export function decodeHtmlEntities(input: string): string {
    return input
        .replaceAll(/&#(\d+);/gu, (_, code) => {
            const num = Number.parseInt(code, 10);
            return Number.isFinite(num) ? String.fromCodePoint(num) : "";
        })
        .replaceAll(/&#x([\da-f]+);/giu, (_, hex) => {
            const num = Number.parseInt(hex, 16);
            return Number.isFinite(num) ? String.fromCodePoint(num) : "";
        })
        .replaceAll(
            /&(?:amp|lt|gt|quot|#39|apos|nbsp);/gu,
            (entity) => NAMED_ENTITIES[entity] ?? entity,
        );
}

export function chunkArray<T>(items: readonly T[], size: number): T[][] {
    const safeSize = Math.max(1, Math.floor(size));
    const chunks: T[][] = [];
    for (let i = 0; i < items.length; i += safeSize) {
        chunks.push(items.slice(i, i + safeSize));
    }
    return chunks;
}

export function chunkText(text: string, maxLength: number): string[] {
    const safeMax = Math.max(1, Math.floor(maxLength));
    if (text.length <= safeMax) {
        return [text];
    }

    const pages: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
        if (remaining.length <= safeMax) {
            pages.push(remaining);
            break;
        }
        let splitAt = remaining.lastIndexOf("\n", safeMax);
        if (splitAt <= safeMax * 0.4) {
            splitAt = safeMax;
        }
        pages.push(remaining.slice(0, splitAt).trimEnd());
        remaining = remaining.slice(splitAt).replace(/^\n+/u, "");
    }
    return pages.length > 0 ? pages : [""];
}

export function createProgressBar(current: number, total: number, length = 15): string {
    if (!Number.isFinite(current) || !Number.isFinite(total) || total <= 0) {
        return `\`🔘${"▬".repeat(Math.max(1, length - 1))}\``;
    }

    const ratio = Math.max(0, Math.min(1, current / total));
    const pos = Math.max(1, Math.min(length, Math.ceil(ratio * length) || 1));
    return `\`${"▬".repeat(pos - 1)}🔘${"▬".repeat(length - pos)}\``;
}

export function createAsciiTable(rows: string[][]): string {
    const colCount = rows.reduce((max, row) => Math.max(max, row.length), 0);
    const widths: number[] = Array.from({ length: colCount }, () => 0);

    for (const row of rows) {
        for (let col = 0; col < row.length; col += 1) {
            const len = (row[col] ?? "").length;
            if (len > (widths[col] ?? 0)) {
                widths[col] = len;
            }
        }
    }

    return rows
        .map((row) =>
            row
                .map(
                    (cell, col) => cell + " ".repeat(Math.max(0, (widths[col] ?? 0) - cell.length)),
                )
                .join(" :: "),
        )
        .join("\n");
}

export function formatCodeSpan(value: string): string {
    const text = `${value}`;
    const runs = [...text.matchAll(/`+/gu)].map((match) => match[0].length);
    const maxBackticks = runs.length > 0 ? Math.max(...runs) : 0;
    const fence = "`".repeat(maxBackticks + 1);
    const padded = text.startsWith("`") || text.endsWith("`") ? ` ${text} ` : text;
    return `${fence}${padded}${fence}`;
}

export function formatPrefixedCommand(prefix: string, command: string): string {
    return formatCodeSpan(`${prefix}${command}`);
}

export function formatBoldPrefixedCommand(prefix: string, command: string): string {
    return `**${formatPrefixedCommand(prefix, command)}**`;
}

const ZERO_WIDTH_BREAK = "\u200b";

export function formatMarkdownText(value: string): string {
    return decodeHtmlEntities(`${value}`)
        .replaceAll("[", `${ZERO_WIDTH_BREAK}[`)
        .replaceAll("]", `]${ZERO_WIDTH_BREAK}`)
        .replaceAll(/[*_~`|]/gu, (match) => `${match}${ZERO_WIDTH_BREAK}`);
}

export function formatMarkdownLink(label: string, url: string | undefined | null): string {
    const safeUrl = url?.trim();
    if (!safeUrl) {
        return formatMarkdownText(label);
    }
    const encoded = encodeURI(safeUrl).replaceAll("(", "%28").replaceAll(")", "%29");
    return `[${formatMarkdownText(label)}](${encoded})`;
}

export function formatBoldMarkdownLink(label: string, url: string | undefined | null): string {
    return `**${formatMarkdownLink(label, url)}**`;
}

export function safeThumbUrl(
    url: string | undefined | null,
    fallback = "https://cdn.stegripe.org/images/icon.png",
): string {
    if (typeof url !== "string") {
        return fallback;
    }
    const trimmed = url.trim();
    return /^https?:\/\/.+/iu.test(trimmed) ? trimmed : fallback;
}
