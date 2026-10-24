import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import PanelTitle from "./PanelTitle";

const collapse = (open: boolean) => ({
  open,
  toggle: () => {},
  buttonProps: { type: "button" as const, onClick: () => {}, "aria-expanded": open },
});
const render = (open: boolean) => renderToStaticMarkup(createElement(PanelTitle, { collapse: collapse(open), children: "Piano Roll" }));

describe("PanelTitle", () => {
  it("is the panel's name as a button, lit while the panel is open like the Lyrics button", () => {
    expect(render(true)).toBe(
      '<button type="button" aria-expanded="true" class="analysis-tab analysis-tab--active">Piano Roll</button>',
    );
  });

  it("is plain and says it is folded when the panel is folded down to it", () => {
    expect(render(false)).toBe('<button type="button" aria-expanded="false" class="analysis-tab">Piano Roll</button>');
  });
});
