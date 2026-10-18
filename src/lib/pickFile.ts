import { open } from "@tauri-apps/plugin-dialog";
import type { PickFile } from "@giamat90/mps-core/hooks";

export const pickFile: PickFile = async (filter) => {
  const selected = await open({ multiple: false, filters: [filter] });
  return typeof selected === "string" ? selected : null;
};
