// Shapes that cross the IPC boundary and are not Rust-derived; scripts/ipc-types.json maps command types onto them.

export interface ZipExportEntry {
  path: string;
  archiveName: string;
}

export interface MixSource {
  path: string;
  gain: number;
  isTake: boolean;
  startPosition?: number;
  audioOffset?: number;
  manualOffset?: number;
}
