-- Legacy deployments have exactly one LocalAdmin row (password administrator).
-- Refuse to guess which row is the administrator if that invariant does not hold.
DO $$
BEGIN
  IF (SELECT count(*) FROM "LocalAdmin") > 1 THEN
    RAISE EXCEPTION 'github_accounts migration requires at most one existing LocalAdmin row, found %', (SELECT count(*) FROM "LocalAdmin");
  END IF;
END $$;

ALTER TABLE "LocalAdmin"
  ADD COLUMN "accountKind" TEXT,
  ADD COLUMN "accountLevel" INTEGER,
  ADD COLUMN "githubId" TEXT,
  ADD COLUMN "githubLogin" TEXT,
  ADD COLUMN "displayName" TEXT,
  ADD COLUMN "avatarUrl" TEXT;

UPDATE "LocalAdmin" SET "accountKind" = 'PASSWORD', "accountLevel" = 4;

ALTER TABLE "LocalAdmin"
  ALTER COLUMN "accountKind" SET NOT NULL,
  ALTER COLUMN "accountLevel" SET NOT NULL,
  ALTER COLUMN "username" DROP NOT NULL,
  ALTER COLUMN "passwordHash" DROP NOT NULL;

ALTER TABLE "LocalAdmin"
  ADD CONSTRAINT "LocalAdmin_account_shape_check" CHECK (
    (
      "accountKind" = 'PASSWORD'
      AND "accountLevel" = 4
      AND "username" IS NOT NULL
      AND "passwordHash" IS NOT NULL
      AND "githubId" IS NULL
    ) OR (
      "accountKind" = 'GITHUB'
      AND "accountLevel" BETWEEN 1 AND 3
      AND "githubId" IS NOT NULL
      AND "username" IS NULL
      AND "passwordHash" IS NULL
    )
  );

CREATE UNIQUE INDEX "LocalAdmin_githubId_key" ON "LocalAdmin"("githubId");
CREATE UNIQUE INDEX "LocalAdmin_single_password_admin" ON "LocalAdmin"("accountKind") WHERE "accountKind" = 'PASSWORD';
