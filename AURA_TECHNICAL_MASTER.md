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

## 2. ARKKITEHTUURIPERIAATTEET

Nama periaatteet ohjaavat kaikkea kehitysta. Uusi koodi noudattaa naita; poikkeamat dokumentoidaan.

- **Single Source of Truth.** Jokaisella tietotyypilla on yksi auktoritatiivinen lahde. Tekninen rakenne = tama tiedosto. Operatiivinen nykytila = `project_memory`. Salaisuudet = vault. Pipeline-tila = `video_jobs`. Ei rinnakkaisia totuuksia.
- **Idempotency.** Jokainen vaihe voidaan ajaa uudelleen tuottamatta duplikaattia. Esim. render-video RETRY_GUARD, publish idempotenssi (alreadyOn-tarkistus), shot-cache md5_hash. Sama kutsu kahdesti = sama lopputulos.
- **Retry-safe.** Transientit virheet (5xx, timeout) erotetaan pysyvista (4xx, validointi). Vain transientit retrytetaan. poll-video transient-luokitus, auto_retry_transient_failures.
- **Idempotenssi ennen automaatiota.** Mikaan cron ei kasittele jobia jolla on ratkaisematon publish_error tai kesken oleva lukko. Portit (automation_enabled) gateaavat kaiken.
- **Fail loud, recover quiet.** Virheet kirjataan nakyvasti (failure_reason, failure_stage, Telegram-halytys), mutta itse-korjautuvat tilanteet (cold start, transient retry) eivat hairitse operaattoria.
- **State in DB, not in memory.** Pipeline-tila elaa `video_jobs.job_payload`-kentassa ja status-sarakkeessa, ei Edge Functionin muistissa. Funktio voi kuolla ja jatkaa siita mihin jai.
- **Vault over env.** Salaisuudet vaultista security-definer-RPC:lla, ei Deno.env-secreteista (jotka voivat tyhjentya deployssa).

---

## 3. TEKNINEN ARKKITEHTUURI

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

## 4. WORKFLOW (pipeline state machine)

**Tilakaavio (video_jobs.status):**

```
[idea_pool] --generate-ideas--> pending
   |
   v generate-script + generate-audio
[script + audio valmis]
   |
   v render-video
processing --(shotit valmiit)--> stored --(poll-video lipsync)--> stored(lipsync_applied=true)
   |  (shot fail)                                                      |
   v                                                                   v merge-video
failed <----(markFailedIfNotDone)                                  merging --(Render valmis)--> merged
   ^                                                                   |
   |  (retry transient)                                                v publish-postiz (telegram_approval)
   +--- auto_retry_transient_failures                              [approval pending] --hyvaksy--> done
                                                                       |
                                                                       v
                                                                  published_videos + analytics_memory
```

**Tilat:** `pending` -> `processing` -> `stored` -> `merging` -> `merged` -> `done`. Haarat: `failed` (palautettavissa retry:lla jos transient). Lukot: MERGING-LUKKO estaa tuplamergen, lipsync_applied estaa ennenaikaisen mergen.

**Pipeline-vaiheet:**
```
Idea (idea_pool) -> generate-ideas
Script (scripts.script_json) -> generate-script  [Haiku, formaatti + psych_vector]
Audio (audio) -> generate-audio  [ElevenLabs TTS + word_timings]
Video shots (shot_render_tasks) -> render-video  [Seedance + FLUX]
Poll + lipsync (video_jobs) -> poll-video  [lipsync hook+verdict]
Merge (merged_video_url) -> merge-video  [Render ffmpeg, pullo-intro]
Publish approval -> publish-postiz  [Telegram-hyvaksynta]
Publish -> Postiz -> YT/TikTok/IG
Analytics -> sync-analytics -> analytics_memory
Patterns -> compute_performance_patterns -> performance_patterns
Feedback loop -> takaisin generointiin (VAIHE 2, kesken)
```

---

## 5. SISALTOFORMAATIT (kiinteat suhteet)

