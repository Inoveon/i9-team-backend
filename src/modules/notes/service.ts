/**
 * notes/service.ts — CRUD de notas markdown do team.
 *
 * Path canônico: <vaultBase>/teams/<projeto>/<team>/<name>.md
 *   - vaultBase: process.env.VAULT_PATH ?? fallback
 *   - projeto/team: derivados de `Team.name` ("projeto/team")
 *
 * Regras:
 *   - Backup automático em writeNote (.bak.<unixtime>.md) antes de sobrescrever
 *   - Soft delete via rename para .deleted.<unixtime>.md
 *   - Listagem ignora backups, deletados e diretórios
 *   - ETag = sha256(content) para controle de concorrência otimista
 */
import {
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

// ────────────────────────────────────────────────────────────────────────────
// Config
// ────────────────────────────────────────────────────────────────────────────

const VAULT_BASE =
  process.env.VAULT_PATH ??
  '/home/ubuntu/Projetos/inoveon/producao/i9_smart_pdv_web/.memory'

/** Limite de tamanho de conteúdo (1 MB) */
export const MAX_CONTENT_SIZE = 1_048_576

/** Nome válido: começa com [a-z0-9], restante [a-z0-9-_], max 100 chars */
export const NAME_RE = /^[a-z0-9][a-z0-9-_]{0,99}$/i

const BAK_RE = /\.bak\.\d+\.md$/
const DEL_RE = /\.deleted\.\d+\.md$/

// ────────────────────────────────────────────────────────────────────────────
// Tipos
// ────────────────────────────────────────────────────────────────────────────

export interface NoteSummary {
  name: string
  size: number
  updatedAt: string
}

export interface NoteFull extends NoteSummary {
  content: string
  etag: string
}

export interface WriteResult {
  name: string
  savedAt: string
  etag: string
  backupPath?: string
}

export type WriteOutcome =
  | { ok: true; result: WriteResult }
  | { ok: false; reason: 'conflict'; currentEtag: string; currentContent: string }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'already_exists' }

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function parseTeamName(teamName: string): { project: string; team: string } | null {
  const idx = teamName.indexOf('/')
  if (idx <= 0 || idx === teamName.length - 1) return null
  return { project: teamName.slice(0, idx), team: teamName.slice(idx + 1) }
}

/** Retorna o diretório absoluto do team ou null se teamName for inválido. */
export function resolveTeamDir(teamName: string): string | null {
  const parsed = parseTeamName(teamName)
  if (!parsed) return null
  return join(VAULT_BASE, 'teams', parsed.project, parsed.team)
}

/** Resolve path do arquivo .md — valida name via regex. */
export function resolveNotePath(teamName: string, name: string): string | null {
  if (!NAME_RE.test(name)) return null
  const dir = resolveTeamDir(teamName)
  if (!dir) return null
  return join(dir, `${name}.md`)
}

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

// ────────────────────────────────────────────────────────────────────────────
// API pública
// ────────────────────────────────────────────────────────────────────────────

/**
 * Lista as notas `.md` do team, descendente por updatedAt. Ignora .bak.*.md,
 * .deleted.*.md, subdiretórios e arquivos não-md.
 */
export function listNotes(teamName: string): NoteSummary[] {
  const dir = resolveTeamDir(teamName)
  if (!dir || !existsSync(dir)) return []

  const out: NoteSummary[] = []
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.md')) continue
    if (BAK_RE.test(entry)) continue
    if (DEL_RE.test(entry)) continue

    const full = join(dir, entry)
    const st = statSync(full)
    if (!st.isFile()) continue

    out.push({
      name: entry.replace(/\.md$/, ''),
      size: st.size,
      updatedAt: st.mtime.toISOString(),
    })
  }

  out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
  return out
}

/**
 * Lê uma nota. Retorna null se a nota não existe ou o name é inválido.
 */
export function readNote(teamName: string, name: string): NoteFull | null {
  const p = resolveNotePath(teamName, name)
  if (!p || !existsSync(p)) return null

  const st = statSync(p)
  if (!st.isFile()) return null

  const content = readFileSync(p, 'utf8')
  return {
    name,
    content,
    size: st.size,
    updatedAt: st.mtime.toISOString(),
    etag: sha256(content),
  }
}

/**
 * Sobrescreve uma nota existente. Com `expectedEtag`, falha com conflict se o
 * etag atual não bater. Faz backup .bak.<unixtime>.md no mesmo diretório.
 * Usado por PUT /teams/:id/notes/:name.
 */
export function writeNote(
  teamName: string,
  name: string,
  content: string,
  expectedEtag?: string
): WriteOutcome {
  const p = resolveNotePath(teamName, name)
  if (!p) return { ok: false, reason: 'not_found' }
  if (!existsSync(p)) return { ok: false, reason: 'not_found' }

  const currentContent = readFileSync(p, 'utf8')
  const currentEtag = sha256(currentContent)

  if (expectedEtag && expectedEtag !== currentEtag) {
    return { ok: false, reason: 'conflict', currentEtag, currentContent }
  }

  // Backup antes de sobrescrever
  const ts = Math.floor(Date.now() / 1000)
  const backupPath = p.replace(/\.md$/, `.bak.${ts}.md`)
  writeFileSync(backupPath, currentContent, 'utf8')

  writeFileSync(p, content, 'utf8')
  const newEtag = sha256(content)
  return {
    ok: true,
    result: {
      name,
      savedAt: new Date().toISOString(),
      etag: newEtag,
      backupPath,
    },
  }
}

/**
 * Cria uma nota nova. Falha com already_exists se já existir.
 * Usado por POST /teams/:id/notes.
 */
export function createNote(
  teamName: string,
  name: string,
  content: string
): WriteOutcome {
  const dir = resolveTeamDir(teamName)
  const p = resolveNotePath(teamName, name)
  if (!dir || !p) return { ok: false, reason: 'not_found' }

  if (existsSync(p)) return { ok: false, reason: 'already_exists' }

  ensureDir(dir)
  writeFileSync(p, content, 'utf8')
  return {
    ok: true,
    result: {
      name,
      savedAt: new Date().toISOString(),
      etag: sha256(content),
    },
  }
}

/**
 * Soft delete — renomeia para .deleted.<unixtime>.md no mesmo diretório.
 * Retorna true se removido, false se não existia.
 */
export function deleteNote(teamName: string, name: string): boolean {
  const p = resolveNotePath(teamName, name)
  if (!p || !existsSync(p)) return false

  const ts = Math.floor(Date.now() / 1000)
  const deletedPath = p.replace(/\.md$/, `.deleted.${ts}.md`)
  renameSync(p, deletedPath)
  return true
}
