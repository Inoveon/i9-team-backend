-- AddUniqueConstraint: Agent(teamId, name)
CREATE UNIQUE INDEX IF NOT EXISTS "Agent_teamId_name_key" ON "Agent"("teamId", "name");