| Formaatti | Osuus | Avatar | Lipsync | Erotin |
|-----------|-------|--------|---------|--------|
| Compliment Magnet | 60% | lahikuva (i2v_avatar) | hook + verdict | avatar-paino |
| Olfactory Ghost | 30% | kaukokuva (i2v_avatar_far) | 0 | avatar-kulma + ei lipsynkkia |
| The Archive | 10% | etainen avatar | max 1 | editorial |

**Shot-jarjestys (buildShotOrder):** verdict aina viimeinen, ei koskaan kahta avataria perakkain (makro valissa). Sama jarjestys kaikille formaateille; Ghost-makropaino peruttiin datan perusteella (analysis-avatar nakyi parempana). Avatar-origIndex {0,2,4,6}, makro {1,3,5}, verdict=6. Max 2 lipsync-shottia (hook + verdict), max 2 avatar-shottia muuten.

**Psykologiset ajurit:** 7 ajuria (curiosity, scarcity, authority, social_proof, novelty, controversy, status_signalling) pisteytetaan 0-1 per script, tallennetaan `psych_vector`. Linkitetaan analytiikkaan performance-oppimista varten.

---

## 6. TIETOMALLI (keskeiset taulut)

**Pipeline-ydin:**
- `idea_pool` — ideat (status pending/in_use), score, format_type. Lahde scriptille.
- `scripts` — script_json (shot1-7, hook, caption, hashtags, mood, format_type, psych_vector, product_image_url). Linkki idea_id.
- `audio` — audio_url, word_timings, duration_seconds, intro_name_url. Linkki script_id.
- `video_jobs` — KESKEINEN. status, job_payload (shots, clip_urls, lipsync_*), merged_video_url, postiz_post_ids, youtube_video_id, publish_error. Linkki script_id.
- `shot_render_tasks` — per-shotti renderointi, md5_hash (cache), output_video_url, status.
- `video_job_states` — tilasiirtymalokituksen audit-trail.

**Julkaisu + analytiikka:**
- `published_videos` — julkaisujalki (idea_id, platform, video_url).
- `publish_approvals` — Telegram-hyvaksynnat (status pending/published/failed).
- `analytics_memory` — per-video YouTube-metriikat + dimensiot (format_type, mood, psych_vector). UNIQUE youtube_video_id.
- `performance_patterns` — lasketut patternit. Tyhja kunnes >=5 videota/formaatti.

**Kirjastot + konfiguraatio:**
- `config` — singleton (id=1). Kaikki pipeline-asetukset + feature flags (automation_enabled, postiz_enabled, publish_mode, jne).
- `project_memory` — singleton (id=1). "Mika on totta nyt". AI lukee taman ensin.
- `shot_prompt_library` — shotti-promptit, test_score, avg_retention, video_count. Oppii analytiikasta.
- `product_bottle_library` — pullokuvat.
- `agent_prompts` — agenttien systeemipromptit.
- `decision_log` — paatoshistoria.

**Telegram/Jarvis:** `telegram_alert_state`, `telegram_send_log`.

---

## 7. EDGE FUNCTIONS (input / output / failure modes)

| Funktio | verify_jwt | Input | Output | Failure modes |
|---------|-----------|-------|--------|---------------|
| generate-ideas | - | (cron) | rivit idea_pooliin | Haiku-virhe -> ei ideoita (ei-kriittinen) |
| generate-script | true | format_type, custom_instructions | scripts-rivi | idea_score < kynnys (422); Haiku JSON drift (normalisoitu); ei ideoita |
| generate-audio | true | script_id | audio-rivi + word_timings | ElevenLabs-virhe; script puuttuu |
| render-video | false | script_id, video_engine | video_jobs processing + generation_ids | shot fail -> failed; FAL/AIML timeout (transient); avatar puuttuu |
| poll-video | false | job_id | stored + clip_urls + lipsync_applied | transient 5xx (cap 20); unknown 4xx (cap 5); lipsync-virhe |
| merge-video | false | job_id | merged + merged_video_url | Render HTTP-virhe (ei ylikirjoita valmista); merge-kilpa-ajo (MERGING-LUKKO); klippimaara-mismatch |
| publish-postiz | true | job_id | done + postiz_post_ids | Telegram chat_id puuttuu; Postiz HTTP per kanava (partial); jo julkaistu (skip) |
| sync-analytics | false | {debug?} | analytics_memory + patterns | OAuth scope 403; video-id resoluutio; YouTube no_rows |

