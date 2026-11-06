import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const h = vi.hoisted(() => ({
  view: { visible: true, label: "Transposing…", progress: null as number | null, others: 0 },
}));

vi.mock("@giamat90/mps-core/hooks", () => ({ useActivity: () => h.view }));

import ActivityIndicator from "./ActivityIndicator";

const render = () => renderToStaticMarkup(createElement(ActivityIndicator));

describe("ActivityIndicator", () => {
  it("draws nothing while hidden", () => {
    h.view = { visible: false, label: "x", progress: null, others: 0 };
    expect(render()).toBe("");
  });

  it("names the work with an indeterminate bar and a polite status role", () => {
    h.view = { visible: true, label: "Transposing…", progress: null, others: 0 };
    const html = render();
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("Transposing…");
    expect(html).toContain("activity__bar--indeterminate");
    expect(html).not.toContain("activity__percent");
  });

  it("shows a determinate fill and the percentage when progress is known", () => {
    h.view = { visible: true, label: "Exporting…", progress: 0.456, others: 0 };
    const html = render();
    expect(html).toContain("width:46%");
    expect(html).toContain("46%");
    expect(html).not.toContain("activity__bar--indeterminate");
  });

  it("counts the other running tasks", () => {
    h.view = { visible: true, label: "Opening song…", progress: null, others: 2 };
    expect(render()).toContain("+2 more");
  });
});
