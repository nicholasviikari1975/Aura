# AURA_TECHNICAL_MASTER.md

> Tekninen totuuslahde AI-jarjestelmille (Claude, Claude Code, ChatGPT, Gemini, Cursor, Windsurf).
> Talla dokumentilla + Supabase `project_memory` -taululla uusi AI ymmartaa projektin arkkitehtuurin.
> Yllapito: paivita kun arkkitehtuuri muuttuu. Operatiivinen "mika on totta nyt" -tilannekuva on `project_memory`-taulussa, EI tassa.
>
> HUOM: Tama on JULKINEN kehitysversio. Ei sisalla projekti-id:ita, avaimia, chat-id:ita, integration-id:ita
> eika muita salaisuuksia. Konkreettiset tunnisteet ja salaisuudet ovat vain Supabasen vaultissa,
> `project_memory`-taulussa ja yksityisessa handoffissa. ALA lisaa salaisuuksia tahan tiedostoon.

---

## 1. PROJEKTIN TARKOITUS

AURA / SEPTENTRION ARCHIVE on taysin automatisoitu AI-pohjainen fragrance-media-pipeline. Se tuottaa lyhytmuotoista videosisaltoa ja julkaisee sen YouTubeen, TikTokiin ja Instagramiin.

**Brandi-identiteetti:** cinematic fragrance archive, cold luxury, editorial, story-first. Ydinperiaate: "story before product".

**EI ole:**
- review-kanava
- influencer-sisaltoa
- hype-sisaltoa

**Liiketoimintatavoite:** Lyhyella aikavalilla rakentaa oppiva sisaltokone. Pitkalla aikavalilla affiliate-linkit, white-label-palvelut, multi-channel AI-media-yhtio. Kohdeyleiso: USA:n fragrance-niche.

**Operaattori:** no-code-operaattori. Antaa ohjeet ja go/no-go-paatokset, deployaa koodin itse. Kommunikoi suomeksi; kaikki koodi ja sisalto englanniksi. Ei em-viivoja vastauksissa.

---

## 2. TEKNINEN ARKKITEHTUURI

| Kerros | Teknologia |
|--------|-----------|
| Backend / DB | Supabase (PostgreSQL, eu-north-1) |
| Frontend | Lovable dashboard |
| Script-AI | Claude Haiku (`generate-script`) |
| TTS | ElevenLabs (word_timings + lipsync) |
| Video-generointi | Seedance via fal.ai (t2v + i2v), FLUX i2i (pullokuvat) |
| Merge | Render.com ffmpeg-palvelu |
| Storage | Supabase Storage |
| Publishing | Postiz -> YouTube / TikTok / Instagram |
| Analytiikka | YouTube Analytics API + YouTube Data API |
| Notifikaatiot | Telegram (Jarvis-botti) |
| Dokumentaatio | Notion (handoff-sivu + Wiki) |

**Pipeline-versiot:** seuraa kunkin Edge Functionin versiota Supabasessa. project_memory.architecture_version pitaa kirjaa nykyisesta kokoonpanosta.

---

## 3. WORKFLOW (pipeline)

```
Idea (idea_pool)
  v  generate-ideas
Script (scripts.script_json)        <- Claude Haiku, formaatti + psych_vector
  v  generate-script
Audio (audio)                       <- ElevenLabs TTS + word_timings
  v  generate-audio
Video shots (shot_render_tasks)     <- Seedance t2v/i2v + FLUX, per shotti
  v  render-video
Poll + lipsync (video_jobs)         <- poll-video, lipsync hook+verdict
  v  poll-video
Merge (merged_video_url)            <- Render.com ffmpeg, pullo-intro + nimi
  v  merge-video
Publish approval (Telegram)         <- publish-postiz telegram_approval
  v  (operaattori hyvaksyy)
Publish (published_videos)          <- Postiz -> YT/TikTok/IG
  v  publish-postiz
Analytics (analytics_memory)        <- sync-analytics, YouTube-metriikat
  v  compute_performance_patterns
Feedback loop (performance_patterns) -> takaisin generointiin (VAIHE 2, kesken)
```

---

## 4. SISALTOFORMAATIT (kiinteat suhteet)

| Formaatti | Osuus | Avatar | Lipsync | Erotin |
|-----------|-------|--------|---------|--------|
| Compliment Magnet | 60% | lahikuva (i2v_avatar) | hook + verdict | avatar-paino |
| Olfactory Ghost | 30% | kaukokuva (i2v_avatar_far) | 0 | avatar-kulma + ei lipsynkkia |
| The Archive | 10% | etainen avatar | max 1 | editorial |

