import { describe, expect, it } from "vitest";
import { parseEnqueueArgs } from "./enqueue";

describe("parseEnqueueArgs", () => {
  it("parses valid enqueue arguments and maps units/evidence", () => {
    expect(parseEnqueueArgs([
      "--object-key", "models/chair.glb",
      "--subject-id", "chair-1",
      "--provenance", "SCANNED_ACTUAL",
      "--subject-type", "item",
      "--version", "2",
      "--units", "cm",
      "--evidence-ref", "scan:123",
    ])).toEqual({
      subject: { type: "item", id: "chair-1", version: 2 },
      inputRef: {
        objectKey: "models/chair.glb",
        provenance: "SCANNED_ACTUAL",
        sourceUnits: "cm",
        evidenceRef: "scan:123",
      },
    });
  });

  it("defaults the subject type and version", () => {
    expect(parseEnqueueArgs([
      "--object-key", "models/chair.glb",
      "--subject-id", "chair-1",
      "--provenance", "SCANNED_ACTUAL",
    ])).toMatchObject({
      subject: { type: "asset", id: "chair-1", version: 1 },
    });
  });

  it("requires the object key, subject id, and provenance", () => {
    expect(() => parseEnqueueArgs([
      "--object-key", "models/chair.glb",
      "--provenance", "SCANNED_ACTUAL",
    ])).toThrow("--subject-id is required");
  });

  it("rejects non-positive or non-integer versions", () => {
    expect(() => parseEnqueueArgs([
      "--object-key", "models/chair.glb",
      "--subject-id", "chair-1",
      "--provenance", "SCANNED_ACTUAL",
      "--version", "1.5",
    ])).toThrow("--version must be a positive integer");
  });

  it("rejects unsupported provenance values with a clear message", () => {
    expect(() => parseEnqueueArgs([
      "--object-key", "models/chair.glb",
      "--subject-id", "chair-1",
      "--provenance", "NOT_A_PROVENANCE",
    ])).toThrow("Invalid asset validation input");
  });
});
