import type { CSSProperties } from 'react';
import {
  layoutText,
  PAPER_FONT,
  PAPER_HEIGHT,
  PAPER_WIDTH,
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

export function paperLineHeight(settings: Settings = defaults) {
  const fontSize = settings.fontSize ?? defaults.fontSize;
  return Math.max(
    settings.lineSpacing ?? defaults.lineSpacing,
    Math.ceil((fontSize * 112) / 100),
  );
}

export function paperTextStyleFor(
  settings: Settings = defaults,
): CSSProperties {
  return {
    ...paperTextStyle,
    fontFamily: paperFont(settings),
    fontSize: `${settings.fontSize ?? defaults.fontSize}px`,
    fontWeight: settings.fontWeight ?? defaults.fontWeight,
    textAlign: settings.textAlign ?? defaults.textAlign,
    lineHeight: `${paperLineHeight(settings)}px`,
    letterSpacing: `${settings.letterSpacing}px`,
  };
}

type PaperLayout = { glyphs: Glyph[]; height: number; top: number };
const cache = new Map<string, PaperLayout>();

const PAPER_SIDE_PADDING = 92;
const PAPER_VERTICAL_PADDING = 80;

function fontMetrics(
  context: CanvasRenderingContext2D,
  settings: Settings,
) {
  const size = settings.fontSize ?? defaults.fontSize;
  const metrics = context.measureText('国Mg');
  return {
    ascent: metrics.actualBoundingBoxAscent || size * 0.88,
    descent: metrics.actualBoundingBoxDescent || size * 0.18,
    inkPadding: Math.max(8, size * 0.06),
  };
}

function centeredPaperGeometry(
  lastLineOffset: number,
  context: CanvasRenderingContext2D,
  settings: Settings,
) {
  const { ascent, descent, inkPadding } = fontMetrics(context, settings);
  const inkHeight = ascent + lastLineOffset + descent + inkPadding * 2;
  const height = Math.max(
    PAPER_HEIGHT,
    PAPER_VERTICAL_PADDING * 2 + inkHeight,
  );
  const firstBaseline =
    height === PAPER_HEIGHT
      ? (PAPER_HEIGHT - inkHeight) / 2 + inkPadding + ascent
      : PAPER_VERTICAL_PADDING + inkPadding + ascent;
  return { ascent, descent, inkPadding, height, firstBaseline };
}

export function measurePaperText(
  text: string,
  settings: Settings = defaults,
): PaperLayout {
  const key = `${text}\u0000${settings.font}\u0000${settings.fontSize}\u0000${settings.letterSpacing}\u0000${settings.lineSpacing}\u0000${settings.fontWeight}\u0000${settings.textAlign}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const context = document.createElement('canvas').getContext('2d')!;
  context.font = `${settings.fontWeight ?? defaults.fontWeight} ${settings.fontSize ?? defaults.fontSize}px ${paperFont(settings)}`;
  const fallback = () => {
    const rawGlyphs = layoutText(
      text,
      (c) => context.measureText(c).width,
      settings.letterSpacing,
      paperLineHeight(settings),
    );
    const lastLineOffset = Math.max(
      0,
      ...rawGlyphs.map((glyph) => glyph.y - 192),
    );
    const geometry = centeredPaperGeometry(
      lastLineOffset,
      context,
      settings,
    );
    const lineHeight = paperLineHeight(settings);
    const fontSize = settings.fontSize ?? defaults.fontSize;
    const baselineInLine =
      (lineHeight - fontSize) / 2 + geometry.ascent;
    const top = geometry.firstBaseline - baselineInLine;
    const glyphs = rawGlyphs.map((glyph) => ({
      ...glyph,
      y: geometry.firstBaseline + glyph.y - 192,
    }));
    return {
      glyphs,
      top,
      height: Math.max(
        geometry.height,
        top + lastLineOffset + lineHeight + PAPER_VERTICAL_PADDING,
      ),
    };
  };
  const mirror = document.createElement('div');
  Object.assign(mirror.style, paperTextStyleFor(settings), {
    position: 'fixed',
    left: '0',
    top: '0',
    width: `${PAPER_WIDTH - PAPER_SIDE_PADDING * 2}px`,
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
    const measuredBaseline = baseline.getBoundingClientRect().top;
    const measuredGlyphs: Array<
      Omit<Glyph, 'y'> & { lineOffset: number }
    > = [];
    let lastLineOffset = 0;
    for (const { segment, index } of new Intl.Segmenter('ja', {
      granularity: 'grapheme',
    }).segment(`${text}\u200b`)) {
      if (segment === '\n') continue;
      range.setStart(node, index);
      range.setEnd(node, index + segment.length);
      const rect = range.getBoundingClientRect();
      const lineOffset = rect.top - firstTop;
      lastLineOffset = Math.max(lastLineOffset, lineOffset);
      if (index < text.length)
        measuredGlyphs.push({
          text: segment,
          x: PAPER_SIDE_PADDING + rect.left,
          lineOffset,
          start: index,
          end: index + segment.length,
        });
    }
    const geometry = centeredPaperGeometry(
      lastLineOffset,
      context,
      settings,
    );
    const top = geometry.firstBaseline - measuredBaseline;
    const glyphs = measuredGlyphs.map(({ lineOffset, ...glyph }) => ({
      ...glyph,
      y: geometry.firstBaseline + lineOffset,
    }));
    const result = {
      glyphs,
      top,
      height: Math.max(
        geometry.height,
        top + mirror.scrollHeight + PAPER_VERTICAL_PADDING,
      ),
    };
    if (cache.size >= 24) cache.delete(cache.keys().next().value!);
    cache.set(key, result);
    return result;
  } finally {
    mirror.remove();
  }
}
