import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { SecurityError } from "./errors.js";

export type DnsResolver = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

const dnsCache = new Map<
    string,
    { records: Array<{ address: string; family: number }>; expiresAt: number }
>();
const DNS_CACHE_TTL_MS = 5 * 60_000;

const defaultDnsResolver: DnsResolver = async (hostname) => {
    const key = hostname.toLowerCase();
    const cached = dnsCache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
        return cached.records;
    }
    const records = await lookup(hostname, { all: true, verbatim: true });
    if (records.length > 0) {
        if (dnsCache.size >= 1000) {
            const oldestKey = dnsCache.keys().next().value;
            if (oldestKey) dnsCache.delete(oldestKey);
        }
        dnsCache.set(key, { records, expiresAt: Date.now() + DNS_CACHE_TTL_MS });
    }
    return records;
};

function parseIPv4(ip: string): number[] | null {
    const parts = ip.split(".");
    if (parts.length !== 4) {
        return null;
    }
    const nums: number[] = [];
    for (const part of parts) {
        if (!/^\d{1,3}$/u.test(part)) {
            return null;
        }
        const n = Number(part);
        if (n < 0 || n > 255) {
            return null;
        }
        nums.push(n);
    }
    return nums;
}

export function isPrivateOrReservedIp(ipRaw: string): boolean {
    const zoneIndex = ipRaw.indexOf("%");
    const ip = (zoneIndex === -1 ? ipRaw : ipRaw.slice(0, zoneIndex)).toLowerCase();
    const version = isIP(ip);
    if (version === 0) {
        return true;
    }

    if (version === 4) {
        const octets = parseIPv4(ip);
        if (!octets) {
            return true;
        }
        const [a = 0, b = 0] = octets;
        if (a === 0) return true; // 0.0.0.0/8 "this network"
        if (a === 10) return true; // 10.0.0.0/8 RFC1918
        if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
        if (a === 127) return true; // 127.0.0.0/8 loopback
        if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local / IMDS
        if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 RFC1918
        if (a === 192 && b === 0 && octets[2] === 0) return true; // 192.0.0.0/24
        if (a === 192 && b === 0 && octets[2] === 2) return true; // TEST-NET-1
        if (a === 192 && b === 168) return true; // 192.168.0.0/16 RFC1918
        if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
        if (a === 198 && b === 51 && octets[2] === 100) return true; // TEST-NET-2
        if (a === 203 && b === 0 && octets[2] === 113) return true; // TEST-NET-3
        if (a >= 224) return true; // multicast & reserved
        return false;
    }

    // IPv6 checks
    if (ip === "::" || ip === "::1") {
        return true;
    }

    // Handle IPv4-mapped IPv6 addresses like ::ffff:127.0.0.1 or ::ffff:7f00:1
    if (ip.startsWith("::ffff:")) {
        const mapped = ip.slice("::ffff:".length);
        if (mapped.includes(".")) {
            return isPrivateOrReservedIp(mapped);
        }
        const hexParts = mapped.split(":");
        if (hexParts.length === 2) {
            const hi = Number.parseInt(hexParts[0] ?? "", 16);
            const lo = Number.parseInt(hexParts[1] ?? "", 16);
            if (!Number.isNaN(hi) && !Number.isNaN(lo)) {
                const ipv4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
                return isPrivateOrReservedIp(ipv4);
            }
        }
    }

    const firstHextetStr = ip.split(":")[0] || "0";
    const firstHextet = Number.parseInt(firstHextetStr, 16);
    if (Number.isNaN(firstHextet)) {
        return true;
    }
    if ((firstHextet & 0xfe00) === 0xfc00) return true; // fc00::/7 Unique local
    if ((firstHextet & 0xffc0) === 0xfe80) return true; // fe80::/10 Link-local
    if ((firstHextet & 0xff00) === 0xff00) return true; // ff00::/8 Multicast
    if (ip.startsWith("2001:db8:")) return true; // documentation
    if (ip.startsWith("64:ff9b:") || ip.startsWith("100::")) return true; // translation/discard

    return false;
}

const BLOCKED_HOSTNAMES = new Set([
    "localhost",
    "localhost.localdomain",
    "ip6-localhost",
    "ip6-loopback",
    "metadata.google.internal",
    "metadata.goog",
]);

export interface SafeUrlOptions {
    allowHttp?: boolean;
    dnsResolver?: DnsResolver;
    resolveDns?: boolean;
}

export async function assertSafePublicUrl(
    rawUrl: string,
    options: SafeUrlOptions = {},
): Promise<URL> {
    let parsed: URL;
    try {
        parsed = new URL(rawUrl.trim());
    } catch {
        throw new SecurityError(`Invalid URL format: ${rawUrl}`);
    }

    const allowHttp = options.allowHttp ?? true;
    const allowedProtocols = allowHttp ? new Set(["https:", "http:"]) : new Set(["https:"]);
    if (!allowedProtocols.has(parsed.protocol)) {
        throw new SecurityError(`Blocked URL protocol: ${parsed.protocol}`);
    }

    if (parsed.username || parsed.password) {
        throw new SecurityError("URLs containing embedded credentials are not allowed");
    }

    const hostname = parsed.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
    if (!hostname || BLOCKED_HOSTNAMES.has(hostname) || hostname.endsWith(".local")) {
        throw new SecurityError(`Blocked internal hostname: ${hostname}`);
    }

    if (isIP(hostname) !== 0) {
        if (isPrivateOrReservedIp(hostname)) {
            throw new SecurityError(`Blocked private or reserved IP address: ${hostname}`);
        }
        return parsed;
    }

    if (options.resolveDns !== false) {
        const resolver = options.dnsResolver ?? defaultDnsResolver;
        let records: Array<{ address: string; family: number }>;
        try {
            records = await resolver(hostname);
        } catch (err) {
            throw new SecurityError(`DNS resolution failed for ${hostname}`, err);
        }

        if (records.length === 0) {
            throw new SecurityError(`DNS resolution returned no records for ${hostname}`);
        }

        for (const record of records) {
            if (isPrivateOrReservedIp(record.address)) {
                throw new SecurityError(
                    `Blocked hostname ${hostname} resolving to private IP ${record.address}`,
                );
            }
        }
    }

    return parsed;
}

export function isValidHttpUrlSyntax(rawUrl: string): boolean {
    try {
        const parsed = new URL(rawUrl.trim());
        return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
        return false;
    }
}
