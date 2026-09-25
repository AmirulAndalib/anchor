import { describe, expect, it } from "vitest";
import { draftTitle, hasTitle } from "./title";

describe("draftTitle", () => {
  it("keeps a title exactly as typed", () => {
    expect(draftTitle(" Renovierung ")).toBe(" Renovierung ");
  });

  it("stores a blank title as empty", () => {
    expect(draftTitle("  \n")).toBe("");
  });
});

describe("hasTitle", () => {
  it("sees a title with text", () => {
    expect(hasTitle("Renovierung ")).toBe(true);
  });

  it("treats a blank title as no title", () => {
    expect(hasTitle("")).toBe(false);
    expect(hasTitle("   ")).toBe(false);
    expect(hasTitle(null)).toBe(false);
  });
});
