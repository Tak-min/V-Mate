import { describe, expect, it } from 'vitest';
import {
  chooseReaction,
  poolForRegion,
  REACTION_PRESETS,
  reactionEnvelope,
  scalePreset,
  type ReactionPreset,
} from './reactions';

describe('poolForRegion', () => {
  it('maps head to the head pool and body to the body pool', () => {
    expect(poolForRegion('head')).toBe(REACTION_PRESETS.head);
    expect(poolForRegion('body')).toBe(REACTION_PRESETS.body);
  });
});

describe('chooseReaction', () => {
  it('never returns the same id twice in a row when alternatives exist', () => {
    const pool = REACTION_PRESETS.head;
    for (let i = 0; i < 200; i += 1) {
      const lastId = pool[i % pool.length].id;
      const picked = chooseReaction(pool, lastId);
      expect(picked.id).not.toBe(lastId);
    }
  });

  it('falls back to the only preset when the pool has a single entry', () => {
    const solo: ReactionPreset[] = [REACTION_PRESETS.head[0]];
    expect(chooseReaction(solo, solo[0].id).id).toBe(solo[0].id);
  });

  it('returns a preset from the pool when there is no prior reaction', () => {
    const pool = REACTION_PRESETS.body;
    const picked = chooseReaction(pool, null);
    expect(pool.map((p) => p.id)).toContain(picked.id);
  });
});

describe('scalePreset', () => {
  const base: ReactionPreset = {
    id: 'test-base',
    expr: { happy: 0.5, sad: 0.2 },
    cameraDolly: 0.1,
    bounceY: 0.02,
    leanX: 0.01,
    duration: 1,
    blinkCluster: true,
  };

  it('scales expression weights and motion amounts proportionally', () => {
    const scaled = scalePreset(base, 0.5);
    expect(scaled.expr.happy).toBeCloseTo(0.25);
    expect(scaled.expr.sad).toBeCloseTo(0.1);
    expect(scaled.cameraDolly).toBeCloseTo(0.05);
    expect(scaled.bounceY).toBeCloseTo(0.01);
    expect(scaled.leanX).toBeCloseTo(0.005);
  });

  it('does not mutate the original preset', () => {
    const original = { ...base, expr: { ...base.expr } };
    scalePreset(base, 0.3);
    expect(base).toEqual(original);
  });

  it('clamps scale to a sane upper bound instead of amplifying without limit', () => {
    const scaled = scalePreset(base, 100);
    expect(scaled.cameraDolly).toBeCloseTo(0.1 * 1.4);
  });

  it('clamps negative scale to zero', () => {
    const scaled = scalePreset(base, -5);
    expect(scaled.cameraDolly).toBe(0);
    expect(scaled.expr.happy).toBe(0);
  });
});

describe('reactionEnvelope', () => {
  it('starts at 0 and ends at 0', () => {
    expect(reactionEnvelope(0)).toBeCloseTo(0);
    expect(reactionEnvelope(1)).toBeCloseTo(0);
  });

  it('rises quickly through the attack phase then decays', () => {
    const attackPeak = reactionEnvelope(0.22);
    const midDecay = reactionEnvelope(0.6);
    const lateDecay = reactionEnvelope(0.9);
    expect(attackPeak).toBeGreaterThan(reactionEnvelope(0.05));
    expect(attackPeak).toBeCloseTo(1, 1);
    expect(midDecay).toBeLessThan(attackPeak);
    expect(lateDecay).toBeLessThan(midDecay);
  });

  it('clamps out-of-range progress into 0..1', () => {
    expect(reactionEnvelope(-1)).toBeCloseTo(reactionEnvelope(0));
    expect(reactionEnvelope(2)).toBeCloseTo(reactionEnvelope(1));
  });
});
