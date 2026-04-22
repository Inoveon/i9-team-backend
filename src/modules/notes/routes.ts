/**
 * notes/routes.ts — CRUD REST de notas markdown do team.
 *
 * Base: /teams/:id/notes
 * Requer JWT (herda o onRequest do bloco protegido em src/index.ts).
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import {
  NAME_RE,
  MAX_CONTENT_SIZE,
  listNotes,
  readNote,
  writeNote,
  createNote,
  deleteNote,
} from './service.js'

const nameSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(NAME_RE, 'name inválido — use [a-z0-9][a-z0-9-_]{0,99}')

const createBodySchema = z.object({
  name: nameSchema,
  content: z.string().max(MAX_CONTENT_SIZE, 'content excede 1MB'),
})

const updateBodySchema = z.object({
  content: z.string().max(MAX_CONTENT_SIZE, 'content excede 1MB'),
  expectedEtag: z.string().optional(),
})

// Helper — busca team por id e valida formato "project/team". Reutilizado pelos
// handlers para padronizar 404 (team não existe no DB) e 400 (nome malformado).
async function loadTeamName(
  app: FastifyInstance,
  teamId: string
): Promise<
  | { ok: true; teamName: string }
  | { ok: false; status: 404 | 400; error: string }
> {
  const team = await prisma.team.findUnique({ where: { id: teamId } })
  if (!team) return { ok: false, status: 404, error: 'Team não encontrado' }
  if (!team.name.includes('/')) {
    return {
      ok: false,
      status: 400,
      error: `Team name inválido (sem "/"): ${team.name}`,
    }
  }
  app.log.debug({ teamId, teamName: team.name }, '[notes] team resolvido')
  return { ok: true, teamName: team.name }
}

export async function notesRoutes(app: FastifyInstance): Promise<void> {
  // GET /teams/:id/notes — lista notas do team
  app.get<{ Params: { id: string } }>(
    '/teams/:id/notes',
    async (request, reply) => {
      const resolved = await loadTeamName(app, request.params.id)
      if (!resolved.ok) return reply.status(resolved.status).send({ error: resolved.error })

      const notes = listNotes(resolved.teamName)
      return reply.send(notes)
    }
  )

  // POST /teams/:id/notes — cria nota nova (falha se já existe)
  app.post<{ Params: { id: string } }>(
    '/teams/:id/notes',
    async (request, reply) => {
      const resolved = await loadTeamName(app, request.params.id)
      if (!resolved.ok) return reply.status(resolved.status).send({ error: resolved.error })

      const parsed = createBodySchema.safeParse(request.body)
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() })
      }

      const r = createNote(resolved.teamName, parsed.data.name, parsed.data.content)
      if (!r.ok) {
        if (r.reason === 'already_exists') {
          return reply.status(409).send({ ok: false, reason: 'already_exists' })
        }
        return reply.status(400).send({ ok: false, reason: r.reason })
      }

      request.log.info(
        { team: resolved.teamName, name: parsed.data.name, size: parsed.data.content.length },
        '[notes] criada'
      )
      return reply.status(201).send(r.result)
    }
  )

  // GET /teams/:id/notes/:name — lê nota com etag
  app.get<{ Params: { id: string; name: string } }>(
    '/teams/:id/notes/:name',
    async (request, reply) => {
      const resolved = await loadTeamName(app, request.params.id)
      if (!resolved.ok) return reply.status(resolved.status).send({ error: resolved.error })

      const nameCheck = nameSchema.safeParse(request.params.name)
      if (!nameCheck.success) {
        return reply.status(400).send({ error: 'name inválido' })
      }

      const note = readNote(resolved.teamName, request.params.name)
      if (!note) return reply.status(404).send({ error: 'Nota não encontrada' })
      return reply.send(note)
    }
  )

  // PUT /teams/:id/notes/:name — atualiza (com etag opcional + backup)
  app.put<{ Params: { id: string; name: string } }>(
    '/teams/:id/notes/:name',
    async (request, reply) => {
      const resolved = await loadTeamName(app, request.params.id)
      if (!resolved.ok) return reply.status(resolved.status).send({ error: resolved.error })

      const nameCheck = nameSchema.safeParse(request.params.name)
      if (!nameCheck.success) {
        return reply.status(400).send({ error: 'name inválido' })
      }

      const parsed = updateBodySchema.safeParse(request.body)
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() })
      }

      const r = writeNote(
        resolved.teamName,
        request.params.name,
        parsed.data.content,
        parsed.data.expectedEtag
      )

      if (r.ok) {
        request.log.info(
          {
            team: resolved.teamName,
            name: request.params.name,
            size: parsed.data.content.length,
            backup: r.result.backupPath,
          },
          '[notes] atualizada'
        )
        return reply.send(r.result)
      }

      if (r.reason === 'conflict') {
        return reply.status(409).send({
          ok: false,
          reason: 'conflict',
          currentEtag: r.currentEtag,
          currentContent: r.currentContent,
        })
      }
      if (r.reason === 'not_found') {
        return reply.status(404).send({ error: 'Nota não encontrada' })
      }
      return reply.status(400).send({ ok: false, reason: r.reason })
    }
  )

  // DELETE /teams/:id/notes/:name — soft delete
  app.delete<{ Params: { id: string; name: string } }>(
    '/teams/:id/notes/:name',
    async (request, reply) => {
      const resolved = await loadTeamName(app, request.params.id)
      if (!resolved.ok) return reply.status(resolved.status).send({ error: resolved.error })

      const nameCheck = nameSchema.safeParse(request.params.name)
      if (!nameCheck.success) {
        return reply.status(400).send({ error: 'name inválido' })
      }

      const removed = deleteNote(resolved.teamName, request.params.name)
      if (!removed) return reply.status(404).send({ error: 'Nota não encontrada' })

      request.log.info(
        { team: resolved.teamName, name: request.params.name },
        '[notes] soft-deleted'
      )
      return reply.status(204).send()
    }
  )
}
