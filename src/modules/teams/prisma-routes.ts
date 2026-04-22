import type { FastifyInstance } from 'fastify'
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { config } from '../../config.js'
import { listSessions, sendKeys } from '../tmux/service.js'
import { startTeam, stopTeam } from './service.js'
import { syncTeamsFromConfig } from './sync.js'
import { resolveAttachment, renewAttachmentMtime } from '../uploads/routes.js'

const teamCreateSchema = z.object({
  name: z.string().min(1).max(128),
  description: z.string().optional(),
})

const agentCreateSchema = z.object({
  name: z.string().min(1).max(128),
  role: z.string().min(1).max(64),
  sessionName: z.string().optional(),
})

/**
 * Mensagem enviada ao orquestrador de um team via `POST /teams/:id/message`.
 *
 * Aceita `content` (nome oficial) ou `message` (compat com chamadas antigas do
 * frontend) e, na Onda 5 (Issue #3), opcionalmente `attachmentIds` — UUIDs
 * de imagens previamente enviadas via `POST /upload/image`. Pelo menos um
 * entre mensagem/conteúdo/anexos precisa estar presente.
 */
const messageSchema = z
  .object({
    content: z.string().min(1).optional(),
    message: z.string().min(1).optional(),
    agentId: z.string().optional(),
    attachmentIds: z.array(z.string().uuid()).max(6).optional(),
  })
  .refine((v) => !!(v.content ?? v.message) || (v.attachmentIds?.length ?? 0) > 0, {
    message: 'Informe "content"/"message" ou ao menos um "attachmentIds"',
  })

/**
 * Schema mínimo para o `teams.json`. Mantém `passthrough` para não descartar
 * campos desconhecidos que o CLI possa adicionar no futuro.
 */
const teamsConfigSchema = z
  .object({
    version: z.string(),
    projects: z.array(z.unknown()),
  })
  .passthrough()

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

/**
 * Adapta o shape de `Team` do Prisma para o formato que o frontend consome
 * (mesma regra aplicada em `frontend/src/lib/api.ts:58-79` dentro de
 * `getTeams()`). Centralizar aqui evita divergência entre as rotas e garante
 * que `GET /teams/:project/:team` entregue o que `TeamPage` espera:
 *   - role: 'orchestrator' | 'worker'
 *   - sessionId (alias de sessionName)
 *   - status default 'running' (status real continua em /agents/status)
 */
type AdaptedAgent = {
  id: string
  teamId: string
  name: string
  role: 'orchestrator' | 'worker'
  sessionName: string | null
  sessionId: string | null
  status: 'running'
}

