import type {
    LyricsResult,
    SearchProviderMode,
    SearchResult,
    SourceProviderType,
    StreamDescriptor,
    Track,
} from "@rawon/shared";

export type QueryKind = "track" | "playlist" | "album" | "artist" | "unknown";

export interface ClassifiedQuery {
    raw: string;
    isUrl: boolean;
    sourceType: SourceProviderType;
    kind: QueryKind;
    normalizedUrl?: string;
}

export interface ProviderHealth {
    name: string;
    healthy: boolean;
    consecutiveFailures: number;
    lastError?: string;
    lastCheckedAt: number;
}

export interface MediaProvider {
    readonly name: SourceProviderType;
    supportsUrl(url: string): boolean;
    classifyUrl(url: string): ClassifiedQuery | null;
    search(query: string, limit: number, mode?: SearchProviderMode): Promise<SearchResult>;
    resolveUrl(url: string, kind: QueryKind): Promise<SearchResult>;
    hydrateTrack(track: Track): Promise<Track>;
    getStreamDescriptor(track: Track, signal?: AbortSignal): Promise<StreamDescriptor>;
    findRelated?(seedTrack: Track, excludeIds: ReadonlySet<string>): Promise<Track[]>;
    healthCheck(): Promise<ProviderHealth>;
}

export interface LyricsProvider {
    readonly name: string;
    fetchLyrics(query: string): Promise<LyricsResult | null>;
    healthCheck(): Promise<ProviderHealth>;
}
