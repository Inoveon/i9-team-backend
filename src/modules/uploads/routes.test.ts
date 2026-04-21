/**
 * uploads/routes.test.ts — valida os pilares de segurança/contrato da Onda 5:
 *   - pathBelongsToTeam (ownership / path traversal)
 *   - resolveAttachment (busca em subdir do team)
 *   - renewAttachmentMtime (segura do cleanup)
 *   - magic bytes via file-type (rejeita arquivo falso)
 *
 * NÃO testa o handler HTTP diretamente — isso exigiria stack completo com
 * Prisma/auth. Foco em lógica testável em isolado.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, rmSync, existsSync, statSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileTypeFromBuffer } from 'file-type'

// UPLOAD_DIR precisa estar setado ANTES de importar o módulo
const TEST_UPLOAD_DIR = join(tmpdir(), 'i9-team-uploads-test-' + Date.now())
process.env.UPLOAD_DIR = TEST_UPLOAD_DIR
mkdirSync(TEST_UPLOAD_DIR, { recursive: true })

const { pathBelongsToTeam, resolveAttachment, renewAttachmentMtime } = await import('./routes.js')

// Helpers — bytes mínimos de PNG válido e arquivo "falso"
// PNG signature: 89 50 4E 47 0D 0A 1A 0A + IHDR (13 bytes)
const VALID_PNG_HEADER = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00,
])

// "payload" apenas com texto — não é imagem
const FAKE_IMAGE = Buffer.from('Isso é só texto pretendendo ser imagem\n')

describe('pathBelongsToTeam — ownership e defesa contra path traversal', () => {
  const teamId = 'team-xyz'

  it('aceita path dentro do subdir do team', () => {
    const p = join(TEST_UPLOAD_DIR, teamId, 'abc.png')
    assert.equal(pathBelongsToTeam(p, teamId), true)
  })

  it('aceita o próprio diretório do team', () => {
    const p = join(TEST_UPLOAD_DIR, teamId)
    assert.equal(pathBelongsToTeam(p, teamId), true)
  })

  it('rejeita path com .. tentando escapar', () => {
    const p = join(TEST_UPLOAD_DIR, teamId, '..', 'outro-team', 'vazado.png')
    assert.equal(pathBelongsToTeam(p, teamId), false)
  })

  it('rejeita path de team diferente', () => {
    const p = join(TEST_UPLOAD_DIR, 'team-malicioso', 'abc.png')
    assert.equal(pathBelongsToTeam(p, teamId), false)
  })

  it('rejeita path fora do UPLOAD_DIR completamente', () => {
    const p = '/etc/passwd'
    assert.equal(pathBelongsToTeam(p, teamId), false)
  })

  it('rejeita separador duplicado + .. (normalização)', () => {
    const p = join(TEST_UPLOAD_DIR, teamId, '..', teamId, 'abc.png')
    // depois de resolve, esse path volta PRA dentro do team → aceita.
    // Isso é coerente — o que matamos é SAIR do subdir.
    assert.equal(pathBelongsToTeam(p, teamId), true)
  })
})

describe('resolveAttachment — busca em subdir e impede colisão inter-team', () => {
  const teamA = 'team-A'
  const teamB = 'team-B'
  const uuid = '11111111-1111-4111-8111-111111111111'

  before(() => {
    mkdirSync(join(TEST_UPLOAD_DIR, teamA), { recursive: true })
    mkdirSync(join(TEST_UPLOAD_DIR, teamB), { recursive: true })
    writeFileSync(join(TEST_UPLOAD_DIR, teamA, `${uuid}.png`), VALID_PNG_HEADER)
  })

  after(() => {
    rmSync(join(TEST_UPLOAD_DIR, teamA), { recursive: true, force: true })
    rmSync(join(TEST_UPLOAD_DIR, teamB), { recursive: true, force: true })
  })

  it('encontra o arquivo no team correto', async () => {
    const r = await resolveAttachment(teamA, uuid)
    assert.ok(r, 'deve encontrar arquivo no teamA')
    assert.equal(r!.mimetype, 'image/png')
    assert.ok(r!.absPath.endsWith(`${teamA}/${uuid}.png`))
  })

  it('retorna null quando buscado no team errado (ownership implícita)', async () => {
    const r = await resolveAttachment(teamB, uuid)
    assert.equal(r, null, 'não deve vazar anexo de outro team')
  })

  it('retorna null para uuid inexistente', async () => {
    const r = await resolveAttachment(teamA, '00000000-0000-4000-8000-000000000000')
    assert.equal(r, null)
  })

  it('retorna null para uuid com path traversal', async () => {
    const r = await resolveAttachment(teamA, '../outro/vazado')
    assert.equal(r, null)
  })
})

describe('renewAttachmentMtime — segura do cleanup', () => {
  const teamId = 'team-mtime'
  const uuid = '22222222-2222-4222-8222-222222222222'
  const filePath = join(TEST_UPLOAD_DIR, teamId, `${uuid}.png`)

  before(() => {
    mkdirSync(join(TEST_UPLOAD_DIR, teamId), { recursive: true })
    writeFileSync(filePath, VALID_PNG_HEADER)
    // Força mtime antigo (48h atrás + margem)
    const past = new Date(Date.now() - 50 * 60 * 60 * 1000)
    utimesSync(filePath, past, past)
  })

  after(() => {
    rmSync(join(TEST_UPLOAD_DIR, teamId), { recursive: true, force: true })
  })

  it('renova mtime para próximo de agora', async () => {
    const before = statSync(filePath).mtimeMs
    await renewAttachmentMtime(filePath)
    const after = statSync(filePath).mtimeMs
    const now = Date.now()
    assert.ok(after > before, `mtime deve ter crescido (antes=${before}, depois=${after})`)
    // depois deve estar próximo de agora (margem 5s)
    assert.ok(Math.abs(now - after) < 5000, 'mtime deve ficar próximo de agora')
  })

  it('não lança erro se arquivo sumir em paralelo', async () => {
    const missing = join(TEST_UPLOAD_DIR, 'team-nao-existe', 'x.png')
    await assert.doesNotReject(() => renewAttachmentMtime(missing))
  })
})

describe('magic bytes — file-type valida MIME real', () => {
  it('detecta PNG válido pelo header', async () => {
    const detected = await fileTypeFromBuffer(VALID_PNG_HEADER)
    assert.equal(detected?.mime, 'image/png')
  })

  it('rejeita arquivo de texto "fake" (nenhum MIME conhecido)', async () => {
    const detected = await fileTypeFromBuffer(FAKE_IMAGE)
    // file-type retorna undefined pra conteúdo não reconhecido
    assert.equal(detected, undefined)
  })

  it('não confunde PNG renomeado como .jpg — detecta o MIME real', async () => {
    const detected = await fileTypeFromBuffer(VALID_PNG_HEADER)
    // Mesmo que o usuário mande "malicioso.jpg", o magic bytes vê PNG
    assert.equal(detected?.mime, 'image/png')
    assert.notEqual(detected?.mime, 'image/jpeg')
  })
})

describe('cleanup do TEST_UPLOAD_DIR', () => {
  after(() => {
    try {
      rmSync(TEST_UPLOAD_DIR, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  it('sanidade — diretório de teste limpo ao final da suite', () => {
    assert.ok(existsSync(TEST_UPLOAD_DIR))
  })
})
