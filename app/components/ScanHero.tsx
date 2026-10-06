import type { ReactNode } from "react";
import styles from "./ScanHero.module.css";

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

// Shown while a scan runs. `value` is the progress from 0 to 1.
export function ScanProgress({ value, label }: { value: number; label: string }) {
  const percent = Math.round(Math.min(1, Math.max(0, value)) * 100);

  return (
    <div className={styles.hero}>
      <div className={styles.percent}>{percent}%</div>
      <div
        className={styles.bar}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={`${percent}% · ${label}`}
      >
        <div className={styles.fill} style={{ width: `${percent}%` }} />
      </div>
      <p className={styles.status} aria-live="polite">
        {label}
      </p>
    </div>
  );
}
