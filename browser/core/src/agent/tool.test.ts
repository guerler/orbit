import { describe, expect, it } from "vitest";
import { capped, MAX_RESULT_CHARS } from "./tool";

describe("capped", () => {
  it("keeps a result within the limit as it is", () => {
    const text = "x".repeat(MAX_RESULT_CHARS);
    expect(capped(text)).toBe(text);
  });

  it("cuts a longer result and says how much was left out", () => {
    const text = "x".repeat(MAX_RESULT_CHARS + 1234);
    const result = capped(text);
    expect(result.startsWith("x".repeat(MAX_RESULT_CHARS))).toBe(true);
    expect(result).toContain("[Truncated: 1234 more characters.");
    expect(result.length).toBeLessThan(MAX_RESULT_CHARS + 200);
  });
});
