import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { listSessions } from '../tmux/service.js'

const teamCreateSchema = z.object({
  name: z.string().min(1).max(128),
  description: z.string().optional(),
})

const agentCreateSchema = z.object({
  name: z.string().min(1).max(128),
  role: z.string().min(1).max(64),
  sessionName: z.string().optional(),
})

export async function teamsDbRoutes(app: FastifyInstance): Promise<void> {
  // GET /teams — lista todos os teams
  app.get('/teams', async () => {
    const teams = await prisma.team.findMany({
      orderBy: { createdAt: 'desc' },
      include: { agents: true },
    })
    return { teams }
  })

  // POST /teams — cria novo team
  app.post('/teams', async (request, reply) => {
    const parsed = teamCreateSchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() })

    const team = await prisma.team.create({ data: parsed.data })
    return reply.status(201).send({ team })
  })

  // GET /teams/:id — busca team por ID
  app.get<{ Params: { id: string } }>('/teams/:id', async (request, reply) => {
    const team = await prisma.team.findUnique({
      where: { id: request.params.id },
      include: { agents: true },
    })
    if (!team) return reply.status(404).send({ error: 'Team não encontrado' })
    return { team }
  })

  // DELETE /teams/:id — remove team
  app.delete<{ Params: { id: string } }>('/teams/:id', async (request, reply) => {
    try {
      await prisma.team.delete({ where: { id: request.params.id } })
      return reply.status(204).send()
    } catch {
      return reply.status(404).send({ error: 'Team não encontrado' })
    }
  })

  // GET /teams/:id/agents — lista agentes do team
  app.get<{ Params: { id: string } }>('/teams/:id/agents', async (request, reply) => {
    const team = await prisma.team.findUnique({ where: { id: request.params.id } })
    if (!team) return reply.status(404).send({ error: 'Team não encontrado' })

    const agents = await prisma.agent.findMany({ where: { teamId: request.params.id } })
    return { agents }
  })

  // POST /teams/:id/agents — adiciona agente ao team
  app.post<{ Params: { id: string } }>('/teams/:id/agents', async (request, reply) => {
    const team = await prisma.team.findUnique({ where: { id: request.params.id } })
    if (!team) return reply.status(404).send({ error: 'Team não encontrado' })

    const parsed = agentCreateSchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() })

    const agent = await prisma.agent.create({
      data: { ...parsed.data, teamId: request.params.id },
    })
    return reply.status(201).send({ agent })
  })

  // DELETE /teams/:id/agents/:agentId — remove agente
  app.delete<{ Params: { id: string; agentId: string } }>(
    '/teams/:id/agents/:agentId',
    async (request, reply) => {
      try {
        await prisma.agent.delete({ where: { id: request.params.agentId } })
        return reply.status(204).send()
      } catch {
        return reply.status(404).send({ error: 'Agente não encontrado' })
      }
    }
  )

  // GET /teams/:id/agents/status — status tmux de cada agente
  app.get<{ Params: { id: string } }>('/teams/:id/agents/status', async (request, reply) => {
    const team = await prisma.team.findUnique({ where: { id: request.params.id } })
    if (!team) return reply.status(404).send({ error: 'Team não encontrado' })

    const agents = await prisma.agent.findMany({ where: { teamId: request.params.id } })
    const activeSessions = new Set(listSessions().map((s) => s.name))

    const result = agents.map((agent) => ({
      id: agent.id,
      name: agent.name,
      role: agent.role,
      sessionName: agent.sessionName,
      active: agent.sessionName ? activeSessions.has(agent.sessionName) : false,
    }))

    return { teamId: request.params.id, teamName: team.name, agents: result }
  })
}
