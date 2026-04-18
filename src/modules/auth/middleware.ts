import type { FastifyRequest, FastifyReply } from 'fastify'

export async function authMiddleware(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const authHeader = request.headers.authorization
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    reply.code(401).send({ error: 'Unauthorized', message: 'Token Bearer obrigatório' })
    return
  }

  const token = authHeader.slice(7)
  try {
    // @ts-ignore — fastify-jwt decora a instância
    await request.jwtVerify()
  } catch {
    reply.code(401).send({ error: 'Unauthorized', message: 'Token inválido ou expirado' })
  }
}
