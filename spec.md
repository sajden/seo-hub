# article-generator — Spec

Automatisk SEO-artikelgenerering med mänskligt godkännande.

## Syfte

Generera en SEO-optimerad artikel per vecka för auto-web, baserat på Google Trends
och sidans befintliga innehåll. Artikeln granskas och godkänns manuellt i ett webb-UI
innan den publiceras.

---

## Systemöversikt

```
Google Trends
     │
     ▼
[Generator] ── Codex CLI ──▶ artikelutkast (lokal JSON-draft)
                                    │
                                    ▼
                           [Review UI] ── approve ──▶ [Publisher]
                                    │                      │
                                    └── reject             ├─ skriver MDX till auto-web/content/articles/
                                                           ├─ git commit + push
                                                           └─ POST /api/revalidate på live-siten
```

---

## Komponenter

### 1. Generator (`generator/`)

Körs manuellt eller via cron (1×/vecka).

**Indata:**
- Google Trends-data för relevanta ämnen (via SerpAPI eller pytrends)
- Befintliga artiklar i `auto-web/content/articles/` (för att undvika duplicering)
- Sidans nisch/persona (konfigurerad i `config.json`)

**Process:**
1. Hämta trending topics för konfigurerade keywords/nisch
2. Välj bäst passande topic (högst trend-score, ej redan publicerad)
3. Anropa Codex CLI med en strukturerad prompt:
   - Rubrik (H1)
   - Meta description (max 160 tecken)
   - Artikel (800–1500 ord, markdown)
   - Slug (URL-vänlig)
   - Tags
4. Spara draft till `.local/drafts/<slug>.json`

**Draft-format:**
```json
{
  "slug": "article-slug",
  "title": "Artikelrubrik",
  "metaDescription": "Max 160 tecken...",
  "body": "# Rubrik\n\nMarkdown...",
  "tags": ["tag1", "tag2"],
  "trendScore": 85,
  "trendTopic": "keyword som triggade",
  "generatedAt": "2026-04-09T10:00:00Z",
  "status": "pending"
}
```

### 2. Review UI (`ui/`)

Enkel webb-app (Express + vanilla HTML eller Next.js).

**Sidor:**
- `/` — lista alla pending drafts (titel, datum, trend-score)
- `/draft/:slug` — visa full artikel, metadata, trend-motivering
  - Knapp: **Godkänn** → publicerar
  - Knapp: **Avvisa** → markerar som rejected (tas bort från listan)
  - Knapp: **Redigera** → inline-editor för att justera texten

**Draft-status:** `pending` → `approved` / `rejected`

### 3. Publisher (`publisher/`)

Triggas när en draft godkänns.

**Steg:**
1. Läs draft JSON
2. Generera MDX-fil:
   ```mdx
   ---
   title: "Artikelrubrik"
   description: "Meta description"
   date: "2026-04-09"
   tags: ["tag1", "tag2"]
   ---

   Markdown-innehåll...
   ```
3. Skriv filen till `../auto-web/content/articles/<slug>.mdx`
4. `git add` + `git commit` + `git push` i auto-web-repot
5. POST till `REVALIDATE_URL` med secret → triggar on-demand ISR på live-siten
6. Uppdatera draft-status till `published`

---

## Artikellagring (auto-web)

Artiklar lagras som **MDX-filer** i `auto-web/content/articles/`.

**Varför MDX-filer i GitHub:**
- Versionshistorik — varje artikel syns som en commit
- Next.js läser dem statiskt → full SEO (ren HTML i sidkällan)
- Inga extra databaser att drifta

**Varför inte en databas:**
- 1 artikel/vecka — ingen anledning till runtime-DB-beroende
- MDX-filer är enklare att granska, redigera och rulla tillbaka

---

## SEO utan full rebuild (Cloudflare)

Next.js **on-demand ISR**:

```
Ny artikel committas → git push → Cloudflare Pages bygger om (30–60 sek)
```

ELLER för instant-publicering utan rebuild:

```
Publisher → POST /api/revalidate?secret=XXX&path=/artiklar/slug
Next.js ogiltigförklarar den sidan → nästa request renderar ny statisk HTML
Cloudflare cachar den nya versionen
```

Revalidate-endpoint i auto-web:
```ts
// app/api/revalidate/route.ts
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  if (searchParams.get('secret') !== process.env.REVALIDATE_SECRET) {
    return Response.json({ error: 'unauthorized' }, { status: 401 })
  }
  revalidatePath(searchParams.get('path') ?? '/')
  return Response.json({ revalidated: true })
}
```

**Resultat:** Artikel publiceras inom sekunder, ingen full rebuild, full SEO (statisk HTML).

---

## Konfiguration (`config.json`)

```json
{
  "site": "auto-web",
  "niche": "beskrivning av sidans nisch",
  "seedKeywords": ["keyword1", "keyword2"],
  "targetLanguage": "sv",
  "articleLength": { "min": 800, "max": 1500 },
  "autoWebPath": "../auto-web",
  "revalidateUrl": "https://din-site.pages.dev/api/revalidate",
  "revalidateSecret": "från env"
}
```

---

## Tech stack

- **Runtime:** Node.js 22
- **Trends:** SerpAPI (Google Trends endpoint) eller `pytrends` via Python subprocess
- **LLM:** Codex CLI (`codex` binary, samma som i ai-cam)
- **UI:** Express + minimal HTML (ingen byggsteg, enkelt att köra)
- **Publish:** `simple-git` npm-paket för git-operationer
- **Hosting av article-generator:** lokalt eller som Docker-container

---

## Faser

### Fas 1 — Generator + Review UI (bygg detta först)
- [ ] `config.json` med nisch och keywords
- [ ] Google Trends-hämtning → välj topic
- [ ] Codex CLI → generera draft
- [ ] Express UI — lista och läs drafts
- [ ] Godkänn/avvisa knappar

### Fas 2 — Publisher
- [ ] Skriv MDX till auto-web
- [ ] Git commit + push
- [ ] Revalidate-webhook

### Fas 3 — Integration i operator-hub
- [ ] Flytta UI-logik till operator-hub som en ny route/panel
- [ ] Dela Microsoft Auth om nödvändigt

---

## Köra lokalt

```bash
# Installera
npm install

# Generera ett nytt utkast
node generator/run.mjs

# Starta review UI
node ui/server.mjs
# Öppna http://localhost:3001
```
