-- CreateTable
CREATE TABLE "ServerAgent" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "os" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "wazuhAgentId" TEXT,
    "wazuhAgentName" TEXT,
    "keyEnc" TEXT,
    "agentVersion" TEXT,
    "osName" TEXT,
    "lastKeepAlive" TIMESTAMP(3),
    "firstSeenAt" TIMESTAMP(3),
    "lastEventAt" TIMESTAMP(3),
    "eventsSyncedUntil" TIMESTAMP(3),
    "lastSyncError" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServerAgent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServerSecurityEvent" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "agentRefId" TEXT NOT NULL,
    "eventKey" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "ruleId" TEXT,
    "level" INTEGER NOT NULL,
    "severity" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "groups" JSONB NOT NULL,
    "filePath" TEXT,
    "fileEvent" TEXT,
    "location" TEXT,
    "logExcerpt" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ServerSecurityEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ServerAgent_orgId_idx" ON "ServerAgent"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "ServerAgent_wazuhAgentId_key" ON "ServerAgent"("wazuhAgentId");

-- CreateIndex
CREATE INDEX "ServerSecurityEvent_orgId_occurredAt_idx" ON "ServerSecurityEvent"("orgId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "ServerSecurityEvent_agentRefId_eventKey_key" ON "ServerSecurityEvent"("agentRefId", "eventKey");

-- AddForeignKey
ALTER TABLE "ServerAgent" ADD CONSTRAINT "ServerAgent_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServerSecurityEvent" ADD CONSTRAINT "ServerSecurityEvent_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServerSecurityEvent" ADD CONSTRAINT "ServerSecurityEvent_agentRefId_fkey" FOREIGN KEY ("agentRefId") REFERENCES "ServerAgent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
