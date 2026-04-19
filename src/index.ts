import Fastify from 'fastify'
import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import jwt from '@fastify/jwt'
import multipart from '@fastify/multipart'
import rateLimit from '@fastify/rate-limit'
import staticFiles from '@fastify/static'
import websocket from '@fastify/websocket'
import { config } from './config.js'
import { authPlugin } from './modules/auth/plugin.js'
import { tmuxRoutes } from './modules/tmux/routes.js'
import { teamsRoutes } from './modules/teams/routes.js'         // rotas legadas: start/stop via teams.json
import { teamsDbRoutes } from './modules/teams/prisma-routes.js' // CRUD Prisma
import { syncTeamsFromConfig } from './modules/teams/sync.js'   // sync teams.json → PostgreSQL
import { wsHandler } from './modules/ws/handler.js'
import { uploadsRoutes } from './modules/uploads/routes.js'
import { startCleanupWorker, scheduleCleanupJob } from './modules/uploads/cleanup-worker.js'

const UPLOAD_DIR = process.env.UPLOAD_DIR ?? '/tmp/i9-team-uploads'

const app = Fastify({ logger: true })

await app.register(cors, { origin: true })
await app.register(helmet)
await app.register(jwt, { secret: config.jwtSecret })
await app.register(multipart)
await app.register(rateLimit, { max: 100, timeWindow: '1 minute' })
await app.register(websocket)
// Servir arquivos de upload como estáticos em /uploads/*
await app.register(staticFiles, { root: UPLOAD_DIR, prefix: '/uploads/' })

// Auth routes (public)
await app.register(authPlugin)

// Protected routes
await app.register(async (instance) => {
  instance.addHook('onRequest', async (request, reply) => {
    try {
      const query = request.query as Record<string, string>
      if (!request.headers.authorization && query.token) {
        request.headers.authorization = `Bearer ${query.token}`
      }
      await request.jwtVerify()
    } catch {
      reply.status(401).send({ error: 'Unauthorized' })
    }
  })

  await instance.register(tmuxRoutes)
  await instance.register(teamsRoutes)
  await instance.register(teamsDbRoutes)
  await instance.register(wsHandler)
  await instance.register(uploadsRoutes)
})

app.get('/health', async () => ({ status: 'ok', ts: Date.now() }))

try {
  await app.listen({ port: config.port, host: '0.0.0.0' })
  console.log(`i9-team-backend running on port ${config.port}`)

  // Sincroniza teams.json → PostgreSQL após o servidor subir
  syncTeamsFromConfig().catch((err) => {
    console.error('[startup] Erro na sincronização de teams:', err)
  })

  // Inicializa worker e agenda job de cleanup de uploads (requer Redis)
  try {
    startCleanupWorker()
    await scheduleCleanupJob()
  } catch (err) {
    console.warn('[startup] cleanup-worker não iniciado (Redis indisponível?):', (err as Error).message)
  }
} catch (err) {
  app.log.error(err)
  process.exit(1)
}
