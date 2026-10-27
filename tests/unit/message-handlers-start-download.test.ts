/**
 * (Round 9 — Fix 4) START_DOWNLOAD response-failure surfacing.
 *
 * Incident: the START_DOWNLOAD response carries the failure
 * ({ success: false, error } — resolved by the message channel's catch in
 * common/chrome.ts listenMessage, NOT by rejecting), but the panel never
 * checked `success`, so the one guard-proof terminal signal was discarded.
 *
 * Under test (handleStartDownload):
 * - a { success: false, error } response surfaces status.failedWithError
 *   with the error text and invokes the onFailure reset hook;
 * - a failure WITHOUT error text falls back to status.failed;
 * - a successful response is returned untouched and stays silent.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/client/message", () => ({
  sendMessageToBackground: vi.fn(),
}));

import { handleStartDownload } from "../../src/sidepanel/utils/messageHandlers";
import { sendMessageToBackground } from "../../src/client/message";

const setMessages = vi.fn();
const onFailure = vi.fn();

describe("handleStartDownload — response-carried failure (Round 9 Fix 4)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("surfaces status.failedWithError and calls onFailure for {success:false, error}", async () => {
    vi.mocked(sendMessageToBackground).mockResolvedValue({
      success: false,
      error: "Server session expired",
    });

    const result = await handleStartDownload(
      1,
      "<html></html>",
      "https://example.com/",
      null,
      setMessages,
      onFailure,
    );

    expect(result).toBeUndefined();
    expect(setMessages).toHaveBeenCalledWith({
      key: "status.failedWithError",
      options: { error: "Server session expired" },
    });
    expect(onFailure).toHaveBeenCalledWith("Server session expired");
  });

  it("falls back to status.failed when the failure carries no error text", async () => {
    vi.mocked(sendMessageToBackground).mockResolvedValue({
      success: false,
    });

    const result = await handleStartDownload(
      1,
      "<html></html>",
      "https://example.com/",
      null,
      setMessages,
      onFailure,
    );

    expect(result).toBeUndefined();
    expect(setMessages).toHaveBeenCalledWith({ key: "status.failed" });
    expect(onFailure).toHaveBeenCalledWith(undefined);
  });

  it("returns the response untouched and stays silent on success", async () => {
    vi.mocked(sendMessageToBackground).mockResolvedValue([]);

    const result = await handleStartDownload(
      1,
      "<html></html>",
      "https://example.com/",
      null,
      setMessages,
      onFailure,
    );

    expect(result).toEqual([]);
    expect(setMessages).not.toHaveBeenCalled();
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("treats an undefined response as success (no false failure)", async () => {
    vi.mocked(sendMessageToBackground).mockResolvedValue(undefined);

    const result = await handleStartDownload(
      1,
      "<html></html>",
      "https://example.com/",
      null,
      setMessages,
      onFailure,
    );

    expect(result).toBeUndefined();
    expect(setMessages).not.toHaveBeenCalled();
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("works without an onFailure hook (optional param)", async () => {
    vi.mocked(sendMessageToBackground).mockResolvedValue({
      success: false,
      error: "boom",
    });

    const result = await handleStartDownload(
      1,
      "<html></html>",
      "https://example.com/",
      null,
      setMessages,
    );

    expect(result).toBeUndefined();
    expect(setMessages).toHaveBeenCalledWith({
      key: "status.failedWithError",
      options: { error: "boom" },
    });
  });
});
