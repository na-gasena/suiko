import type { Mark, MotionMode } from './revision';

function seedFrom(id: string): number {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i++)
    hash = Math.imul(hash ^ id.charCodeAt(i), 16777619);
  return (hash >>> 0) / 4294967296;
}
function reflect(value: number, min: number, max: number): number {
  const span = max - min;
  const part = (((value - min) % (span * 2)) + span * 2) % (span * 2);
  return min + (part <= span ? part : span * 2 - part);
}

// Analytic time + seeded trajectories give the editor and projector the same motion,
// independent of refresh rate, dropped frames or reconnection. Never mutate a mark's anchor.
export function motionPose(
  mark: Pick<Mark, 'id' | 'x' | 'y'>,
  ageSeconds: number,
  mode: MotionMode,
  width = 960,
  height = 620,
  tuning: {
    speed?: number;
    wander?: number;
    wind?: number;
    lift?: number;
  } = {},
) {
  const t = Math.max(0, ageSeconds);
  if (mode === 'eraser' || t === 0) return { x: mark.x, y: mark.y, angle: 0 };
  const seed = seedFrom(mark.id),
    phase = seed * Math.PI * 2;
  const ease = 1 - Math.exp(-t * 4);
  if (mode === 'float') {
    const drag = 0.38,
      wind = ((25 + seed * 35) * (tuning.wind ?? 100)) / 100,
      kick = (seed - 0.5) * 90;
    // Velocity approaches a wind speed under drag; buoyancy lifts the glyph.
    const dx = wind * t + ((kick - wind) * (1 - Math.exp(-drag * t))) / drag;
    const dy =
      ((-(18 + seed * 17) * (tuning.lift ?? 100)) / 100) * t +
      ((10 + seed * 15) * (1 - Math.exp(-drag * t))) / drag;
    return {
      x:
        mark.x + dx + 12 * (Math.sin(t * 1.1 + phase) - Math.sin(phase)) * ease,
      y: mark.y + dy + 9 * (Math.sin(t * 1.5 + phase) - Math.sin(phase)) * ease,
      angle:
        ((seed - 0.5) * t * 0.35 + 0.17 * Math.sin(t * 1.8 + phase)) * ease,
    };
  }
  const speed = ((22 + seed * 32) * (tuning.speed ?? 100)) / 100;
  const distance =
    speed * (t + 0.065 * (Math.sin(t * 12 + phase) - Math.sin(phase)));
  const x =
    mark.x +
    Math.cos(phase) * distance +
    ((22 * (tuning.wander ?? 100)) / 100) *
      (Math.sin(t * 2.7 + phase) - Math.sin(phase)) *
      ease;
  const y =
    mark.y +
    Math.sin(phase) * distance +
    ((18 * (tuning.wander ?? 100)) / 100) *
      (Math.sin(t * 3.1 + phase) - Math.sin(phase)) *
      ease;
  return {
    x: reflect(x, 24, width - 44),
    y: reflect(y, 46, height - 26),
    angle:
      (0.55 * Math.sin(t * 4.5 + phase) + 0.14 * Math.sin(t * 19 + phase)) *
      ease,
  };
}

export function motionAlpha(ageMs: number, durationMs: number): number {
  const progress = Math.max(0, Math.min(1, ageMs / durationMs));
  return 0.5 * (1 - Math.pow(progress, 2));
}