**Shot-jarjestys (buildShotOrder):** verdict aina viimeinen, ei koskaan kahta avataria perakkain (makro valissa). Sama jarjestys kaikille formaateille; Ghost-makropaino peruttiin datan perusteella (analysis-avatar nakyi parempana). Avatar-origIndex {0,2,4,6}, makro {1,3,5}, verdict=6. Max 2 lipsync-shottia (hook + verdict), max 2 avatar-shottia muuten.

**Psykologiset ajurit:** 7 ajuria (curiosity, scarcity, authority, social_proof, novelty, controversy, status_signalling) pisteytetaan 0-1 per script, tallennetaan `psych_vector`. Linkitetaan analytiikkaan performance-oppimista varten.

---

## 5. TIETOMALLI (keskeiset taulut)

**Pipeline-ydin:**
- `idea_pool` — ideat (status pending/in_use), score, format_type. Lahde scriptille.
- `scripts` — script_json (shot1-7, hook, caption, hashtags, mood, format_type, psych_vector, product_image_url). Linkki idea_id.
- `audio` — audio_url, word_timings, duration_seconds, intro_name_url. Linkki script_id.
- `video_jobs` — KESKEINEN. status (processing/stored/merging/merged/done/failed), job_payload (shots, clip_urls, lipsync_*), merged_video_url, postiz_post_ids, youtube_video_id, publish_error. Linkki script_id.
- `shot_render_tasks` — per-shotti renderointi, md5_hash (cache), output_video_url, status.
- `video_job_states` — tilasiirtymalokituksen audit-trail.

**Julkaisu + analytiikka:**
- `published_videos` — julkaisujalki (idea_id, platform, video_url). Jaljitettavyys idea_pooliin.
- `publish_approvals` — Telegram-hyvaksynnat (status pending/published/failed).
- `analytics_memory` — per-video YouTube-metriikat (retention_pct, ctr, views, likes, shares, comments, engagement_rate) + dimensiot (format_type, mood, psych_vector). UNIQUE youtube_video_id.
- `performance_patterns` — lasketut patternit (pattern_type format/psych_driver, avg_retention, avg_ctr, sample_size, confidence_score). Tyhja kunnes >=5 videota/formaatti.

**Kirjastot + konfiguraatio:**
- `config` — singleton (id=1). Kaikki pipeline-asetukset (avatar, lipsync_shots, publish_mode, automation_enabled, postiz_enabled, format-asetukset).
- `project_memory` — singleton (id=1). "Mika on totta nyt" -tilannekuva. AI lukee taman ensin.
- `shot_prompt_library` — shotti-promptit (t2v_environment, i2v_avatar, i2v_avatar_far), test_score, avg_retention, video_count. Oppii analytiikasta.
- `product_bottle_library` — pullokuvat (fragrance_name, brand, slug, image_url).
- `agent_prompts` — agenttien systeemipromptit.
- `decision_log` — paatoshistoria.

**Telegram/Jarvis:** `telegram_alert_state`, `telegram_send_log`.

---

## 6. EDGE FUNCTIONS (keskeiset)

| Funktio | verify_jwt | Tehtava |
|---------|-----------|---------|
| generate-ideas | - | Ideat idea_pooliin |
| generate-script | true | Script Haikulla, normalisoi shot-skeeman (VAIHE 0) |
| generate-audio | true | ElevenLabs TTS + word_timings |
| render-video | false | Seedance-shotit, buildShotOrder, lipsync-suunnitelma |
| poll-video | false | Pollaa Seedance, lipsync hook+verdict, transient-suoja |
| merge-video | false | Render.com merge, MERGING-LUKKO, pullo-intro |
| publish-postiz | true | Postiz-julkaisu, Telegram-hyvaksynta, YT-thumbnail |
| sync-analytics | false | YouTube-metriikat -> analytics_memory -> patterns |

**Auth-saanto:** verify_jwt=false -funktiot kutsuttavissa pg_net:lla. verify_jwt=true vaatii Bearer service_role_key (vault).

---

## 7. AUTOMAATIO (pg_cron)

| Aikataulu | Tehtava |
|-----------|---------|
| */2 min | auto_poll_pending_jobs |
| */3 min | auto_merge_ready_jobs |
| */4 min | auto_publish_merged_jobs |
| */5 min | auto_retry_transient_failures |
| */15 min | stuck-job-tarkistus |
| */15 min | telegram_check_alerts |
| su 04:00 | sync-analytics (viikoittain) |
| paivittain 07:00 | telegram_daily_summary |
| siivous | audio/leads/idea_pool retention |

Kaikilla auto-cron-funktioilla `automation_enabled`-portti config:ssa.

---

## 8. API-REKISTERI

