-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'SUPERSEDED');

-- CreateTable
CREATE TABLE "jobs" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "type" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "subject_type" TEXT NOT NULL,
    "subject_id" TEXT NOT NULL,
    "subject_version" INTEGER NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 3,
    "lease_owner" TEXT,
    "lease_token" TEXT,
    "lease_expires_at" TIMESTAMPTZ(3),
    "run_after" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "input_ref" JSONB,
    "output_ref" JSONB,
    "reason" TEXT,
    "cancel_requested_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(3),

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "jobs_idempotency_key_key" ON "jobs"("idempotency_key");

-- CreateIndex
CREATE INDEX "jobs_status_run_after_idx" ON "jobs"("status", "run_after");

-- CreateIndex
CREATE INDEX "jobs_subject_type_subject_id_subject_version_idx" ON "jobs"("subject_type", "subject_id", "subject_version");
