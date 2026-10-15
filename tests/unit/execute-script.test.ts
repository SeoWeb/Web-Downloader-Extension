/**
 * Tests for the executeScript wrapper (task 1.4 / D8).
 *
 * Verifies:
 * - The promise REJECTS when chrome.scripting.executeScript rejects
 *   (restricted pages: chrome://, PDF viewer, Web Store, crashed tabs) —
 *   the scraping loop stops with an error instead of hanging forever.
 * - The promise resolves {success:false} when injection succeeds but ALL
 *   frame results are falsy (bounded stop, no usable result).
 * - The first truthy frame result is returned (existing behavior).
 */

import { executeScript } from "../../src/common/chrome";

// The common/chrome module imports sendMessageToPanel from
// ../background/message, which pulls in the whole background graph.
// Mock it away — these tests only exercise executeScript.
vi.mock("../../src/background/message", () => ({
  sendMessageToPanel: vi.fn().mockResolvedValue(undefined),
}));

const mockExecuteScript = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(globalThis, "chrome", {
    value: {
      scripting: {
        executeScript: mockExecuteScript,
      },
    },
    configurable: true,
  });
});

describe("executeScript (task 1.4)", () => {
  it("rejects when chrome.scripting.executeScript rejects (restricted page)", async () => {
    mockExecuteScript.mockRejectedValue(
      new Error("Cannot access contents of the page (chrome://settings)"),
    );

    await expect(
      executeScript(1, () => document.title),
    ).rejects.toThrow(/Cannot access contents of the page/);
  });

  it("propagates rejections for crashed tabs", async () => {
    mockExecuteScript.mockRejectedValue(
      new Error("The tab was closed or discarded"),
    );

    await expect(executeScript(7, () => window.scrollY)).rejects.toThrow(
      /tab was closed/,
    );
  });

  it("resolves {success:false} when all injection results are falsy (empty array)", async () => {
    mockExecuteScript.mockResolvedValue([]);

    const result = await executeScript(1, () => document.title);

    expect(result).toMatchObject({ success: false });
    expect(typeof result.error).toBe("string");
  });

  it("resolves {success:false} when every frame result is falsy", async () => {
    mockExecuteScript.mockResolvedValue([
      { frameId: 0, result: undefined },
      { frameId: 1, result: null },
      { frameId: 2, result: "" },
    ]);

    const result = await executeScript(1, () => null, []);

    expect(result).toMatchObject({ success: false });
    expect(result.success).toBe(false);
  });

  it("resolves {success:false} when results are missing entirely", async () => {
    mockExecuteScript.mockResolvedValue([{}, undefined]);

    const result = await executeScript(1, () => 0);

    expect(result.success).toBe(false);
  });

  it("resolves with the first truthy frame result", async () => {
    mockExecuteScript.mockResolvedValue([
      { frameId: 0, result: null },
      { frameId: 1, result: { success: true, top: 42, html: "<div/>" } },
    ]);

    const result = await executeScript(1, () => window.scrollY);

    expect(result).toEqual({ success: true, top: 42, html: "<div/>" });
  });

  it("passes target/func/args through to chrome.scripting.executeScript", async () => {
    mockExecuteScript.mockResolvedValue([{ result: "ok" }]);

    await executeScript(3, (_a: number) => _a * 2, [21]);

    expect(mockExecuteScript).toHaveBeenCalledWith({
      target: { tabId: 3 },
      func: expect.any(Function),
      args: [21],
    });
  });
});
