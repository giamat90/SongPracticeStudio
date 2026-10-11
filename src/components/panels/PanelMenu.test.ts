import { describe, it, expect, beforeEach } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createPanelStore } from "@giamat90/mps-core/panels";
import PanelMenu, { PanelMenuList } from "./PanelMenu";

const PANELS = [
  { id: "a", label: "Alpha", defaultVisible: true },
  { id: "b", label: "Beta", defaultVisible: false },
] as const;

const listProps = (extra: object = {}) => ({
  panels: PANELS,
  visible: { a: true, b: false },
  onToggle: () => {},
  onShowAll: () => {},
  onHideAll: () => {},
  onReset: () => {},
  ...extra,
});

describe("PanelMenuList", () => {
  it("has one labelled checkbox per panel, checked as visible", () => {
    const html = renderToStaticMarkup(createElement(PanelMenuList, listProps()));
    expect(html).toContain("Alpha");
    expect(html).toContain("Beta");
    expect(html.match(/<input type="checkbox"/g)).toHaveLength(2);
    expect(html.match(/checked=""/g)).toHaveLength(1);
    expect(html.indexOf('checked=""')).toBeLessThan(html.indexOf("Beta"));
  });

  it("marks the panels that are in a window of their own", () => {
    const html = renderToStaticMarkup(createElement(PanelMenuList, listProps({ detached: { a: true } })));
    expect(html.match(/panel-menu__tag/g)).toHaveLength(1);
    expect(html.indexOf("panel-menu__tag")).toBeGreaterThan(html.indexOf("Alpha"));
    expect(html.indexOf("panel-menu__tag")).toBeLessThan(html.indexOf("Beta"));
  });

  it("marks nothing when nothing is detached", () => {
    expect(renderToStaticMarkup(createElement(PanelMenuList, listProps()))).not.toContain("panel-menu__tag");
  });

  it("offers show all, hide all and reset", () => {
    const html = renderToStaticMarkup(createElement(PanelMenuList, listProps()));
    for (const label of ["Show all", "Hide all", "Reset"]) expect(html).toContain(label);
  });

  it("wraps the checkboxes in a labelled group for assistive technology", () => {
    const html = renderToStaticMarkup(createElement(PanelMenuList, listProps()));
    expect(html).toContain('role="group"');
    expect(html).toContain('aria-label="Visible panels"');
  });
});

describe("PanelMenu", () => {
  beforeEach(() => localStorage.clear());
  const make = () => createPanelStore({ storageKey: "menu_test", panels: PANELS });
  const text = (html: string) => html.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, "");

  it("starts closed, showing how many panels are on", () => {
    const html = renderToStaticMarkup(createElement(PanelMenu<"a" | "b">, { store: make(), panels: PANELS }));
    expect(html).toContain('aria-expanded="false"');
    expect(text(html)).toBe("Panels 1/2");
    expect(html).not.toContain("Alpha");
  });

  it("counts only the panels it is given", () => {
    const html = renderToStaticMarkup(createElement(PanelMenu<"a" | "b">, { store: make(), panels: [PANELS[1]] }));
    expect(text(html)).toBe("Panels 0/1");
  });

  it("reflects what the user chose earlier", () => {
    localStorage.setItem("menu_test", JSON.stringify({ overrides: { b: true } }));
    const store = make();
    const html = renderToStaticMarkup(createElement(PanelMenu<"a" | "b">, { store, panels: PANELS }));
    expect(text(html)).toBe("Panels 2/2");
  });
});
