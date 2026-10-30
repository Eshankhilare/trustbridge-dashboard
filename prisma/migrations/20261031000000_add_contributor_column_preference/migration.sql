-- CreateTable
CREATE TABLE "ContributorColumnPreference" (
    "id" TEXT NOT NULL,
    "maintainerOrgId" TEXT NOT NULL DEFAULT 'default',
    "userId" TEXT NOT NULL,
    "columns" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContributorColumnPreference_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ContributorColumnPreference_userId_maintainerOrgId_key" ON "ContributorColumnPreference"("userId", "maintainerOrgId");

-- CreateIndex
CREATE INDEX "ContributorColumnPreference_maintainerOrgId_idx" ON "ContributorColumnPreference"("maintainerOrgId");

-- AddForeignKey
ALTER TABLE "ContributorColumnPreference" ADD CONSTRAINT "ContributorColumnPreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Tenant default and row-level security, matching the existing multi-tenant
-- tables created by 20260828000000_add_maintainer_org_rls.
ALTER TABLE "ContributorColumnPreference" ALTER COLUMN "maintainerOrgId" SET DEFAULT COALESCE(public.current_maintainer_org_id(), 'default');

ALTER TABLE "ContributorColumnPreference" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ContributorColumnPreference" FORCE ROW LEVEL SECURITY;

CREATE POLICY "ContributorColumnPreference_maintainer_org_isolation"
  ON "ContributorColumnPreference"
  USING ("maintainerOrgId" = public.current_maintainer_org_id())
  WITH CHECK ("maintainerOrgId" = public.current_maintainer_org_id());
