import { Worker, Queue } from 'bullmq'
import { readdirSync, statSync, unlinkSync, existsSync, mkdirSync } from 'node:fs'
import { config } from '../../config.js'

const UPLOAD_DIR = config.uploadDir
const MAX_AGE_MS = 24 * 60 * 60 * 1000 // 24h

const redisConnection = {
  host: config.redisHost,
  port: config.redisPort,
}

export const cleanupQueue = new Queue('cleanup-uploads', { connection: redisConnection })

/**
 * Worker que remove uploads com mais de 24h — executa a cada 30min.
 */
export function startCleanupWorker(): Worker {
  const worker = new Worker(
    'cleanup-uploads',
    async () => {
      if (!existsSync(UPLOAD_DIR)) {
        mkdirSync(UPLOAD_DIR, { recursive: true })
        return
      }

      const now = Date.now()
      const files = readdirSync(UPLOAD_DIR)
      let removed = 0

      for (const file of files) {
        const filepath = `${UPLOAD_DIR}/${file}`
        try {
          const age = now - statSync(filepath).mtimeMs
          if (age > MAX_AGE_MS) {
            unlinkSync(filepath)
            removed++
          }
        } catch {
          // arquivo pode ter sido removido concorrentemente
        }
      }

      console.log(`[cleanup-uploads] ${removed}/${files.length} arquivos removidos`)
    },
    { connection: redisConnection }
  )

  worker.on('failed', (job, err) => {
    console.error(`[cleanup-uploads] job ${job?.id} falhou:`, err.message)
  })

  console.log('[cleanup-uploads] worker iniciado')
  return worker
}

/**
 * Agenda o job recorrente a cada 30min.
 */
export async function scheduleCleanupJob(): Promise<void> {
  await cleanupQueue.add(
    'cleanup',
    {},
    {
      repeat: { every: 30 * 60 * 1000 }, // 30min
      removeOnComplete: 10,
      removeOnFail: 5,
    }
  )
  console.log('[cleanup-uploads] job agendado (intervalo: 30min)')
}
