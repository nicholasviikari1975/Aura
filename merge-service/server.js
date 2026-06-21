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

const LOGO_URL = process.env.LOGO_URL || 'https://feavsiliwajtqxgpbmqu.supabase.co/storage/v1/object/public/aura-assets/Archive%20logo.jpg'
// v56: oletukset; config voi yliajaa (logo_scale_px, logo_intro_duration) ilman deployta
const DEFAULT_LOGO_SCALE = 600
const DEFAULT_INTRO_DURATION = 1.5
const DEFAULT_OUTRO_DURATION = 1.5
const DEFAULT_LOGO_COLORKEY = 0.15
// v57: pullo-introframen oletuskesto (config: bottle_intro_duration voi yliajaa)
const DEFAULT_BOTTLE_INTRO_DURATION = 1.5

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
// POST /merge — klippit + audio + logo intro/outro + PULLO-INTROFRAME (v58)
// v57 (19.6): intro_image_url (pullokuva) -> 1.5s klippi sisällön ALKUUN, heti
//   logo-intron jälkeen. Tällöin videon näkyvä kansi on pullo (IG/TikTok ottavat
//   kannen framesta, YT myös ilman custom-thumbnailia). Failsafe: jos pullokuva
//   puuttuu/kaatuu, jatketaan ilman (kuten logo).
//   Järjestys: [logo intro] -> [PULLO intro] -> [sisältö+audio] -> [logo outro].
//   Audio alkaa vasta sisällöstä (logon ja pullon päällä hiljaisuus), kuten ennen.
// v56: logon koko configista (logo_scale_px). Muu logiikka v54:stä (matala-RAM,
//   vaiheittainen kutistus, failsafe).
// ============================================================
app.post('/merge', async (req, res) => {
  const { job_id, clip_urls, audio_url, intro_image_url, intro_duration, intro_audio_url } = req.body
  if (!job_id || !clip_urls?.length || !audio_url)
    return res.status(400).json({ ok: false, error: 'Parametrit puuttuu' })

  res.status(202).json({ ok: true, job_id, clips: clip_urls.length, status: 'processing', bottle_intro: !!intro_image_url })

  // v56: lue logo-asetukset configista (failsafe oletuksiin)
  let logoScale = DEFAULT_LOGO_SCALE
  let introDur = DEFAULT_INTRO_DURATION
  let outroDur = DEFAULT_OUTRO_DURATION
  let logoKey = DEFAULT_LOGO_COLORKEY
  let bottleIntroDur = DEFAULT_BOTTLE_INTRO_DURATION
  try {
    const { data: cfg } = await sb.from('config').select('logo_scale_px, logo_intro_duration, logo_colorkey_similarity, bottle_intro_duration').eq('id', 1).maybeSingle()
    if (cfg?.logo_scale_px && Number(cfg.logo_scale_px) > 0) logoScale = Math.min(720, Math.max(100, Number(cfg.logo_scale_px)))
    if (cfg?.logo_intro_duration && Number(cfg.logo_intro_duration) > 0) { introDur = Number(cfg.logo_intro_duration); outroDur = Number(cfg.logo_intro_duration) }
    if (cfg?.logo_colorkey_similarity != null && Number(cfg.logo_colorkey_similarity) >= 0) logoKey = Math.min(0.5, Math.max(0, Number(cfg.logo_colorkey_similarity)))
    if (cfg?.bottle_intro_duration && Number(cfg.bottle_intro_duration) > 0) bottleIntroDur = Math.min(4, Math.max(0.5, Number(cfg.bottle_intro_duration)))
  } catch (e) { console.error('[merge] config-luku epäonnistui, oletukset:', e.message) }
  // Payloadin intro_duration (merge-video lähettää) ylittää configin, jos annettu validina.
  if (intro_duration && Number(intro_duration) > 0) bottleIntroDur = Math.min(4, Math.max(0.5, Number(intro_duration)))
  console.log(`[merge] logo_scale=${logoScale}px intro=${introDur}s colorkey=${logoKey} bottle_intro=${bottleIntroDur}s`)

  const tmp = `/tmp/job_${job_id}`
  fs.mkdirSync(tmp, { recursive: true })

  try {
    console.log(`[merge] START ${job_id} — ${clip_urls.length} clips + logo${intro_image_url ? ' + bottle-intro' : ''} (v58)`)

    // 1. Lataa + normalisoi sisältöklipit erikseen (matala RAM)
    for (let i = 0; i < clip_urls.length; i++) {
      const raw = `${tmp}/raw${i}.mp4`
      await download(clip_urls[i], raw)
      const size = fs.statSync(raw).size
      if (size < 1000) throw new Error(`raw${i}.mp4 corrupted (${size} bytes)`)
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

    // 2. Sisältö-concat + audio
    const contentLines = clip_urls.map((_, i) => `file '${tmp}/norm${i}.mp4'`)
    fs.writeFileSync(`${tmp}/concat_content.txt`, contentLines.join('\n'))
    execSync(`ffmpeg -y -f concat -safe 0 -i ${tmp}/concat_content.txt -c:v copy -an ${tmp}/content_video.mp4`, { timeout: 120000, stdio: 'pipe' })
    execSync(`ffmpeg -y -i ${tmp}/content_video.mp4 -i ${tmp}/audio.mp3 -c:v copy -c:a aac -b:a 128k -shortest ${tmp}/content.mp4`, { timeout: 60000, stdio: 'pipe' })
    console.log(`[merge] content ready`)

    // 2.5 PULLO-INTROFRAME (v58) — pullokuvasta lyhyt klippi sisällön alkuun.
    // Kuva skaalataan 9:16-korttiin (sama 720x1280 kuin sisältö) mustalla paddingilla.
    // Hiljainen audioraita + pehmeät fade-reunat. Failsafe: kaatuminen ei riko mergeä.
    let bottleOk = false
    if (intro_image_url) {
      try {
        await download(intro_image_url, `${tmp}/bottle_raw`)
        if (fs.statSync(`${tmp}/bottle_raw`).size > 1000) {
          // 2.5a Skaalaa pullo 9:16-korttiin (decrease + pad), PNG välitiedostoksi
          execSync(
            `ffmpeg -y -i ${tmp}/bottle_raw ` +
            `-vf "scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2:black,setsar=1,format=yuv420p" ` +
            `-frames:v 1 ${tmp}/bottle_card.png`,
            { timeout: 30000, stdio: 'pipe' }
          )
          fs.unlinkSync(`${tmp}/bottle_raw`)
          // 2.5b Tee bottleIntroDur-pituinen klippi. AANI:
          //   - jos intro_audio_url annettu (VAIHE B: nimi-aani): lataa se ja kayta
          //     audioraitana. apad varmistaa etta raita kestaa koko pullosegmentin
          //     (nimi voi olla lyhyempi kuin pullon kesto). Nain nimi soi pullon paalla.
          //   - muuten: hiljainen anullsrc (kuten v57).
          // Paaaudio EI ole tassa mukana -> avatar-lipsync sailyy taysin.
          let introAudioOk = false
          if (intro_audio_url) {
            try {
              await download(intro_audio_url, `${tmp}/name_audio.mp3`)
              if (fs.statSync(`${tmp}/name_audio.mp3`).size > 500) introAudioOk = true
            } catch (e) {
              console.error(`[merge] name-audio download failed, hiljainen intro: ${e.message}`)
            }
          }
          if (introAudioOk) {
            execSync(
              `ffmpeg -y -loop 1 -t ${bottleIntroDur} -i ${tmp}/bottle_card.png ` +
              `-i ${tmp}/name_audio.mp3 ` +
              `-vf "fps=30,format=yuv420p,fade=t=in:st=0:d=0.3,fade=t=out:st=${(bottleIntroDur-0.3).toFixed(2)}:d=0.3" ` +
              `-af "apad,atrim=0:${bottleIntroDur},aresample=44100" ` +
              `-c:v libx264 -preset veryfast -crf 26 -c:a aac -b:a 128k -t ${bottleIntroDur} ${tmp}/bottle_intro.mp4`,
              { timeout: 45000, stdio: 'pipe' }
            )
            console.log(`[merge] bottle-intro ok WITH name-audio (${bottleIntroDur}s)`)
          } else {
            execSync(
              `ffmpeg -y -loop 1 -t ${bottleIntroDur} -i ${tmp}/bottle_card.png ` +
              `-f lavfi -t ${bottleIntroDur} -i anullsrc=channel_layout=stereo:sample_rate=44100 ` +
              `-vf "fps=30,format=yuv420p,fade=t=in:st=0:d=0.3,fade=t=out:st=${(bottleIntroDur-0.3).toFixed(2)}:d=0.3" ` +
              `-c:v libx264 -preset veryfast -crf 26 -c:a aac -b:a 128k -t ${bottleIntroDur} ${tmp}/bottle_intro.mp4`,
              { timeout: 45000, stdio: 'pipe' }
            )
            console.log(`[merge] bottle-intro ok silent (${bottleIntroDur}s)`)
          }
          bottleOk = true
        }
      } catch (bottleErr) {
        console.error(`[merge] bottle-intro failed, jatketaan ilman: ${bottleErr.message}`)
      }
    }

    // 3. LOGO — kevyt, vaiheittain. Kaatuminen ei riko mergeä (failsafe).
    let logoOk = false
    try {
      await download(LOGO_URL, `${tmp}/logo_raw.jpg`)
      if (fs.statSync(`${tmp}/logo_raw.jpg`).size > 1000) {
        // 3a. v56: kutista logo configin leveyteen (oletus 600). Pariton -> -2 pakottaa parilliseksi.
        // Sama vaihe poistaa mustan taustan colorkeyllä (logo: musta tausta + kultainen teksti).
        // colorkey=0x000000 similarity 0.15 -> tummat alueet läpinäkyviksi, kulta jää. PNG säilyttää alfan.
        execSync(`ffmpeg -y -i ${tmp}/logo_raw.jpg -vf "scale=${logoScale}:-2,format=rgba,colorkey=0x000000:${logoKey}:0.05" -frames:v 1 ${tmp}/logo_small.png`, { timeout: 30000, stdio: 'pipe' })
        fs.unlinkSync(`${tmp}/logo_raw.jpg`)
        // 3b. Logo (nyt läpinäkyvä tausta) keskelle mustaa 720x1280 korttia. overlay säilyttää alfan -> ei laatikkoa.
        execSync(
          `ffmpeg -y -f lavfi -i color=c=black:s=720x1280 -i ${tmp}/logo_small.png ` +
          `-filter_complex "[0][1]overlay=(W-w)/2:(H-h)/2" -frames:v 1 ${tmp}/logo_card.png`,
          { timeout: 30000, stdio: 'pipe' }
        )
        // 3c. Intro/outro videoklipit logokortista. Hiljainen audio. Fade.
        const buildLogoClip = (dest, dur) => {
          execSync(
            `ffmpeg -y -loop 1 -t ${dur} -i ${tmp}/logo_card.png -f lavfi -t ${dur} -i anullsrc=channel_layout=stereo:sample_rate=44100 ` +
            `-vf "fps=30,format=yuv420p,fade=t=in:st=0:d=0.4,fade=t=out:st=${(dur-0.4).toFixed(2)}:d=0.4" ` +
            `-c:v libx264 -preset veryfast -crf 26 -c:a aac -b:a 128k -t ${dur} ${dest}`,
            { timeout: 45000, stdio: 'pipe' }
          )
        }
        buildLogoClip(`${tmp}/intro.mp4`, introDur)
        buildLogoClip(`${tmp}/outro.mp4`, outroDur)
        logoOk = true
        console.log(`[merge] logo intro/outro ok (scale ${logoScale})`)
      }
    } catch (logoErr) {
      console.error(`[merge] logo failed, jatketaan ilman: ${logoErr.message}`)
    }

    // 4. Lopullinen concat
    // Järjestys: [logo intro] -> [PULLO intro] -> [sisältö] -> [logo outro].
    // Kaikki osat ovat valinnaisia (failsafe): jos jokin puuttuu, se jätetään pois.
    let finalSource = `${tmp}/final.mp4`
    const finalParts = []
    if (logoOk) finalParts.push(`${tmp}/intro.mp4`)
    if (bottleOk) finalParts.push(`${tmp}/bottle_intro.mp4`)
    finalParts.push(`${tmp}/content.mp4`)
    if (logoOk) finalParts.push(`${tmp}/outro.mp4`)

    if (finalParts.length > 1) {
      fs.writeFileSync(`${tmp}/concat_final.txt`, finalParts.map(p => `file '${p}'`).join('\n'))
      execSync(`ffmpeg -y -f concat -safe 0 -i ${tmp}/concat_final.txt -c:v copy -c:a aac -b:a 128k -movflags +faststart ${finalSource}`, { timeout: 90000, stdio: 'pipe' })
    } else {
      execSync(`ffmpeg -y -i ${tmp}/content.mp4 -c copy -movflags +faststart ${finalSource}`, { timeout: 60000, stdio: 'pipe' })
    }

    const sizeMB = (fs.statSync(finalSource).size / 1024 / 1024).toFixed(1)
    console.log(`[merge] final: ${sizeMB} MB (logo: ${logoOk}, bottle: ${bottleOk})`)

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

app.post('/split-audio', async (req, res) => {
  const { script_id, audio_url, timings } = req.body
  if (!script_id || !audio_url || !timings?.length)
    return res.status(400).json({ ok: false, error: 'script_id, audio_url ja timings vaaditaan' })
  const tmp = `/tmp/split_${script_id}`
  fs.mkdirSync(tmp, { recursive: true })
  try {
    await download(audio_url, `${tmp}/master.mp3`)
    const segments = []
    for (const timing of timings) {
      const { shot, start, end } = timing
      const duration = end - start
      const dest = `${tmp}/shot${shot}.mp3`
      execSync(`ffmpeg -y -i ${tmp}/master.mp3 -ss ${start} -t ${duration} -c:a copy ${dest}`, { timeout: 30000, stdio: 'pipe' })
      const size = fs.statSync(dest).size
      const storagePath = `segments/${script_id}_shot${shot}.mp3`
      const url = await uploadToSupabase(dest, storagePath)
      segments.push({ shot, start, end, url, size })
    }
    res.json({ ok: true, script_id, segments })
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch(e) {}
  }
})

app.post('/search', async (req, res) => {
  const { query, count = 4 } = req.body
  if (!query) return res.status(400).json({ ok: false, error: 'query vaaditaan' })
  const searchKey = process.env.BRAVE_SEARCH_API_KEY
  const answersKey = process.env.BRAVE_ANSWERS_API_KEY
  if (!searchKey && !answersKey) return res.status(500).json({ ok: false, error: 'Brave API keys puuttuvat' })
  try {
    if (searchKey) {
      const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}&search_lang=en`
      const response = await fetch(url, { headers: { 'Accept': 'application/json', 'Accept-Encoding': 'gzip', 'X-Subscription-Token': searchKey } })
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
    res.status(500).json({ ok: false, error: err.message })
  }
})

app.get('/health', (_, res) => res.json({ ok: true, service: 'aura-merge', version: 'v58' }))
app.listen(process.env.PORT || 3000, () => console.log('Merge v58 running on port ' + (process.env.PORT || 3000)))
