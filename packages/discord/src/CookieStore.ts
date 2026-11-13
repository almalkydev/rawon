import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface NetscapeCookieEntry {
    domain: string;
    includeSubdomains: boolean;
    path: string;
    secure: boolean;
    expiration: number;
    name: string;
    value: string;
}

export class CookieStore {
    public readonly cookiesTxtPath: string;
    private readonly encryptedPath: string;
    private readonly secretKey: Buffer | null;

    public constructor(options: { dataDir: string; encryptionKey?: string | null }) {
        this.cookiesTxtPath = join(options.dataDir, "cookies.txt");
        this.encryptedPath = join(options.dataDir, "cookies.enc");
        this.secretKey = options.encryptionKey
            ? scryptSync(options.encryptionKey, "rawon-cookie-salt-v2", 32)
            : null;

        if (!existsSync(options.dataDir)) {
            mkdirSync(options.dataDir, { recursive: true });
        }
    }

    public saveCookies(entries: NetscapeCookieEntry[]): {
        cookiesPath: string;
        cookieHash: string;
        count: number;
    } {
        const lines = [
            "# Netscape HTTP Cookie File",
            "# Exported by Rawon V2 CookieStore",
            ...entries.map((c) =>
                [
                    c.domain,
                    c.includeSubdomains ? "TRUE" : "FALSE",
                    c.path || "/",
                    c.secure ? "TRUE" : "FALSE",
                    Math.floor(c.expiration || 0),
                    c.name,
                    c.value,
                ].join("\t"),
            ),
        ];
        const content = `${lines.join("\n")}\n`;
        const cookieHash = createHash("sha256").update(content).digest("hex");

        mkdirSync(dirname(this.cookiesTxtPath), { recursive: true });
        // Always maintain yt-dlp readable cookies.txt (0600 permissions)
        writeFileSync(this.cookiesTxtPath, content, { encoding: "utf8", mode: 0o600 });

        if (this.secretKey) {
            const iv = randomBytes(12);
            const cipher = createCipheriv("aes-256-gcm", this.secretKey, iv);
            const encrypted = Buffer.concat([cipher.update(content, "utf8"), cipher.final()]);
            const tag = cipher.getAuthTag();
            const payload = Buffer.concat([iv, tag, encrypted]);
            writeFileSync(this.encryptedPath, payload, { mode: 0o600 });
        }

        return {
            cookiesPath: this.cookiesTxtPath,
            cookieHash,
            count: entries.length,
        };
    }

    public restoreFromEncryptedIfNeeded(): string | null {
        if (existsSync(this.cookiesTxtPath)) {
            return this.cookiesTxtPath;
        }
        if (!this.secretKey || !existsSync(this.encryptedPath)) {
            return null;
        }
        try {
            const buf = readFileSync(this.encryptedPath);
            if (buf.byteLength < 29) return null;
            const iv = buf.subarray(0, 12);
            const tag = buf.subarray(12, 28);
            const ciphertext = buf.subarray(28);
            const decipher = createDecipheriv("aes-256-gcm", this.secretKey, iv);
            decipher.setAuthTag(tag);
            const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
                "utf8",
            );
            writeFileSync(this.cookiesTxtPath, plain, { encoding: "utf8", mode: 0o600 });
            return this.cookiesTxtPath;
        } catch {
            return null;
        }
    }

    public hasCookies(): boolean {
        return existsSync(this.cookiesTxtPath) || existsSync(this.encryptedPath);
    }

    public clear(): void {
        if (existsSync(this.cookiesTxtPath)) unlinkSync(this.cookiesTxtPath);
        if (existsSync(this.encryptedPath)) unlinkSync(this.encryptedPath);
    }
}
