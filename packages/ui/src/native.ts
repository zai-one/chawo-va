// Form fields of the app talk to the DOM's own events, not React's synthetic onChange: a text field
// saves on `input` (every keystroke) or on `change` (blur after an edit, Enter), exactly like the
// pages did before React, and a value set by a script plus a dispatched event is seen too. The shown
// value follows the main process, but never while the field is being edited.
import { useEffect, useEffectEvent, useLayoutEffect, useRef, type RefObject } from 'react';

type Field = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

/** Native `input` / `change` listeners with the latest handlers. */
export function useNativeEvents<E extends Field>(ref: RefObject<E | null>, onInput?: (el: E) => void, onChange?: (el: E) => void): void {
  const input = useEffectEvent((el: E) => onInput?.(el));
  const change = useEffectEvent((el: E) => onChange?.(el));
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const i = () => input(el);
    const c = () => change(el);
    el.addEventListener('input', i);
    el.addEventListener('change', c);
    return () => {
      el.removeEventListener('input', i);
      el.removeEventListener('change', c);
    };
  }, [ref]);
}

/** Puts `value` into the field when it changes, unless the user is in the middle of editing it. */
export function useSyncedValue<E extends Field>(ref: RefObject<E | null>, value: string): void {
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && el.value !== value && el.ownerDocument.activeElement !== el) el.value = value;
  }, [ref, value]);
}

/**
 * A checkbox, radio or select: a click shows at once, and every render puts main's state back — also
 * when main answered «no» and the state did not change at all.
 */
export function useSyncedChoice(ref: RefObject<HTMLInputElement | HTMLSelectElement | null>, value: boolean | string): void {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof value === 'boolean') {
      if (el instanceof HTMLInputElement && el.checked !== value) el.checked = value;
    } else if (el.value !== value) el.value = value;
  });
}

/** A forwarded ref and the local one in one object. */
export function useFieldRef<E extends Field>(outer?: RefObject<E | null>): RefObject<E | null> {
  const local = useRef<E | null>(null);
  return outer ?? local;
}
