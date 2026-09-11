'use client';
import { useState } from 'react';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { defaults, diffText, type Mark, type MotionMode } from '@/lib/revision';
import Paper, { measureGlyphs } from './paper';

export const motionChoices: {
  value: MotionMode;
  title: string;
}[] = [
  {
    value: 'eraser',
    title: '消しゴム',
  },
  {
    value: 'insect',
    title: '虫のように',
  },
  {
    value: 'float',
    title: '風に漂う',
  },
];

export function MotionPicker({
  value,
  onChange,
  disabled = false,
  idPrefix = 'motion',
}: {
  value: MotionMode;
  onChange: (mode: MotionMode) => void;
  disabled?: boolean;
  idPrefix?: string;
}) {
  return (
    <RadioGroup
      aria-label="消した文字の動き"
      value={value}
      onValueChange={(v) => onChange(v as MotionMode)}
      disabled={disabled}
      className="motion-options"
    >
      {motionChoices.map((choice) => (
        <label
          key={choice.value}
          htmlFor={`${idPrefix}-${choice.value}`}
          className="motion-option"
        >
          <RadioGroupItem
            id={`${idPrefix}-${choice.value}`}
            value={choice.value}
          />
          <span>{choice.title}</span>
        </label>
      ))}
    </RadioGroup>
  );
}

const before = '雨のあと、庭はまだ眠っている。';
const after = '雨のあと、庭は静かに濡れている。';
export default function MotionStudy() {
  const [mode, setMode] = useState<MotionMode>('float');
  const [played, setPlayed] = useState(false);
  const [marks, setMarks] = useState<Mark[]>([]);
  function play(nextMode = mode) {
    const difference = diffText(before, after);
    setMode(nextMode);
    setPlayed(true);
    setMarks(
      measureGlyphs(before)
        .filter(
          (g) =>
            g.start >= difference.start &&
            g.start < difference.start + difference.removed.length,
        )
        .map((g, i) => ({
          id: `sample-${i}`,
          sessionId: 'sample',
          text: g.text,
          x: g.x,
          y: g.y,
          createdAt: Date.now(),
          temporary: false,
        })),
    );
  }
  return (
    <section className="motion-study" aria-label="消した文字の動きの試作">
      <MotionPicker
        value={mode}
        onChange={(next) => play(next)}
        idPrefix="sample-motion"
      />
      <Paper
        text={played ? after : before}
        committed={played ? after : before}
        composing={false}
        marks={marks}
        settings={{ ...defaults, motion: mode, fadeSeconds: 12 }}
        number={1}
        paused={false}
        textOnly
      />
      <div className="motion-study-actions">
        <button className="action" onClick={() => play()}>
          推敲を再生
        </button>
      </div>
    </section>
  );
}
