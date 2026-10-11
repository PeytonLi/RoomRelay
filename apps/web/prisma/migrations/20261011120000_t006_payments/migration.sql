-- CreateEnum
CREATE TYPE "QuoteStatus" AS ENUM ('REQUESTED', 'SELLER_APPROVED', 'BUYER_APPROVED', 'SUPERSEDED', 'EXPIRED', 'REJECTED');

-- CreateEnum
CREATE TYPE "InventoryState" AS ENUM ('AVAILABLE', 'HELD', 'PAYMENT_PENDING', 'SOLD');

-- CreateEnum
CREATE TYPE "HoldState" AS ENUM ('ACTIVE', 'CAPTURE_PENDING', 'CONSUMED', 'RELEASED', 'EXPIRED', 'EXCEPTION');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('CREATED', 'PROVIDER_CREATED', 'APPROVED', 'CAPTURE_SUBMITTING', 'PENDING', 'RECONCILING', 'PAID', 'CANCELED', 'EXPIRED', 'FAILED', 'PARTIALLY_REFUNDED', 'REFUNDED', 'REVERSED', 'EXCEPTION');

-- CreateEnum
CREATE TYPE "PaymentOperationType" AS ENUM ('CREATE', 'CAPTURE');

-- CreateEnum
CREATE TYPE "OperationStatus" AS ENUM ('STAGED', 'SUBMITTED', 'UNKNOWN', 'PENDING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "RefundStatus" AS ENUM ('STAGED', 'SUBMITTED', 'PENDING', 'COMPLETED', 'FAILED', 'RECONCILING');

-- CreateEnum
CREATE TYPE "WebhookProcessingState" AS ENUM ('RECEIVED', 'PROCESSED', 'IGNORED', 'FAILED');

-- CreateTable
CREATE TABLE "quotes" (
    "id" TEXT NOT NULL,
    "buyer_id" TEXT NOT NULL,
    "seller_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "previous_quote_id" TEXT,
    "status" "QuoteStatus" NOT NULL DEFAULT 'REQUESTED',
    "environment" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "subtotal_cents" INTEGER NOT NULL,
    "discount_cents" INTEGER NOT NULL DEFAULT 0,
    "total_cents" INTEGER NOT NULL,
    "room_id" TEXT,
    "room_revision" INTEGER,
    "layout_revision_id" TEXT,
    "pickup_slot_start" TIMESTAMP(3) NOT NULL,
    "pickup_slot_end" TIMESTAMP(3) NOT NULL,
    "terms_version" TEXT NOT NULL,
    "acknowledged_warnings" JSONB,
    "content_hash" TEXT NOT NULL,
    "seller_approved_at" TIMESTAMP(3),
    "buyer_approved_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "quotes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quote_lines" (
    "id" TEXT NOT NULL,
    "quote_id" TEXT NOT NULL,
    "item_id" TEXT NOT NULL,
    "item_updated_at" TIMESTAMP(3) NOT NULL,
    "title" TEXT NOT NULL,
    "width_m" DECIMAL(7,4),
    "depth_m" DECIMAL(7,4),
    "height_m" DECIMAL(7,4),
    "condition_disclosure" TEXT,
    "price_cents" INTEGER NOT NULL,

    CONSTRAINT "quote_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "item_inventory" (
    "item_id" TEXT NOT NULL,
    "state" "InventoryState" NOT NULL DEFAULT 'AVAILABLE',
    "hold_id" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "item_inventory_pkey" PRIMARY KEY ("item_id")
);

-- CreateTable
CREATE TABLE "inventory_holds" (
    "id" TEXT NOT NULL,
    "quote_id" TEXT NOT NULL,
    "buyer_id" TEXT NOT NULL,
    "state" "HoldState" NOT NULL DEFAULT 'ACTIVE',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "active_quote_lock" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "released_at" TIMESTAMP(3),

    CONSTRAINT "inventory_holds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_hold_items" (
    "hold_id" TEXT NOT NULL,
    "item_id" TEXT NOT NULL,

    CONSTRAINT "inventory_hold_items_pkey" PRIMARY KEY ("hold_id","item_id")
);

-- CreateTable
CREATE TABLE "payment_orders" (
    "id" TEXT NOT NULL,
    "hold_id" TEXT NOT NULL,
    "quote_id" TEXT NOT NULL,
    "buyer_id" TEXT NOT NULL,
    "seller_id" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "amount_cents" INTEGER NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'CREATED',
    "provider_order_id" TEXT,
    "approve_url" TEXT,
    "provider_capture_id" TEXT,
    "captured_cents" INTEGER NOT NULL DEFAULT 0,
    "refunded_cents" INTEGER NOT NULL DEFAULT 0,
    "cancel_requested_at" TIMESTAMP(3),
    "paid_at" TIMESTAMP(3),
    "operator_attention" BOOLEAN NOT NULL DEFAULT false,
    "exception_reason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_operations" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "type" "PaymentOperationType" NOT NULL,
    "request_id" TEXT NOT NULL,
    "status" "OperationStatus" NOT NULL DEFAULT 'STAGED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3),
    "provider_ref" TEXT,
    "debug_id" TEXT,
    "last_error_code" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_operations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_events" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "from_status" "PaymentStatus",
    "to_status" "PaymentStatus",
    "kind" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "detail" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refunds" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "capture_id" TEXT NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "request_id" TEXT NOT NULL,
    "request_key" TEXT NOT NULL,
    "provider_refund_id" TEXT,
    "status" "RefundStatus" NOT NULL DEFAULT 'STAGED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3),
    "debug_id" TEXT,
    "last_error_code" TEXT,
    "initiator_id" TEXT NOT NULL,
    "initiator_role" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "refunds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "paypal_webhook_events" (
    "id" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "provider_event_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "resource_type" TEXT,
    "resource_id" TEXT,
    "related_order_id" TEXT,
    "payload_sha256" TEXT NOT NULL,
    "minimal" JSONB NOT NULL,
    "verification_status" TEXT NOT NULL,
    "processing_state" "WebhookProcessingState" NOT NULL DEFAULT 'RECEIVED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMP(3),

    CONSTRAINT "paypal_webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "quotes_previous_quote_id_key" ON "quotes"("previous_quote_id");

-- CreateIndex
CREATE INDEX "quotes_buyer_id_status_idx" ON "quotes"("buyer_id", "status");

-- CreateIndex
CREATE INDEX "quotes_seller_id_status_idx" ON "quotes"("seller_id", "status");

-- CreateIndex
CREATE INDEX "quote_lines_item_id_idx" ON "quote_lines"("item_id");

-- CreateIndex
CREATE UNIQUE INDEX "quote_lines_quote_id_item_id_key" ON "quote_lines"("quote_id", "item_id");

-- CreateIndex
CREATE INDEX "item_inventory_hold_id_idx" ON "item_inventory"("hold_id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_holds_active_quote_lock_key" ON "inventory_holds"("active_quote_lock");

-- CreateIndex
CREATE INDEX "inventory_holds_state_expires_at_idx" ON "inventory_holds"("state", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_holds_buyer_id_idempotency_key_key" ON "inventory_holds"("buyer_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "inventory_hold_items_item_id_idx" ON "inventory_hold_items"("item_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_orders_hold_id_key" ON "payment_orders"("hold_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_orders_provider_order_id_key" ON "payment_orders"("provider_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_orders_provider_capture_id_key" ON "payment_orders"("provider_capture_id");

-- CreateIndex
CREATE INDEX "payment_orders_buyer_id_created_at_idx" ON "payment_orders"("buyer_id", "created_at");

-- CreateIndex
CREATE INDEX "payment_orders_seller_id_created_at_idx" ON "payment_orders"("seller_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "payment_operations_request_id_key" ON "payment_operations"("request_id");

-- CreateIndex
CREATE INDEX "payment_operations_status_next_attempt_at_idx" ON "payment_operations"("status", "next_attempt_at");

-- CreateIndex
CREATE UNIQUE INDEX "payment_operations_order_id_type_key" ON "payment_operations"("order_id", "type");

-- CreateIndex
CREATE INDEX "payment_events_order_id_created_at_idx" ON "payment_events"("order_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "refunds_order_id_key" ON "refunds"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX "refunds_request_id_key" ON "refunds"("request_id");

-- CreateIndex
CREATE UNIQUE INDEX "refunds_provider_refund_id_key" ON "refunds"("provider_refund_id");

-- CreateIndex
CREATE INDEX "paypal_webhook_events_processing_state_received_at_idx" ON "paypal_webhook_events"("processing_state", "received_at");

-- CreateIndex
CREATE UNIQUE INDEX "paypal_webhook_events_environment_provider_event_id_key" ON "paypal_webhook_events"("environment", "provider_event_id");

-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_previous_quote_id_fkey" FOREIGN KEY ("previous_quote_id") REFERENCES "quotes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_lines" ADD CONSTRAINT "quote_lines_quote_id_fkey" FOREIGN KEY ("quote_id") REFERENCES "quotes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_lines" ADD CONSTRAINT "quote_lines_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_inventory" ADD CONSTRAINT "item_inventory_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_inventory" ADD CONSTRAINT "item_inventory_hold_id_fkey" FOREIGN KEY ("hold_id") REFERENCES "inventory_holds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_holds" ADD CONSTRAINT "inventory_holds_quote_id_fkey" FOREIGN KEY ("quote_id") REFERENCES "quotes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_hold_items" ADD CONSTRAINT "inventory_hold_items_hold_id_fkey" FOREIGN KEY ("hold_id") REFERENCES "inventory_holds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_hold_items" ADD CONSTRAINT "inventory_hold_items_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_orders" ADD CONSTRAINT "payment_orders_hold_id_fkey" FOREIGN KEY ("hold_id") REFERENCES "inventory_holds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_orders" ADD CONSTRAINT "payment_orders_quote_id_fkey" FOREIGN KEY ("quote_id") REFERENCES "quotes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_operations" ADD CONSTRAINT "payment_operations_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "payment_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "payment_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "payment_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "quotes"
  ADD CONSTRAINT "quotes_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "rooms"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "quotes_money_check" CHECK ("subtotal_cents" >= 0 AND "discount_cents" >= 0 AND "total_cents" = "subtotal_cents" - "discount_cents"),
  ADD CONSTRAINT "quotes_approved_total_check" CHECK ("status" NOT IN ('SELLER_APPROVED', 'BUYER_APPROVED') OR "total_cents" > 0);
ALTER TABLE "quote_lines" ADD CONSTRAINT "quote_lines_price_check" CHECK ("price_cents" > 0);
ALTER TABLE "item_inventory"
  ALTER COLUMN "updated_at" SET DEFAULT CURRENT_TIMESTAMP,
  ADD CONSTRAINT "item_inventory_state_hold_check" CHECK (
    ("state" = 'AVAILABLE' AND "hold_id" IS NULL) OR
    ("state" <> 'AVAILABLE' AND "hold_id" IS NOT NULL)
  );
ALTER TABLE "payment_orders" ADD CONSTRAINT "payment_orders_amounts_check"
  CHECK ("amount_cents" > 0 AND "captured_cents" >= 0 AND "refunded_cents" >= 0 AND "refunded_cents" <= "captured_cents");
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_amount_check" CHECK ("amount_cents" > 0);
