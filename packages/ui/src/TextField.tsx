import type { InputHTMLAttributes, RefObject, TextareaHTMLAttributes } from 'react';
import { useFieldRef, useNativeEvents, useSyncedValue } from './native';

type Base<A> = Omit<A, 'value' | 'defaultValue' | 'onInput' | 'onChange'>;

export interface TextFieldProps extends Base<InputHTMLAttributes<HTMLInputElement>> {
  /** What the field shows; it follows this prop except while the user is editing the field. */
  value: string;
  /** Every keystroke. */
  onInput?: (value: string) => void;
  /** Blur after an edit, or Enter. */
  onCommit?: (value: string) => void;
  fieldRef?: RefObject<HTMLInputElement | null>;
}

export function TextField({ value, onInput, onCommit, fieldRef, type = 'text', ...rest }: TextFieldProps) {
  const ref = useFieldRef(fieldRef);
  useNativeEvents(ref, (el) => onInput?.(el.value), (el) => onCommit?.(el.value));
  useSyncedValue(ref, value);
  return <input ref={ref} type={type} defaultValue={value} {...rest} />;
}

export interface TextAreaProps extends Base<TextareaHTMLAttributes<HTMLTextAreaElement>> {
  value: string;
  onInput?: (value: string) => void;
  onCommit?: (value: string) => void;
  fieldRef?: RefObject<HTMLTextAreaElement | null>;
}

export function TextArea({ value, onInput, onCommit, fieldRef, ...rest }: TextAreaProps) {
  const ref = useFieldRef(fieldRef);
  useNativeEvents(ref, (el) => onInput?.(el.value), (el) => onCommit?.(el.value));
  useSyncedValue(ref, value);
  return <textarea ref={ref} defaultValue={value} {...rest} />;
}
