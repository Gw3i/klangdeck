/** Looks up an element the app created itself; a missing one is a programming error. */
export function $<T extends HTMLElement = HTMLElement>(id: string) {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id}`);
  return element as T;
}

export const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
