import Fastify from 'fastify'
import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import jwt from '@fastify/jwt'
import rateLimit from '@fastify/rate-limit'
import websocket from '@fastify/websocket'
import { config } from './config.js'
import { authPlugin } from './modules/auth/plugin.js'
import { tmuxRoutes } from './modules/tmux/routes.js'
import { teamsRoutes } from './modules/teams/routes.js'         // rotas legadas: start/stop via teams.json
import { teamsDbRoutes } from './modules/teams/prisma-routes.js' // CRUD Prisma
import { syncTeamsFromConfig } from './modules/teams/sync.js'   // sync teams.json → PostgreSQL
import { wsHandler } from './modules/ws/handler.js'

const app = Fastify({ logger: true })

await app.register(cors, { origin: true })
await app.register(helmet)
await app.register(jwt, { secret: config.jwtSecret })
await app.register(rateLimit, { max: 100, timeWindow: '1 minute' })
await app.register(websocket)

// Auth routes (public)
await app.register(authPlugin)

// Protected routes
await app.register(async (instance) => {
  instance.addHook('onRequest', async (request, reply) => {
    try {
      // WebSocket não suporta headers — aceitar token via query param ?token=
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
})

app.get('/health', async () => ({ status: 'ok', ts: Date.now() }))

try {
  await app.listen({ port: config.port, host: '0.0.0.0' })
  console.log(`i9-team-backend running on port ${config.port}`)

  // Sincroniza teams.json → PostgreSQL após o servidor subir
  syncTeamsFromConfig().catch((err) => {
    console.error('[startup] Erro na sincronização de teams:', err)
  })
} catch (err) {
  app.log.error(err)
  process.exit(1)
}
