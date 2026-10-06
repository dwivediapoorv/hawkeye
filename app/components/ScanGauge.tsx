import { useId, type ReactNode } from "react";
import styles from "./ScanGauge.module.css";

// Gauge geometry (SVG user units). The dial is a 270° arc that opens at the bottom.
const CX = 130;
const CY = 130;
const R = 100;
const START_DEG = 135; // bottom-left, measured clockwise from 3 o'clock
const SWEEP_DEG = 270;
const TICKS = [0, 0.25, 0.5, 0.75, 1];

const point = (deg: number, r: number) => {
  const rad = (deg * Math.PI) / 180;
  return { x: CX + r * Math.cos(rad), y: CY + r * Math.sin(rad) };
};

const ARC_START = point(START_DEG, R);
const ARC_END = point(START_DEG + SWEEP_DEG, R);
const ARC_PATH = `M ${ARC_START.x} ${ARC_START.y} A ${R} ${R} 0 1 1 ${ARC_END.x} ${ARC_END.y}`;

// Empty state before the first scan: a short intro and the round scan button.
export function ScanIntro({
  heading,
  children,
  onScan,
  disabled,
}: {
  heading: string;
  children: ReactNode;
  onScan: () => void;
  disabled?: boolean;
}) {
  return (
    <div className={styles.hero}>
      <h2 className={styles.heading}>{heading}</h2>
      <p className={styles.intro}>{children}</p>
      <button
        type="button"
        className={styles.scanButton}
        onClick={onScan}
        disabled={disabled}
        aria-label="Scan my store"
      >
        SCAN
      </button>
    </div>
  );
}

// `value` is the scan's progress from 0 to 1.
export function ScanGauge({ value, label }: { value: number; label: string }) {
  const gradientId = `gauge-${useId().replace(/:/g, "")}`;
  const progress = Math.min(1, Math.max(0, value));
  const percent = Math.round(progress * 100);

  return (
    <div className={styles.hero}>
      <svg
        className={styles.gauge}
        viewBox="0 0 260 225"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={`${percent}% · ${label}`}
      >
        <defs>
          <linearGradient id={gradientId} x1="30" y1="200" x2="230" y2="60" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#1a8cff" />
            <stop offset="100%" stopColor="#2ee6d6" />
          </linearGradient>
        </defs>

        <path className={styles.track} d={ARC_PATH} pathLength={100} />
        <path
          className={styles.fill}
          d={ARC_PATH}
          pathLength={100}
          stroke={`url(#${gradientId})`}
          strokeDasharray={`${percent} 100`}
        />

        {TICKS.map((t) => {
          const deg = START_DEG + SWEEP_DEG * t;
          const outer = point(deg, 84);
          const inner = point(deg, 78);
          return (
            <line
              key={t}
              className={styles.tick}
              x1={inner.x}
              y1={inner.y}
              x2={outer.x}
              y2={outer.y}
            />
          );
        })}

        {/* Drawn pointing straight up, then rotated onto the dial. */}
        <g
          className={styles.needle}
          style={{ transform: `rotate(${SWEEP_DEG * progress - SWEEP_DEG / 2}deg)` }}
        >
          <polygon points={`${CX - 4},${CY} ${CX + 4},${CY} ${CX},${CY - 74}`} fill="#c9c9c9" />
        </g>
        <circle cx={CX} cy={CY} r={7} fill="#e0e0e0" />

        <text className={styles.percent} x={CX} y={CY + 72} textAnchor="middle">
          {percent}%
        </text>
      </svg>
      <p className={styles.status} aria-live="polite">
        {label}
      </p>
    </div>
  );
}
