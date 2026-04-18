import { readFileSync, existsSync } from 'node:fs'
import { config } from '../../config.js'
import { prisma } from '../../lib/prisma.js'

// Estrutura do ~/.claude/teams.json
interface TeamsFileAgent {
  name: string
  dir: string
}

interface TeamsFileTeam {
  name: string
  orchestrator: string
  agents: TeamsFileAgent[]
}

interface TeamsFileProject {
  name: string
  root: string
  teams: TeamsFileTeam[]
}

interface TeamsFile {
  version: string
  projects: TeamsFileProject[]
}

/**
 * Lê ~/.claude/teams.json e faz upsert no PostgreSQL.
 * Chave única de Team: "projeto/team" (ex: "i9-team/dev")
 * Chave única de Agent: teamId + name
 */
export async function syncTeamsFromConfig(): Promise<void> {
  if (!existsSync(config.teamsJsonPath)) {
    console.warn(`[sync] teams.json não encontrado em: ${config.teamsJsonPath}`)
    return
  }

  let file: TeamsFile
  try {
    const raw = readFileSync(config.teamsJsonPath, 'utf8')
    file = JSON.parse(raw) as TeamsFile
  } catch (err) {
    console.error('[sync] Erro ao ler/parsear teams.json:', err)
    return
  }

  let teamsUpserted = 0
  let agentsUpserted = 0

  for (const project of file.projects) {
    for (const team of project.teams) {
      const teamKey = `${project.name}/${team.name}`

      // Upsert Team
      const dbTeam = await prisma.team.upsert({
        where: { name: teamKey },
        update: {
          description: `Projeto: ${project.name} | Root: ${project.root}`,
        },
        create: {
          name: teamKey,
          description: `Projeto: ${project.name} | Root: ${project.root}`,
        },
      })
      teamsUpserted++

      // Upsert Agents
      for (const agent of team.agents) {
        const isOrchestrator = agent.name === team.orchestrator
        const role = isOrchestrator ? 'orchestrator' : 'agent'

        // Convenção de nome de sessão tmux:
        //   orquestrador → projeto-team-orquestrador
        //   agente       → projeto-team-nome-do-agente
        const sessionSuffix = isOrchestrator ? 'orquestrador' : agent.name
        const sessionName = `${project.name}-${team.name}-${sessionSuffix}`

        await prisma.agent.upsert({
          where: {
            teamId_name: { teamId: dbTeam.id, name: agent.name },
          },
          update: { sessionName, role },
          create: {
            teamId: dbTeam.id,
            name: agent.name,
            role,
            sessionName,
          },
        })
        agentsUpserted++
      }
    }
  }

  console.log(
    `[sync] teams.json sincronizado: ${teamsUpserted} teams, ${agentsUpserted} agentes`
  )
}
