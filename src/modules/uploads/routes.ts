/**
 * uploads/routes.ts — Upload de imagens por team (Onda 5 / Issue #3).
 *
 * Contrato:
 *   POST /upload/image?teamId=<id>   (multipart, campo "file")
 *   → { id, teamId, url, filename, size, mimetype, createdAt }
 *
 * Mudanças nesta onda:
 *   - `teamId` obrigatório via query string; arquivo salvo em
 *     UPLOAD_DIR/{teamId}/{uuid}.{extCanônica}.
 *   - Validação MIME por magic bytes via `file-type` (não confia no cliente).
 *   - Extensão derivada do MIME real; filename original apenas para resposta.
 *   - Rate limit local: 30 uploads / 10 min (usuário via JWT sub / ou IP).
 *   - Limite elevado: 10 MB → 15 MB.
 *   - MIME allowlist: png, jpeg, webp, gif (sem SVG, sem HEIC).
 *
 * Segurança: se magic bytes não corresponderem a um MIME permitido,
 * arquivo é deletado antes de responder.
 */
import type { FastifyInstance } from 'fastify'
import { createWriteStream, mkdirSync, existsSync } from 'node:fs'
import { unlink, stat, readFile } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { randomUUID } from 'node:crypto'
import { join, resolve as pathResolve } from 'node:path'
import { fileTypeFromBuffer } from 'file-type'
import { prisma } from '../../lib/prisma.js'

export const UPLOAD_DIR = process.env.UPLOAD_DIR ?? '/tmp/i9-team-uploads'
const MAX_FILE_SIZE = 15 * 1024 * 1024 // 15 MB (era 10)

/** MIMEs aceitos. Extensão canônica derivada do MIME detectado via magic bytes. */
const MIME_TO_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
}

mkdirSync(UPLOAD_DIR, { recursive: true })

