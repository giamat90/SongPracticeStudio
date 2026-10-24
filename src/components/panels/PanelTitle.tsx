import type { ReactNode } from "react";
import type { CollapsiblePanel } from "@giamat90/mps-core/hooks";

interface PanelTitleProps {
  collapse: CollapsiblePanel;
  children: ReactNode;
}

/** A panel's name, as the button that folds the panel down to it and opens it again (the Lyrics panel's button). */
function PanelTitle({ collapse, children }: PanelTitleProps) {
  return (
    <button {...collapse.buttonProps} className={`analysis-tab${collapse.open ? " analysis-tab--active" : ""}`}>
      {children}
    </button>
  );
}

export default PanelTitle;
