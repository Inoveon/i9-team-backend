/**
 * message-schema.test.ts — valida o schema Zod estendido na Onda 5 (Issue #3).
 *
 * Testa apenas o schema — o handler HTTP é testado via curl/e2e em staging
 * (requer Prisma/auth completos).
 *
 * O schema é recriado aqui idêntico ao de `prisma-routes.ts` pra evitar
 * exportar coisa interna só pra teste. Qualquer ajuste lá deve ser refletido
 * aqui (o grep encontra esta nota).
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'

// Cópia fiel do schema em src/modules/teams/prisma-routes.ts:27-41
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

const validUuid = () => '11111111-1111-4111-8111-111111111111'

describe('messageSchema — campo attachmentIds', () => {
  it('aceita mensagem com só texto (compatibilidade com versão anterior)', () => {
    const r = messageSchema.safeParse({ message: 'olá' })
    assert.equal(r.success, true)
  })

  it('aceita só attachmentIds (sem texto) — mensagem só-anexo', () => {
    const r = messageSchema.safeParse({ attachmentIds: [validUuid()] })
    assert.equal(r.success, true)
  })

  it('aceita texto + anexos', () => {
    const r = messageSchema.safeParse({
      message: 'veja isso',
      attachmentIds: [validUuid()],
    })
    assert.equal(r.success, true)
  })

  it('rejeita payload vazio (nem texto nem anexo)', () => {
    const r = messageSchema.safeParse({})
    assert.equal(r.success, false)
  })

  it('rejeita attachmentIds vazio sem texto', () => {
    const r = messageSchema.safeParse({ attachmentIds: [] })
    assert.equal(r.success, false)
  })

  it('rejeita UUID mal formado', () => {
    const r = messageSchema.safeParse({
      message: 'oi',
      attachmentIds: ['não-é-uuid'],
    })
    assert.equal(r.success, false)
  })

  it('rejeita mais de 6 anexos', () => {
    const r = messageSchema.safeParse({
      message: 'oi',
      attachmentIds: Array(7).fill(validUuid()),
    })
    assert.equal(r.success, false)
  })

  it('aceita exatamente 6 anexos (limite inclusivo)', () => {
    const r = messageSchema.safeParse({
      message: 'oi',
      attachmentIds: Array(6).fill(validUuid()),
    })
    assert.equal(r.success, true)
  })

  it('aceita agentId + texto (compat)', () => {
    const r = messageSchema.safeParse({
      agentId: 'agent-xyz',
      message: 'oi',
    })
    assert.equal(r.success, true)
  })

  it('aceita "content" em vez de "message"', () => {
    const r = messageSchema.safeParse({ content: 'usando content' })
    assert.equal(r.success, true)
  })
})