**Auth-saanto:** verify_jwt=false kutsuttavissa pg_net:lla. verify_jwt=true vaatii Bearer service_role_key (vault).

---

## 8. VIRHEIDEN SEVERITY-LUOKITUS

| Severity | Maaritelma | Toiminta | Esimerkki |
|----------|-----------|----------|-----------|
| **P0 kriittinen** | Koko pipeline pysahtyy, kaikki uudet videot estyvat | Telegram-halytys heti, korjaa ennen muuta | auto-julkaisu jumissa (chat_id tyhja), generate-script kaatuu aina |
| **P1 vakava** | Yksittainen video epaonnistuu peruuttamattomasti tai vaarin julkaistu | Telegram-halytys, korjaa saman paivan aikana | shot-generointi failed, vaara caption, merge-kilpa-ajo |
| **P2 merkittava** | Toistuva mutta ei-blokkaava, laatu karsii | Lokita, korjaa kun ehtii | thumbnail puuttuu, transient-retry toistuu |
| **P3 viilaus** | Kosmeettinen tai pieni optimointi | Backlog | promptin sanamuoto, lokituksen selkeys |

**Periaate:** P0/P1 keskeyttavat muun tyon. P2/P3 backlogiin. Severity kirjataan decision_log-merkintoihin.

---

## 9. API-REKISTERI

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

**Salaisuudet:** Tokenit vaultista security-definer-RPC:lla, EI Deno.env-secreteista. Konkreettiset id:t ja avaimet vain vaultissa ja yksityisessa handoffissa, EIVAT tassa.

---

## 10. RISKIREKISTERI

| Riski | Severity | Tila | Mitigaatio |
|-------|----------|------|-----------|
| JSON drift (Haiku improvisoi shot-avaimia) | P1 | Hallittu | generate-script normalisointi |
| Pullo-hallusinaatio (Seedance) | P2 | Hallittu | "no bottle" eksplisiittisesti |
| Edge Function -secret katoaa deployssa | P0 | Hallittu | tokenit vaultiin + RPC |
| Merge-kilpa-ajo (tupla /merge) | P1 | Hallittu | MERGING-LUKKO + markFailedIfNotDone |
| Speech cutoff videon lopussa | P2 | Hallittu | max(videoDur, audioDur+0.15), ceil |
| TikTok DIRECT_POST katoaa | P1 | Hallittu | UPLOAD + SELF_ONLY |
| Avatar consistency | P2 | Avoin | seurataan |
| Retention-data ohut | P2 | Avoin | feedback-loop kerryttaa |
| API deprecation / quota | P1 | Avoin | fal auto top-up, fallback-enginet |

---

## 11. KESKEISET OPIT (alykonteksti)

- **Ghost-erotin** = avatar-kulma (far) + lipsync 0, EI shottimaaran vahennys (testattu, makropaino peruttu).
- **Shot-prompt-avainten yhtenaisyys kriittista:** generate-script normalisoi avaimet, muuten Seedance saa tyhjat promptit ja hallusinoi.
- **Audio/video-kesto:** Math.ceil shotti-laskentaan, merge max(videoDur, audioDur+0.15) + tpad freeze + fade.
- **Lipsync:** max 2 (hook + verdict). Merge vasta kun lipsync_applied=true.
- **Vault > Deno.env:** secretit voivat tyhjentya deployssa.
- **pg_net net._http_response lagaa:** tarkista kohdetaulu suoraan.
- **Render cold start:** status voi nayttaa stored ~1-2 min ennen merging-tilaa. Ei bugi.

---

## 12. AI AGENT RULES

Saannot kaikille AI-jarjestelmille jotka tyoskentelevat AURAn parissa.

**Lukujarjestys uudelle AI:lle:**
1. Lue tama tiedosto (arkkitehtuuri).
2. Lue `project_memory` (id=1) Supabasesta (nykytila).
3. Vasta sitten aloita tyo.

