import { existsSync } from "node:fs";
import type { DatabaseStore } from "@rawon/database";
import {
    getOrFetchYouTubeVisitorData,
    type YouTubeDeviceCodeSession,
    type YouTubeOAuthManager,
    type YtDlpClient,
} from "@rawon/providers";
import type { AuthSessionRecord, Logger } from "@rawon/shared";
import puppeteer, { type Browser } from "puppeteer-core";
import {
    type CookieStore,
    type NetscapeCookieEntry,
    parseNetscapeCookieEntries,
} from "./CookieStore.js";

function findChromiumExecutable(explicitPath?: string | null): string | null {
    const candidates = [
        explicitPath,
        process.env.CHROME_PATH,
        process.env.CHROMIUM_PATH,
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        "/usr/bin/google-chrome",
    ].filter((c): c is string => Boolean(c?.trim()));

    for (const candidate of candidates) {
        if (existsSync(candidate)) {
            return candidate;
        }
    }
    return null;
}

export class GoogleLoginService {
    private readonly store: DatabaseStore;
    private readonly cookieStore: CookieStore;
    private readonly ytdlp: YtDlpClient;
    private readonly oauthManager: YouTubeOAuthManager | null;
    private readonly devtoolsPort: number;
    private readonly chromiumPath: string | null;
    private readonly logger?: Logger;

    private browser: Browser | null = null;
    private refreshTimer: NodeJS.Timeout | null = null;

    public constructor(options: {
        store: DatabaseStore;
        cookieStore: CookieStore;
        ytdlp: YtDlpClient;
        oauthManager?: YouTubeOAuthManager | null;
        devtoolsPort?: number;
        chromiumPath?: string | null;
        logger?: Logger;
    }) {
        this.store = options.store;
        this.cookieStore = options.cookieStore;
        this.ytdlp = options.ytdlp;
        this.oauthManager = options.oauthManager ?? null;
        this.devtoolsPort = options.devtoolsPort ?? 3000;
        this.chromiumPath = options.chromiumPath ?? null;
        this.logger = options.logger;
    }

    public hasOAuth(): boolean {
        return Boolean(this.oauthManager?.hasRefreshToken());
    }

    public async startOAuthDeviceLogin(): Promise<YouTubeDeviceCodeSession> {
        if (!this.oauthManager) {
            throw new Error("YouTube OAuth manager is not initialized.");
        }
        await this.store.saveAuthSession({
            id: 1,
            status: "waiting_for_login",
            error: null,
        });

        return this.oauthManager.startDeviceFlow({
            onAuthorized: async () => {
                await this.store.saveAuthSession({
                    id: 1,
                    status: "logged_in",
                    lastRefresh: Date.now(),
                    error: null,
                });
                this.logger?.info("YouTube OAuth2 device authorization completed successfully");
            },
            onError: async (err) => {
                this.logger?.warn({ err }, "YouTube OAuth2 device authorization failed");
                await this.store.saveAuthSession({
                    id: 1,
                    status: "error",
                    error: err.message,
                });
            },
        });
    }

    public async getStatus(): Promise<AuthSessionRecord> {
        return this.store.getAuthSession(1);
    }

    public async startInteractiveLogin(timeoutMs = 300_000): Promise<{
        devtoolsPort: number;
        wsEndpoint: string;
        record: AuthSessionRecord;
    }> {
        await this.stopBrowser();

        const executablePath = findChromiumExecutable(this.chromiumPath);
        if (!executablePath) {
            const errMsg =
                "No Chromium/Chrome executable found. Set CHROMIUM_PATH in your environment.";
            await this.store.saveAuthSession({
                id: 1,
                status: "error",
                error: errMsg,
            });
            throw new Error(errMsg);
        }

        await this.store.saveAuthSession({
            id: 1,
            status: "waiting_for_login",
            error: null,
        });

        const browser = await puppeteer.launch({
            executablePath,
            headless: true,
            args: [
                "--no-sandbox",
                "--disable-setuid-sandbox",
                `--remote-debugging-port=${this.devtoolsPort}`,
                "--remote-debugging-address=127.0.0.1",
            ],
        });
        this.browser = browser;

        const page = await browser.newPage();
        await page.goto("https://accounts.google.com/ServiceLogin?service=youtube", {
            waitUntil: "networkidle2",
        });

        // Background watcher waits for authenticated YouTube SID/SAPISID cookies
        void this.waitForCookiesAndPersist(browser, timeoutMs).catch(async (err) => {
            this.logger?.warn({ err }, "Google login session failed or timed out");
            await this.store.saveAuthSession({
                id: 1,
                status: "error",
                error: err instanceof Error ? err.message : String(err),
            });
            await this.stopBrowser();
        });

        const record = await this.store.getAuthSession(1);
        return {
            devtoolsPort: this.devtoolsPort,
            wsEndpoint: browser.wsEndpoint(),
            record,
        };
    }

