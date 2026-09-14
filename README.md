# herdr-math

Render LaTeX display equations directly inside [Herdr](https://herdr.dev) terminal panes using MathJax and Resvg.

The plugin reads visible terminal text. It works independently of agent APIs, session files, and authentication. The [writing skill](skills/herdr-math/SKILL.md) teaches your agent to emit the LaTeX that the plugin renders.

![Codex answering a question about Maxwell’s equations, rendered by herdr-math inside Herdr](artifacts/herdr-rendered.png)

## Install

Requires Node.js 20+, npm, Herdr 0.8.2+, and a Kitty-graphics-compatible terminal. Tested on Linux with Kitty; macOS has not been visually tested.

1. **Open Herdr in Kitty** (or another terminal that supports Kitty graphics).

2. **Install the plugin and writing skill:**

   ```sh
   herdr plugin install liambern/herdr-math
   npx skills add liambern/herdr-math --skill herdr-math -g
   ```

   In the skill installer, select the agents you use, such as Codex or Claude Code. `-g` installs the skill across projects for those agents.

3. **Switch panes once, then ask your agent:** “What are Maxwell's equations?” Start a fresh agent conversation if it was already running when you installed the skill.

The plugin enables Herdr's `kitty_graphics` setting during installation, starts automatically with Herdr, and follows the active pane. No per-pane toggle or rendering command is needed. If graphics were previously disabled in an existing session, reattaching a compatible terminal or restarting that server may still be necessary; installation does not interrupt running agents.

## Update

```sh
herdr plugin disable herdr-math
herdr plugin install liambern/herdr-math
npx skills update herdr-math
herdr plugin enable herdr-math
```

Switch panes once after updating.

The [latest release](https://github.com/liambern/herdr-math/releases/latest) lists the current version and changes.

## Use

Ask mathematical questions normally. The skill supplies display LaTeX; the plugin renders it. The same plugin works across agent harnesses, including Codex, Claude Code, and Antigravity.

To stop rendering, run `herdr plugin disable herdr-math`. To resume, run `herdr plugin enable herdr-math` and switch panes.

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
- Focus events start rendering the new pane immediately. Images travel over a persistent raw-pixel graphics stream; unchanged screens are not repeatedly uploaded. The last eight screens are cached, and outlined equations skip system-font loading.
- Host scrollback events shift the cached image by the reported row offset before the next text snapshot is rendered. Agent interfaces that scroll by redrawing their own screen may not emit host scrollback events; those changes are detected from visible text. Brief transitions remain possible.

## If equations still appear as plain text

The writing skill must be installed for the agent you are using. Try asking it to use `herdr-math` for one equation. If it still emits Unicode, check for an older instruction or saved preference forbidding LaTeX. Update that preference to allow LaTeX display environments in Herdr; installing a renderer cannot override agent instructions. Existing conversations may need the corrected preference stated explicitly.

## Development and verification

From the repository root:

```sh
npm ci
npm test
herdr plugin link "$PWD"
```

Seven automated tests cover scroll-offset repositioning before a blocked text read completes, stream framing and cleanup, installation configuration, active-pane switching, row/column placement, code fences, incomplete input, invalid TeX, macro isolation, and connection closure. On Herdr 0.9.0 with Kitty under Xvfb, eight screen-capture trials measured 27–36 ms from newly visible pane text to its rendered equation, and eight wheel-scroll trials measured 37–90 ms from input to the image at its new position. These are local measurements, not guarantees for other terminals or agent TUIs.

Automatic startup and restart were checked in an isolated Herdr session, including startup before any panes exist. The original rendering action was exercised in an isolated Herdr 0.8.2 / Kitty 0.45.0 session under Xvfb, with visual checks of rendering, resizing, scrolling, and image cleanup. `test/live.mjs` provides the interactive terminal fixture for those checks.

The rendering scale follows [pi-math's architecture](https://github.com/Fadouse/pi-math/blob/main/docs/ARCHITECTURE.md): one MathJax ex is approximately half a terminal cell's height. This implementation is independent of Pi's TUI.

## License

MIT. See [LICENSE](LICENSE).
