const express = require('express')
const { execSync, exec } = require('child_process')
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
    const req = get(url, res => {
      if (res.statusCode !== 200) { file.close(); fs.unlinkSync(dest); return reject(new Error(`HTTP ${res.statusCode}`)) }
      res.pipe(file)
      file.on('finish', () => { file.close(); resolve() })
    })
    req.on('error', err => { file.close(); reject(err) })
    req.setTimeout(60000, () => { req.destroy(); reject(new Error('Download timeout')) })
  })
}

async function uploadToSupabase(filePath, storagePath) {
  const stat = fs.statSync(filePath)
  const sizeMB = (stat.size / 1024 / 1024).toFixed(1)
  console.log(`[upload] ${storagePath} — ${sizeMB} MB`)
  if (stat.size > 490 * 1024 * 1024) throw new Error(`File too large: ${sizeMB} MB`)
  const buffer = fs.readFileSync(filePath)
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/aura-audio/${storagePath}`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'audio/mpeg', 'x-upsert': 'true', 'Content-Length': String(buffer.length) },
    body: buffer,
  })
  if (!res.ok) throw new Error('Storage: ' + await res.text())
  return `${SUPABASE_URL}/storage/v1/object/public/aura-audio/${storagePath}`
}

async function uploadVideoToSupabase(filePath, storagePath) {
  const stat = fs.statSync(filePath)
  const sizeMB = (stat.size / 1024 / 1024).toFixed(1)
  console.log(`[upload] ${storagePath} — ${sizeMB} MB`)
  if (stat.size > 490 * 1024 * 1024) throw new Error(`File too large: ${sizeMB} MB`)
  const buffer = fs.readFileSync(filePath)
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/aura-videos/${storagePath}`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'video/mp4', 'x-upsert': 'true', 'Content-Length': String(buffer.length) },
    body: buffer,
  })
  if (!res.ok) throw new Error('Storage: ' + await res.text())
  return `${SUPABASE_URL}/storage/v1/object/public/aura-videos/${storagePath}`
}

app.use((req, res, next) => {
  if (req.headers.authorization !== 'Bearer ' + MERGE_API_KEY)
    return res.status(401).json({ ok: false, error: 'Unauthorized' })
  next()
})

