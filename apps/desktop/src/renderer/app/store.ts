// A tiny external store: state that outlives a page (pushes arrive while another page is open) and is
// shared by components and plain modules (the microphone code). React reads it with useStore.
import { useSyncExternalStore } from 'react';

export interface Store<T> {
  get: () => T;
  set: (value: T) => void;
  update: (fn: (value: T) => T) => void;
  subscribe: (listener: () => void) => () => void;
}

export function createStore<T>(initial: T): Store<T> {
  let value = initial;
  const listeners = new Set<() => void>();
  const set = (next: T) => {
    if (Object.is(next, value)) return;
    value = next;
    for (const l of [...listeners]) l();
  };
  return {
    get: () => value,
    set,
    update: (fn) => set(fn(value)),
    subscribe: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
}

export function useStore<T>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
