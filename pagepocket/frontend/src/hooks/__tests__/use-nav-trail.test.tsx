import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

// Same observable next/navigation stubs shape as the component tests: tests
// seed `nav.pathname`/`nav.params` and rerender to simulate SPA navigation.
const nav = vi.hoisted(() => ({
  pathname: "/app/pages/test-page-id",
  params: new URLSearchParams(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname,
  useSearchParams: () => nav.params,
}));

const { useNavTrail } = await import("../use-nav-trail");

const CURRENT = "/app/pages/test-page-id";

function trail() {
  const raw = sessionStorage.getItem("pp_nav_history");
  return raw ? (JSON.parse(raw) as string[]) : [];
}

function renderTrail() {
  return renderHook(() => useNavTrail());
}

beforeEach(() => {
  sessionStorage.clear();
  nav.pathname = CURRENT;
  nav.params = new URLSearchParams();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useNavTrail", () => {
  it("records the current path on mount", () => {
    renderTrail();
    expect(trail()).toEqual([CURRENT]);
  });

  it("does not append consecutive duplicates (reload/re-render dedupe)", () => {
    const { rerender, unmount } = renderTrail();
    act(() => rerender());
    expect(trail()).toEqual([CURRENT]);
    // A real reload remounts the whole tree on the same URL.
    unmount();
    renderTrail();
    expect(trail()).toEqual([CURRENT]);
  });

  it("appends on SPA navigation (pathname change)", () => {
    const { rerender } = renderTrail();
    act(() => {
      nav.pathname = "/app";
      rerender();
    });
    expect(trail()).toEqual([CURRENT, "/app"]);
  });

  it("records a param-only change as a variant entry", () => {
    const { rerender } = renderTrail();
    act(() => {
      nav.params = new URLSearchParams({ format: "md" });
      rerender();
    });
    expect(trail()).toEqual([CURRENT, `${CURRENT}?format=md`]);
  });

  it("caps the trail length, keeping the most recent entries", () => {
    sessionStorage.setItem(
      "pp_nav_history",
      JSON.stringify(Array.from({ length: 30 }, (_, i) => `/app/p/${i}`)),
    );
    renderTrail();
    const t = trail();
    expect(t).toHaveLength(25);
    expect(t[t.length - 1]).toBe(CURRENT);
    expect(t[0]).toBe("/app/p/6");
  });

  it("goBack walks backwards and skips the current path", () => {
    sessionStorage.setItem(
      "pp_nav_history",
      JSON.stringify(["/app", CURRENT, `${CURRENT}?format=md`]),
    );
    nav.params = new URLSearchParams({ format: "md" });
    const { result } = renderTrail();
    // Current is the ?format=md variant; back skips it and lands on the
    // plain page path — never the current URL.
    expect(result.current("/app")).toBe(CURRENT);
  });

  it("goBack returns the latest qualifying /app entry, not any entry", () => {
    sessionStorage.setItem(
      "pp_nav_history",
      JSON.stringify(["/app/collections/c1", "/app", CURRENT]),
    );
    const { result } = renderTrail();
    expect(result.current("/fallback")).toBe("/app");
  });

  it("goBack falls back when the trail has no other /app entry (deep link)", () => {
    const { result } = renderTrail();
    expect(result.current("/app")).toBe("/app");
  });

  it("goBack ignores non-/app entries", () => {
    sessionStorage.setItem(
      "pp_nav_history",
      JSON.stringify(["/", "/login", CURRENT]),
    );
    const { result } = renderTrail();
    expect(result.current("/app")).toBe("/app");
  });

  it("survives a throwing sessionStorage (privacy mode)", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded");
    });
    expect(() => renderTrail()).not.toThrow();
    // goBack still resolves from the unreadable trail's fallback.
    const { result } = renderTrail();
    expect(result.current("/app")).toBe("/app");
  });

  it("survives corrupted trail data", () => {
    sessionStorage.setItem("pp_nav_history", "not json{");
    expect(() => renderTrail()).not.toThrow();
    const { result } = renderTrail();
    expect(result.current("/app")).toBe("/app");
  });
});
