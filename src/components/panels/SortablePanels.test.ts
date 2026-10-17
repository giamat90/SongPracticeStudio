import { describe, it, expect, beforeEach } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createPanelStore } from "@giamat90/mps-core/panels";
import SortablePanels, { MoveGrip } from "./SortablePanels";

const PANELS = [
  { id: "a", label: "Alpha", defaultVisible: true },
  { id: "b", label: "Beta", defaultVisible: true },
  { id: "c", label: "Gamma", defaultVisible: true },
] as const;

type Id = (typeof PANELS)[number]["id"];

const make = () => createPanelStore({ storageKey: "sortable_test", panels: PANELS });

beforeEach(() => localStorage.clear());

describe("SortablePanels", () => {
  const render = (ids: Id[], className?: (id: Id) => string | undefined) =>
    renderToStaticMarkup(
      createElement(SortablePanels<Id>, {
        store: make(),
        ids,
        className,
        children: (id: Id) => createElement("p", { "data-panel": id }, createElement(MoveGrip)),
      }),
    );
  const order = (html: string) => [...html.matchAll(/data-panel="(\w+)"/g)].map((m) => m[1]);

  it("draws the panels in the order it is given, each in its own slot", () => {
    const html = render(["c", "a", "b"]);
    expect(order(html)).toEqual(["c", "a", "b"]);
    expect(html.match(/class="sortable-panel/g)).toHaveLength(3);
  });

  it("draws nothing for panels that are not on screen", () => {
    expect(order(render(["b"]))).toEqual(["b"]);
    expect(render([])).not.toContain("sortable-panel");
  });

  it("gives each slot the class the page asked for", () => {
    const html = render(["a", "b"], (id) => (id === "a" ? "page__alpha" : undefined));
    expect(html).toContain("sortable-panel page__alpha");
    expect(html.match(/page__alpha/g)).toHaveLength(1);
  });

  it("puts a labelled move grip, reachable by keyboard, in every slot", () => {
    const html = render(["a", "b"]);
    expect(html.match(/detach-handle__move/g)).toHaveLength(2);
    expect(html).toContain('aria-label="Move this panel"');
    expect(html).toContain('tabindex="0"');
  });

  it("has no grip outside a sortable list", () => {
    expect(renderToStaticMarkup(createElement(MoveGrip))).toBe("");
  });
});
