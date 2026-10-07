// Nerd Font icons (Powerline, Devicons, Font Awesome, Material Design ...) live in the Private Use Area, which no system
// monospace font covers. "Symbols Nerd Font Mono" (an installed copy first, else the bundled one, see terminal-font.css)
// fills in exactly those code points; letters keep coming from the families before it.
export const TERMINAL_FONT = 'ui-monospace, "JetBrains Mono", SFMono-Regular, Menlo, Consolas, "Symbols Nerd Font Mono", monospace';

const SYMBOLS = '14px "Symbols Nerd Font Mono"';
/** Longest wait for the icon font before the terminal opens without it. */
const WAIT_MS = 3000;

let load: Promise<void> | undefined;

/** The real font load: resolves (never rejects) when it settled, a failure or no font API included. Once per page. */
export function terminalFontSettled(): Promise<void> {
  // The sample forces the unicode-range file: a bare family name would load nothing.
  return (load ??= Promise.resolve(document.fonts?.load(SYMBOLS, "\ue0a0")).then(
    () => {},
    () => {},
  ));
}

/**
 * Resolves when the icon font is ready or after 3 s, whichever comes first: xterm measures its cells when it opens, so
 * the terminal opens after this. A font arriving later (the timeout won) is `terminalFontSettled()`.
 */
export function loadTerminalFont(): Promise<void> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([terminalFontSettled(), new Promise<void>((r) => (timer = setTimeout(r, WAIT_MS)))]).finally(() => clearTimeout(timer));
}

/** For tests: forget the memoized load. */
export function resetTerminalFont() {
  load = undefined;
}
