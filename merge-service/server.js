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

// Logo intro/outro asetukset
const LOGO_URL = process.env.LOGO_URL || 'https://feavsiliwajtqxgpbmqu.supabase.co/storage/v1/object/public/aura-assets/Archive%20logo.jpg'
const INTRO_DURATION = 1.5
const OUTRO_DURATION = 1.5

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
// POST /merge — Yhdistä klippit + audio + logo intro/outro
// v53 (12.6.2026): v52 + logo-intro ja -outro (1.5s musta tausta + logo, fade).
// Matala-RAM säilyy: intro/outro tehdään erillisinä normalisoituina klippeinä,
// liitetään concat-demuxilla. Audio liitetään VAIN sisältöosaan (intro/outro hiljaisia),
// joten lipsync-synkka säilyy. Logo JPG ok koska tausta musta.
// ============================================================
app.post('/merge', async (req, res) => {
  const { job_id, clip_urls, audio_url } = req.body
  if (!job_id || !clip_urls?.length || !audio_url)
    return res.status(400).json({ ok: false, error: 'Parametrit puuttuu' })

  res.status(202).json({ ok: true, job_id, clips: clip_urls.length, status: 'processing' })

  const tmp = `/tmp/job_${job_id}`
  fs.mkdirSync(tmp, { recursive: true })

  try {
    console.log(`[merge] START ${job_id} — ${clip_urls.length} clips + logo`)

    // 1. Lataa + normalisoi jokainen sisältöklippi ERIKSEEN (matala RAM)
    for (let i = 0; i < clip_urls.length; i++) {
      const raw = `${tmp}/raw${i}.mp4`
      await download(clip_urls[i], raw)
      const size = fs.statSync(raw).size
      if (size < 1000) throw new Error(`raw${i}.mp4 corrupted (${size} bytes)`)
      console.log(`[merge] downloaded ${i+1}/${clip_urls.length} (${(size/1024/1024).toFixed(1)} MB)`)
      const norm = `${tmp}/norm${i}.mp4`
      execSync(
        `ffmpeg -y -i ${raw} ` +
        `-vf "scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2:black,fps=30,setsar=1,format=yuv420p" ` +
        `-c:v libx264 -preset veryfast -crf 26 -an ${norm}`,
        { timeout: 90000, stdio: 'pipe' }
      )
      fs.unlinkSync(raw)
      console.log(`[merge] normalized ${i+1}/${clip_urls.length}`)
    }

    await download(audio_url, `${tmp}/audio.mp3`)
    console.log(`[merge] audio ok`)

    // 2. Concat sisältöklipit (ilman audiota), liitä audio -> content.mp4
    const contentLines = clip_urls.map((_, i) => `file '${tmp}/norm${i}.mp4'`)
    fs.writeFileSync(`${tmp}/concat_content.txt`, contentLines.join('\n'))
    execSync(
      `ffmpeg -y -f concat -safe 0 -i ${tmp}/concat_content.txt -c:v copy -an ${tmp}/content_video.mp4`,
      { timeout: 120000, stdio: 'pipe' }
    )
    // Audio VAIN sisältöön (intro/outro hiljaisia) -> lipsync-synkka säilyy
    execSync(
      `ffmpeg -y -i ${tmp}/content_video.mp4 -i ${tmp}/audio.mp3 -c:v copy -c:a aac -b:a 128k -shortest ${tmp}/content.mp4`,
      { timeout: 60000, stdio: 'pipe' }
    )
    console.log(`[merge] content with audio ok`)

    // 3. Logo intro + outro: musta tausta + logo keskellä, fade in/out, hiljainen audioraita.
    let logoOk = false
    try {
      await download(LOGO_URL, `${tmp}/logo.jpg`)
      const logoSize = fs.statSync(`${tmp}/logo.jpg`).size
      if (logoSize > 1000) {
        // Intro: musta tausta, logo skaalattu mahtumaan (max 500px leveä), fade in+out, hiljainen stereo-audio
        const buildLogoClip = (dest, dur) => {
          execSync(
            `ffmpeg -y -loop 1 -i ${tmp}/logo.jpg -f lavfi -i anullsrc=channel_layout=stereo:sample_rate=44100 ` +
            `-filter_complex "[0:v]scale=500:-1:force_original_aspect_ratio=decrease,` +
            `pad=720:1280:(ow-iw)/2:(oh-ih)/2:black,fps=30,setsar=1,format=yuv420p,` +
            `fade=t=in:st=0:d=0.4,fade=t=out:st=${(dur-0.4).toFixed(2)}:d=0.4[v]" ` +
            `-map "[v]" -map 1:a -t ${dur} -c:v libx264 -preset veryfast -crf 26 -c:a aac -b:a 128k -shortest ${dest}`,
            { timeout: 60000, stdio: 'pipe' }
          )
        }
        buildLogoClip(`${tmp}/intro.mp4`, INTRO_DURATION)
        buildLogoClip(`${tmp}/outro.mp4`, OUTRO_DURATION)
        logoOk = true
        console.log(`[merge] logo intro/outro built`)
      }
    } catch (logoErr) {
      console.error(`[merge] logo failed, jatketaan ilman: ${logoErr.message}`)
    }

    let finalSource
    if (logoOk) {
      // 4. Concat: intro + content + outro. Kaikki samaa formaattia + audioraita -> stream copy turvallinen.
      // Mutta content on jo aac+h264; intro/outro samoin. Concat-demux vaatii saman koodekin -> ok.
      fs.writeFileSync(`${tmp}/concat_final.txt`,
        `file '${tmp}/intro.mp4'\nfile '${tmp}/content.mp4'\nfile '${tmp}/outro.mp4'`)
      execSync(
        `ffmpeg -y -f concat -safe 0 -i ${tmp}/concat_final.txt -c:v copy -c:a aac -b:a 128k -movflags +faststart ${tmp}/final.mp4`,
        { timeout: 90000, stdio: 'pipe' }
      )
      finalSource = `${tmp}/final.mp4`
    } else {
      // Logo epäonnistui -> käytä pelkkää sisältöä (ei riko mergeä)
      execSync(`ffmpeg -y -i ${tmp}/content.mp4 -c copy -movflags +faststart ${tmp}/final.mp4`, { timeout: 60000, stdio: 'pipe' })
      finalSource = `${tmp}/final.mp4`
    }

    const sizeMB = (fs.statSync(finalSource).size / 1024 / 1024).toFixed(1)
    console.log(`[merge] final: ${sizeMB} MB (logo: ${logoOk})`)

    const url = await uploadVideoToSupabase(finalSource, `merged/job_${job_id}_final.mp4`)
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
// POST /split-audio — Pilko audio per shot-segmentti (ENNALLAAN v52:sta)
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
      execSync(
        `ffmpeg -y -i ${tmp}/master.mp3 -ss ${start} -t ${duration} -c:a copy ${dest}`,
        { timeout: 30000, stdio: 'pipe' }
      )
      const size = fs.statSync(dest).size
      console.log(`[split] shot ${shot} ok (${(size/1024).toFixed(0)} KB, ${start}-${end}s)`)
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

// ============================================================
// POST /search — Brave Search proxy (ENNALLAAN v52:sta)
// ============================================================
app.post('/search', async (req, res) => {
  const { query, count = 4 } = req.body
  if (!query) return res.status(400).json({ ok: false, error: 'query vaaditaan' })
  const searchKey = process.env.BRAVE_SEARCH_API_KEY
  const answersKey = process.env.BRAVE_ANSWERS_API_KEY
  if (!searchKey && !answersKey) return res.status(500).json({ ok: false, error: 'Brave API keys puuttuvat' })
  try {
    console.log(`[search] query: ${query}`)
    if (searchKey) {
      const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}&search_lang=en`
      const response = await fetch(url, { headers: { 'Accept': 'application/json', 'Accept-Encoding': 'gzip', 'X-Subscription-Token': searchKey } })
      console.log(`[search] web status: ${response.status}`)
      if (response.ok) {
        const data = await response.json()
        const results = data?.web?.results || []
        const facts = results.slice(0, count).map(r => r.description || r.extra_snippets?.[0] || '').filter(s => s.length > 20).join(' | ')
        if (facts.length > 0) return res.json({ ok: true, facts, results_count: results.length, source: 'web' })
      }
    }
    if (answersKey) {
      const url2 = `https://api.search.brave.com/res/v1/summarizer/search?q=${encodeURIComponent(query)}&count=${count}&key=${answersKey}`
      const res2 = await fetch(url2, { headers: { 'Accept': 'application/json', 'Accept-Encoding': 'gzip', 'X-Subscription-Token': answersKey } })
      console.log(`[search] answers status: ${res2.status}`)
      if (res2.ok) {
        const data2 = await res2.json()
        const summary = (data2?.summary || []).map(s => s.text || '').filter(t => t.length > 10).join(' ')
        const snippets = (data2?.results || []).slice(0, count).map(r => r.description || '').filter(s => s.length > 20).join(' | ')
        const facts2 = [summary, snippets].filter(Boolean).join(' | ')
        return res.json({ ok: true, facts: facts2, results_count: data2?.results?.length || 0, source: 'answers' })
      }
    }
    res.json({ ok: true, facts: '', results_count: 0, source: 'none' })
  } catch (err) {
    console.error(`[search] exception: ${err.message}`)
    res.status(500).json({ ok: false, error: err.message })
  }
})

app.get('/health', (_, res) => res.json({ ok: true, service: 'aura-merge', version: 'v53' }))
app.listen(process.env.PORT || 3000, () => console.log('Merge v53 running on port ' + (process.env.PORT || 3000)))
