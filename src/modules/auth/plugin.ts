import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { config } from '../../config.js'

export async function authPlugin(app: FastifyInstance) {
  app.post('/auth/login', async (request, reply) => {
    const schema = z.object({
      username: z.string(),
      password: z.string(),
    })
    const parsed = schema.safeParse(request.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid body' })
    }

    const { username, password } = parsed.data
    if (username !== config.appUser || password !== config.appPassword) {
      return reply.status(401).send({ error: 'Invalid credentials' })
    }

    const token = app.jwt.sign({ sub: username }, { expiresIn: '24h' })
    return { access_token: token }
  })
}
