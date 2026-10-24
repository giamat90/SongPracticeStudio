import { describe, it, expect, beforeEach } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import SortableTopbar from "./SortableTopbar";
import { useTopbarOrder } from "../../stores/topbar";

beforeEach(() => {
  localStorage.clear();
  useTopbarOrder.getState().resetOrder();
});

const render = (ids: Parameters<typeof SortableTopbar>[0]["ids"]) =>
  renderToStaticMarkup(createElement(SortableTopbar, { ids, children: (id) => createElement("p", { "data-card": id }) }));
const cards = (html: string) => [...html.matchAll(/data-card="(\w+)"/g)].map((m) => m[1]);

describe("SortableTopbar", () => {
  it("draws the cards in the order it is given, in one wrapping bar, each a labelled group", () => {
    const html = render(["loop", "transport"]);
    expect(cards(html)).toEqual(["loop", "transport"]);
    expect(html.match(/analyzer-page__topbar/g)).toHaveLength(1);
    expect(html).toContain('aria-label="Loop"');
    expect(html).toContain('aria-label="Transport"');
  });

  it("puts a labelled grip, reachable by keyboard, on every card, and says anywhere in the bar, not up or down the page", () => {
    const html = render(["devices", "transpose"]);
    expect(html.match(/class="topbar-grip"/g)).toHaveLength(2);
    expect(html).toContain('aria-label="Move the Input and output card"');
    expect(html).toContain("anywhere in this bar");
    expect(html).not.toContain("detach-handle");
    expect(html).not.toContain("up or down");
  });

  it("draws no card, and no grip, for a card with nothing to show", () => {
    const html = renderToStaticMarkup(
      createElement(SortableTopbar, { ids: ["loop", "chords", "tempo"], children: (id) => (id === "chords" ? null : createElement("p", { "data-card": id })) }),
    );
    expect(cards(html)).toEqual(["loop", "tempo"]);
    expect(html.match(/class="topbar-grip"/g)).toHaveLength(2);
    expect(html).not.toContain('aria-label="Chords"');
  });
});
