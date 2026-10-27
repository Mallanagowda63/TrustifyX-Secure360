-- CreateTable
CREATE TABLE "BackupStatus" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "frequency" TEXT NOT NULL,
    "storage" TEXT NOT NULL,
    "includesFiles" BOOLEAN,
    "includesDatabase" BOOLEAN,
    "encrypted" BOOLEAN,
    "retentionDays" INTEGER,
    "lastBackupAt" TIMESTAMP(3),
    "source" TEXT NOT NULL DEFAULT 'CUSTOMER_REPORTED',
    "notes" TEXT,
    "updatedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BackupStatus_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RestoreTest" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "testedAt" TIMESTAMP(3) NOT NULL,
    "result" TEXT NOT NULL,
    "durationMinutes" INTEGER,
    "notes" TEXT,
    "recordedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RestoreTest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BackupStatus_websiteId_key" ON "BackupStatus"("websiteId");

-- CreateIndex
CREATE INDEX "BackupStatus_orgId_idx" ON "BackupStatus"("orgId");

-- CreateIndex
CREATE INDEX "RestoreTest_orgId_testedAt_idx" ON "RestoreTest"("orgId", "testedAt");

-- CreateIndex
CREATE INDEX "RestoreTest_websiteId_testedAt_idx" ON "RestoreTest"("websiteId", "testedAt");

-- AddForeignKey
ALTER TABLE "BackupStatus" ADD CONSTRAINT "BackupStatus_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BackupStatus" ADD CONSTRAINT "BackupStatus_websiteId_fkey" FOREIGN KEY ("websiteId") REFERENCES "Website"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RestoreTest" ADD CONSTRAINT "RestoreTest_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RestoreTest" ADD CONSTRAINT "RestoreTest_websiteId_fkey" FOREIGN KEY ("websiteId") REFERENCES "Website"("id") ON DELETE CASCADE ON UPDATE CASCADE;
