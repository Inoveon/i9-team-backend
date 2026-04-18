import type { FastifyInstance } from 'fastify'
import { createWriteStream, mkdirSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { randomUUID } from 'node:crypto'
import { extname } from 'node:path'

const UPLOAD_DIR = process.env.UPLOAD_DIR ?? '/tmp/i9-team-uploads'
const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10 MB

const ALLOWED_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
])

// Garantir que o diretório existe
mkdirSync(UPLOAD_DIR, { recursive: true })

export async function uploadsRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /upload/image — recebe imagem via multipart/form-data
   * Campo: file
   * Retorna: { id, url, filename, size, mimetype, createdAt }
   */
  app.post('/upload/image', async (request, reply) => {
    const data = await request.file({ limits: { fileSize: MAX_FILE_SIZE } })

    if (!data) {
      return reply.status(400).send({ error: 'Nenhum arquivo enviado' })
    }

    if (!ALLOWED_MIME.has(data.mimetype)) {
      return reply.status(415).send({
        error: 'Tipo de arquivo não permitido',
        allowed: [...ALLOWED_MIME],
      })
    }

    const ext = extname(data.filename) || '.bin'
    const id = randomUUID()
    const savedAs = `${id}${ext}`
    const filepath = `${UPLOAD_DIR}/${savedAs}`

    try {
      await pipeline(data.file, createWriteStream(filepath))
    } catch {
      return reply.status(500).send({ error: 'Erro ao salvar arquivo' })
    }

    if (data.file.truncated) {
      return reply.status(413).send({ error: `Arquivo excede ${MAX_FILE_SIZE / 1024 / 1024}MB` })
    }

    const { size, birthtime } = await stat(filepath)

    return reply.status(201).send({
      id,
      url: `/uploads/${savedAs}`,
      filename: data.filename,
      size,
      mimetype: data.mimetype,
      createdAt: birthtime.toISOString(),
    })
  })
}
