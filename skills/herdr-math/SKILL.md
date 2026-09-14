---
name: herdr-math
description: Write mathematical explanations in Herdr terminal panes with inline and display LaTeX rendered by the Herdr Math plugin.
---

# Math in Herdr

Write mathematical explanations naturally using standard LaTeX delimiters. The installed plugin renders visible math automatically; no rendering commands or image escapes are needed.

- Use `$E=mc^2$` or `\(E=mc^2\)` for short expressions within prose. Prefer `\(...\)` when nearby dollar amounts would make the delimiters ambiguous.
- Use standalone `$$...$$`, `\[...\]`, or `equation`, `align`, `gather`, and `multline` environments (with or without `*`) for display math. Display equations are centered in full-width bands.
- Choose inline or display math for readability. There is no required three-line template. Tall fractions, matrices, and multiline derivations usually need display math with the opening delimiter, body, and closing delimiter on separate lines; add source lines for taller expressions.

Inline math overlays only its original text span, preserving neighboring prose. The plugin cannot reflow text: long LaTeX commands may leave a wider gap than the rendered expression. Expressions that are incomplete, invalid, clipped, or too large for their source space stay as text. Inline expressions must fit on a single terminal row.

For aligned multiline equations, use `align`/`align*` and `&` before the relation. Account for the agent harness's Markdown processing: TeX needs two backslashes for a row break, so emit four backslashes in Markdown prose to leave two in the terminal. For example, emit this outside a code fence:

```text
\begin{align*}
a &= b + c \\\\
d &= e + f
\end{align*}
```

The example above shows the exact Markdown source to emit. In raw terminal output or an actual `.tex` file, use the normal two-backslash TeX separator instead. The plugin reads terminal text literally and does not infer missing row separators.

Markdown also consumes backslashes before punctuation. When those backslashes belong to TeX, double them in Markdown source: for example, emit `\\(` and `\\)` for inline delimiters, `\\[` and `\\]` for display delimiters, and `\\{` for a TeX literal opening brace. Commands such as `\nabla` need no extra slash because the following letter is not Markdown-escapable punctuation. Prefer dollar delimiters when convenient.

Keep math outside code fences and inline backticks when it should render. Use code formatting when discussing literal LaTeX syntax. Avoid a source line containing only `=` because Markdown can consume it as a heading underline.

Follow the user's requested notation and output format; this skill does not require LaTeX when the user wants something else.
