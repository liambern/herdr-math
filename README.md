# herdr-math

Render LaTeX display equations inside [Herdr](https://herdr.dev) terminal panes using MathJax and Resvg.

![Codex answering a request for Schrödinger’s equation inside Herdr](artifacts/herdr-rendered.png)

## Install

Requires Node.js 20+, npm, Herdr 0.8.2+, and a Kitty-graphics-compatible terminal. Tested on Linux with Kitty.

Open Herdr in your compatible terminal, then install the plugin and [writing skill](skills/herdr-math/SKILL.md):

```sh
herdr plugin install liambern/herdr-math
npx skills add liambern/herdr-math --skill herdr-math -g
```

Select your agents in the skill installer. Switch panes once after installation, and start a fresh agent conversation to load the skill.

The plugin enables Kitty graphics, starts with Herdr, and follows the active pane. If graphics were disabled in an existing session, reattach your terminal or restart the Herdr server.

## Use

Ask your agent: **“Show me Schrödinger’s equation. Use herdr-math.”**

The skill tells the agent to write standalone LaTeX display environments outside code fences. The plugin renders them from visible terminal text, independently of the agent harness.

Only display math is rendered. Images cover the source rows without reflowing surrounding text, so tall equations need enough source lines. Incomplete, invalid, partially visible, or cramped equations remain text. Inline math stays text, and the original source remains available for copying.

To pause rendering, run `herdr plugin disable herdr-math`. To resume, run `herdr plugin enable herdr-math` and switch panes.

## Update

```sh
herdr plugin disable herdr-math
herdr plugin install liambern/herdr-math
npx skills update herdr-math
herdr plugin enable herdr-math
```

Switch panes once after updating. See the [latest release](https://github.com/liambern/herdr-math/releases/latest) for changes.

## License

[MIT](LICENSE).
