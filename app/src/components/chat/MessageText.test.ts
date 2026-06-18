import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageText, MESSAGE_TEXT_CLASS } from "./MessageText";

// Feature 1 (rendering bug): a multi-line coach reply must RENDER as multiple
// lines, not collapse into one wall of text. The fix is `white-space: pre-wrap`
// (the `whitespace-pre-wrap` Tailwind class) on the bubble text. We render the
// component to static HTML (react-dom/server — already a dependency, no new dep)
// and assert both the class and that the embedded "\n" is preserved verbatim in
// the DOM text (the browser then renders it as a visible line break). Uses
// createElement (not JSX) so the test lives in a .test.ts matched by vitest.

describe("MessageText — renders line breaks (Feature 1)", () => {
  it("carries the whitespace-pre-wrap class so \\n becomes a visible line break", () => {
    const html = renderToStaticMarkup(
      createElement(MessageText, { content: "一行目\n二行目\n三行目" }),
    );
    expect(html).toContain("whitespace-pre-wrap");
    expect(MESSAGE_TEXT_CLASS).toContain("whitespace-pre-wrap");
  });

  it("preserves the newlines in the rendered text (not collapsed away)", () => {
    const html = renderToStaticMarkup(
      createElement(MessageText, { content: "一行目\n二行目" }),
    );
    // The raw newline survives into the markup text content (pre-wrap renders it).
    expect(html).toContain("一行目\n二行目");
    // And it is a real multi-line string, not one collapsed line.
    expect(html).toMatch(/一行目[\s\S]*\n[\s\S]*二行目/);
  });
});
