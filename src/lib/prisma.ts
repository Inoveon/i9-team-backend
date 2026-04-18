import pg from 'pg'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../generated/prisma/index.js'

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgresql://i9team:i9team@localhost:5438/i9team',
})

const adapter = new PrismaPg(pool)

export const prisma = new PrismaClient({ adapter })
