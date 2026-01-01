
import { StreamingDownloader } from "../utils/StreamingDownloader";
import { StreamingFetcher } from "../utils/streamingFetch";
import { createProgressPersistence } from "../utils/progressPersistence";

// Initialize streaming infrastructure
export const persistence = createProgressPersistence('indexeddb');
export const streamingDownloader = new StreamingDownloader(persistence);
export const streamingFetcher = new StreamingFetcher();
