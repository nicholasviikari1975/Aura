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
    const req = get(url, res => {
      if (res.statusCode !== 200) { file.close(); fs.unlinkSync(dest); return reject(new Error(`HTTP ${res.statusCode}`)) }
      res.pipe(file)
      file.on('finish', () => { file.close(); resolve() })
    })
    req.on('error', err => { file.close(); reject(err) })
  })
}
async function uploadToSupabase(filePath, storagePath) {
  const sizeMB = (fs.statSync(filePath).size / 1024 / 1024).toFixed(1)
  console.log(`[upload] ${storagePath} — ${sizeMB} MB`)
  if (fs.statSync(filePath).size > 45 * 1024 * 1024) throw new Error(`File too large: ${sizeMB} MB`)
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
  if (req.headers.authorization !== 'Bearer ' + MERGE_API_KEY) return res.status(401).json({ ok: false, error: 'Unauthorized' })
  next()
})
app.post('/merge', async (req, res) => {
  const { job_id, clip_urls, audio_url } = req.body
  if (!job_id || !clip_urls?.length || !audio_url) return res.status(400).json({ ok: false, error: 'Parametrit puuttuu' })
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
    const lines = clip_urls.map((_, i) => `file '${tmp}/clip${i}.mp4'`)
    fs.writeFileSync(`${tmp}/concat.txt`, lines.join('\n'))
    console.log(`[merge] concat: ${lines.length} clips`)
    execSync(
      `ffmpeg -y -f concat -safe 0 -i ${tmp}/concat.txt -i ${tmp}/audio.mp3 ` +
      `-map 0:v -map 1:a -vf "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2" ` +
      `-c:v libx264 -crf 32 -preset ultrafast -tune fastdecode ` +
      `-c:a aac -b:a 128k -shortest ${tmp}/final.mp4`,
      { timeout: 300000, stdio: 'pipe' }
    )
    const sizeMB = (fs.statSync(`${tmp}/final.mp4`).size / 1024 / 1024).toFixed(1)
    console.log(`[merge] done — ${sizeMB} MB`)
    const url = await uploadToSupabase(`${tmp}/final.mp4`, `merged/job_${job_id}_final.mp4`)
    await sb.from('video_jobs').update({ status: 'merged', merged_video_url: url, updated_at: new Date().toISOString() }).eq('id', job_id)
    console.log(`[merge] DONE — ${url}`)
  } catch (err) {
    console.error(`[merge] ERROR: ${err.message}`)
    await sb.from('video_jobs').update({ status: 'failed', updated_at: new Date().toISOString() }).eq('id', job_id)
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch(e) {}
  }
})
app.get('/health', (_, res) => res.json({ ok: true, service: 'aura-merge', version: 'v42' }))
app.listen(process.env.PORT || 3000, () => console.log('Merge v42 running on port ' + (process.env.PORT || 3000)))
