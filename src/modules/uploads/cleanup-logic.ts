/**
 * cleanup-logic.ts — Lógica pura de limpeza de uploads expirados.
 *
 * Separado do `cleanup-worker.ts` (que importa BullMQ e abre conexão Redis
 * no load do módulo) pra permitir testes unitários sem dependência externa.
 */
import { readdirSync, statSync, unlinkSync, existsSync, mkdirSync, rmdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * TTL dos uploads — 48h (elevado de 24h na Onda 5 / Issue #3).
 * O handler de /teams/:id/message renova mtime a cada uso via
 * `renewAttachmentMtime`, permitindo que anexos reusados sobrevivam
 * indefinidamente enquanto o usuário engajar com eles.
 */
export const MAX_AGE_MS = 48 * 60 * 60 * 1000

export interface CleanReport {
  removedFiles: number
  scanned: number
  removedDirs: number
}

/**
 * Remove arquivos expirados em UPLOAD_DIR/{teamId}/*. Diretórios de team que
 * ficam vazios após a limpeza são também removidos.
 *
 * Também trata arquivos legados na raiz de UPLOAD_DIR (pré-Onda 5).
 */
export function cleanOnce(uploadDir: string, maxAgeMs: number = MAX_AGE_MS): CleanReport {
  if (!existsSync(uploadDir)) {
    mkdirSync(uploadDir, { recursive: true })
    return { removedFiles: 0, scanned: 0, removedDirs: 0 }
  }

  const now = Date.now()
  let removedFiles = 0
  let scanned = 0
  let removedDirs = 0

  const topEntries = readdirSync(uploadDir)

  for (const entry of topEntries) {
    const entryPath = join(uploadDir, entry)
    let entryStat
    try {
      entryStat = statSync(entryPath)
    } catch {
      continue
    }

    if (entryStat.isDirectory()) {
      let files: string[] = []
      try {
        files = readdirSync(entryPath)
      } catch {
        continue
      }

      for (const file of files) {
        const filepath = join(entryPath, file)
        scanned++
        try {
          const age = now - statSync(filepath).mtimeMs
          if (age > maxAgeMs) {
            unlinkSync(filepath)
            removedFiles++
          }
        } catch {
          // arquivo sumiu em paralelo
        }
      }

      try {
        if (readdirSync(entryPath).length === 0) {
          rmdirSync(entryPath)
          removedDirs++
        }
      } catch {
        // permissões / corrida — ignora
      }
    } else if (entryStat.isFile()) {
      scanned++
      try {
        const age = now - entryStat.mtimeMs
        if (age > maxAgeMs) {
          unlinkSync(entryPath)
          removedFiles++
        }
      } catch {
        // ignora
      }
    }
  }

  return { removedFiles, scanned, removedDirs }
}
