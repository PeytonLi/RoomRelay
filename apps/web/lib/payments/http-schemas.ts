import { z } from "zod";

const id = z.string().trim().min(1).max(128);

export const quoteBody = z.object({
  sellerId: id,
  lines: z.array(z.object({
    itemId: id,
    priceCents: z.number().int().positive().safe(),
  }).strict()).min(1).max(50),
  discountCents: z.number().int().nonnegative().safe().default(0),
  pickupSlot: z.object({
    start: z.string().datetime(),
    end: z.string().datetime(),
  }).strict(),
  roomId: id.optional(),
  layoutRevisionId: id.optional(),
  termsVersion: z.string().trim().min(1).max(64),
}).strict();

export const sellerApprovalBody = z.object({
  contentHash: z.string().length(64).regex(/^[a-f0-9]+$/),
}).strict();

export const buyerApprovalBody = z.object({
  contentHash: z.string().length(64).regex(/^[a-f0-9]+$/),
  acknowledgedWarnings: z.array(z.string().max(128)).max(50).optional(),
}).strict();

export const checkoutBody = z.object({
  quoteId: id,
  idempotencyKey: z.string().trim().min(1).max(200),
}).strict();

export const emptyBody = z.object({}).strict();

export const providerOrderBody = z.object({
  providerOrderId: id,
}).strict();

export const refundBody = z.object({
  requestKey: z.string().trim().min(1).max(200),
  reason: z.string().trim().min(1).max(255),
}).strict();
