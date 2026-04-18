-- CreateTable
CREATE TABLE "Team" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Team_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Agent" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "sessionName" TEXT,

    CONSTRAINT "Agent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamSession" (
    "id" TEXT NOT NULL,
    "project" TEXT NOT NULL,
    "team" TEXT NOT NULL,
    "agent" TEXT NOT NULL,
    "session" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "stoppedAt" TIMESTAMP(3),

    CONSTRAINT "TeamSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Team_name_key" ON "Team"("name");

-- CreateIndex
CREATE INDEX "Agent_teamId_idx" ON "Agent"("teamId");

-- CreateIndex
CREATE INDEX "TeamSession_project_team_idx" ON "TeamSession"("project", "team");

-- CreateIndex
CREATE INDEX "TeamSession_session_idx" ON "TeamSession"("session");

-- AddForeignKey
ALTER TABLE "Agent" ADD CONSTRAINT "Agent_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
