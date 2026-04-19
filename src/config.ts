export const config = {
  port: parseInt(process.env.PORT ?? '4020', 10),
  jwtSecret: process.env.JWT_SECRET ?? 'change-me-in-production',
  appUser: process.env.APP_USER ?? 'admin',
  appPassword: process.env.APP_PASSWORD ?? 'i9team',
  teamsJsonPath: process.env.TEAMS_JSON_PATH ?? `${process.env.HOME}/.claude/teams.json`,
  databaseUrl: process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/i9_team_db',
  redisHost: process.env.REDIS_HOST ?? 'localhost',
  redisPort: parseInt(process.env.REDIS_PORT ?? '6379', 10),
  uploadDir: process.env.UPLOAD_DIR ?? '/tmp/i9-team-uploads',
}
