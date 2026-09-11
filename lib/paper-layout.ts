import type { CSSProperties } from 'react';
import {
  layoutText,
  PAPER_FONT,
  PAPER_HEIGHT,
  LINE_HEIGHT,
  defaults,
  fontChoices,
  type Settings,
  type Glyph,
} from './revision';

// Shared by the native writing surface and the invisible measuring surface.
// Measure browser line wrapping so selections, deletion anchors and projection agree.
export const paperTextStyle: CSSProperties = {
  font: PAPER_FONT,
  lineHeight: `${LINE_HEIGHT}px`,
  letterSpacing: '2px',
  fontKerning: 'none',
  fontVariantLigatures: 'none',
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
  wordBreak: 'break-all',
  lineBreak: 'anywhere',
  tabSize: 2,
  textAlign: 'left',
  direction: 'ltr',
  unicodeBidi: 'plaintext',
};
export function paperFont(settings: Pick<Settings, 'font'> = defaults) {
  return (
    fontChoices.find((choice) => choice.value === settings.font)?.family ??
    PAPER_FONT
  );
}
export function paperTextStyleFor(
  settings: Settings = defaults,
): CSSProperties {
  return {
    ...paperTextStyle,
    fontFamily: paperFont(settings),
    lineHeight: `${settings.lineSpacing}px`,
    letterSpacing: `${settings.letterSpacing}px`,
  };
}

type PaperLayout = { glyphs: Glyph[]; height: number; top: number };
const cache = new Map<string, PaperLayout>();

export function measurePaperText(
  text: string,
  settings: Settings = defaults,
): PaperLayout {
  const key = `${text}\u0000${settings.font}\u0000${settings.letterSpacing}\u0000${settings.lineSpacing}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const context = document.createElement('canvas').getContext('2d')!;
  context.font = `34px ${paperFont(settings)}`;
  const fallback = () => {
    const glyphs = layoutText(
      text,
      (c) => context.measureText(c).width,
      settings.letterSpacing,
      settings.lineSpacing,
    );
    return {
      glyphs,
      top: 139,
      height: Math.max(
        PAPER_HEIGHT,
        ...layoutText(
          `${text}\u200b`,
          (c) => context.measureText(c).width,
          settings.letterSpacing,
          settings.lineSpacing,
        ).map((g) => g.y + 150),
      ),
    };
  };
  const mirror = document.createElement('div');
  Object.assign(mirror.style, paperTextStyleFor(settings), {
    position: 'fixed',
    left: '0',
    top: '0',
    width: '776px',
    margin: '0',
    padding: '0',
    border: '0',
    visibility: 'hidden',
    pointerEvents: 'none',
    zIndex: '-1',
  });
  mirror.setAttribute('aria-hidden', 'true');
  const baseline = document.createElement('span');
  Object.assign(baseline.style, {
    display: 'inline-block',
    width: '0',
    height: '0',
    padding: '0',
    margin: '0',
    verticalAlign: 'baseline',
  });
  const node = document.createTextNode(`${text}\u200b`);
  mirror.appendChild(baseline);
  mirror.appendChild(node);
  document.body.appendChild(mirror);
  try {
    const range = document.createRange();
    // Non-layout environments (SSR tests) use the original deterministic layout.
    if (!range.getBoundingClientRect || !mirror.getBoundingClientRect().height)
      return fallback();
    range.setStart(node, 0);
    range.setEnd(node, 1);
    const firstTop = range.getBoundingClientRect().top;
    const top = 192 - baseline.getBoundingClientRect().top;
    const glyphs: Glyph[] = [];
    let lastY = 192;
    for (const { segment, index } of new Intl.Segmenter('ja', {
      granularity: 'grapheme',
    }).segment(`${text}\u200b`)) {
      if (segment === '\n') continue;
      range.setStart(node, index);
      range.setEnd(node, index + segment.length);
      const rect = range.getBoundingClientRect();
      const y = 192 + rect.top - firstTop;
      lastY = Math.max(lastY, y);
      if (index < text.length)
        glyphs.push({
          text: segment,
          x: 92 + rect.left,
          y,
          start: index,
          end: index + segment.length,
        });
    }
    const result = { glyphs, top, height: Math.max(PAPER_HEIGHT, lastY + 150) };
    if (cache.size >= 24) cache.delete(cache.keys().next().value!);
    cache.set(key, result);
    return result;
  } finally {
    mirror.remove();
  }
}
