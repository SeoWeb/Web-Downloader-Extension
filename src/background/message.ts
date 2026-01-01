import { sendMessage } from "../common/chrome";
import { MessageAction, messageActions } from "../common/message";
console.log("MessageActions in background:", messageActions);
import { scrollDownAndScrape, startDownload } from "./jobs";
import { downloadResourcesWithIncrementalAssembly } from "./download";
import { mergeHtmlIncremental } from "./merge-html";

export async function sendMessageToPanel(
  action: MessageAction,
  data: any,
  force: boolean = true,
) {
  return await sendMessage(
    "side-panel",
    {
      action,
      data,
    },
    force,
  );
}

type Message = {
  action: MessageAction;
  data: any;
};

export async function messageWorker(
  action: MessageAction,
  data: any,
  addMessage: (message: Message) => void,
): Promise<any> {
  if (!messageActions) {
    console.error("messageActions is not defined!");
    throw new Error("messageActions is not defined");
  }

  switch (action) {
    case messageActions.START_SCROLL:
      return await scrollDownAndScrape(data.tabId);

    case messageActions.START_DOWNLOAD:
      return await startDownload(
        data.html,
        data.tabUrl,
        data.downloadOptions,
        (message: string | { key: string; options?: any }) =>
          addMessage({
            action: messageActions.PANEL_MESSAGE,
            data: { message },
          }),
        data.tabId,
      );

    case messageActions.INITIALIZE_DIFFERENTIAL_SCRAPING:
      // Initialize differential scraping and return assembly job ID
      const assemblyJobId = `assembly-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      try {
        await mergeHtmlIncremental(data.html, "", assemblyJobId, {
          useIncrementalAssembly: true,
          jobId: assemblyJobId,
        });
        return {
          success: true,
          assemblyJobId,
        };
      } catch (error) {
        console.error("Failed to initialize differential scraping:", error);
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }

    case messageActions.SCROLL_AND_EXTRACT_DIFF:
      // Process a new content chunk
      try {
        await mergeHtmlIncremental(
          "", // Empty base HTML since we're adding to existing job
          data.htmlChunk,
          data.assemblyJobId,
          {
            useIncrementalAssembly: true,
            jobId: data.assemblyJobId,
          }
        );
        return {
          success: true,
          assemblyJobId: data.assemblyJobId,
          chunkProcessed: true,
        };
      } catch (error) {
        console.error("Failed to process HTML chunk:", error);
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }

    case messageActions.START_INCREMENTAL_DOWNLOAD:
      // Start download with incremental assembly
      return await downloadResourcesWithIncrementalAssembly(
        data.assemblyJobId,
        data.tabUrl,
        data.downloadOptions,
        (message: string | { key: string; options?: any }) =>
          addMessage({
            action: messageActions.PANEL_MESSAGE,
            data: { message },
          }),
        data.tabId,
      );

    case messageActions.CHECK_ONLINE_STATUS:
      return true;

    default:
      return null;
  }
}
