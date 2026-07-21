import { describe, expect, it } from "vitest";
import { crisisSupportReply, redactDisallowed, screenUserInput } from "../src/moderation";

describe("screenUserInput", () => {
  it("allows ordinary benign conversation", () => {
    expect(screenUserInput("今日は天気がいいね", { minor: false })).toEqual({ action: "allow" });
    expect(screenUserInput("最近仕事が忙しくて疲れた", { minor: false })).toEqual({ action: "allow" });
  });

  it("flags self-harm ideation as crisis regardless of age", () => {
    expect(screenUserInput("もう死にたい", { minor: false }).action).toBe("crisis");
    expect(screenUserInput("死にたい", { minor: true }).action).toBe("crisis");
  });

  it("refuses explicit sexual requests for adults too", () => {
    expect(screenUserInput("エッチな話をしよう", { minor: false }).action).toBe("refuse");
  });

  it("refuses explicit sexual requests more readily for minors", () => {
    expect(screenUserInput("エッチな話をしよう", { minor: true }).action).toBe("refuse");
  });

  it("refuses romantic/dating overtures only when the user is a minor", () => {
    expect(screenUserInput("付き合ってほしい", { minor: true }).action).toBe("refuse");
    expect(screenUserInput("付き合ってほしい", { minor: false }).action).toBe("allow");
  });

  it("prioritizes crisis over refuse when both patterns are present", () => {
    const result = screenUserInput("エッチな話もできないくらいもう死にたい", { minor: false });
    expect(result.action).toBe("crisis");
  });
});

describe("redactDisallowed", () => {
  it("passes benign text through unchanged", () => {
    const result = redactDisallowed("今日も楽しかったね", { minor: false });
    expect(result).toEqual({ clean: "今日も楽しかったね", blocked: false });
  });

  it("replaces explicit sexual content with a safe fallback and marks blocked", () => {
    const result = redactDisallowed("エッチな話をしよう", { minor: false });
    expect(result.blocked).toBe(true);
    expect(result.clean).not.toContain("エッチ");
  });

  it("replaces minor-directed romantic overtures only when minor flag is set", () => {
    expect(redactDisallowed("付き合ってほしい", { minor: true }).blocked).toBe(true);
    expect(redactDisallowed("付き合ってほしい", { minor: false }).blocked).toBe(false);
  });
});

describe("crisisSupportReply", () => {
  it("always includes a real crisis hotline number", () => {
    const reply = crisisSupportReply();
    expect(reply).toContain("0570-783-556");
    expect(reply).toContain("0120-279-338");
  });
});
