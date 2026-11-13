import {
    assertSafePublicUrl,
    createLogger,
    isPrivateOrReservedIp,
    redactSensitiveText,
    SecurityError,
} from "@rawon/shared";
import { describe, expect, it } from "vitest";

describe("SSRF & Security Guards", () => {
    it("blocks private, loopback, CGNAT, link-local, documentation, and reserved IP addresses", () => {
        const blocked = [
            "0.0.0.0",
            "10.0.0.1",
            "10.255.255.254",
            "100.64.0.1",
            "100.127.255.254",
            "127.0.0.1",
            "127.1.2.3",
            "169.254.169.254",
            "172.16.0.1",
            "172.31.255.254",
            "192.0.0.1",
            "192.0.2.1",
            "192.168.1.1",
            "198.18.0.1",
            "198.51.100.1",
            "203.0.113.1",
            "224.0.0.1",
            "255.255.255.255",
            "::",
            "::1",
            "::ffff:127.0.0.1",
            "::ffff:7f00:1",
            "fc00::1",
            "fd12:3456::1",
            "fe80::1%eth0",
            "ff02::1",
            "2001:db8::1",
            "not-an-ip",
        ];

        for (const ip of blocked) {
            expect(isPrivateOrReservedIp(ip), `Expected ${ip} to be flagged private/reserved`).toBe(
                true,
            );
        }
    });

    it("allows public IPv4 and IPv6 addresses", () => {
        const allowed = ["1.1.1.1", "8.8.8.8", "142.250.185.78", "2606:4700:4700::1111"];
        for (const ip of allowed) {
            expect(isPrivateOrReservedIp(ip), `Expected ${ip} to be allowed`).toBe(false);
        }
    });

    it("rejects non-HTTP protocols, embedded credentials, localhost, and .local domains", async () => {
        const unsafeUrls = [
            "file:///etc/passwd",
            "ftp://example.com/file.mp3",
            "gopher://127.0.0.1:6379/_INFO",
            "https://user:pass@example.com/stream.mp3",
            "http://localhost:8080/admin",
            "http://metadata.google.internal/computeMetadata/v1/",
            "https://internal-redis.local/export.json",
            "http://169.254.169.254/latest/meta-data/",
            "http://[::1]:3000/secret",
        ];

        for (const url of unsafeUrls) {
            await expect(assertSafePublicUrl(url, { resolveDns: false })).rejects.toThrow(
                SecurityError,
            );
        }
    });

    it("defends against DNS rebinding to private IPs while permitting public DNS results", async () => {
        await expect(
            assertSafePublicUrl("https://rebind.attacker.example/export.json", {
                dnsResolver: async () => [{ address: "10.0.0.42", family: 4 }],
            }),
        ).rejects.toThrow(SecurityError);

        await expect(
            assertSafePublicUrl("https://rebind-mixed.example/export.json", {
                dnsResolver: async () => [
                    { address: "93.184.216.34", family: 4 },
                    { address: "192.168.10.5", family: 4 },
                ],
            }),
        ).rejects.toThrow(SecurityError);

        const safeParsed = await assertSafePublicUrl("https://cdn.example.com/song.opus", {
            dnsResolver: async () => [{ address: "93.184.216.34", family: 4 }],
        });
        expect(safeParsed.hostname).toBe("cdn.example.com");
    });

    it("redacts sensitive tokens and secrets from text and logger configuration", () => {
        const secretToken = "MTIzNDU2Nzg5.ABCDEF.super_secret_token_xyz";
        const dbUrl = "postgres://rawon:s3cr3tPass@postgres:5432/rawon";
        const input = `token=${secretToken} db=${dbUrl}`;

        const redacted = redactSensitiveText(input, [secretToken, dbUrl, "tiny", ""]);
        expect(redacted).not.toContain(secretToken);
        expect(redacted).not.toContain(dbUrl);
        expect(redacted).toContain("[REDACTED]");

        const logger = createLogger({
            scope: "security-test",
            level: "silent",
            redactSecrets: [secretToken, dbUrl],
        });
        expect(logger).toBeDefined();
    });
});
