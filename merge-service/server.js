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

    // Toista viimeinen klippi 5 kertaa (5 x 5s = 25s extra)
    // 7 klippia x 5s = 35s + 25s = 60s — riittaa 45s audiolle
    const lastClip = `${tmp}/clip${clip_urls.length - 1}.mp4`
    const allClipLines = [
      ...clip_urls.map((_, i) => `file '${tmp}/clip${i}.mp4'`),
      ...Array(5).fill(`file '${lastClip}'`)
    ]

    const concatFile = `${tmp}/concat.txt`
    fs.writeFileSync(concatFile, allClipLines.join('\n'))
    console.log(`[merge] concat: ${allClipLines.length} klippia (${allClipLines.length * 5}s)`)

    console.log(`[merge] running ffmpeg...`)
    execSync(
      `ffmpeg -y -f concat -safe 0
