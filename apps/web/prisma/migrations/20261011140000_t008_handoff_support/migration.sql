-- T-008: order handoff, support cases and order notes.

CREATE TYPE "HandoffState" AS ENUM ('UNSCHEDULED', 'SCHEDULED', 'READY', 'BUYER_ACKNOWLEDGED', 'SELLER_ACKNOWLEDGED', 'COMPLETED', 'ISSUE_OPEN');

CREATE TYPE "SupportCaseReason" AS ENUM ('UNAVAILABLE', 'DAMAGED', 'MISSING', 'OTHER');

CREATE TYPE "SupportCaseStatus" AS ENUM ('OPEN', 'RESOLVED');

CREATE TABLE "handoffs" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "state" "HandoffState" NOT NULL DEFAULT 'SCHEDULED',
    "pickup_slot_start" TIMESTAMP(3) NOT NULL,
    "pickup_slot_end" TIMESTAMP(3) NOT NULL,
    "buyer_acknowledged_at" TIMESTAMP(3),
    "seller_acknowledged_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "handoffs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "support_cases" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "opened_by_id" TEXT NOT NULL,
    "opened_by_role" TEXT NOT NULL,
    "reason" "SupportCaseReason" NOT NULL,
    "affected_item_ids" TEXT[] NOT NULL,
    "description" TEXT NOT NULL,
    "status" "SupportCaseStatus" NOT NULL DEFAULT 'OPEN',
    "resolution_note" TEXT,
    "resolved_by_id" TEXT,
    "resolved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_cases_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "order_notes" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "author_id" TEXT NOT NULL,
    "author_role" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_notes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "handoffs_order_id_key" ON "handoffs"("order_id");
CREATE INDEX "support_cases_order_id_idx" ON "support_cases"("order_id");
CREATE INDEX "order_notes_order_id_idx" ON "order_notes"("order_id");

ALTER TABLE "handoffs" ADD CONSTRAINT "handoffs_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "payment_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "support_cases" ADD CONSTRAINT "support_cases_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "payment_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "order_notes" ADD CONSTRAINT "order_notes_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "payment_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Order notes are fully immutable once written (same pattern as T-004 revisions).
CREATE TRIGGER order_notes_immutable_update
BEFORE UPDATE ON "order_notes"
FOR EACH ROW EXECUTE FUNCTION reject_immutable_revision_update();

-- Support cases: only status/resolution fields may change after creation.
CREATE FUNCTION reject_support_case_content_update() RETURNS trigger AS $$
BEGIN
    IF OLD.order_id IS DISTINCT FROM NEW.order_id
       OR OLD.opened_by_id IS DISTINCT FROM NEW.opened_by_id
       OR OLD.opened_by_role IS DISTINCT FROM NEW.opened_by_role
       OR OLD.reason IS DISTINCT FROM NEW.reason
       OR OLD.affected_item_ids IS DISTINCT FROM NEW.affected_item_ids
       OR OLD.description IS DISTINCT FROM NEW.description
       OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
        RAISE EXCEPTION 'immutable revision';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER support_cases_immutable_content
BEFORE UPDATE ON "support_cases"
FOR EACH ROW EXECUTE FUNCTION reject_support_case_content_update();
