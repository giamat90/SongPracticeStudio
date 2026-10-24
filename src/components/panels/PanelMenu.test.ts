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

describe("PanelMenuList areas", () => {
  const items = [{ id: "area", label: "Area", parts: [{ id: "p1", label: "Part one" }, { id: "p2", label: "Part two" }] }];
  const fixedProps = (extra: object = {}, visible: Record<string, boolean> = { area: true, p1: true, p2: false }) =>
    listProps({ fixed: { items, visible, onToggle: () => {}, ...extra } });
  const render = (props: object) => renderToStaticMarkup(createElement(PanelMenuList, props as never));

  it("lists the areas above the panels, with their parts indented under them", () => {
    const html = render(fixedProps());
    expect(html.indexOf("Area")).toBeLessThan(html.indexOf("Part one"));
    expect(html.indexOf("Part two")).toBeLessThan(html.indexOf("Alpha"));
    expect(html).toContain("panel-menu__item--part");
    expect(html.match(/<input type="checkbox"/g)).toHaveLength(5);
  });

  it("checks what is visible and unchecks what is not", () => {
    const html = render(fixedProps());
    const state = [...html.matchAll(/<input type="checkbox"([^>]*)\/>/g)].map((m) => m[1].includes("checked"));
    expect(state).toEqual([true, true, false, true, false]);
  });

  it("greys out the parts while their area is off, without forgetting their state", () => {
    const html = render(fixedProps({}, { area: false, p1: true, p2: false }));
    expect(html.match(/disabled=""/g)).toHaveLength(2);
    expect(render(fixedProps())).not.toContain("disabled");
  });

  it("notes why a hidden part may be silent", () => {
    const html = render(fixedProps({ tags: { p2: "muted" } }));
    expect(html.match(/panel-menu__tag/g)).toHaveLength(1);
    expect(html.indexOf("muted")).toBeGreaterThan(html.indexOf("Part two"));
    expect(html.indexOf("muted")).toBeLessThan(html.indexOf("Alpha"));
  });

  it("says the grip moves panels only when they can be moved", () => {
    expect(render(listProps())).toContain("Drag the");
    expect(render(listProps({ movable: false }))).not.toContain("Drag the");
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

describe("PanelMenu with areas", () => {
  beforeEach(() => localStorage.clear());
  const text = (html: string) => html.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, "");
  const panels = [
    { id: "a", label: "Alpha", defaultVisible: true },
    { id: "b", label: "Beta", defaultVisible: false },
  ] as const;
  const store = () => createPanelStore({ storageKey: "menu_main_test", panels });

  it("counts the areas with the panels, and not their tracks", () => {
    const area = createPanelStore({
      storageKey: "menu_area_test",
      panels: [
        { id: "area", label: "Area", defaultVisible: true },
        { id: "p1", label: "Part", defaultVisible: true },
      ],
    });
    const items = [{ id: "area", label: "Area", parts: [{ id: "p1", label: "Part" }] }];
    const html = renderToStaticMarkup(
      createElement(PanelMenu<"a" | "b", "area" | "p1">, { store: store(), panels, fixed: { store: area, items } }),
    );
    expect(text(html)).toBe("Panels 2/3");
  });

  it("drops an area from the count when the user switched it off", () => {
    localStorage.setItem("menu_area_test2", JSON.stringify({ overrides: { area: false } }));
    const area = createPanelStore({
      storageKey: "menu_area_test2",
      panels: [{ id: "area", label: "Area", defaultVisible: true }],
    });
    const html = renderToStaticMarkup(
      createElement(PanelMenu<"a" | "b", "area">, {
        store: store(), panels, fixed: { store: area, items: [{ id: "area", label: "Area" }] },
      }),
    );
    expect(text(html)).toBe("Panels 1/3");
  });
});

describe("PanelMenu words", () => {
  it("says Panels by default and takes its own words for another list, such as the cards of the top bar", () => {
    const store = createPanelStore({ storageKey: "menu_words", panels: PANELS });
    expect(renderToStaticMarkup(createElement(PanelMenu<"a" | "b">, { store, panels: PANELS }))).toContain("Panels 1/2");
    const labels = { button: "Cards", title: "Choose cards", group: "Visible cards", hint: "Drag the grip on a card.", resetTitle: "Every card" };
    const html = renderToStaticMarkup(createElement(PanelMenu<"a" | "b">, { store, panels: PANELS, labels }));
    expect(html).toContain("Cards 1/2");
    expect(html).toContain('title="Choose cards"');
    expect(html).not.toContain("Panels 1/2");
    const list = renderToStaticMarkup(createElement(PanelMenuList, { ...listProps(), labels }));
    expect(list).toContain('aria-label="Visible cards"');
    expect(list).toContain("Drag the grip on a card.");
    expect(list).toContain('title="Every card"');
  });
});