| Provider | Tarkoitus | Fallback | Huom |
|----------|-----------|----------|------|
| Anthropic (Claude Haiku) | Script-generointi | - | generate-script |
| ElevenLabs | TTS + lipsync | - | |
| fal.ai (Seedance) | Video-generointi | aimlapi | auto top-up |
| fal.ai (FLUX i2i) | Pullokuvat | - | bottle_i2i |
| Render.com | ffmpeg-merge | - | operaattori deployaa |
| Postiz | Julkaisu | - | ei anna natiivia YT-video-id:ta |
| YouTube Data API | uploads-lista, video-id-resoluutio | - | vaatii youtube.readonly-scopen |
| YouTube Analytics API | retention/ctr/views | - | vaatii yt-analytics.readonly-scopen |
| Telegram | notifikaatiot + hyvaksynnat | - | |

**Salaisuudet:** Tokenit luetaan vaultista security-definer-RPC:lla (esim. get_telegram_bot_token, get_telegram_chat_id), EI Deno.env-secreteista (jotka voivat tyhjentya deployssa). Vault-pattern: `SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name=...`. Konkreettiset id:t, avaimet ja chat-id:t ovat vain vaultissa ja yksityisessa handoffissa, EIVAT tassa julkisessa tiedostossa.

---

## 9. RISKIREKISTERI

| Riski | Tila | Mitigaatio |
|-------|------|-----------|
| JSON drift (Haiku improvisoi shot-avaimia) | Hallittu | generate-script normalisointi, kaikki kentat ei-tyhjia stringeja |
| Pullo-hallusinaatio (Seedance) | Hallittu | "no bottle" eksplisiittisesti, ei "product only" |
| Edge Function -secret katoaa deployssa | Hallittu | tokenit vaultiin + RPC |
| Merge-kilpa-ajo (tupla /merge) | Hallittu | MERGING-LUKKO + markFailedIfNotDone |
| Speech cutoff videon lopussa | Hallittu | max(videoDur, audioDur+0.15), ceil shotti-laskennassa |
| TikTok DIRECT_POST katoaa | Hallittu | UPLOAD + SELF_ONLY (audit-rajoitus) |
| Avatar consistency | Avoin | seurataan |
| Retention-data ohut | Avoin | feedback-loop kerryttaa |
| API deprecation / quota | Avoin | fal auto top-up, fallback-enginet |

---

## 10. KESKEISET OPIT (alykonteksti)

- **Ghost-erotin** = avatar-kulma (far) + lipsync 0, EI shottimaaran vahennys (testattu, makropaino peruttu).
- **Shot-prompt-avainten yhtenaisyys kriittista:** generate-script normalisoi avaimet (visual_prompt vs odotettu), muuten Seedance saa tyhjat promptit ja hallusinoi.
- **Audio/video-kesto:** Math.ceil shotti-laskentaan, merge max(videoDur, audioDur+0.15) + tpad freeze + fade.
- **Lipsync:** max 2 (hook + verdict). Merge vasta kun lipsync_applied=true.
- **Vault > Deno.env:** secretit voivat tyhjentya deployssa.
- **pg_net net._http_response lagaa:** tarkista kohdetaulu suoraan, ala luota heti vastaukseen.
- **Render cold start:** status voi nayttaa stored ~1-2 min ennen merging-tilaa. Ei bugi.

---

## 11. TYOSKENTELYTAPA

- Claude kirjoittaa TAYDELLISET korvaavat tiedostot (ei patch-paloja); operaattori deployaa ja sanoo "tehty".
- Pienet robustius/infrastruktuurikorjaukset: Claude deployaa suoraan Supabase MCP:lla.
- Data/infrastruktuurityo: Claude etenee itsenaisesti niin pitkalle kuin paasee.
- Generointi/sisaltomuutokset (VAIHE 2+): operaattori tekee eksplisiittiset go/no-go-paatokset.
- Itse generoitu koodi/SQL ei mene tuotantoon ilman operaattorin hyvaksyntaa (paitsi esivaltuutetut pienet korjaukset).
- Sessiotila ja handoffit: yksityinen Notion-handoff. Operatiivinen nykytila: Supabase project_memory.

---

## 12. TUNNISTEET JA SALAISUUDET

Konkreettiset projekti-id:t, kanava-id:t, chat-id:t, voice-id:t, integration-id:t ja kaikki avaimet ovat tarkoituksella POIS tasta julkisesta tiedostosta. Ne sijaitsevat:
- Supabasen vaultissa (avaimet, tokenit)
- `project_memory`-taulussa ja `config`-taulussa (operatiiviset asetukset)
- Yksityisessa Notion-handoffissa

Kun AI tarvitsee konkreettisen tunnisteen, se hakee sen Supabasesta, ei tasta tiedostosta.

---

*Operatiivinen tilannekuva (nykyinen vaihe, avoimet tehtavat, blokkerit): katso Supabase `project_memory` (id=1).*