// ============================================================
// POST /merge — Yhdistä klippit + audio
// ============================================================
app.post('/merge', async (req, res) => {
  const { job_id, clip_urls, audio_url } = req.body
  if (!job_id || !clip_urls?.length || !audio_url)
    return res.status(400).json({ ok: false, error: 'Parametrit puuttuu' })

  res.status(202).json({ ok: true, job_id, clips: clip_urls.length, status: 'processing' })

  const tmp = `/tmp/job_${job_id}`
  fs.mkdirSync(tmp, { recursive: true })

  try {
    console.log(`[merge] START ${job_id} — ${clip_urls.length} clips`)

    for (let i = 0; i < clip_urls.length; i++) {
      const dest = `${tmp}/clip${i}.mp4`
      await download(clip_urls[i], dest)
      const size = fs.statSync(dest).size
      if (size < 1000) throw new Error(`clip${i}.mp4 corrupted (${size} bytes)`)
      console.log(`[merge] clip ${i+1}/${clip_urls.length} ok (${(size/1024/1024).toFixed(1)} MB)`)
    }

    await download(audio_url, `${tmp}/audio.mp3`)
    console.log(`[merge] audio ok`)

    // Check stream copy feasibility
    let canStreamCopy = true
    try {
      const probeResults = []
      for (let i = 0; i < clip_urls.length; i++) {
        const probe = execSync(`ffprobe -v quiet -select_streams v:0 -show_entries stream=codec_name,width,height -of json ${tmp}/clip${i}.mp4`, { timeout: 10000 }).toString()
        probeResults.push(JSON.parse(probe).streams[0])
      }
      const ref = probeResults[0]
      for (const p of probeResults) {
        if (p.codec_name !== ref.codec_name || p.width !== ref.width || p.height !== ref.height) { canStreamCopy = false; break }
      }
      console.log(`[merge] stream_copy=${canStreamCopy} (${ref.codec_name} ${ref.width}x${ref.height})`)
    } catch (e) {
      console.log(`[merge] probe failed, fallback: ${e.message}`)
      canStreamCopy = false
    }

    const lines = clip_urls.map((_, i) => `file '${tmp}/clip${i}.mp4'`)
    fs.writeFileSync(`${tmp}/concat.txt`, lines.join('\n'))

    if (canStreamCopy) {
      execSync(`ffmpeg -y -f concat -safe 0 -i ${tmp}/concat.txt -c:v copy -an ${tmp}/video_only.mp4`, { timeout: 120000, stdio: 'pipe' })
      execSync(`ffmpeg -y -i ${tmp}/video_only.mp4 -i ${tmp}/audio.mp3 -c:v copy -c:a aac -b:a 128k -shortest ${tmp}/final.mp4`, { timeout: 60000, stdio: 'pipe' })
      console.log(`[merge] stream copy done`)
    } else {
      execSync(
        `ffmpeg -y -f concat -safe 0 -i ${tmp}/concat.txt -i ${tmp}/audio.mp3 ` +
        `-map 0:v -map 1:a -vf "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2" ` +
        `-c:v libx264 -crf 32 -preset ultrafast -tune fastdecode -c:a aac -b:a 128k -shortest ${tmp}/final.mp4`,
        { timeout: 300000, stdio: 'pipe' }
      )
    }

    const sizeMB = (fs.statSync(`${tmp}/final.mp4`).size / 1024 / 1024).toFixed(1)
    console.log(`[merge] final: ${sizeMB} MB (${canStreamCopy ? 'stream_copy' : 'transcode'})`)

    const url = await uploadVideoToSupabase(`${tmp}/final.mp4`, `merged/job_${job_id}_final.mp4`)
    await sb.from('video_jobs').update({ status: 'merged', merged_video_url: url, updated_at: new Date().toISOString() }).eq('id', job_id)
    console.log(`[merge] DONE ${job_id}`)

  } catch (err) {
    console.error(`[merge] ERROR: ${err.message}`)
    await sb.from('video_jobs').update({ status: 'failed', updated_at: new Date().toISOString() }).eq('id', job_id)
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch(e) {}
  }
})

// ============================================================
// POST /split-audio — Pilko audio per shot-segmentti
// ============================================================
app.post('/split-audio', async (req, res) => {
  const { script_id, audio_url, timings } = req.body
  if (!script_id || !audio_url || !timings?.length)
    return res.status(400).json({ ok: false, error: 'script_id, audio_url ja timings vaaditaan' })

  const tmp = `/tmp/split_${script_id}`
  fs.mkdirSync(tmp, { recursive: true })

  try {
    console.log(`[split] START ${script_id} — ${timings.length} segments`)

    await download(audio_url, `${tmp}/master.mp3`)
    console.log(`[split] master audio downloaded`)

    const segments = []

    for (const timing of timings) {
      const { shot, start, end } = timing
      const duration = end - start
      const dest = `${tmp}/shot${shot}.mp3`

      // FFmpeg extract segment
      execSync(
        `ffmpeg -y -i ${tmp}/master.mp3 -ss ${start} -t ${duration} -c:a copy ${dest}`,
        { timeout: 30000, stdio: 'pipe' }
      )

      const size = fs.statSync(dest).size
      console.log(`[split] shot ${shot} ok (${(size/1024).toFixed(0)} KB, ${start}-${end}s)`)

      // Upload to Supabase aura-audio bucket
      const storagePath = `segments/${script_id}_shot${shot}.mp3`
      const url = await uploadToSupabase(dest, storagePath)

      segments.push({ shot, start, end, url, size })
    }

    console.log(`[split] DONE — ${segments.length} segments`)
    res.json({ ok: true, script_id, segments })

  } catch (err) {
    console.error(`[split] ERROR: ${err.message}`)
    res.status(500).json({ ok: false, error: err.message })
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch(e) {}
  }
})

app.get('/health', (_, res) => res.json({ ok: true, service: 'aura-merge', version: 'v44' }))
app.listen(process.env.PORT || 3000, () => console.log('Merge v44 running on port ' + (process.env.PORT || 3000)))
