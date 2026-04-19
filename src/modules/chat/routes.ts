import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { createMessage, listMessages } from './service.js'
import { broadcastChatMessage } from './ws.js'

export async function chatRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /chat/messages
   * Envia uma nova mensagem de chat (usuário → sistema).
   * Body: { teamId, agentId?, role, content }
   */
  app.post('/chat/messages', async (request, reply) => {
    const schema = z.object({
      teamId:  z.string().min(1),
      agentId: z.string().optional(),
      role:    z.enum(['user', 'agent', 'system']),
      content: z.string().min(1).max(10_000),
    })

    const parsed = schema.safeParse(request.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() })
    }

    const { teamId, agentId, role, content } = parsed.data

    const message = await createMessage({ teamId, agentId, role, content })

    // Broadcast via WebSocket para todos os clientes conectados ao team
    broadcastChatMessage(teamId, message)

    return reply.status(201).send(message)
  })

  /**
   * GET /chat/messages?teamId=X&limit=50&before=<id>
   * Retorna histórico de mensagens (mais recentes primeiro).
   */
  app.get('/chat/messages', async (request, reply) => {
    const schema = z.object({
      teamId: z.string().min(1),
      limit:  z.coerce.number().int().min(1).max(200).default(50),
      before: z.string().optional(),
    })

    const parsed = schema.safeParse(request.query)
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() })
    }

    const { teamId, limit, before } = parsed.data
    const messages = await listMessages({ teamId, limit, before })

    return { messages, total: messages.length }
  })
}
