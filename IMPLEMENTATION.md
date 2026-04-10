# SEO-Hub Implementation Plan

Baserat på diskussion 2026-04-09.

## Beslutade workflows

### Multi-site struktur
En central config med alla sites:

```json
{
  "sites": [
    {
      "id": "autoweb",
      "niche": "bilnyheter och elbilstrender",
      "targetRepo": "../auto-web",
      "contentPath": "content/articles",
      "seedKeywords": ["elbilar", "tesla", "laddinfrastruktur"],
      "schedule": {
        "day": "monday",
        "time": "09:00"
      },
      "articleLength": { "min": 800, "max": 1500 },
      "targetLanguage": "sv",
      "revalidateUrl": "https://autoweb.pages.dev/api/revalidate",
      "revalidateSecret": "env:AUTOWEB_SECRET"
    }
  ]
}
```

### Generator workflow (cron-driven)

```
Cron trigger (per site schedule):
  1. Läs befintliga artiklar från targetRepo/contentPath/*.mdx
  2. Läs befintliga drafts från .local/drafts/{siteId}/*.json
  3. Extrahera titles, tags, keywords från alla artiklar

  4. Hämta Google Trends för seedKeywords
  5. AI-jämför trending topics mot befintligt innehåll:
     - Är detta samma innehåll/syfte? (semantic matching)
     - Filtrera bort duplicerade topics

  6. Om ALLA trending topics redan täckts:
     - Expandera keyword-sökning
     - AI analyserar befintliga artiklar → föreslår relaterade topics
     - Generera relevant innehåll även om det inte trendar

  7. Välj bästa topic (trend-score + relevans + gap i befintligt innehåll)

  8. Anropa Codex CLI för att generera draft

  9. Spara till .local/drafts/{siteId}/{slug}.json med status: "pending"
```

### Draft-struktur
```json
{
  "siteId": "autoweb",
  "slug": "article-slug",
  "title": "Artikelrubrik",
  "metaDescription": "Max 160 tecken...",
  "body": "# Rubrik\n\nMarkdown...",
  "tags": ["tag1", "tag2"],
  "trendScore": 85,
  "trendTopic": "keyword som triggade",
  "reasoning": "Varför detta topic valdes (gap-analys)",
  "generatedAt": "2026-04-09T10:00:00Z",
  "status": "pending"
}
```

### Review UI workflow
```
http://localhost:3001/

Startsida:
  - Lista ALLA pending drafts från alla sites
  - Visar: [siteId] Titel | Trend-score | Datum
  - Sorterat på datum (nyast först)

/draft/{siteId}/{slug}:
  - Visa full artikel
  - Visa metadata, trend-motivering, reasoning
  - Knappar:
    - Godkänn → trigger Publisher
    - Avvisa → status: "rejected"
    - Redigera → inline editor (optional fas 1)
```

### Publisher workflow
```
Triggas av "Godkänn" i UI:

  1. Läs draft JSON
  2. Hitta site-config via siteId
  3. Generera MDX-fil:
     ---
     title: "..."
     description: "..."
     date: "2026-04-09"
     tags: ["tag1", "tag2"]
     ---

     {body}

  4. Skriv till {targetRepo}/{contentPath}/{slug}.mdx
  5. Git: add + commit + push i targetRepo
  6. POST {revalidateUrl}?secret=XXX&path=/artiklar/{slug}
  7. Uppdatera draft status: "published"
```

### Cron setup (lokal maskin)
```bash
# crontab -e
0 9 * * 1 cd /home/sajden/github/seo-hub && node generator/cron.mjs --site autoweb
0 10 * * 3 cd /home/sajden/github/seo-hub && node generator/cron.mjs --site othersite
```

ELLER en scheduler i Node.js som kör kontinuerligt:
```bash
# Kör alltid, checkar schedule i config
node scheduler/run.mjs
```

---

## Tech decisions

### AI-jämförelse av topics
- Använd Codex CLI för semantic matching
- Prompt: "Är topic X samma innehåll/syfte som dessa artiklar: [titles]?"
- Returnerar: boolean + reasoning

### Google Trends API
- **Alternativ 1:** SerpAPI (betald, enkel REST API)
- **Alternativ 2:** pytrends (gratis Python library) via subprocess
- **Beslut:** Börja med pytrends (gratis), kan bytas ut senare

### Codex CLI
- Finns redan installerat (använt i ai-cam)
- Anropa via `exec('codex prompt "..."')`
- Strukturerad output via JSON-mode eller markdown parsing

---

## Fas 1 - Bygg nu

### Core komponenter
```
seo-hub/
├── config.json                 # Multi-site config
├── .local/
│   └── drafts/
│       ├── autoweb/
│       └── othersite/
├── generator/
│   ├── run.mjs                # Main generator
│   ├── trends.mjs             # Google Trends hämtning
│   ├── duplicate-check.mjs    # AI semantic matching
│   └── codex.mjs              # Codex CLI wrapper
├── ui/
│   ├── server.mjs             # Express server
│   └── views/
│       ├── index.html         # Lista drafts
│       └── draft.html         # Visa en draft
└── lib/
    └── config.mjs             # Läs config, hitta sites
```

### Fas 1 tasks
- [ ] config.json struktur + läsare
- [ ] Google Trends integration (pytrends)
- [ ] Läs befintliga artiklar från targetRepo
- [ ] AI semantic duplicate-check (Codex CLI)
- [ ] Gap-analys om alla trending topics täckta
- [ ] Draft generation (Codex CLI)
- [ ] Express UI - lista drafts
- [ ] Express UI - visa draft
- [ ] Godkänn/avvisa knappar

---

## Fas 2 - Publisher
- [ ] MDX-generering
- [ ] Git operations (simple-git)
- [ ] Revalidate webhook
- [ ] Status tracking (pending → published)

---

## Fas 3 - Integration i operator-hub
- [ ] Flytta UI till operator-hub route
- [ ] Dela auth om nödvändigt
