/**
 * context/routes.ts — Lê agent-context do vault e expõe como API REST.
 *
 * GET /context/agents → array de { agent, team, project, status, current_focus, last_task_corr_id, updatedAt }
 *
 * Requer JWT (herda o onRequest do bloco protegido em src/index.ts).
 */
import type { FastifyInstance } from 'fastify'
import { readdir, readFile, stat } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentContextEntry {
  agent: string
  team: string
  project: string
  status: string
  current_focus: string
  last_task_corr_id: string | null
  updatedAt: string
}

// ---------------------------------------------------------------------------
// Frontmatter parser (simple key: value, no js-yaml dependency)
// ---------------------------------------------------------------------------

function parseFrontmatter(content: string): Record<string, string> {
  const result: Record<string, string> = {}
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match) return result

  for (const line of match[1].split('\n')) {
    const colonIdx = line.indexOf(':')
    if (colonIdx === -1) continue
    const key = line.slice(0, colonIdx).trim()
    const value = line.slice(colonIdx + 1).trim().replace(/^["']|["']$/g, '')
    if (key) result[key] = value
  }

  return result
}

// ---------------------------------------------------------------------------
// Read all agent-context files from ~/.memory/teams/*/agent-context/*.md
// ---------------------------------------------------------------------------

async function readAllAgentContexts(): Promise<AgentContextEntry[]> {
  const teamsDir = join(homedir(), '.memory', 'teams')
  const entries: AgentContextEntry[] = []

  let teamDirs: string[]
  try {
    teamDirs = await readdir(teamsDir)
  } catch {
    return entries // vault não existe ainda
  }

  for (const teamName of teamDirs) {
    const agentContextDir = join(teamsDir, teamName, 'agent-context')
    let files: string[]
    try {
      files = await readdir(agentContextDir)
    } catch {
      continue
    }

    for (const file of files) {
      if (!file.endsWith('.md')) continue
      const filePath = join(agentContextDir, file)
      try {
        const [content, fileStat] = await Promise.all([
          readFile(filePath, 'utf-8'),
          stat(filePath),
        ])
        const fm = parseFrontmatter(content)

        entries.push({
          agent: fm.agent ?? file.replace('.md', ''),
          team: fm.team ?? teamName,
          project: fm.project ?? '',
          status: fm.status ?? 'offline',
          current_focus: fm.current_focus ?? '',
          last_task_corr_id: fm.last_task_corr_id ?? null,
          updatedAt: fm.last_update ?? fileStat.mtime.toISOString(),
        })
      } catch {
        // arquivo corrompido — ignorar
      }
    }
  }

  return entries
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function contextRoutes(app: FastifyInstance): Promise<void> {
  app.get('/context/agents', async (_request, reply) => {
    const agents = await readAllAgentContexts()
    return reply.send({ agents, total: agents.length })
  })
}
