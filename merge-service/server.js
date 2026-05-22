app.post('/merge', async (req, res) => {
  const { job_id, clip_urls, audio_url } = req.body
  if (!job_id || !clip_urls?.length || !audio_url) {
    return res.status(400).json({ ok: false, error: 'Parametrit puuttuu' })
  }

  // Palauta 202 heti — aja FFmpeg taustalla
  res.status(202).json({ ok: true, job_id, status: 'processing' })

  // Taustaprosessi
  const tmp = `/tmp/job_${job_id}`
  fs.mkdirSync(tmp, { recursive: true })
  try {
    console.log(`[merge] START job ${job_id}`)
    await Promise.all(clip_urls.map((url, i) => download(url, `${tmp}/clip${i}.mp4`)))
    await download(audio_url, `${tmp}/audio.mp3`)

    const concatFile = `${tmp}/concat.txt`
    fs.writeFileSync(concatFile, clip_urls.map((_, i) => `file '${tmp}/clip${i}.mp4'`).join('\n'))

    execSync(
      `ffmpeg -y -f concat -safe 0 -i ${concatFile} -i ${tmp}/audio.mp3 ` +
      `-map 0:v:0 -map 1:a:0 -c:v libx264 -crf 28 -preset fast ` +
      `-c:a aac -b:a 128k -shortest ${tmp}/final.mp4`,
      { timeout: 300000 }
    )

    const storagePath = `merged/job_${job_id}_final.mp4`
    const buffer = fs.readFileSync(`${tmp}/final.mp4`)
    const { error } = await sb.storage.from('aura-videos').upload(storagePath, buffer, { contentType: 'video/mp4', upsert: true })
    if (error) throw new Error('Storage: ' + error.message)

    const { data: { publicUrl } } = sb.storage.from('aura-videos').getPublicUrl(storagePath)

    await sb.from('video_jobs').update({
      status: 'merged',
      merged_video_url: publicUrl,
      updated_at: new Date().toISOString()
    }).eq('id', job_id)

    console.log(`[merge] DONE job ${job_id} — ${publicUrl}`)
  } catch (err) {
    console.error(`[merge] ERROR job ${job_id}:`, err.message)
    await sb.from('video_jobs').update({ status: 'done', updated_at: new Date().toISOString() }).eq('id', job_id)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})
