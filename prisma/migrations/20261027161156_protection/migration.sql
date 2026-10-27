-- AlterTable
ALTER TABLE "PricingPlan" ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'BASE';

-- CreateTable
CREATE TABLE "CloudflareConnection" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "tokenEnc" TEXT NOT NULL,
    "tokenHint" TEXT NOT NULL,
    "cfTokenId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "tokenExpiresAt" TIMESTAMP(3),
    "permissions" JSONB,
    "lastVerifiedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CloudflareConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CloudflareZone" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "cfZoneId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "planCode" TEXT,
    "planName" TEXT,
    "nameServers" JSONB,
    "paused" BOOLEAN NOT NULL DEFAULT false,
    "capabilities" JSONB,
    "observed" JSONB,
    "lastSyncedAt" TIMESTAMP(3),
    "lastSyncError" TEXT,
    "eventCoverage" JSONB,
    "eventsSyncedUntil" TIMESTAMP(3),
    "eventsError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CloudflareZone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProtectionConfiguration" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "zoneRefId" TEXT NOT NULL,
    "feature" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "cfRulesetId" TEXT,
    "cfRuleId" TEXT,
    "previous" JSONB,
    "desired" JSONB,
    "observed" JSONB,
    "verifiedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProtectionConfiguration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProtectionChangeAudit" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "zoneRefId" TEXT,
    "feature" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "result" TEXT NOT NULL,
    "error" TEXT,
    "userId" TEXT,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProtectionChangeAudit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SecurityEvent" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "zoneRefId" TEXT NOT NULL,
    "eventKey" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "action" TEXT NOT NULL,
    "source" TEXT,
    "ruleId" TEXT,
    "country" TEXT,
    "host" TEXT,
    "path" TEXT,
    "method" TEXT,
    "userAgent" TEXT,
    "clientIp" TEXT,
    "rayId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SecurityEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CloudflareConnection_orgId_key" ON "CloudflareConnection"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "CloudflareZone_websiteId_key" ON "CloudflareZone"("websiteId");

-- CreateIndex
CREATE INDEX "CloudflareZone_orgId_idx" ON "CloudflareZone"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "CloudflareZone_orgId_cfZoneId_key" ON "CloudflareZone"("orgId", "cfZoneId");

-- CreateIndex
CREATE INDEX "ProtectionConfiguration_orgId_idx" ON "ProtectionConfiguration"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "ProtectionConfiguration_zoneRefId_feature_key" ON "ProtectionConfiguration"("zoneRefId", "feature");

-- CreateIndex
CREATE INDEX "ProtectionChangeAudit_orgId_createdAt_idx" ON "ProtectionChangeAudit"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX "SecurityEvent_orgId_occurredAt_idx" ON "SecurityEvent"("orgId", "occurredAt");

-- CreateIndex
CREATE INDEX "SecurityEvent_zoneRefId_occurredAt_idx" ON "SecurityEvent"("zoneRefId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "SecurityEvent_zoneRefId_eventKey_key" ON "SecurityEvent"("zoneRefId", "eventKey");

-- AddForeignKey
ALTER TABLE "CloudflareConnection" ADD CONSTRAINT "CloudflareConnection_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CloudflareZone" ADD CONSTRAINT "CloudflareZone_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CloudflareZone" ADD CONSTRAINT "CloudflareZone_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "CloudflareConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CloudflareZone" ADD CONSTRAINT "CloudflareZone_websiteId_fkey" FOREIGN KEY ("websiteId") REFERENCES "Website"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProtectionConfiguration" ADD CONSTRAINT "ProtectionConfiguration_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProtectionConfiguration" ADD CONSTRAINT "ProtectionConfiguration_zoneRefId_fkey" FOREIGN KEY ("zoneRefId") REFERENCES "CloudflareZone"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProtectionChangeAudit" ADD CONSTRAINT "ProtectionChangeAudit_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProtectionChangeAudit" ADD CONSTRAINT "ProtectionChangeAudit_zoneRefId_fkey" FOREIGN KEY ("zoneRefId") REFERENCES "CloudflareZone"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SecurityEvent" ADD CONSTRAINT "SecurityEvent_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SecurityEvent" ADD CONSTRAINT "SecurityEvent_zoneRefId_fkey" FOREIGN KEY ("zoneRefId") REFERENCES "CloudflareZone"("id") ON DELETE CASCADE ON UPDATE CASCADE;
