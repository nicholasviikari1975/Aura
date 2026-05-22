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
  const { error } = await sb.storage
    .from('aura-videos')
    .upload(storagePath, buffer, { contentType: 'video/mp4', upsert: true })
  if (error) throw new Error('Storage upload: ' + error.message)
  const { data: { publicUrl } } = sb.storage.from('aura-videos').getPublicUrl(storagePath)
  return publicUrl
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

    console.log(`[merge] running ffmpeg (stream copy)...`)
    execSync(
      `ffmpeg -y -f concat -safe 0 -i ${concatFile} -i ${tmp}/audio.mp3 ` +
      `-map 0:v:0 -map 1:a:0 -c:v copy -c:a aac -b:a 96k -shortest ${tmp}/final.mp4`,
      { timeout: 300000, stdio: 'pipe' }
    )

    const finalSize = (fs.statSync(`${tmp}/final.mp4`).size / 1024 / 1024).toFixed(1)
    console.log(`[merge] ffmpeg done — ${finalSize} MB`)

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
    }).eq('id', job_id).catch(() => {})
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

app.get('/health', (_, res) => res.json({ ok: true, service: 'aura-merge' }))

app.listen(process.env.PORT || 3000, () => {
  console.log(`Merge service running on port ${process.env.PORT || 3000}`)
})
