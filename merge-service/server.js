const express = require('express')
const { execSync } = require('child_process')
const { createClient } = require('@supabase/supabase-js')
const fs = require('fs')
const https = require('https')
const http = require('http')

const app = express()
app.use(express.json({ limit: '10mb' }))

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

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

app.use((req, res, next) => {
  const auth = req.headers.authorization
 if (!auth || auth !== 'Bearer ' + process.env.MERGE_API_KEY) {
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

    await Promise.all(
      clip_urls.map((url, i) => download(url, `${tmp}/clip${i}.mp4`))
    )
    await download(audio_url, `${tmp}/audio.mp3`)

    const concatFile = `${tmp}/concat.txt`
    fs.writeFileSync(concatFile,
      clip_urls.map((_, i) => `file '${tmp}/clip${i}.mp4'`).join('\n')
    )

    execSync(`ffmpeg -y -f concat -safe 0 -i ${concatFile} -c copy ${tmp}/merged.mp4`)
    execSync(`ffmpeg -y -i ${tmp}/merged.mp4 -i ${tmp}/audio.mp3 -map 0:v:0 -map 1:a:0 -c:v copy -c:a aac -shortest ${tmp}/final.mp4`)

    const buffer = fs.readFileSync(`${tmp}/final.mp4`)
    const path = `merged/job_${job_id}_final.mp4`

    const { error } = await sb.storage
      .from('aura-videos')
      .upload(path, buffer, { contentType: 'video/mp4', upsert: true })
    if (error) throw new Error('Storage upload: ' + error.message)

    const { data: { publicUrl } } = sb.storage.from('aura-videos').getPublicUrl(path)

    await sb.from('video_jobs').update({
      video_url: publicUrl,
      updated_at: new Date().toISOString()
    }).eq('id', job_id)

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

app.listen(process.env.PORT || 3000, () => console.log('Merge service running'))
