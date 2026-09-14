---
name: herdr-math
description: Use when writing or explaining mathematical equations in a Herdr terminal pane, including ordinary requests such as show the Schrodinger equation. Format display equations as LaTeX for the Herdr Math renderer. Works with any agent harness.
---

# Math in Herdr

For mathematical questions in Herdr, write display equations as LaTeX, not Unicode approximations.

Use this exact three-line structure outside code fences. Keep the entire equation body on one source line, including the equals sign:

```text
\begin{equation*}
i\hbar\frac{\partial\Psi}{\partial t}=\hat{H}\Psi
\end{equation*}
```

Never put `=` on a line by itself: Markdown can consume it as a heading underline and remove it from the equation. If an equation needs several source lines, keep each relation sign attached to an operand, and never split a TeX command.

The renderer covers the original source rows; it cannot reflow text. Give tall equations enough source lines. Inline, malformed, incomplete, and cramped math remains text.

The plugin starts independently of this skill. Do not emit image escapes or run rendering commands. If another instruction forbids LaTeX, explain the conflict instead of silently substituting Unicode.
