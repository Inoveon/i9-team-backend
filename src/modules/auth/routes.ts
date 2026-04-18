import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
})

// Credenciais padrão de desenvolvimento — substituir por banco em produção
const ADMIN_USER = process.env.ADMIN_USER ?? 'admin'
const ADMIN_PASS = process.env.ADMIN_PASS ?? 'i9team2024'

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post('/auth/login', async (request, reply) => {
    const result = loginSchema.safeParse(request.body)
    if (!result.success) {
      return reply.code(400).send({ error: 'Bad Request', details: result.error.flatten() })
    }

    const { username, password } = result.data
    if (username !== ADMIN_USER || password !== ADMIN_PASS) {
      return reply.code(401).send({ error: 'Credenciais inválidas' })
    }

    // @ts-ignore — fastify-jwt decora a instância
    const token = app.jwt.sign({ sub: username, role: 'admin' }, { expiresIn: '24h' })
    return reply.send({ token, expiresIn: '24h' })
  })
}
