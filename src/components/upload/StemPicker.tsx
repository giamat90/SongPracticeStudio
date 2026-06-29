import type { StemName } from "../../lib/types";

const ALL_STEMS: StemName[] = ["vocals", "drums", "bass", "guitar", "piano", "other"];

const STEM_COLORS: Record<StemName, string> = {
  vocals: "rgba(74,158,255,0.85)",
  drums:  "rgba(180,80,220,0.85)",
  bass:   "rgba(60,200,100,0.85)",
  guitar: "rgba(255,140,30,0.85)",
  piano:  "rgba(255,220,50,0.85)",
  other:  "rgba(160,160,160,0.85)",
};

export const DEFAULT_STEMS: StemName[] = [...ALL_STEMS];

interface StemPickerProps {
  value: StemName[];
  onChange: (stems: StemName[]) => void;
  disabled?: boolean;
}

export default function StemPicker({ value, onChange, disabled }: StemPickerProps) {
  const toggle = (stem: StemName) => {
    if (value.includes(stem)) {
      if (value.length <= 1) return; // always keep at least one stem
      onChange(value.filter((s) => s !== stem));
    } else {
      onChange([...value, stem]);
    }
  };

  return (
    <div className="stem-picker">
      <span className="stem-picker__label">Extract</span>
      <div className="stem-picker__chips">
        {ALL_STEMS.map((stem) => {
          const on = value.includes(stem);
          return (
            <button
              key={stem}
              type="button"
              className={`stem-picker__chip${on ? " stem-picker__chip--on" : ""}`}
              style={on ? ({ "--chip-color": STEM_COLORS[stem] } as React.CSSProperties) : undefined}
              onClick={() => toggle(stem)}
              disabled={disabled}
              title={on ? `Remove ${stem}` : `Add ${stem}`}
            >
              {stem}
            </button>
          );
        })}
      </div>
    </div>
  );
}