**Mita saa tehda itsenaisesti:**
- Lukea kantaa, diagnosoida, analysoida.
- Pienet robustius/infrastruktuurikorjaukset (deploy suoraan).
- Data/infrastruktuurityo joka ei muuta generointia.

**Mika vaatii operaattorin go/no-go:**
- Generointi/sisaltomuutokset (prompt-logiikka, formaattipainot, shot-jarjestys).
- Mika tahansa mika muuttaa julkaistavaa sisaltoa.
- Tuotantoon menevä koodi/SQL (paitsi esivaltuutetut pienet korjaukset).

**Toimintatapa:**
- Kirjoita TAYDELLISET korvaavat tiedostot, ei patch-paloja.
- Diagnosoi koodista/datasta ennen deployta. Yksi muutos kerrallaan.
- Ala oleta kyvykkyytta tai kontekstia; tarkista kannasta.
- Sailyta verify_jwt-asetus deployssa.
- Ala koskaan ylikirjoita valmista tulosta (idempotenssi, markFailedIfNotDone).
- Paivita tama tiedosto kun arkkitehtuuri muuttuu; paivita project_memory kun nykytila muuttuu. Ala sekoita.

**Turvallisuus:**
- Ala koskaan lisaa salaisuuksia/tunnisteita julkiseen tiedostoon tai koodiin. Vaultiin.
- Ala julkaise testivideoita. Tarkista status ja publish_error ennen julkaisua.

---

## 13. TYOSKENTELYTAPA (operaattori <-> AI)

- Claude kirjoittaa taydelliset korvaavat tiedostot; operaattori deployaa ja sanoo "tehty".
- Pienet korjaukset: Claude deployaa suoraan Supabase MCP:lla.
- Data/infra: Claude etenee itsenaisesti niin pitkalle kuin paasee.
- Generointi (VAIHE 2+): operaattori tekee eksplisiittiset go/no-go-paatokset.
- Sessiotila: yksityinen Notion-handoff. Nykytila: project_memory.

---

## 14. ROADMAP / KEHITYSVAIHEET

**Tehty:**
- Pipeline paasta paahan (idea -> julkaisu).
- Formaatti-kytkenta (Magnet/Ghost/Archive).
- Publish-pipeline + Telegram-hyvaksynta.
- Feedback-loop VAIHE 1 koodi (kerays + patterns).
- Muistikerros (master file + project_memory).

**Kesken / seuraavaksi:**
- OAuth taysilla scopeilla -> sync-analytics maaliin -> analytics_memory tayteen.
- Feedback-loop VAIHE 2 (patterns -> generointipainotukset). Vaatii go-paatoksen.

**Myohemmin (kun dataa on):**
- A/B-testaus (kytkeytyy feedback-looppiin).
- Kustannusseuranta per video (cost_log).
- pgvector embedding memory (samankaltaiset tuoksut/hookit).
- Multi-provider AI -abstraktion laajennus.

**EI nyt (vaara kokoluokka yhdelle pipelinelle):**
- Event-driven orchestration, message queue, distributed workers.
- Taysi observability-stack (OpenTelemetry/Grafana/Prometheus).
- Multi-agent-jarjestelma (Supervisor/Planner/erikoisagentit), self-healing, knowledge graph.
- Nama harkitaan uudelleen jos volyymi kasvaa merkittavasti tai agentteja tulee useita.

---

## 15. TUNNISTEET JA SALAISUUDET

Konkreettiset projekti-id:t, kanava-id:t, chat-id:t, voice-id:t, integration-id:t ja kaikki avaimet ovat tarkoituksella POIS tasta julkisesta tiedostosta. Ne sijaitsevat:
- Supabasen vaultissa (avaimet, tokenit)
- `project_memory`- ja `config`-tauluissa (operatiiviset asetukset)
- Yksityisessa Notion-handoffissa

Kun AI tarvitsee konkreettisen tunnisteen, se hakee sen Supabasesta, ei tasta tiedostosta.

---

*Operatiivinen tilannekuva (nykyinen vaihe, avoimet tehtavat, blokkerit): katso Supabase `project_memory` (id=1).*
