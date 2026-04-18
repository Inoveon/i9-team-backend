import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { listSessions, sendToSession, captureSession } from './service.js'

export async function tmuxRoutes(app: FastifyInstance) {
  app.get('/tmux/sessions', async () => {
    const sessions = listSessions()
    return { sessions }
  })

  app.post('/tmux/send', async (request, reply) => {
    const schema = z.object({
      session: z.string(),
      message: z.string(),
    })
    const parsed = schema.safeParse(request.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() })
    }
    sendToSession(parsed.data.session, parsed.data.message)
    return { ok: true }
  })

  app.get<{ Params: { session: string }; Querystring: { lines?: string } }>(
    '/tmux/capture/:session',
    async (request) => {
      const { session } = request.params
      const lines = parseInt(request.query.lines ?? '50', 10)
      const output = captureSession(session, lines)
      return { session, output }
    }
  )
}
