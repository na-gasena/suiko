'use client';
/* oxlint-disable jsx-a11y/prefer-tag-over-role -- The canvas is an accessible drawing surface, not a replaceable img. */
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { measurePaperText, paperFont } from '@/lib/paper-layout';
import { motionAlpha, motionPose } from '@/lib/motion';
import {
  diffText,
  defaults,
  markAlpha,
  PAPER_WIDTH,
  type Mark,
  type Settings,
} from '@/lib/revision';

export function measureGlyphs(text: string, settings?: Settings) {
  return measurePaperText(text, settings).glyphs;
}

export default function Paper({
  text,
  committed,
  composing,
  marks,
  settings,
  number,
  paused,
  blankLabel = true,
  textOnly = false,
  children,
}: {
  text: string;
  committed: string;
  composing: boolean;
  marks: Mark[];
  settings: Settings;
  number: number;
  paused: boolean;
  blankLabel?: boolean;
  textOnly?: boolean;
  children?: ReactNode;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const paperRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [canvasWidth, setCanvasWidth] = useState(0);
  const editable = !!children;
  const visibleText =
    composing && !settings.showComposition && !editable ? committed : text;
  const layout =
    typeof document === 'undefined'
      ? null
      : measurePaperText(visibleText, settings);
  const height = Math.max(
    layout?.height || 620,
    ...marks.map((m) => m.y + 150),
  );
  useLayoutEffect(() => {
    if (!editable || !paperRef.current) return;
    const paper = paperRef.current;
    const resize = () =>
      setScale(paper.getBoundingClientRect().width / PAPER_WIDTH || 1);
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(paper);
    return () => observer.disconnect();
  }, [editable]);
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const resize = () => setCanvasWidth(canvas.getBoundingClientRect().width);
    resize();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);
  const [reducedMotion, setReducedMotion] = useState(false);
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReducedMotion(query.matches);
    queueMicrotask(update);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext('2d')!;
    const layer = document.createElement('canvas');
    const ink = layer.getContext('2d')!;
    context.font = `${settings.fontWeight ?? defaults.fontWeight} 34px ${paperFont(settings)}`;
    const glyphs = measureGlyphs(visibleText, settings);
    const change = diffText(committed, visibleText);
    // The projection surface can be much larger than the 960px logical paper.
    // Size the backing bitmap from the actual CSS width so a fullscreen HDMI
    // window does not stretch a low-resolution canvas. Keep a ceiling because
    // very long performances can otherwise allocate an unexpectedly large bitmap.
    const cssWidth =
      canvasWidth || canvas.getBoundingClientRect().width || PAPER_WIDTH;
    const ratio = Math.min(
      Math.max((window.devicePixelRatio || 1) * (cssWidth / PAPER_WIDTH), 1),
      textOnly ? 3.5 : 2.5,
    );
    canvas.width = layer.width = PAPER_WIDTH * ratio;
    canvas.height = layer.height = height * ratio;
    canvas.style.aspectRatio = `${PAPER_WIDTH} / ${height}`;
    context.scale(ratio, ratio);
    ink.scale(ratio, ratio);
    const mode = reducedMotion ? 'eraser' : settings.motion || 'eraser';
    const fadeSeconds =
      mode === 'eraser' ? settings.fadeSeconds : defaults.fadeSeconds;
    const inkColor = settings.invert ? '#f4f4ef' : '#302d2a';
    const textColor = settings.invert ? '#f4f4ef' : '#262421';
    const movingMarks =
      mode === 'eraser'
        ? []
        : marks.filter(
            (m) =>
              !m.temporary && Date.now() - m.createdAt < fadeSeconds * 1000,
          );
    let frame = 0,
      last = 0,
      stopped = false;
    const draw = (stamp: number) => {
      if (stopped) return;
      if (stamp - last < (movingMarks.length ? 24 : 80)) {
        frame = requestAnimationFrame(draw);
        return;
      }
      last = stamp;
      const now = Date.now();
      context.clearRect(0, 0, PAPER_WIDTH, height);
      ink.clearRect(0, 0, PAPER_WIDTH, height);
      ink.font = `${settings.fontWeight ?? defaults.fontWeight} 34px ${paperFont(settings)}`;
      ink.fillStyle = inkColor;
      ink.globalCompositeOperation = 'source-over';
      for (const mark of marks) {
        const residue = mode === 'eraser' ? settings.residue : defaults.residue;
        ink.globalAlpha = Math.min(
          1,
          (mode === 'eraser' || mark.temporary
            ? markAlpha(now - mark.createdAt, settings, mark.temporary)
            : residue / 100) / 0.34,
        );
        if (ink.globalAlpha > 0) ink.fillText(mark.text, mark.x, mark.y);
      }
      // Fine gaps leave graphite-like fragments; the whole residue layer has a density ceiling.
      ink.globalCompositeOperation = 'destination-out';
      ink.globalAlpha = 0.27;
      for (let y = 1; y < height; y += 4) ink.fillRect(0, y, PAPER_WIDTH, 0.55);
      ink.globalAlpha = 0.38;
      for (let i = 0; i < Math.floor(height * 1.6); i++)
        ink.fillRect(
          (i * 137.31) % PAPER_WIDTH,
          (i * 73.17) % height,
          0.9,
          1.7,
        );
      ink.globalAlpha = 1;
      ink.globalCompositeOperation = 'source-over';
      context.globalAlpha = 0.34;
      context.drawImage(layer, 0, 0, PAPER_WIDTH, height);
      context.globalAlpha = 1;
      context.font = `${settings.fontWeight ?? defaults.fontWeight} 34px ${paperFont(settings)}`;
      context.fillStyle = inkColor;
      for (const mark of movingMarks) {
        const age = now - mark.createdAt;
        const alpha = motionAlpha(age, fadeSeconds * 1000);
        if (alpha <= 0) continue;
        const pose = motionPose(mark, age / 1000, mode, PAPER_WIDTH, height, {
          speed: settings.insectSpeed,
          wander: settings.insectWander,
          wind: settings.floatWind,
          lift: settings.floatLift,
        });
        context.save();
        context.globalAlpha = alpha;
        context.translate(pose.x, pose.y);
        context.rotate(pose.angle);
        context.fillText(mark.text, 0, 0);
        context.restore();
      }
      context.globalAlpha = 1;
      if (!textOnly) {
        context.fillStyle = '#76716b';
        context.font = '13px system-ui, sans-serif';
        context.fillText(String(number).padStart(2, '0'), 92, 66);
      }
      context.font = `${settings.fontWeight ?? defaults.fontWeight} 34px ${paperFont(settings)}`;
      context.fillStyle = textColor;
      for (const glyph of editable ? [] : glyphs) {
        context.globalAlpha =
          composing &&
          settings.showComposition &&
          glyph.start >= change.start &&
          glyph.start < change.start + change.inserted.length
            ? 0.57
            : 1;
        context.fillText(glyph.text, glyph.x, glyph.y);
      }
      context.globalAlpha = 1;
      if (!textOnly && !visibleText && marks.length === 0 && blankLabel) {
        context.font = '24px "Yu Mincho", serif';
        context.fillStyle = settings.invert ? '#8e8e88' : '#b2aca3';
        context.fillText('未入力', 92, 192);
      }
      if (paused && !textOnly) {
        context.font = '14px "Yu Mincho", serif';
        context.fillStyle = settings.invert ? '#9c9c96' : '#76716b';
        context.fillText('休 憩', 92, height - 60);
      }
      if (
        marks.some(
          (m) => now - m.createdAt < (m.temporary ? 2000 : fadeSeconds * 1000),
        )
      )
        frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => {
      stopped = true;
      cancelAnimationFrame(frame);
    };
  }, [
    text,
    committed,
    composing,
    marks,
    settings,
    number,
    paused,
    blankLabel,
    textOnly,
    reducedMotion,
    visibleText,
    height,
    editable,
    canvasWidth,
  ]);
  // A canvas rendering text needs its accessible image name; it cannot be replaced with an img element.
  // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role
  return (
    <div
      className={`paper${editable ? ' paper-editable' : ''}${settings.invert ? ' paper-inverted' : ''}`}
      ref={paperRef}
    >
      <canvas
        ref={canvasRef}
        role="img"
        aria-hidden={editable || undefined}
        aria-label={`${String(number).padStart(2, '0')}。${visibleText || '未入力'}`}
      />
      {editable && (
        <div
          className="paper-writing-layer"
          style={{
            width: PAPER_WIDTH,
            height,
            transform: `scale(${scale})`,
            paddingTop: layout?.top || 139,
          }}
        >
          {children}
        </div>
      )}
    </div>
  );
}
