/*
  Warnings:

  - You are about to drop the column `depth_m` on the `items` table. All the data in the column will be lost.
  - You are about to drop the column `dims_confirmed_at` on the `items` table. All the data in the column will be lost.
  - You are about to drop the column `height_m` on the `items` table. All the data in the column will be lost.
  - You are about to drop the column `provenance` on the `items` table. All the data in the column will be lost.
  - You are about to drop the column `title` on the `items` table. All the data in the column will be lost.
  - You are about to drop the column `width_m` on the `items` table. All the data in the column will be lost.
  - You are about to drop the column `geometry` on the `rooms` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[object_key]` on the table `assets` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `content_type` to the `assets` table without a default value. This is not possible if the table is not empty.
  - Added the required column `kind` to the `assets` table without a default value. This is not possible if the table is not empty.
  - Added the required column `object_key` to the `assets` table without a default value. This is not possible if the table is not empty.
  - Added the required column `owner_id` to the `assets` table without a default value. This is not possible if the table is not empty.
  - Added the required column `name` to the `rooms` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "AssetKind" AS ENUM ('PHOTO', 'MODEL_GLB', 'VIDEO');

-- CreateEnum
CREATE TYPE "AssetVisibility" AS ENUM ('PRIVATE', 'APPROVED_LISTING');

-- CreateEnum
CREATE TYPE "UploadRole" AS ENUM ('CONDITION_PHOTO', 'ITEM_MODEL', 'ROOM_MODEL');

-- CreateEnum
CREATE TYPE "StorageBackend" AS ENUM ('LOCAL_FS', 'S3');

-- CreateEnum
CREATE TYPE "UploadStatus" AS ENUM ('PENDING', 'UPLOADED', 'FINALIZED', 'REJECTED');

-- AlterTable
ALTER TABLE "assets" ADD COLUMN     "content_type" TEXT NOT NULL,
ADD COLUMN     "kind" "AssetKind" NOT NULL,
ADD COLUMN     "object_key" TEXT NOT NULL,
ADD COLUMN     "owner_id" TEXT NOT NULL,
ADD COLUMN     "visibility" "AssetVisibility" NOT NULL DEFAULT 'PRIVATE',
ALTER COLUMN "provenance" DROP NOT NULL;

-- AlterTable
ALTER TABLE "items" DROP COLUMN "depth_m",
DROP COLUMN "dims_confirmed_at",
DROP COLUMN "height_m",
DROP COLUMN "provenance",
DROP COLUMN "title",
DROP COLUMN "width_m",
ADD COLUMN     "current_version" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "published_version" INTEGER,
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "rooms" DROP COLUMN "geometry",
ADD COLUMN     "name" TEXT NOT NULL;

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "auth_subject" TEXT NOT NULL,
    "display_name" TEXT,
    "disabled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "room_revisions" (
    "id" TEXT NOT NULL,
    "room_id" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "geometry" JSONB NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "room_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "listing_versions" (
    "id" TEXT NOT NULL,
    "item_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "category" TEXT,
    "width_m" DECIMAL(7,4) NOT NULL,
    "depth_m" DECIMAL(7,4) NOT NULL,
    "height_m" DECIMAL(7,4) NOT NULL,
    "dims_confirmed" BOOLEAN NOT NULL DEFAULT false,
    "condition_notes" TEXT,
    "condition_photo_asset_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "price_cents" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "pickup_window_start" TIMESTAMP(3) NOT NULL,
    "pickup_window_end" TIMESTAMP(3) NOT NULL,
    "coarse_area" TEXT NOT NULL DEFAULT '',
    "exact_pickup_address" TEXT NOT NULL DEFAULT '',
    "provenance" "ItemProvenance" NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "listing_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "upload_manifests" (
    "id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "role" "UploadRole" NOT NULL,
    "content_type" TEXT NOT NULL,
    "declared_bytes" INTEGER NOT NULL,
    "declared_sha256" TEXT NOT NULL,
    "object_key" TEXT NOT NULL,
    "backend" "StorageBackend" NOT NULL,
    "status" "UploadStatus" NOT NULL DEFAULT 'PENDING',
    "asset_id" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "upload_manifests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "layout_revisions" (
    "id" TEXT NOT NULL,
    "room_id" TEXT NOT NULL,
    "room_revision" INTEGER NOT NULL,
    "parent_id" TEXT,
    "owner_id" TEXT NOT NULL,
    "placements" JSONB NOT NULL,
    "requirements" JSONB NOT NULL,
    "findings" JSONB NOT NULL,
    "fits_provided_measurements" BOOLEAN NOT NULL,
    "total_cents" INTEGER NOT NULL,
    "prefilter_reasons" JSONB NOT NULL,
    "quotable" BOOLEAN NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "layout_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_auth_subject_key" ON "users"("auth_subject");

-- CreateIndex
CREATE UNIQUE INDEX "room_revisions_room_id_revision_key" ON "room_revisions"("room_id", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "listing_versions_item_id_version_key" ON "listing_versions"("item_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "upload_manifests_object_key_key" ON "upload_manifests"("object_key");

-- CreateIndex
CREATE UNIQUE INDEX "upload_manifests_asset_id_key" ON "upload_manifests"("asset_id");

-- CreateIndex
CREATE UNIQUE INDEX "assets_object_key_key" ON "assets"("object_key");

-- AddForeignKey
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room_revisions" ADD CONSTRAINT "room_revisions_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room_revisions" ADD CONSTRAINT "room_revisions_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "items" ADD CONSTRAINT "items_seller_id_fkey" FOREIGN KEY ("seller_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "listing_versions" ADD CONSTRAINT "listing_versions_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "listing_versions" ADD CONSTRAINT "listing_versions_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upload_manifests" ADD CONSTRAINT "upload_manifests_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upload_manifests" ADD CONSTRAINT "upload_manifests_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "layout_revisions" ADD CONSTRAINT "layout_revisions_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "layout_revisions" ADD CONSTRAINT "layout_revisions_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "layout_revisions" ADD CONSTRAINT "layout_revisions_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "layout_revisions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE FUNCTION reject_immutable_revision_update() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'immutable revision';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER room_revisions_immutable_update
BEFORE UPDATE ON "room_revisions"
FOR EACH ROW EXECUTE FUNCTION reject_immutable_revision_update();

CREATE TRIGGER listing_versions_immutable_update
BEFORE UPDATE ON "listing_versions"
FOR EACH ROW EXECUTE FUNCTION reject_immutable_revision_update();

CREATE TRIGGER layout_revisions_immutable_update
BEFORE UPDATE ON "layout_revisions"
FOR EACH ROW EXECUTE FUNCTION reject_immutable_revision_update();
