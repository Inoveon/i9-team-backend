/**
 * cleanup-logic.test.ts — valida a função `cleanOnce` recursiva (Onda 5).
 * Importa de `cleanup-logic.ts` — módulo PURO sem BullMQ/Redis.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, utimesSync, rmSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'

import { cleanOnce, MAX_AGE_MS } from './cleanup-logic.js'

const TEST_UPLOAD_DIR = join(tmpdir(), 'i9-team-cleanup-test-' + Date.now())
mkdirSync(TEST_UPLOAD_DIR, { recursive: true })

function touchAgedFile(path: string, ageMs: number): void {
  // Garante que o diretório do arquivo existe — cleanup pode ter removido
  // subdirs vazios de iterações anteriores da mesma suite.
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, 'conteudo')
  const t = new Date(Date.now() - ageMs)
  utimesSync(path, t, t)
}

describe('cleanup-worker — cleanOnce recursivo com TTL 48h', () => {
  const teamA = 'team-A'
  const teamB = 'team-B'

  before(() => {
    mkdirSync(join(TEST_UPLOAD_DIR, teamA), { recursive: true })
    mkdirSync(join(TEST_UPLOAD_DIR, teamB), { recursive: true })
  })

  after(() => {
    rmSync(TEST_UPLOAD_DIR, { recursive: true, force: true })
  })

  it('MAX_AGE_MS é 48h', () => {
    assert.equal(MAX_AGE_MS, 48 * 60 * 60 * 1000)
  })

  it('remove arquivo expirado em subdir de team', () => {
    const oldFile = join(TEST_UPLOAD_DIR, teamA, 'expired-aaa.png')
    touchAgedFile(oldFile, 50 * 60 * 60 * 1000) // 50h — expirado

    const r = cleanOnce(TEST_UPLOAD_DIR)
    assert.ok(r.removedFiles >= 1)
    assert.equal(existsSync(oldFile), false)
  })

  it('preserva arquivo dentro do TTL', () => {
    const freshFile = join(TEST_UPLOAD_DIR, teamA, 'fresh-bbb.png')
    touchAgedFile(freshFile, 10 * 60 * 1000) // 10min — fresco

    cleanOnce(TEST_UPLOAD_DIR)
    assert.equal(existsSync(freshFile), true)
  })

  it('remove diretório de team se ficou vazio após limpeza', () => {
    const emptyTeam = 'team-empty'
    const dir = join(TEST_UPLOAD_DIR, emptyTeam)
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'old.png')
    touchAgedFile(file, 100 * 60 * 60 * 1000) // muito velho

    const r = cleanOnce(TEST_UPLOAD_DIR)
    assert.ok(r.removedFiles >= 1)
    assert.ok(r.removedDirs >= 1)
    assert.equal(existsSync(dir), false)
  })

  it('preserva diretório de team com arquivos frescos mesmo com velhos dentro', () => {
    const mixTeam = 'team-mixed'
    const dir = join(TEST_UPLOAD_DIR, mixTeam)
    mkdirSync(dir, { recursive: true })
    const old = join(dir, 'old-ccc.png')
    const fresh = join(dir, 'fresh-ddd.png')
    touchAgedFile(old, 100 * 60 * 60 * 1000)
    touchAgedFile(fresh, 1000)

    cleanOnce(TEST_UPLOAD_DIR)
    assert.equal(existsSync(old), false)
    assert.equal(existsSync(fresh), true)
    assert.equal(existsSync(dir), true)
  })

  it('remove arquivos legados na raiz (pré-Onda 5)', () => {
    const legacy = join(TEST_UPLOAD_DIR, 'legacy-eee.png')
    touchAgedFile(legacy, 100 * 60 * 60 * 1000)

    const r = cleanOnce(TEST_UPLOAD_DIR)
    assert.ok(r.removedFiles >= 1)
    assert.equal(existsSync(legacy), false)
  })
})