function adaptAgent(a: {
  id: string
  teamId: string
  name: string
  role: string
  sessionName: string | null
}): AdaptedAgent {
  return {
    id: a.id,
    teamId: a.teamId,
    name: a.name,
    role: a.role === 'orchestrator' ? 'orchestrator' : 'worker',
    sessionName: a.sessionName,
    sessionId: a.sessionName,
    status: 'running',
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Rotas
// ────────────────────────────────────────────────────────────────────────────

export async function teamsDbRoutes(app: FastifyInstance): Promise<void> {
  // ──────────────────────────────────────────────────────────────────────
  // Rotas com segmentos estáticos vêm primeiro — find-my-way prioriza
  // static > parametric, mas declaramos na ordem para clareza.
  // ──────────────────────────────────────────────────────────────────────

  // GET /teams/config — lê teams.json cru
  app.get('/teams/config', async (request, reply) => {
    if (!existsSync(config.teamsJsonPath)) {
      return reply.status(404).send({ error: 'teams.json não encontrado', path: config.teamsJsonPath })
    }
    try {
      const raw = readFileSync(config.teamsJsonPath, 'utf8')
      return JSON.parse(raw)
    } catch (err) {
      request.log.error({ err }, '[teams/config] erro ao ler/parsear teams.json')
      return reply.status(500).send({ error: 'Falha ao ler teams.json', detail: String(err) })
    }
  })

  // PUT /teams/config — sobrescreve teams.json (write atômico) + resync
  app.put('/teams/config', async (request, reply) => {
    const parsed = teamsConfigSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() })
    }

    const target = config.teamsJsonPath
    const tmp = `${target}.tmp`
    try {
      writeFileSync(tmp, JSON.stringify(parsed.data, null, 2), 'utf8')
      renameSync(tmp, target)
      request.log.info({ path: target }, '[teams/config] teams.json atualizado')
    } catch (err) {
      request.log.error({ err }, '[teams/config] falha ao escrever teams.json')
      return reply.status(500).send({ error: 'Falha ao escrever teams.json', detail: String(err) })
    }

    try {
      const synced = await syncTeamsFromConfig()
      return { ok: true, path: target, synced }
    } catch (err) {
      request.log.error({ err }, '[teams/config] arquivo gravado mas sync falhou')
      return reply
        .status(500)
        .send({ ok: false, path: target, error: 'Arquivo gravado mas sync falhou', detail: String(err) })
    }
  })

  // POST /teams/sync — força resync teams.json → DB
  app.post('/teams/sync', async (request) => {
    const synced = await syncTeamsFromConfig()
    request.log.info({ synced }, '[teams/sync] resync forçado')
    return synced
  })

  // ──────────────────────────────────────────────────────────────────────
  // CRUD básico de teams
  // ──────────────────────────────────────────────────────────────────────

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

  // GET /teams/:project/:team — busca team por project/name (ex: i9-team/dev)
  // Retorna objeto Team no formato esperado pelo frontend (project + name separados)
  app.get<{ Params: { project: string; team: string } }>(
    '/teams/:project/:team',
    async (request, reply) => {
      const { project, team } = request.params
      const fullName = `${project}/${team}`
      const raw = await prisma.team.findFirst({
        where: { name: fullName },
        include: { agents: true },
      })
      if (!raw) return reply.status(404).send({ error: 'Team não encontrado' })
      const activeSessions = new Set(listSessions().map((s) => s.name))
      return {
        id: raw.id,
        project,
        name: team,
        description: raw.description,
        status: raw.agents.length > 0 ? 'running' : 'stopped',
        agents: raw.agents.map((a) => ({
          id: a.id,
          name: a.name,
          role: a.role === 'orchestrator' ? 'orchestrator' : 'worker',
          status: a.sessionName && activeSessions.has(a.sessionName) ? 'running' : 'stopped',
          sessionId: a.sessionName,
        })),
        createdAt: raw.createdAt,
        updatedAt: raw.createdAt,
      }
    }
  )

  // GET /teams/:id — busca team por ID
  app.get<{ Params: { id: string } }>('/teams/:id', async (request, reply) => {
    const team = await prisma.team.findUnique({
      where: { id: request.params.id },
      include: { agents: true },
    })
    if (!team) return reply.status(404).send({ error: 'Team não encontrado' })
    return { team }
  })

  // GET /teams/:project/:team — busca team pelo par project/team já no shape
  // que o frontend consome (role='orchestrator'|'worker', sessionId, status).
  //
  // A tabela `Team` não tem coluna `project` separada — o campo `name` é único
  // e armazena "project/team" (ver sync.ts). Portanto compomos `${project}/${team}`.
  //
  // Adaptação de shape centralizada em `adaptAgent()` — espelha a regra que
  // `frontend/src/lib/api.ts:58-79` faz em `getTeams()`. Replicar aqui evita
  // que a TeamPage (que chama este endpoint direto) receba role='agent' e
  // sessionName cru, o que travava o filter `a.role==='worker'`.
  app.get<{ Params: { project: string; team: string } }>(
    '/teams/:project/:team',
    async (request, reply) => {
      const { project, team: teamName } = request.params
      const fullName = `${project}/${teamName}`
      const team = await prisma.team.findUnique({
        where: { name: fullName },
        include: { agents: true },
      })
      if (!team) return reply.status(404).send({ error: 'Team não encontrado' })

      const adapted = {
        ...team,
        agents: team.agents.map(adaptAgent),
      }
      return { team: adapted }
    }
  )

  // DELETE /teams/:id — remove team
  app.delete<{ Params: { id: string } }>('/teams/:id', async (request, reply) => {
    try {
      await prisma.team.delete({ where: { id: request.params.id } })
      return reply.status(204).send()
    } catch {
      return reply.status(404).send({ error: 'Team não encontrado' })
    }
  })

  // ──────────────────────────────────────────────────────────────────────
  // Agentes do team
  // ──────────────────────────────────────────────────────────────────────

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

  // ──────────────────────────────────────────────────────────────────────
  // Ações — envio de mensagem + start/stop
  // ──────────────────────────────────────────────────────────────────────

  // POST /teams/:id/message — envia conteúdo (e/ou anexos) à sessão tmux do
  // agente alvo.
  //
  // Onda 5 (Issue #3): suporte a `attachmentIds`. Para cada UUID enviado:
  //   - valida que o arquivo existe em UPLOAD_DIR/{teamIdDaURL}/{uuid}.ext
  //     (ownership implícita — garante que anexos só sejam consumidos pelo
  //     próprio team que os subiu)
  //   - renova mtime para que o cleanup-worker não remova entre upload e uso
  //   - monta o texto final no formato `@<absPath>` em linhas separadas, que
  //     o Claude Code TUI reconhece como referência a imagem
  //
  // Se alguns IDs forem inválidos, o handler procede com os válidos e devolve
  // 207 Multi-Status com `attachmentsRejected` listando motivos.
  app.post<{ Params: { id: string } }>(
    '/teams/:id/message',
    async (request, reply) => {
      const parsed = messageSchema.safeParse(request.body)
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() })
      }
      const textContent = parsed.data.content ?? parsed.data.message ?? ''

      const team = await prisma.team.findUnique({
        where: { id: request.params.id },
        include: { agents: true },
      })
      if (!team) return reply.status(404).send({ error: 'Team não encontrado' })

      // Se o caller especificou agentId, usa esse agente; senão, orquestrador.
      const targetAgent = parsed.data.agentId
        ? team.agents.find((a) => a.id === parsed.data.agentId)
        : team.agents.find((a) => a.role === 'orchestrator')

      if (!targetAgent) {
        return reply.status(404).send({ error: 'Agente destinatário não encontrado no team' })
      }
      if (!targetAgent.sessionName) {
        return reply.status(400).send({ error: 'Agente não tem sessão tmux configurada' })
      }

      // ── Resolução de anexos ────────────────────────────────────────────
      const attachmentsUsed: Array<{ id: string; absPath: string; mimetype: string }> = []
      const attachmentsRejected: Array<{ id: string; reason: 'not_found' }> = []

      for (const attId of parsed.data.attachmentIds ?? []) {
        const resolved = await resolveAttachment(team.id, attId)
        if (!resolved) {
          attachmentsRejected.push({ id: attId, reason: 'not_found' })
          continue
        }
        await renewAttachmentMtime(resolved.absPath)
        attachmentsUsed.push({ id: attId, absPath: resolved.absPath, mimetype: resolved.mimetype })
      }

      if ((parsed.data.attachmentIds?.length ?? 0) > 0 && attachmentsUsed.length === 0) {
        // Mensagem que só tem anexos e TODOS falharam → 400 (não há o que enviar)
        return reply.status(400).send({
          error: 'Nenhum anexo válido e sem texto',
          attachmentsRejected,
        })
      }

      // ── Montagem do payload final para o tmux ─────────────────────────
      // Formato:
      //   <texto>
      //   @<path1>
      //   @<path2>
      // O Claude Code reconhece `@<caminho absoluto>` como referência a
      // arquivo/imagem. Duas quebras separam prosa de anexos para legibilidade.
      const attachmentLines = attachmentsUsed.map((a) => `@${a.absPath}`)
      const parts: string[] = []
      if (textContent) parts.push(textContent)
      if (attachmentLines.length > 0) parts.push(attachmentLines.join('\n'))
      const payload = parts.join('\n\n')

      try {
        sendKeys(targetAgent.sessionName, payload)
        request.log.info(
          {
            session: targetAgent.sessionName,
            teamId: team.id,
            bytes: payload.length,
            attachmentsUsed: attachmentsUsed.length,
            attachmentsRejected: attachmentsRejected.length,
          },
          '[teams/message] mensagem enviada'
        )
      } catch (err) {
        request.log.error({ err, session: targetAgent.sessionName }, '[teams/message] sendKeys falhou')
        return reply
          .status(500)
          .send({ error: 'Falha ao enviar tmux send-keys', detail: String(err) })
      }

      const body = {
        ok: true,
        session: targetAgent.sessionName,
        agent: targetAgent.name,
        attachmentsUsed: attachmentsUsed.map((a) => a.id),
        attachmentsRejected,
      }

      // 207 Multi-Status se algum anexo foi rejeitado mas o envio seguiu;
      // 200 caso contrário.
      const status = attachmentsRejected.length > 0 ? 207 : 200
      return reply.status(status).send(body)
    }
  )

  // POST /teams/:id/start — delega para `~/.claude/scripts/team.sh start`
  //
  // Status mapping:
  //   200 — script retornou exit 0
  //   404 — exit != 0 com stdout/stderr contendo "não encontrado" (team.sh diagnosticou)
  //   400 — exit != 0 por outro motivo (jq, tmux, args inválidos)
  //   500 — exceção JS (spawn falhou, script ausente)
  app.post<{ Params: { id: string } }>('/teams/:id/start', async (request, reply) => {
    const team = await prisma.team.findUnique({ where: { id: request.params.id } })
    if (!team) return reply.status(404).send({ error: 'Team não encontrado' })

    const [project, name] = team.name.split('/', 2)
    if (!project || !name) {
      return reply.status(400).send({ error: `Team name inválido (sem "/"): ${team.name}` })
    }
    try {
      const result = startTeam(project, name)
      request.log.info(
        { project, team: name, ok: result.ok, code: result.code },
        '[teams/start] executado'
      )
      if (!result.ok) {
        const status = result.notFound ? 404 : 400
        return reply.status(status).send(result)
      }
      return result
    } catch (err) {
      request.log.error({ err, project, team: name }, '[teams/start] crash')
      return reply.status(500).send({ ok: false, error: String(err) })
    }
  })

  // POST /teams/:id/stop — análogo ao start, mesmo mapping de status
  app.post<{ Params: { id: string } }>('/teams/:id/stop', async (request, reply) => {
    const team = await prisma.team.findUnique({ where: { id: request.params.id } })
    if (!team) return reply.status(404).send({ error: 'Team não encontrado' })

    const [project, name] = team.name.split('/', 2)
    if (!project || !name) {
      return reply.status(400).send({ error: `Team name inválido (sem "/"): ${team.name}` })
    }
    try {
      const result = stopTeam(project, name)
      request.log.info(
        { project, team: name, ok: result.ok, code: result.code },
        '[teams/stop] executado'
      )
      if (!result.ok) {
        const status = result.notFound ? 404 : 400
        return reply.status(status).send(result)
      }
      return result
    } catch (err) {
      request.log.error({ err, project, team: name }, '[teams/stop] crash')
      return reply.status(500).send({ ok: false, error: String(err) })
    }
  })
}
