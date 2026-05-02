import type { FastifyInstance } from 'fastify'
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export type RcStatus = 'active' | 'reconnecting' | 'disconnected' | 'unknown'

interface RcEntry {
  session: string
  agent: string
  project: string
  team: string
  rc_status: RcStatus
}

interface TeamsJson {
  version: string
  projects: Array<{
    name: string
    root: string
    teams: Array<{
      name: string
      orchestrator?: string
      agents: Array<{
        name: string
        role: string
        dir?: string
        client?: string
      }>
    }>
  }>
}

function capturePane(session: string, lines = 80): string | null {
  try {
    return execSync(
      `tmux capture-pane -p -t ${session} -l ${lines} 2>/dev/null`,
      { timeout: 3000, encoding: 'utf8' }
    )
  } catch {
    return null
  }
}

function detectRcStatus(output: string | null): RcStatus {
  if (output === null) return 'unknown'
  if (/reconnecting/i.test(output)) return 'reconnecting'
  if (/remote\s*control/i.test(output)) return 'active'
  return 'disconnected'
}

export async function rcRoutes(app: FastifyInstance) {
  app.get('/rc/status', async (_request, reply) => {
    const teamsPath = join(homedir(), '.claude', 'teams.json')
    let teamsData: TeamsJson
    try {
      teamsData = JSON.parse(readFileSync(teamsPath, 'utf8')) as TeamsJson
    } catch {
      return reply.status(503).send({ error: 'teams.json não encontrado' })
    }

    const results: RcEntry[] = []

    for (const project of teamsData.projects) {
      for (const team of project.teams) {
        const orchestrators = team.agents.filter((a) => a.role === 'orchestrator')
        for (const agent of orchestrators) {
          const session = `${project.name}-${team.name}-${agent.name}`
          const output = capturePane(session)
          const rc_status = detectRcStatus(output)
          results.push({
            session,
            agent: agent.name,
            project: project.name,
            team: team.name,
            rc_status,
          })
        }
      }
    }

    return reply.send({ rc: results })
  })
}
