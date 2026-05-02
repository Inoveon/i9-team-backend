import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'

const SendSchema = z.object({
  teamId: z.string().min(1),
  agentName: z.string().min(1),
  message: z.string().min(1).max(10000),
})

export async function bridgeRoutes(app: FastifyInstance) {
  // POST /bridge/send — envia mensagem a um agente via bridge service (porta 7773)
  app.post('/bridge/send', async (request, reply) => {
    const parsed = SendSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() })
    }

    const { teamId, agentName, message } = parsed.data

    // Busca agente no Prisma pelo teamId + name
    let agent: { sessionName: string | null } | null = null
    try {
      agent = await prisma.agent.findFirst({
        where: { teamId, name: agentName },
        select: { sessionName: true },
      })
    } catch {
      // DB indisponível — tenta entregar direto pelo nome de sessão convencional
      // Convenção: {teamId}-{agentName} não é confiável sem o DB, retornar 503
      return reply.status(503).send({ error: 'Database indisponível' })
    }

    if (!agent || !agent.sessionName) {
      return reply.status(404).send({ error: 'Agente não encontrado' })
    }

    // Faz POST para o bridge service
    let bridgeRes: Response
    try {
      bridgeRes = await fetch('http://localhost:7773/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session: agent.sessionName, message, as_user: true }),
        signal: AbortSignal.timeout(30_000),
      })
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ECONNREFUSED' || code === 'ENOTFOUND') {
        return reply.status(503).send({ error: 'Bridge service indisponível' })
      }
      throw err
    }

    // Repassa erro do bridge
    if (!bridgeRes.ok) {
      const bridgeBody = await bridgeRes.text()
      return reply.status(bridgeRes.status).send(
        bridgeBody ? JSON.parse(bridgeBody) : { error: 'Bridge service retornou erro' }
      )
    }

    return reply.send({ ok: true, session: agent.sessionName, delivered: true })
  })
}
