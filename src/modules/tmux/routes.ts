import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { listSessions, createSession, destroySession, sendKeys, captureSession } from './service.js'

export async function tmuxRoutes(app: FastifyInstance) {
  // GET /tmux/sessions — lista sessões tmux ativas
  app.get('/tmux/sessions', async () => {
    return { sessions: listSessions() }
  })

  // POST /tmux/sessions — cria nova sessão
  app.post('/tmux/sessions', async (request, reply) => {
    const schema = z.object({ name: z.string().min(1).max(64) })
    const parsed = schema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() })

    const ok = createSession(parsed.data.name)
    return reply.status(ok ? 201 : 500).send({ ok, name: parsed.data.name })
  })

  // DELETE /tmux/sessions/:name — destrói sessão
  app.delete<{ Params: { name: string } }>('/tmux/sessions/:name', async (request, reply) => {
    const ok = destroySession(request.params.name)
    return reply.status(ok ? 200 : 404).send({ ok })
  })

  // POST /tmux/sessions/:name/keys — envia teclas
  app.post<{ Params: { name: string } }>('/tmux/sessions/:name/keys', async (request, reply) => {
    const schema = z.object({ keys: z.string().min(1) })
    const parsed = schema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() })

    sendKeys(request.params.name, parsed.data.keys)
    return { ok: true }
  })

  // GET /tmux/capture/:session — captura output atual
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
