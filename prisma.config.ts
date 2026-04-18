import { defineConfig } from 'prisma/config'
import 'dotenv/config'

const dbUrl = process.env.DATABASE_URL ?? 'postgresql://i9team:i9team@localhost:5438/i9team'

export default defineConfig({
  datasource: {
    url: dbUrl,
  },
})
