const express = require('express')
const { execSync } = require('child_process')
const { createClient } = require('@supabase/supabase-js')
const fs = require('fs')
const https = require('https')
const http = require('http')

const app = express()
app.use(express.json({ limit: '10mb' }))

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const MERGE_API_KEY = process.env.MERGE_API_KEY

const sb = createClient(SUPABASE_URL, SUPABASE_KEY)

async function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest)
    const get = url.startsWith('https') ? https.get : http.get
    get(url, res => {
      res.pipe(file)
      file.on('finish', () => { file.close(); resolve() })
    }).on('error', reject)
  })
}

async function uploadToSupabase(filePath, storagePath) {
  const fileSize = fs.statSync(filePath).size
  const sizeMB = (fileSize / 1024 / 1024).toFixed(1)
  console.log(`[upload] ${storagePath} — ${sizeMB} MB`)
  const buffer = fs.readFileSync(filePath)
  const url = `${SUPABASE_URL}/storage/v1/object/aura-videos/${storagePath}`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'video/mp4',
      'x-upsert': 'true',
      'Content-Length': String(buffer.length),
    },
    body: buffer,
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error('Storage upload: ' + err)
  }
  return `${SUPABASE_URL}/storage/v1/object/public/aura-videos/${storagePath}`
}

function getDuration(filePath) {
  try {
    const out = execSync(
      `ffprobe -v quiet -print_format json -show_streams "${filePath}"`,
      { stdio: ['pipe', 'pipe', 'pipe'] }
    ).toString()
    const streams = JSON.parse(out).streams
    for (const s of streams) {
      if (s.duration) return parseFloat(s.duration)
    }
  } catch (e) {
    console.log(`[duration] error: ${e.message}`)
  }
  return 0
}

app.use((req, res, next) => {
  const auth = req.headers.authorization
  if (!auth || auth !== 'Bearer ' + MERGE_API_KEY) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' })
  }
  next()
})

app.post('/merge', async (req, res) => {
  const { job_id, clip_urls, audio_url } = req.body
  if (!job_id || !clip_urls?.length || !audio_url) {
    return res.status(400).json({ ok: false, error: 'job_id, clip_urls, audio_url vaaditaan' })
  }

  res.status(202).json({ ok: true, job_id, status: 'processing' })

  const tmp = `/tmp/job_${job_id}`
  fs.mkdirSync(tmp, { recursive: true })

  try {
    console.log(`[merge] START job ${job_id} — ${clip_urls.length} clips`)

    for (let i = 0; i < clip_urls.length; i++) {
      await download(clip_urls[i], `${tmp}/clip${i}.mp4`)
      console.log(`[merge] clip ${i + 1}/${clip_urls.length} ladattu`)
    }

    await download(audio_url, `${tmp}/audio.mp3`)
    console.log(`[merge] audio ladattu`)

    const concatFile = `${tmp}/concat.txt`
    fs.writeFileSync(concatFile, clip_urls.map((_, i) => `file '${tmp}/clip${i}.mp4'`).join('\n'))

    // Laske audion ja videon kestot
    const audioDuration = getDuration(`${tmp}/audio.mp3`)
    const videoDuration = clip_urls.length * 5 // 5s per clip
    const padNeeded = Math.max(0, Math.ceil(audioDuration - videoDuration) + 3) // +3s buffer
    console.log(`[merge] audio: ${audioDuration.toFixed(1)}s, video: ${videoDuration}s, pad: ${padNeeded}s`)

    // Vaihe 1: yhdista klipsit + lisaa freeze-frame
    console.log(`[merge] vaihe 1 — concat + tpad ${padNeeded}s...`)
    execSync(
      `ffmpeg -y -f concat -safe 0 -i ${concatFile} ` +
      `-vf "tpad=stop_mode=clone:stop_duration=${padNeeded}" ` +
      `-c:v libx264 -crf 32 -preset ultrafast ` +
      `${tmp}/video_padded.mp4`,
      { timeout: 180000, stdio: 'pipe' }
    )

    // Vaihe 2: yhdista padded video + audio — video on nyt pidempi kuin audio
    console.log(`[merge] vaihe 2 — yhdista audio...`)
    execSync(
      `ffmpeg -y -i ${tmp}/video_padded.mp4 -i ${tmp}/audio.mp3 ` +
      `-map 0:v -map 1:a ` +
      `-c:v copy -c:a aac -b:a 96k -shortest ` +
      `${tmp}/final.mp4`,
      { timeout: 120000, stdio: 'pipe' }
    )

    const finalSize = (fs.statSync(`${tmp}/final.mp4`).size / 1024 / 1024).toFixed(1)
    const finalDuration = getDuration(`${tmp}/final.mp4`)
    console.log(`[merge] ffmpeg done — ${finalSize} MB, ${finalDuration.toFixed(1)}s`)

    const storagePath = `merged/job_${job_id}_final.mp4`
    const publicUrl = await uploadToSupabase(`${tmp}/final.mp4`, storagePath)

    await sb.from('video_jobs').update({
      status: 'merged',
      merged_video_url: publicUrl,
      updated_at: new Date().toISOString()
    }).eq('id', job_id)

    console.log(`[merge] DONE — ${publicUrl}`)
  } catch (err) {
    console.error(`[merge] ERROR job ${job_id}:`, err.message)
    await sb.from('video_jobs').update({
      status: 'done',
      updated_at: new Date().toISOString()
    }).eq('id', job_id)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

app.get('/health', (_, res) => res.json({ ok: true, service: 'aura-merge' }))

app.listen(process.env.PORT || 3000, () => {
  console.log(`Merge service running on port ${process.env.PORT || 3000}`)
})
