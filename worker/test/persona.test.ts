import { describe, expect, it } from "vitest";
import { stageFor, nextStageThreshold, buildSystemPrompt } from "../src/persona";

describe("stageFor", () => {
  it("returns the lowest stage for a fresh user", () => {
    const [name] = stageFor(0);
    expect(name).toBe("はじめまして");
  });

  it("returns the exact stage at a threshold boundary", () => {
    const [name] = stageFor(50);
    expect(name).toBe("友達");
  });

  it("returns the highest stage once score exceeds the top threshold", () => {
    const [name] = stageFor(9999);
    expect(name).toBe("相棒");
  });

  it("does not overshoot the stage just below a threshold", () => {
    const [name] = stageFor(49);
    expect(name).toBe("顔なじみ");
  });
});

describe("nextStageThreshold", () => {
  it("returns the next threshold above the current score", () => {
    expect(nextStageThreshold(10)).toBe(20);
  });

  it("returns null once no higher threshold remains", () => {
    expect(nextStageThreshold(200)).toBeNull();
  });
});

describe("buildSystemPrompt minor safety constraints", () => {
  const baseOpts = { userName: "たろう", affinity: 10, facts: [], timeContext: "" };

  it("omits the minor safety section by default", () => {
    const prompt = buildSystemPrompt(baseOpts);
    expect(prompt).not.toContain("安全ルール");
  });

  it("includes the minor safety section when minor is true", () => {
    const prompt = buildSystemPrompt({ ...baseOpts, minor: true });
    expect(prompt).toContain("安全ルール");
    expect(prompt).toContain("恋愛的・性的な表現");
  });
});