    public async importRawNetscapeCookies(netscapeContent: string): Promise<AuthSessionRecord> {
        const entries = parseNetscapeCookieEntries(netscapeContent);
        if (entries.length === 0) {
            throw new Error("No valid Netscape cookie entries found.");
        }

        const saved = this.cookieStore.saveCookies(entries);
        this.ytdlp.setCookiesPath(saved.cookiesPath);
        const visitorData = await getOrFetchYouTubeVisitorData(undefined, {
            cookiesPath: saved.cookiesPath,
            forceRefreshVisitorData: true,
        }).catch(() => null);

        return this.store.saveAuthSession({
            id: 1,
            status: "logged_in",
            visitorData,
            cookieHash: saved.cookieHash,
            lastRefresh: Date.now(),
            error: null,
        });
    }

    public async logout(): Promise<AuthSessionRecord> {
        await this.stopBrowser();
        if (this.refreshTimer) {
            clearInterval(this.refreshTimer);
            this.refreshTimer = null;
        }
        this.cookieStore.clear();
        this.oauthManager?.clear();
        this.ytdlp.setCookiesPath(null);
        this.ytdlp.setVisitorData(null);

        return this.store.saveAuthSession({
            id: 1,
            status: "idle",
            email: null,
            visitorData: null,
            cookieHash: null,
            lastRefresh: null,
            error: null,
        });
    }

    public async stopBrowser(): Promise<void> {
        if (this.browser) {
            await this.browser.close().catch(() => undefined);
            this.browser = null;
        }
    }

    private async waitForCookiesAndPersist(browser: Browser, timeoutMs: number): Promise<void> {
        const deadline = Date.now() + timeoutMs;
        const page = (await browser.pages())[0];
        if (!page) {
            throw new Error("Browser page closed unexpectedly");
        }

        while (Date.now() < deadline && browser.connected) {
            const cookies = await browser.cookies();
            const ytCookies = cookies.filter(
                (c) =>
                    c.domain.includes("youtube.com") ||
                    c.domain.includes("google.com") ||
                    c.domain.includes("googleusercontent.com"),
            );
            const hasSessionAuth = ytCookies.some(
                (c) =>
                    (c.name === "SAPISID" || c.name === "__Secure-3PAPISID") &&
                    c.domain.includes("youtube.com"),
            );

            if (hasSessionAuth) {
                const netscape: NetscapeCookieEntry[] = ytCookies.map((c) => ({
                    domain: c.domain,
                    includeSubdomains: c.domain.startsWith("."),
                    path: c.path,
                    secure: c.secure,
                    expiration:
                        c.expires > 0 ? c.expires : Math.floor(Date.now() / 1000) + 86400 * 30,
                    name: c.name,
                    value: c.value,
                }));

                const saved = this.cookieStore.saveCookies(netscape);
                this.ytdlp.setCookiesPath(saved.cookiesPath);

                await page
                    .goto("https://www.youtube.com/", { waitUntil: "domcontentloaded" })
                    .catch(() => undefined);
                const visitorData = await page
                    .evaluate(() => {
                        const w = globalThis as unknown as {
                            ytcfg?: { get?: (k: string) => unknown };
                        };
                        return typeof w.ytcfg?.get?.("VISITOR_DATA") === "string"
                            ? (w.ytcfg.get("VISITOR_DATA") as string)
                            : null;
                    })
                    .catch(() => null);
                // Never inject anonymous visitorData when authenticated cookies are active;
                // mismatched visitor/cookie sessions trigger YouTube bot verification checks
                this.ytdlp.setVisitorData(null);

                await this.store.saveAuthSession({
                    id: 1,
                    status: "logged_in",
                    visitorData,
                    cookieHash: saved.cookieHash,
                    lastRefresh: Date.now(),
                    error: null,
                });

                await this.stopBrowser();
                return;
            }

            await new Promise((r) => setTimeout(r, 2_000));
        }

        throw new Error("Google login timed out waiting for YouTube session cookies.");
    }
}
