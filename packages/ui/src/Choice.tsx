import { useRef, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from 'react';
import { useNativeEvents, useSyncedChoice } from './native';

type InputBase = Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'checked' | 'defaultChecked' | 'onChange'>;

export interface CheckProps extends InputBase {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** The text after the box; without it only the box is rendered. */
  label?: ReactNode;
  /** Class of the <label>: 'check' (own line, the default), 'block', or '' (inline). */
  labelClass?: string;
  labelTitle?: string;
}

/** A checkbox inside its label. The box shows the click at once; main's next state has the last word. */
export function Check({ checked, onChange, label, labelClass = 'check', labelTitle, ...rest }: CheckProps) {
  const ref = useRef<HTMLInputElement>(null);
  useNativeEvents(ref, undefined, (el) => onChange(el.checked));
  useSyncedChoice(ref, checked);
  const box = <input ref={ref} type="checkbox" defaultChecked={checked} {...rest} />;
  if (label === undefined) return box;
  return (
    <label className={labelClass || undefined} title={labelTitle}>
      {box}
      {label}
    </label>
  );
}

export interface RadioProps extends InputBase {
  checked: boolean;
  /** Called when this radio gets selected. */
  onSelect: () => void;
}

export function Radio({ checked, onSelect, ...rest }: RadioProps) {
  const ref = useRef<HTMLInputElement>(null);
  useNativeEvents(ref, undefined, (el) => el.checked && onSelect());
  useSyncedChoice(ref, checked);
  return <input ref={ref} type="radio" defaultChecked={checked} {...rest} />;
}

export interface Option {
  value: string;
  label: string;
}

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'value' | 'defaultValue' | 'onChange'> {
  options: readonly Option[];
  value: string;
  onChange: (value: string) => void;
}

export function Select({ options, value, onChange, ...rest }: SelectProps) {
  const ref = useRef<HTMLSelectElement>(null);
  useNativeEvents(ref, undefined, (el) => onChange(el.value));
  useSyncedChoice(ref, value);
  return (
    <select ref={ref} defaultValue={value} {...rest}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
