const express = require('express')
const { execSync } = require('child_process')
const fs = require('fs')
const https = require('https')
const http = require('http')

const app = express()
app.use(express.json({ limit: '10mb' }))

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const MERGE_API_KEY = process.env.MERGE_API_KEY

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
  const buffer = fs.readFileSync(filePath)
  const sizeMB = (buffer.length / 1024 / 1024).toFixed(1)
  console.log(`[upload] ${storagePath} — ${sizeMB} MB`)

  const res = await fetch(
    `${SUPABASE_URL}/storage/v1/object/aura-videos/${storagePath}`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'video/mp4',
        'x-upsert': 'true',
      },
      body: buffer,
    }
  )

  if (!res.ok) {
    const err = await res.text()
    throw new Error('Storage upload: ' + err)
  }

  return `${SUPABASE_URL}/storage/v1/object/public/aura-videos/${storagePath}`
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

  const tmp = `/tmp/job_${job_id}`
  fs.mkdirSync(tmp, { recursive: true })

  try {
    console.log(`[merge] job ${job_id} — ${clip_urls.length} clips`)

    // Lataa klipsit rinnakkain
    await Promise.all(
      clip_urls.map((url, i) => download(url, `${tmp}/clip${i}.mp4`))
    )
    await download(audio_url, `${tmp}/audio.mp3`)

    // Luo concat-lista
    const concatFile = `${tmp}/concat.txt`
    fs.writeFileSync(
      concatFile,
      clip_urls.map((_, i) => `file '${tmp}/clip${i}.mp4'`).join('\n')
    )

    // FFmpeg: konkatenoi + lisää audio + kompressoi (CRF 28, ~25-40 MB)
    console.log(`[merge] running ffmpeg...`)
    execSync(
      `ffmpeg -y -f concat -safe 0 -i ${concatFile} -i ${tmp}/audio.mp3 ` +
      `-map 0:v:0 -map 1:a:0 ` +
      `-c:v libx264 -crf 28 -preset fast ` +
      `-c:a aac -b:a 128k ` +
      `-shortest ${tmp}/final.mp4`,
      { timeout: 300000 }
    )

    const finalSize = (fs.statSync(`${tmp}/final.mp4`).size / 1024 / 1024).toFixed(1)
    console.log(`[merge] ffmpeg done — ${finalSize} MB`)

    // Upload Supabaseen
    const storagePath = `merged/job_${job_id}_final.mp4`
    const publicUrl = await uploadToSupabase(`${tmp}/final.mp4`, storagePath)

    console.log(`[merge] done — ${publicUrl}`)
    res.json({ ok: true, merged_url: publicUrl })

  } catch (err) {
    console.error('[merge] error:', err.message)
    res.status(500).json({ ok: false, error: err.message })
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

app.get('/health', (_, res) => res.json({ ok: true, service: 'aura-merge' }))

app.listen(process.env.PORT || 3000, () => {
  console.log(`Merge service running on port ${process.env.PORT || 3000}`)
})
