import { readFileSync, existsSync } from 'fs'
import { execSync } from 'child_process'
import { config } from '../../config.js'

interface TeamAgent {
  name: string
  session: string
}

interface TeamConfig {
  name: string
  agents: TeamAgent[]
  startScript?: string
  stopScript?: string
}

interface TeamsJson {
  [project: string]: {
    [team: string]: TeamConfig
  }
}

export function loadTeamsConfig(): TeamsJson {
  if (!existsSync(config.teamsJsonPath)) {
    return {}
  }
  const raw = readFileSync(config.teamsJsonPath, 'utf8')
  return JSON.parse(raw) as TeamsJson
}

export function startTeam(project: string, team: string): { ok: boolean; message: string } {
  const teams = loadTeamsConfig()
  const teamConfig = teams[project]?.[team]
  if (!teamConfig) {
    return { ok: false, message: `Team ${project}/${team} not found` }
  }
  if (teamConfig.startScript) {
    execSync(`bash "${teamConfig.startScript}"`, { stdio: 'inherit' })
  }
  return { ok: true, message: `Team ${project}/${team} started` }
}

export function stopTeam(project: string, team: string): { ok: boolean; message: string } {
  const teams = loadTeamsConfig()
  const teamConfig = teams[project]?.[team]
  if (!teamConfig) {
    return { ok: false, message: `Team ${project}/${team} not found` }
  }
  if (teamConfig.stopScript) {
    execSync(`bash "${teamConfig.stopScript}"`, { stdio: 'inherit' })
  }
  return { ok: true, message: `Team ${project}/${team} stopped` }
}
