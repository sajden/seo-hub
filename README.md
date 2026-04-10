# SEO-Hub

Automatisk SEO-artikelgenerering med mänskligt godkännande.

## Vad är detta?

SEO-Hub genererar SEO-optimerade artiklar baserat på Google Trends för dina webbplatser. Artiklar granskas manuellt i ett webb-UI innan publicering.

## Status: Fas 1 ✅

- [x] Generator (Google Trends → Codex → Draft)
- [x] Duplicate check (AI semantic matching)
- [x] Gap analysis (när trends är täckta)
- [x] Review UI (granska, godkänn, avvisa)
- [ ] Publisher (Fas 2 - git commit/push)

## Installation

```bash
# Installera dependencies
npm install

# Installera pytrends för Google Trends
npm run setup
```

## Användning

### 1. Generera artikel

```bash
# Generera för en specifik site
node generator/run.mjs --site autoweb

# Generera för alla sites i config.json
node generator/run.mjs --all
```

Generatorn kommer att:
1. Hämta trending topics från Google Trends
2. Jämföra mot befintliga artiklar (semantic duplicate check)
3. Om alla topics är duplicerade → gap analysis
4. Generera artikel med Codex CLI
5. Spara draft till `.local/drafts/{siteId}/{slug}.json`

### 2. Granska artikel

```bash
# Starta review UI
npm run start:ui

# Öppna i browser
# http://localhost:3001
```

I UI:t kan du:
- Se alla pending drafts
- Läsa full artikel
- Godkänna (status → approved)
- Avvisa (status → rejected)

### 3. Publicera (Fas 2 - kommande)

När en artikel godkänns kommer Publisher (Fas 2) att:
- Skriva MDX till target repo
- Git commit + push
- Revalidate live site

## Konfiguration

Redigera `config.json` för att lägga till sites:

```json
{
  "sites": [
    {
      "id": "autoweb",
      "niche": "Bilnyheter och elbilstrender i Sverige",
      "targetRepo": "../auto-web",
      "contentPath": "content/articles",
      "seedKeywords": ["elbilar", "tesla", "laddinfrastruktur"],
      "schedule": { "day": "monday", "time": "09:00" },
      "articleLength": { "min": 800, "max": 1500 },
      "targetLanguage": "sv",
      "revalidateUrl": "https://site.com/api/revalidate",
      "revalidateSecret": "env:SECRET"
    }
  ]
}
```

## Workflow

```
Cron → Generator → Trends → Duplicate check → Draft → Review UI → Approve → Publisher (Fas 2)
```

### Hur duplicate-check fungerar

Använder Codex CLI för semantic matching:
- Jämför topic mot befintliga artiklar
- AI bedömer om innehållet överlappar >70%
- Filtrerar bort duplicerade topics

### Vad händer om alla topics är duplicerade?

Gap analysis triggas automatiskt:
- AI analyserar befintliga artiklar
- Föreslår relevanta topics som saknas
- Genererar artikel även om det inte trendar

## Projektstruktur

```
seo-hub/
├── config.json              # Multi-site config
├── .local/drafts/           # Generated drafts (gitignored)
├── lib/                     # Core libraries
│   ├── config.mjs          # Config loader
│   ├── codex.mjs           # Codex CLI wrapper
│   └── articles.mjs        # Read existing articles
├── generator/               # Article generation
│   ├── run.mjs             # Main entry point
│   ├── trends.py           # Google Trends (pytrends)
│   ├── trends.mjs          # Trends wrapper
│   ├── duplicate-check.mjs # AI semantic check
│   ├── gap-analysis.mjs    # Content gap finder
│   └── draft-generator.mjs # Draft creator
└── ui/                      # Review UI
    ├── server.mjs          # Express server
    ├── public/styles.css   # Styles
    └── views/              # HTML templates (inline)
```

## Krav

- Node.js 22+
- Python 3.8+
- Codex CLI (installerat)
- pytrends (installeras via `npm run setup`)

## Nästa steg (Fas 2)

- [ ] Publisher-komponent
- [ ] Git operations (commit + push)
- [ ] Revalidate webhook
- [ ] Cron scheduler
- [ ] Error handling & logging

## Nästa steg (Fas 3)

- [ ] Integration i operator-hub
- [ ] Dela Microsoft Auth
- [ ] Multi-tenant UI
