-- CreateEnum
CREATE TYPE "ItemProvenance" AS ENUM ('SCANNED_ACTUAL', 'CATALOG_EXACT_MATCH', 'APPROXIMATE_PROXY', 'ILLUSTRATIVE_GENERATED');

-- CreateEnum
CREATE TYPE "ItemStatus" AS ENUM ('DRAFT', 'ACTIVE', 'RESERVED', 'SOLD', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "AssetProcessingStatus" AS ENUM ('UPLOADED', 'QUEUED', 'PROCESSING', 'NEEDS_REVIEW', 'READY', 'FAILED', 'DELETING', 'DELETED');

-- CreateEnum
CREATE TYPE "EvidenceSource" AS ENUM ('USER_CONFIRMED', 'TAPE_MEASURED', 'SCAN_ESTIMATE', 'CATALOG_SPEC');

-- CreateTable
CREATE TABLE "rooms" (
    "id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "geometry" JSONB NOT NULL,
    "measurement_revision" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rooms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "items" (
    "id" TEXT NOT NULL,
    "seller_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "width_m" DECIMAL(7,4),
    "depth_m" DECIMAL(7,4),
    "height_m" DECIMAL(7,4),
    "dims_confirmed_at" TIMESTAMP(3),
    "provenance" "ItemProvenance" NOT NULL,
    "status" "ItemStatus" NOT NULL DEFAULT 'DRAFT',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assets" (
    "id" TEXT NOT NULL,
    "item_id" TEXT,
    "room_id" TEXT,
    "sha256" TEXT NOT NULL,
    "bytes" BIGINT NOT NULL,
    "bounds" JSONB,
    "normalization" JSONB,
    "provenance" "ItemProvenance" NOT NULL,
    "processing_status" "AssetProcessingStatus" NOT NULL DEFAULT 'UPLOADED',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "measurement_evidence" (
    "id" TEXT NOT NULL,
    "subject_type" TEXT NOT NULL,
    "subject_id" TEXT NOT NULL,
    "source" "EvidenceSource" NOT NULL,
    "value" JSONB NOT NULL,
    "actor" TEXT NOT NULL,
    "confirmed_at" TIMESTAMP(3),
    "revision" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "measurement_evidence_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "rooms"("id") ON DELETE SET NULL ON UPDATE CASCADE;
