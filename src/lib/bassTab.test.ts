import { describe, it, expect } from "vitest";
import {
  bassTabToMidi, visibleNotes, tabWindowStart, tabTimeToX, tabXToTime, TAB_WINDOW_SECONDS, type BassNote,
} from "./bassTab";

const note = (time: number, duration: number, pitch: number, string = 0, fret = 0): BassNote => ({
  time, duration, pitch, string, fret,
});

function readVlq(bytes: Uint8Array, at: number): [number, number] {
  let value = 0;
  let i = at;
  for (;;) {
    const b = bytes[i++];
    value = (value << 7) | (b & 0x7f);
    if ((b & 0x80) === 0) return [value, i];
  }
}

interface Ev { tick: number; kind: "on" | "off"; pitch: number; velocity: number }

function parse(bytes: Uint8Array) {
  const text = (at: number, n: number) => String.fromCharCode(...bytes.slice(at, at + n));
  const u16 = (at: number) => (bytes[at] << 8) | bytes[at + 1];
  const u32 = (at: number) => ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
  expect(text(0, 4)).toBe("MThd");
  expect(u32(4)).toBe(6);
  const header = { format: u16(8), tracks: u16(10), division: u16(12) };
  expect(text(14, 4)).toBe("MTrk");
  const trackLen = u32(18);
  expect(bytes.length).toBe(22 + trackLen);
  let i = 22;
  let tick = 0;
  let tempo = 0;
  let program = -1;
  let ended = false;
  const events: Ev[] = [];
  while (i < bytes.length) {
    const [delta, next] = readVlq(bytes, i);
    tick += delta;
    i = next;
    const status = bytes[i++];
    if (status === 0xff) {
      const type = bytes[i++];
      const len = bytes[i++];
      if (type === 0x51) tempo = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
      if (type === 0x2f) ended = true;
      i += len;
    } else if (status === 0xc0) {
      program = bytes[i++];
    } else if ((status & 0xf0) === 0x90) {
      const velocity = bytes[i + 1];
      events.push({ tick, kind: velocity === 0 ? "off" : "on", pitch: bytes[i], velocity });
      i += 2;
    } else if ((status & 0xf0) === 0x80) {
      events.push({ tick, kind: "off", pitch: bytes[i], velocity: bytes[i + 1] });
      i += 2;
    } else {
      throw new Error(`unexpected status ${status}`);
    }
  }
  return { header, tempo, program, ended, events };
}

describe("bassTabToMidi", () => {
  it("writes a format 0 file with one track, 480 ticks per beat and the tempo", () => {
    const m = parse(bassTabToMidi([note(0, 0.5, 40)], 120));
    expect(m.header).toEqual({ format: 0, tracks: 1, division: 480 });
    expect(m.tempo).toBe(500000);
    expect(m.program).toBe(33);
    expect(m.ended).toBe(true);
  });

  it("places each note on the tick that matches its time at the tempo", () => {
    const m = parse(bassTabToMidi([note(0.5, 0.25, 43), note(1, 0.5, 40)], 120));
    expect(m.events).toEqual([
      { tick: 480, kind: "on", pitch: 43, velocity: 96 },
      { tick: 720, kind: "off", pitch: 43, velocity: 0 },
      { tick: 960, kind: "on", pitch: 40, velocity: 96 },
      { tick: 1440, kind: "off", pitch: 40, velocity: 0 },
    ]);
  });

  it("ends a note before the next one of the same pitch starts", () => {
    const m = parse(bassTabToMidi([note(0, 0.5, 40), note(0.5, 0.5, 40)], 120));
    expect(m.events.map((e) => `${e.tick}:${e.kind}`)).toEqual(["0:on", "480:off", "480:on", "960:off"]);
  });

  it("uses 120 BPM when the tempo is unknown and keeps notes sorted by time", () => {
    const m = parse(bassTabToMidi([note(1, 0.5, 45), note(0, 0.5, 40)], 0));
    expect(m.tempo).toBe(500000);
    expect(m.events[0].pitch).toBe(40);
  });

  it("keeps pitches inside the MIDI range and skips empty notes", () => {
    const m = parse(bassTabToMidi([note(0, 0.5, 300), note(1, 0, 40)], 120));
    expect(m.events.filter((e) => e.kind === "on").map((e) => e.pitch)).toEqual([127]);
  });

  it("is a valid empty file for no notes", () => {
    const m = parse(bassTabToMidi([], 100));
    expect(m.events).toEqual([]);
    expect(m.ended).toBe(true);
  });
});

describe("visibleNotes", () => {
  const notes = [note(0, 1, 40), note(5, 1, 41), note(9, 2, 42), note(30, 1, 43)];

  it("returns the notes that overlap the window", () => {
    expect(visibleNotes(notes, 4, 10).map((n) => n.pitch)).toEqual([41, 42]);
  });

  it("includes a note that started before the window but still sounds in it", () => {
    expect(visibleNotes(notes, 0.5, 2).map((n) => n.pitch)).toEqual([40]);
  });

  it("is empty past the last note", () => {
    expect(visibleNotes(notes, 40, 50)).toEqual([]);
  });
});

describe("tab window", () => {
  it("keeps the playhead a quarter of the way in", () => {
    const start = tabWindowStart(10);
    expect(tabTimeToX(10, start, 600)).toBeCloseTo(150);
  });

  it("maps a window's whole width onto its seconds, and back", () => {
    expect(tabTimeToX(2 + TAB_WINDOW_SECONDS, 2, 600)).toBeCloseTo(600);
    expect(tabXToTime(tabTimeToX(7.3, 2, 600), 2, 600)).toBeCloseTo(7.3);
  });
});
