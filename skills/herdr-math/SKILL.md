---
name: herdr-math
description: Write scientific equations for the Herdr Math terminal renderer when the user requests rendered math in a Herdr pane. Works with any agent harness.
---

# Math in Herdr

Prefer standalone LaTeX environments, outside Markdown code fences. They survive harnesses such as Antigravity that already turn dollar-delimited math into Unicode text. Put the boundaries on separate lines:

```text
\begin{equation*}
E = \frac{\langle\Psi|H|\Psi\rangle}{\langle\Psi|\Psi\rangle}
\end{equation*}
```

The renderer recognizes `equation`, `align`, `gather`, and `multline` environments (with or without stars), bracket display delimiters, and double-dollar blocks. Delimiters must survive the harness's own formatter. Keep continuation lines indented consistently. Prefer short source lines so TeX commands do not wrap across the terminal edge.

The renderer uses the rows already occupied by the source. For tall matrices, nested fractions, or multi-line equations, spread the source across several lines inside the delimiters. Keep nearby prose outside the block. Inline math remains text; use a display block when typesetting matters.

Do not emit image escapes or run a rendering command for each equation. The Herdr plugin observes the pane. This skill only changes how equations are written; it does not activate the plugin. Malformed, incomplete, or excessively cramped equations remain as their original text.
