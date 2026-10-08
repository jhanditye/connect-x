// A screen that holds something the person would lose by leaving (a recording in progress) registers a guard here. The shell asks it
// before an in-app link to another screen is followed; the guard returns true to block the navigation and shows its own question.
// This only covers links and buttons inside the app (tab bar, More, wordmark). The browser's back gesture cannot be stopped from a
// page, so the screen also says on its face that leaving discards the take.

type Guard = (href: string) => boolean;

let guard: Guard | null = null;

/** Register (or, with null, remove) the guard. Returns the function that removes this guard if it is still the current one. */
export function setLeaveGuard(next: Guard | null): () => void {
  guard = next;
  return () => {
    if (guard === next) guard = null;
  };
}

/** True when the screen asked for the navigation to be held back. */
export function shouldBlockLeave(href: string): boolean {
  try {
    return guard ? guard(href) : false;
  } catch {
    return false;
  }
}
