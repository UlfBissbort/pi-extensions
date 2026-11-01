// Keeps the transcript still when a step box changes height.
//
// Toggling a box never changes the lines above the clicked line, so the clicked
// line keeps its screen row exactly when the transcript keeps its scroll offset.
// Pi already keeps the offset while the user is scrolled up; at the bottom it
// follows new output instead, which would shift the clicked box. So before the
// redraw we stop following, at the current offset.
export type ScrollState = { top: number; following: boolean };
export type ScrollCommand = { scrollTo: number; disableFollow: true } | undefined;

export const holdScroll = (state: ScrollState): ScrollCommand =>
  state.following ? { scrollTo: state.top, disableFollow: true } : undefined;

// Edge: Pi gives extensions the TUI only through widget factories. The primary
// scroll view's scrollTo is not part of Pi's public TUI API; without it, clicks
// still work and the transcript behaves as before.
type ScrollView = { scrollTop: number; isFollowingEnd: boolean; scrollTo(top: number, options: { disableFollow: boolean }): void };
type Tui = { getPrimaryScrollView?: () => ScrollView | undefined };
let tui: Tui | undefined;

export const setTui = (value: unknown) => { tui = value as Tui; };

export function keepScrollPosition() {
  try {
    const view = tui?.getPrimaryScrollView?.();
    if (!view || typeof view.scrollTo !== 'function') return;
    const command = holdScroll({ top: view.scrollTop, following: view.isFollowingEnd });
    if (command) view.scrollTo(command.scrollTo, { disableFollow: command.disableFollow });
  } catch { /* Scrolling is cosmetic; never break a click over it. */ }
}