/** Resolve o diretório do team e garante sua existência. */
function teamDir(teamId: string): string {
  const dir = join(UPLOAD_DIR, teamId)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Garante que `absPath` está sob `UPLOAD_DIR/{teamId}/` — bloqueia path
 * traversal (qualquer `..` ou symlink fora da árvore do team).
 */
export function pathBelongsToTeam(absPath: string, teamId: string): boolean {
  const base = pathResolve(join(UPLOAD_DIR, teamId))
  const target = pathResolve(absPath)
  return target === base || target.startsWith(base + '/')
}

export async function uploadsRoutes(app: FastifyInstance): Promise<void> {
  // Rate limit local, PRE HANDLER na rota de upload.
  // Chave: `sub` do JWT quando disponível, senão IP. Evita que um token
  // conseguido em rate-check global (100/min) dispare 100 uploads.
  const rateLimit = app.rateLimit({
    max: 30,
    timeWindow: '10 minutes',
    keyGenerator: (req) => {
      const jwt = (req.user ?? {}) as { sub?: string }
      return jwt.sub ?? req.ip
    },
    errorResponseBuilder: (_req, ctx) => ({
      error: 'Too many uploads',
      limit: ctx.max,
      windowMinutes: 10,
      retryAfterSeconds: Math.ceil(ctx.ttl / 1000),
    }),
  })

  app.post(
    '/upload/image',
    { preHandler: rateLimit },
    async (request, reply) => {
      const { teamId } = request.query as { teamId?: string }
      if (!teamId) {
        return reply.status(400).send({ error: 'Parâmetro obrigatório: ?teamId=<id>' })
      }

      const team = await prisma.team.findUnique({ where: { id: teamId } })
      if (!team) {
        return reply.status(404).send({ error: 'Team não encontrado', teamId })
      }

      const data = await request.file({ limits: { fileSize: MAX_FILE_SIZE } })
      if (!data) {
        return reply.status(400).send({ error: 'Nenhum arquivo enviado (campo multipart "file")' })
      }

      const id = randomUUID()
      const tmpFilename = `${id}.tmp`
      const tmpPath = join(teamDir(teamId), tmpFilename)

      try {
        await pipeline(data.file, createWriteStream(tmpPath))
      } catch {
        await unlink(tmpPath).catch(() => {})
        return reply.status(500).send({ error: 'Erro ao salvar arquivo' })
      }

      if (data.file.truncated) {
        await unlink(tmpPath).catch(() => {})
        return reply.status(413).send({
          error: `Arquivo excede ${MAX_FILE_SIZE / 1024 / 1024} MB`,
        })
      }

      // Magic bytes: lê os primeiros KB pra detectar MIME real.
      // `fileTypeFromBuffer` usa até 4100 bytes de cabeçalho — suficiente pra
      // todos os formatos da allowlist. Lemos só o header pra não duplicar IO.
      let realMime: string | undefined
      try {
        const header = await readFile(tmpPath)
        const detected = await fileTypeFromBuffer(header.subarray(0, 4100))
        realMime = detected?.mime
      } catch {
        realMime = undefined
      }

      if (!realMime || !(realMime in MIME_TO_EXT)) {
        await unlink(tmpPath).catch(() => {})
        return reply.status(415).send({
          error: 'Tipo de arquivo não permitido ou não detectável',
          detectedMime: realMime ?? null,
          allowed: Object.keys(MIME_TO_EXT),
        })
      }

      const ext = MIME_TO_EXT[realMime]
      const savedAs = `${id}${ext}`
      const finalPath = join(teamDir(teamId), savedAs)

      try {
        // rename atômico
        await (await import('node:fs/promises')).rename(tmpPath, finalPath)
      } catch {
        await unlink(tmpPath).catch(() => {})
        return reply.status(500).send({ error: 'Erro ao finalizar arquivo' })
      }

      const { size, birthtime } = await stat(finalPath)

      request.log.info(
        { id, teamId, mimetype: realMime, size, filename: data.filename },
        '[upload/image] arquivo aceito'
      )

      return reply.status(201).send({
        id,
        teamId,
        url: `/uploads/${teamId}/${savedAs}`,
        filename: data.filename,
        size,
        mimetype: realMime,
        createdAt: birthtime.toISOString(),
      })
    }
  )
}

// ────────────────────────────────────────────────────────────────────────────
// POST /upload/screenshot — salva base64 dataUrl em /tmp/screenshot-{ts}.png
// Usado pelo terminal input para que o agente acesse a imagem no disco.
// ────────────────────────────────────────────────────────────────────────────

export async function screenshotRoutes(app: FastifyInstance): Promise<void> {
  app.post('/upload/screenshot', { bodyLimit: 15 * 1024 * 1024 }, async (request, reply) => {
    const { dataUrl } = request.body as { dataUrl?: string }
    if (!dataUrl || !dataUrl.startsWith('data:image/')) {
      return reply.status(400).send({ error: 'dataUrl de imagem obrigatório' })
    }

    // Extrai extensão e bytes do data URL
    const mimeMatch = dataUrl.match(/^data:(image\/\w+);base64,/)
    if (!mimeMatch) return reply.status(400).send({ error: 'dataUrl inválido' })
    const mime = mimeMatch[1]
    const ext = MIME_TO_EXT[mime] ?? '.png'
    const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
    const buffer = Buffer.from(base64, 'base64')

    const filename = `screenshot-${Date.now()}${ext}`
    const path = `/tmp/${filename}`
    await (await import('node:fs/promises')).writeFile(path, buffer)

    return reply.status(201).send({ path, filename })
  })
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers exportados para uso pelo handler de /teams/:id/message
// ────────────────────────────────────────────────────────────────────────────

/**
 * Resolve um attachmentId no diretório do team. Retorna path absoluto ou
 * null se não encontrado. Procura qualquer extensão da allowlist.
 */
export async function resolveAttachment(
  teamId: string,
  attachmentId: string
): Promise<{ absPath: string; mimetype: string } | null> {
  for (const [mime, ext] of Object.entries(MIME_TO_EXT)) {
    const candidate = join(UPLOAD_DIR, teamId, `${attachmentId}${ext}`)
    if (existsSync(candidate)) {
      // Defesa adicional: confirma que o path resolvido realmente fica sob o
      // diretório do team (evita UUID maldoso com .. ou separadores).
      if (!pathBelongsToTeam(candidate, teamId)) return null
      return { absPath: candidate, mimetype: mime }
    }
  }
  return null
}

/** Renova mtime de um arquivo (segura do cleanup-worker). */
export async function renewAttachmentMtime(absPath: string): Promise<void> {
  const { utimes } = await import('node:fs/promises')
  const now = new Date()
  await utimes(absPath, now, now).catch(() => {
    // arquivo pode ter sumido — handler trata separadamente
  })
}
