import type { FastifyInstance } from 'fastify'
import { readdir, readFile } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'

interface AuditEvent {
  id: string
  ts: string
  type: string
  project?: string
  team?: string
  from?: string
  to?: string
  corr_id?: string
  summary?: string
  payload?: unknown
}

function parseEvent(line: string): AuditEvent | null {
  try {
    const raw = JSON.parse(line) as Record<string, unknown>
    return {
      id: (raw.msg_id as string) ?? (raw.corr_id as string) ?? Math.random().toString(36).slice(2),
      ts: (raw.executed_at as string) ?? (raw.ts as string) ?? new Date().toISOString(),
      type: (raw.kind as string) ?? (raw.type as string) ?? 'event',
      project: raw.project as string | undefined,
      team: raw.team as string | undefined,
      from: (raw.from_agent as string) ?? (raw.from as string) ?? undefined,
      to: (raw.to_agent as string) ?? (raw.to as string) ?? undefined,
      corr_id: raw.corr_id as string | undefined,
      summary: raw.summary as string | undefined,
      payload: raw,
    }
  } catch {
    return null
  }
}

async function loadEvents(): Promise<AuditEvent[]> {
  const eventsDir = join(homedir(), '.claude', 'team-events')
  let files: string[]
  try {
    files = await readdir(eventsDir)
  } catch {
    return []
  }

  const jsonlFiles = files.filter((f) => f.endsWith('.jsonl'))
  const allEvents: AuditEvent[] = []

  await Promise.all(
    jsonlFiles.map(async (file) => {
      try {
        const content = await readFile(join(eventsDir, file), 'utf-8')
        const lines = content.split('\n').filter((l) => l.trim())
        for (const line of lines) {
          const ev = parseEvent(line)
          if (ev) allEvents.push(ev)
        }
      } catch {
        // skip unreadable files
      }
    })
  )

  // Sort by ts descending
  allEvents.sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime())
  return allEvents
}

export async function auditRoutes(app: FastifyInstance) {
  // GET /audit/events
  app.get('/audit/events', async (request, reply) => {
    const query = request.query as {
      project?: string
      team?: string
      type?: string
      limit?: string
      offset?: string
    }

    const limit = Math.min(parseInt(query.limit ?? '200', 10) || 200, 1000)
    const offset = parseInt(query.offset ?? '0', 10) || 0

    let events = await loadEvents()

    if (query.project) {
      events = events.filter((e) => e.project === query.project)
    }
    if (query.team) {
      events = events.filter((e) => e.team === query.team)
    }
    if (query.type) {
      events = events.filter((e) => e.type === query.type)
    }

    const total = events.length
    const page = events.slice(offset, offset + limit)

    return reply.send({ events: page, total, hasMore: offset + limit < total })
  })

  // GET /audit/export?format=csv
  app.get('/audit/export', async (request, reply) => {
    const query = request.query as {
      project?: string
      team?: string
      type?: string
      format?: string
    }

    let events = await loadEvents()

    if (query.project) events = events.filter((e) => e.project === query.project)
    if (query.team) events = events.filter((e) => e.team === query.team)
    if (query.type) events = events.filter((e) => e.type === query.type)

    const header = 'id,ts,type,project,team,from,to,corr_id,summary\n'
    const rows = events
      .map((e) =>
        [
          e.id,
          e.ts,
          e.type,
          e.project ?? '',
          e.team ?? '',
          e.from ?? '',
          e.to ?? '',
          e.corr_id ?? '',
          `"${(e.summary ?? '').replace(/"/g, '""')}"`,
        ].join(',')
      )
      .join('\n')

    const csv = header + rows
    void reply.header('Content-Type', 'text/csv')
    void reply.header('Content-Disposition', 'attachment; filename="audit-events.csv"')
    return reply.send(csv)
  })
}
