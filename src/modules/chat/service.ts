import { prisma } from '../../lib/prisma.js'

export interface ChatMessageData {
  id: string
  teamId: string
  agentId: string | null
  role: string
  content: string
  createdAt: Date
}

export async function createMessage(params: {
  teamId: string
  agentId?: string
  role: 'user' | 'agent' | 'system'
  content: string
}): Promise<ChatMessageData> {
  return prisma.chatMessage.create({
    data: {
      teamId: params.teamId,
      agentId: params.agentId ?? null,
      role: params.role,
      content: params.content,
    },
  })
}

export async function listMessages(params: {
  teamId: string
  limit?: number
  before?: string // cursor: id da mensagem mais antiga já carregada
}): Promise<ChatMessageData[]> {
  const { teamId, limit = 50, before } = params

  return prisma.chatMessage.findMany({
    where: {
      teamId,
      ...(before ? { id: { lt: before } } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
  })
}
