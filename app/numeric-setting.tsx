'use client';

import {
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { Slider } from '@/components/ui/slider';

type NumericSettingProps = {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  hardMin?: number;
  hardMax?: number;
  step?: number;
  unit: string;
  disabled?: boolean;
  onChange: (value: number) => void;
};

const format = (value: number) =>
  Number.isInteger(value)
    ? String(value)
    : value.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');

export default function NumericSetting({
  id,
  label,
  value,
  min,
  max,
  hardMin = min,
  hardMax = max,
  step = 1,
  unit,
  disabled = false,
  onChange,
}: NumericSettingProps) {
  const [draft, setDraft] = useState(format(value));
  const [editing, setEditing] = useState(false);
  const [overlay, setOverlay] = useState<{ x: number; y: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const drag = useRef<{ x: number; value: number; pointerId: number } | null>(
    null,
  );
  const labelId = `${id}-label`;

  const clamp = (next: number) => Math.min(hardMax, Math.max(hardMin, next));
  const apply = (next: number) => {
    const normalized = clamp(Math.round(next / step) * step);
    onChange(Number(normalized.toFixed(6)));
  };
  const finishInput = () => {
    const next = Number(draft);
    if (Number.isFinite(next)) apply(next);
    setEditing(false);
    setDraft(format(Number.isFinite(next) ? clamp(next) : value));
  };
  const startDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (disabled || event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, value, pointerId: event.pointerId };
    setOverlay({ x: event.clientX, y: event.clientY });
  };
  const moveDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!drag.current || drag.current.pointerId !== event.pointerId) return;
    const sensitivity = event.shiftKey ? 0.1 : event.altKey ? 10 : 1;
    const unitStep = step * sensitivity;
    const delta = Math.round(event.clientX - drag.current.x) * unitStep;
    const next = Math.round((drag.current.value + delta) / unitStep) * unitStep;
    onChange(Number(clamp(next).toFixed(6)));
    setOverlay({ x: event.clientX, y: event.clientY });
  };
  const endDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!drag.current || drag.current.pointerId !== event.pointerId) return;
    drag.current = null;
    setOverlay(null);
    event.currentTarget.releasePointerCapture(event.pointerId);
  };

  return (
    <div
      className="setting numeric-setting"
      data-outside-range={value < min || value > max || undefined}
    >
      <div className="numeric-row">
        <button
          type="button"
          id={labelId}
          className="numeric-scrub"
          onPointerDown={startDrag}
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onDoubleClick={() => {
            inputRef.current?.focus();
            inputRef.current?.select();
          }}
          title="左右にドラッグして調整"
        >
          {label}
        </button>
        <span className="numeric-value">
          <input
            ref={inputRef}
            id={id}
            aria-labelledby={labelId}
            type="number"
            inputMode="decimal"
            min={hardMin}
            max={hardMax}
            step={step}
            value={editing ? draft : format(value)}
            disabled={disabled}
            onFocus={(event) => {
              setEditing(true);
              setDraft(event.currentTarget.value);
              event.currentTarget.select();
            }}
            onChange={(event) => {
              const nextDraft = event.currentTarget.value;
              setDraft(nextDraft);
              const next = Number(nextDraft);
              if (
                nextDraft !== '' &&
                Number.isFinite(next) &&
                next >= hardMin &&
                next <= hardMax
              )
                onChange(next);
            }}
            onBlur={finishInput}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur();
              if (event.key === 'Escape') {
                setDraft(format(value));
                event.currentTarget.blur();
              }
            }}
          />
          <span>{unit}</span>
        </span>
      </div>
      <Slider
        className="numeric-slider"
        aria-labelledby={labelId}
        min={min}
        max={max}
        step={step}
        value={[Math.min(max, Math.max(min, value))]}
        disabled={disabled}
        title={`${min}〜${max}${unit}が推奨範囲`}
        onValueChange={(next) => apply(Array.isArray(next) ? next[0] : next)}
      />
      {overlay && (
        <output
          className="numeric-overlay"
          style={{ left: overlay.x, top: overlay.y }}
        >
          {format(value)} {unit}
        </output>
      )}
    </div>
  );
}
