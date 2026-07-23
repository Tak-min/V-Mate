import { describe, expect, it } from "vitest";
import { parseIntroNameResponse } from "../src/onboarding";

describe("parseIntroNameResponse", () => {
  it("extracts the name and the emotion-tagged reaction", () => {
    const result = parseIntroNameResponse("たくみ\n[happy] たくみくん、すてきな名前だね。");
    expect(result).toEqual({ name: "たくみ", text: "たくみくん、すてきな名前だね。", emotion: "happy" });
  });

  it("returns name: null when the model reports 「なし」", () => {
    const result = parseIntroNameResponse("なし\n[shy] もう一回だけ、教えてくれる？");
    expect(result.name).toBeNull();
    expect(result.emotion).toBe("shy");
  });

  it("truncates names longer than 40 characters", () => {
    const longName = "あ".repeat(50);
    const result = parseIntroNameResponse(`${longName}\n[happy] よろしくね。`);
    expect(result.name).toHaveLength(40);
  });

  it("falls back to a gentle retry when the response has fewer than 2 lines", () => {
    const result = parseIntroNameResponse("たくみ");
    expect(result.name).toBeNull();
    expect(result.emotion).toBe("shy");
  });

  it("falls back when the reaction line is empty after stripping the emotion tag", () => {
    const result = parseIntroNameResponse("たくみ\n[happy]");
    expect(result.name).toBeNull();
    expect(result.text).toContain("もう一度");
  });

  it("defaults to neutral emotion when no tag is present", () => {
    const result = parseIntroNameResponse("たくみ\nよろしくね。");
    expect(result.emotion).toBe("neutral");
    expect(result.name).toBe("たくみ");
  });
});
