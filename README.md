# herdr-math

Render LaTeX display equations directly inside [Herdr](https://herdr.dev) terminal panes using MathJax and Resvg.

The plugin reads visible terminal text. It works independently of agent APIs, session files, and authentication. An optional [writing skill](skills/herdr-math/SKILL.md) explains how any agent can write equations for it.

![Equations rendered in a real Herdr pane](artifacts/herdr-rendered.png)

## Install

Requires Node.js 20+, npm, Herdr 0.8.2+, and a Kitty-graphics-compatible outer terminal. Tested on Linux with Kitty 0.45.0; macOS is declared but has not been visually tested.

```sh
herdr plugin install liambern/herdr-math
```

Installation runs `npm ci` and enables `kitty_graphics = true` in your Herdr configuration, using the setting location reported by your installed Herdr binary. Other settings and comments are preserved.

Rendering starts automatically when Herdr starts and follows the active pane. When installing into an already-running session, switch panes once to start it. No per-pane activation is needed.

If graphics were previously disabled, the existing session may require a compatible terminal reattach or a server restart before graphics become available. The installer does not restart your server or interrupt agents. Run Herdr inside a Kitty-graphics-compatible terminal, such as Kitty.

## Use

Ask your agent for equations. To disable rendering, use `herdr plugin disable herdr-math`; re-enable it with `herdr plugin enable herdr-math` and switch panes. The renderer clears its images when disabled or uninstalled.

Install the [harness-independent writing skill](skills/herdr-math/SKILL.md) through the [Skills CLI](https://github.com/vercel-labs/skills):

```sh
npx skills add liambern/herdr-math --skill herdr-math -g
```

`-g` makes the skill available across projects for the agents you select. This installs writing instructions; the Herdr plugin above provides the rendering. To inspect the available skill without installing it, use `npx skills add liambern/herdr-math --list`.

Alternatively, ask agents to write standalone display environments, outside Markdown code fences:

```latex
\begin{equation*}
E = \frac{\langle\Psi|H|\Psi\rangle}{\langle\Psi|\Psi\rangle}
\end{equation*}
```

The renderer also recognizes `align`, `gather`, and `multline` environments, with or without stars, bracket display delimiters, and double-dollar blocks. Standalone environments are preferred: in our Antigravity test they survived its formatter, while dollar-delimited equations were converted to Unicode before Herdr saw them.

## Behavior and limitations

- Images cover the original source rectangle; they do not reserve additional rows or reflow paragraphs. Spread tall equations across several source lines.
- Inline, incomplete, invalid, partially visible, and unreadably cramped equations remain text. Keep source lines short enough to avoid wrapping inside TeX commands.
- The source remains available for copying. Only delimiters still present in the terminal can be detected; the plugin cannot recover Markdown already transformed by a harness.
- Equations use a dark background and light text. The screenshot shows the matching Catppuccin-style colors.
- The worker caches its PNG and refreshes the placement every 200 ms while visible. MathJax runs only for uncached formulas. Brief raw-text transitions can occur during output and scrolling.

## Development and verification

From the repository root:

```sh
npm ci
npm test
herdr plugin link "$PWD"
```

Seven automated tests cover installation configuration, active-pane switching and cleanup, row/column placement, code fences, incomplete input, invalid TeX, macro isolation, and connection closure. Automatic startup and restart were checked in an isolated Herdr session, including startup before any panes exist. The original rendering action was exercised in an isolated Herdr 0.8.2 / Kitty 0.45.0 session under Xvfb, with visual checks of rendering, resizing, scrolling, and image cleanup. `test/live.mjs` provides the interactive terminal fixture for those checks.

The rendering scale follows [pi-math's architecture](https://github.com/Fadouse/pi-math/blob/main/docs/ARCHITECTURE.md): one MathJax ex is approximately half a terminal cell's height. This implementation is independent of Pi's TUI.

## License

MIT. See [LICENSE](LICENSE).
