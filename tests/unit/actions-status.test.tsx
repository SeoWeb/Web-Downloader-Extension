/**
 * @vitest-environment jsdom
 *
 * Actions status headline + subtitle (raw-i18n fix, parts 2b/2c/2d/2f).
 *
 * - Assembling must show the assembly headline, not "Done!" (2c).
 * - Background error keys live under `app.*` — renamed emissions
 *   (app.noUrl / app.downloadInProgress / app.memoryPressure) must resolve
 *   through t() (2b).
 * - Unknown keys must never render raw (2d).
 * - Assembly progress interpolates the TRANSLATED phase, not the raw
 *   server id like "merging_html" (2f, UI-side translation).
 *
 * Resolution runs against the real en.json.
 */

import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import en from "../../src/i18n/locales/en.json";
import Actions, { Message } from "../../src/components/Actions";

// ---------------------------------------------------------------------------
// i18n mock — resolve through the REAL en.json (flat dotted key → nested
// translation map), i18next-style interpolation, defaultValue/raw-key
// fallback.
// ---------------------------------------------------------------------------

const translation = (en as { translation: Record<string, unknown> })
  .translation;

function resolveKey(key: string): unknown {
  return key
    .split(".")
    .reduce<unknown>(
      (acc, part) =>
        acc !== null && typeof acc === "object"
          ? (acc as Record<string, unknown>)[part]
          : undefined,
      translation,
    );
}

function interpolate(
  template: string,
  options: Record<string, unknown> | undefined,
): string {
  if (!options) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) =>
    options[name] !== undefined ? String(options[name]) : "",
  );
}

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, optionsOrDefault?: unknown) => {
      const value = resolveKey(key);
      const template = typeof value === "string" ? value : undefined;
      if (template === undefined) {
        // i18next: string second arg = defaultValue; object = options.
        if (typeof optionsOrDefault === "string") return optionsOrDefault;
        return key;
      }
      // Resolved key wins over a string defaultValue (i18next semantics).
      if (
        typeof optionsOrDefault !== "object" ||
        optionsOrDefault === null ||
        !("defaultValue" in (optionsOrDefault as Record<string, unknown>))
      ) {
        return interpolate(
          template,
          optionsOrDefault as Record<string, unknown> | undefined,
        );
      }
      // defaultValue option + interpolation
      const opts = {
        ...(optionsOrDefault as Record<string, unknown>),
      };
      const dv = opts.defaultValue;
      delete opts.defaultValue;
      const interpolated = interpolate(template, opts);
      return interpolated.includes("undefined") && dv !== undefined
        ? interpolated.replace("undefined", String(dv))
        : interpolated;
    },
  }),
}));

// React 19 requires this flag for act() outside its own test renderer.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

function renderUi(ui: React.ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(ui);
  });
  return {
    container,
    unmount: () =>
      act(() => {
        root.unmount();
      }),
  };
}

function renderMessages(messages: Message[]) {
  return renderUi(<Actions messages={messages} />);
}

describe("Actions status headline (step → headline map)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("assembling shows the assembly headline — not Done! (2c)", () => {
    const { container, unmount } = renderMessages([
      { key: "status.assemblingServer" },
    ]);

    expect(container.textContent).toContain("Assembling on server...");
    expect(container.textContent).not.toContain("Done!");

    unmount();
  });

  it("assembly progress keeps the assembly headline (2c)", () => {
    const { container, unmount } = renderMessages([
      { key: "status.assemblingServer" },
      {
        key: "status.assemblyProgress",
        options: { status: "running", phase: "merging_html", progressPct: 0 },
      },
    ]);

    expect(container.textContent).toContain("Assembling on server...");
    expect(container.textContent).not.toContain("Done!");

    unmount();
  });

  it("the finished state shows Done! (2c)", () => {
    const { container, unmount } = renderMessages([
      { key: "status.assemblingServer" },
      { key: "status.complete" },
    ]);

    expect(container.textContent).toContain("Done!");

    unmount();
  });
});

describe("Actions subtitle", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("translates the phase before interpolating assembly progress (2f)", () => {
    const { container, unmount } = renderMessages([
      {
        key: "status.assemblyProgress",
        options: { status: "running", phase: "merging_html", progressPct: 0 },
      },
    ]);

    expect(container.textContent).toContain("Assembling: Merging HTML (0%)");
    expect(container.textContent).not.toContain("merging_html");

    unmount();
  });

  it.each([
    ["app.noUrl", "Error: No URL provided for download"],
    [
      "app.downloadInProgress",
      "A download is already in progress. Please wait.",
    ],
    ["app.memoryPressure", "Cannot start download due to critical memory"],
  ])("renamed error key %s resolves through t() (2b)", (key, expected) => {
    const { container, unmount } = renderMessages([{ key }]);

    expect(container.textContent).toContain(expected);
    expect(container.textContent).not.toContain(key);

    unmount();
  });

  it("an unknown key never renders raw — subtitle is skipped (2d)", () => {
    const { container, unmount } = renderMessages([
      { key: "status.doesNotExist.anywhere" },
    ]);

    expect(container.textContent).not.toContain("status.doesNotExist");

    unmount();
  });

  it("emitted status keys added in 2a resolve instead of rendering raw", () => {
    const keys = [
      "status.uploadingHtml",
      "status.htmlUploaded",
      "status.sessionSizeLimitReached",
      "status.serverDownloadReady",
    ];
    for (const key of keys) {
      const { container, unmount } = renderMessages([{ key }]);
      expect(container.textContent).not.toContain(key);
      unmount();
    }
  });
});
