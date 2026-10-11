import { describe, expect, it } from "vitest";
import { parseRoomGeometry } from "./room-geometry";

const room = {
  schemaVersion: 1,
  units: "m",
  boundaryXZ: [[0, 0], [3, 0], [3, 4], [0, 4]],
  ceilingHeightM: 2.4,
  doors: [],
  obstacles: [],
  measurementRevision: 1,
};

describe("room geometry schema", () => {
  it("rejects more than twelve boundary vertices", () => {
    expect(() => parseRoomGeometry({ ...room, boundaryXZ: [...room.boundaryXZ, [1, 1], [1.1, 1], [1.2, 1], [1.3, 1], [1.4, 1], [1.5, 1], [1.6, 1], [1.7, 1], [1.8, 1]] })).toThrow();
  });

  it("rejects non-finite coordinates", () => {
    expect(() => parseRoomGeometry({ ...room, boundaryXZ: [[0, 0], [3, 0], [3, Number.NaN], [0, 4]] })).toThrow();
  });
});
