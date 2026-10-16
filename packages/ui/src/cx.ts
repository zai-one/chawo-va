/** Joins class names, skipping empty ones. */
export function cx(...names: (string | false | null | undefined)[]): string | undefined {
  const s = names.filter(Boolean).join(' ');
  return s || undefined;
}
