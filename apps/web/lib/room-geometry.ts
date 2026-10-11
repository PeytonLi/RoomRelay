import { z } from "zod";
import { validateRoom } from "@roomrelay/spatial";
import type { RoomGeometry } from "@roomrelay/spatial";

const point = z.array(z.number().finite()).length(2);
const polygon = z.array(point).min(3);

export const roomGeometrySchema = z.object({
  schemaVersion: z.literal(1),
  units: z.literal("m"),
  frameId: z.string().optional(),
  boundaryXZ: polygon.min(3).max(12),
  ceilingHeightM: z.number().finite().nullable(),
  doors: z.array(
    z.object({
      id: z.string().min(1),
      openingXZ: z.array(point).length(2),
      swingPolygonXZ: z.array(point),
      confirmed: z.boolean(),
    }).passthrough(),
  ),
  obstacles: z.array(
    z.object({
      id: z.string().min(1),
      label: z.string(),
      footprintXZ: polygon,
      heightM: z.number().finite().nullable().optional(),
    }).passthrough(),
  ).max(20),
  captureToRoomMatrix: z.array(z.number().finite()).length(16).nullable().optional(),
  measurementRevision: z.number().int().positive(),
}).passthrough();

export function parseRoomGeometry(value: unknown): RoomGeometry {
  const parsed = roomGeometrySchema.parse(value);
  return validateRoom(parsed) as RoomGeometry;
}
