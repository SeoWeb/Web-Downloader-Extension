import { describe, it, expect } from "vitest";
import { formatBytes } from "./format";

describe("formatBytes (storage-usage-display, design D5)", () => {
  it.each([
    [0, "0 B"],
    [1, "1 B"],
    [5, "5 B"],
    [512, "512 B"],
    [1023, "1023 B"],
    [1024, "1 KB"], // exact boundary
    [5120, "5 KB"], // 5.0 → trailing ".0" trimmed
    [5242, "5.1 KB"], // 5.119… → one decimal below 10
    [1048576, "1 MB"],
    [2516582, "2.4 MB"], // spec scenario value
    [1835008, "1.8 MB"], // 1.75 MB rounds up
    [10485760, "10 MB"], // ≥ 10 → whole numbers
    [12939428, "12 MB"], // 12.34 MB → no decimal
    [52428800, "50 MB"], // meter example from the spec
    [1073741824, "1 GB"],
    [10737418240, "10 GB"],
  ])("formats %d bytes as %s", (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected);
  });

  it("clamps at GB and never emits a negative or NaN value", () => {
    expect(formatBytes(-5)).toBe("0 B");
    expect(formatBytes(Number.NaN)).toBe("0 B");
    expect(formatBytes(5 * 1024 ** 4)).toMatch(/ GB$/);
  });
});
