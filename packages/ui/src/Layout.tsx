import type { FieldsetHTMLAttributes, HTMLAttributes, ReactNode } from 'react';
import { cx } from './cx';

export interface FieldsetProps extends FieldsetHTMLAttributes<HTMLFieldSetElement> {
  legend: ReactNode;
}

/** A titled group of settings. */
export function Fieldset({ legend, children, ...rest }: FieldsetProps) {
  return (
    <fieldset {...rest}>
      <legend>{legend}</legend>
      {children}
    </fieldset>
  );
}

export interface HintProps extends HTMLAttributes<HTMLParagraphElement> {
  /** Accent colour for something the user should act on. */
  warn?: boolean;
  /** Under a checkbox: lines up with its text. */
  indent?: boolean;
  /** Long unbroken text (paths, URLs) wraps anywhere. */
  line?: boolean;
}

/** Small explanatory text. */
export function Hint({ warn, indent, line, className, ...rest }: HintProps) {
  return <p className={cx(!warn && 'muted', 'hint', warn && 'warn', indent && 'indent', line && 'line', className)} {...rest} />;
}

export interface StatusProps extends HTMLAttributes<HTMLParagraphElement> {
  warn?: boolean;
}

/** One status line under an action. */
export function Status({ warn, className, ...rest }: StatusProps) {
  return <p className={cx('status', 'line', warn && 'warn', className)} {...rest} />;
}

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  failed?: boolean;
}

export function Card({ failed, className, ...rest }: CardProps) {
  return <div className={cx('card', failed && 'failed', className)} {...rest} />;
}

export function Row({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cx('row', className)} {...rest} />;
}

/** A download or a long job: percent, or null while the size is unknown. */
export function Progress({ percent }: { percent: number | null }) {
  return (
    <div className={cx('progress', percent === null && 'indeterminate')}>
      <div style={percent === null ? undefined : { width: `${percent.toFixed(1)}%` }} />
    </div>
  );
}
