import { describe, expect, it } from "vitest";
import { computeAgeBand } from "../src/agegate";
import { ValueError } from "../src/auth";

const TODAY = new Date("2026-07-20T12:00:00Z");

describe("computeAgeBand", () => {
  it("classifies exactly-12-year-olds as under13", () => {
    expect(computeAgeBand("2013-07-21", TODAY)).toBe("under13"); // 誕生日が明日 → まだ12歳
  });

  it("classifies a 13th birthday today as minor", () => {
    expect(computeAgeBand("2013-07-20", TODAY)).toBe("minor");
  });

  it("classifies 17-year-olds as minor", () => {
    expect(computeAgeBand("2009-07-21", TODAY)).toBe("minor"); // 明日18歳になる → まだ17歳
  });

  it("classifies an 18th birthday today as adult", () => {
    expect(computeAgeBand("2008-07-20", TODAY)).toBe("adult");
  });

  it("classifies adults well above 18 as adult", () => {
    expect(computeAgeBand("1990-01-01", TODAY)).toBe("adult");
  });

  it("handles a leap-day birth date correctly", () => {
    // 2012-02-29生まれ、2026-07-20時点で14歳(2026年の誕生日は2/28扱いで通過済み)
    expect(computeAgeBand("2012-02-29", TODAY)).toBe("minor");
  });

  it("rejects a future birth date", () => {
    expect(() => computeAgeBand("2027-01-01", TODAY)).toThrow(ValueError);
  });

  it("rejects a malformed date string", () => {
    expect(() => computeAgeBand("not-a-date", TODAY)).toThrow(ValueError);
  });

  it("rejects an invalid calendar date", () => {
    expect(() => computeAgeBand("2021-02-30", TODAY)).toThrow(ValueError);
  });
});
