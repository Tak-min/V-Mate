import { describe, expect, it } from "vitest";
import { applyJitter } from "../src/tts";

describe("applyJitter", () => {
  const base = { speaking_rate: 1.0, emotional_intensity: 1.0, volume: 1.0 };

  it("returns the base values unchanged when rng is pinned at the midpoint", () => {
    const result = applyJitter(base, () => 0.5);
    expect(result).toEqual(base);
  });

  it("shifts values within the expected spread at the rng extremes", () => {
    const max = applyJitter(base, () => 1);
    expect(max.speaking_rate).toBeCloseTo(1.04, 5);
    expect(max.emotional_intensity).toBeCloseTo(1.06, 5);
    expect(max.volume).toBeCloseTo(1.03, 5);

    const min = applyJitter(base, () => 0);
    expect(min.speaking_rate).toBeCloseTo(0.96, 5);
    expect(min.emotional_intensity).toBeCloseTo(0.94, 5);
    expect(min.volume).toBeCloseTo(0.97, 5);
  });

  it("clamps extreme base values into a safe range", () => {
    const result = applyJitter({ speaking_rate: 10, emotional_intensity: 10, volume: 10 }, () => 1);
    expect(result.speaking_rate).toBeLessThanOrEqual(1.4);
    expect(result.emotional_intensity).toBeLessThanOrEqual(2.0);
    expect(result.volume).toBeLessThanOrEqual(1.3);
  });
});
