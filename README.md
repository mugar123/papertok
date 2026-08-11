# PaperTok

**A personalized way to discover scientific research.**

[Open PaperTok](https://mugar123.github.io/papertok/#/)

<p align="center">
  <a href="https://mugar123.github.io/papertok/#/">
    <img src="docs/assets/papertok-feed.png" alt="PaperTok personalized scientific paper feed" width="100%">
  </a>
</p>

PaperTok is an open-source web app for discovering research papers through a scrollable, personalized feed.

I started building it as a physics student because I kept running into the same problem: there is an enormous amount of interesting research available online, but discovering papers outside of a very specific search can still be surprisingly difficult.

PaperTok tries to make that process feel more natural.

Instead of knowing exactly what to search for, you can browse papers, interact with the ones that interest you, follow scientific topics and researchers, and gradually get recommendations that better match what you care about.

> PaperTok is currently under active development. It is a personal open-source project and not affiliated with arXiv, OpenAlex, PubMed, or any other data provider.

The interface supports Spanish and English. PaperTok selects a default from the visitor's
region and also provides a manual language setting.

## What PaperTok does

PaperTok brings scientific literature from multiple sources into a common discovery experience.

The main feed is personalized using signals such as:

- scientific fields and categories you are interested in
- papers you interact with
- learned affinities with research topics
- authors, topics, institutions and projects you follow
- publication recency
- citation information
- semantic concepts
- exploration outside your usual interests
- content diversity

The goal is not simply to rank the most popular papers, but to help each person discover research that is relevant to them while still leaving room for unexpected and interesting results.

## Research

PaperTok also includes a **Research** section designed for exploring important research over different time periods.

It collects candidates from several scientific sources and ranks them using a combination of relevance, scientific impact, recency and diversity.

The report is intended to answer a slightly different question from the main feed:

> *What research is worth paying attention to right now?*

Rather than only showing papers from a single database, PaperTok normalizes papers from different providers into a common format before ranking them.

## Data sources

PaperTok uses open scientific infrastructure wherever possible.

Core sources include:

- **arXiv** — preprints across physics, mathematics, computer science and other fields
- **OpenAlex** — publication metadata, citations, concepts, institutions and open-access information
- **PubMed** — biomedical and life-science literature
- **OpenReview** — current conference and journal submissions in machine learning and computer science
- **NIH iCite** — citation and translation metrics for PubMed-indexed papers
- **Hugging Face Hub** — AI papers and their linked models, datasets, code and project pages

The project also contains integrations and enrichment tools for additional scientific services and domain-specific sources.

PaperTok does not host research papers itself. Links to papers, PDFs and metadata are obtained from their respective providers.

## Recommendation system

The recommendation engine is intentionally built inside the project rather than relying on a black-box recommendation API.

Each candidate paper can receive signals based on:

**Explicit preferences**  
Fields and categories selected by the user.

**Learned affinity**  
Interactions gradually modify the user's affinity with scientific categories and concepts.

**Following**  
Papers can be boosted when they relate to followed authors, topics, institutions or projects.

**Recency**  
New research receives a bounded recency signal.

**Scientific impact**  
Citation information can contribute to ranking without allowing highly cited papers to dominate everything else.

**Semantic relevance**  
Scientific concepts associated with papers can be compared with learned user interests.

**Exploration**  
Some results intentionally come from outside the strongest known preferences to avoid creating an overly narrow feed.

**Diversity**  
The ranking tries to avoid long sequences containing only one type of publication or source.

The recommendation system is still experimental, and one of the main reasons this project is open source is to make its behavior inspectable and easier to improve.

## Architecture

PaperTok is primarily built with:

- **React**
- **Vite**
- **Firebase**
- **React Router**
- **Framer Motion**
- **KaTeX**

The frontend is deployed through **GitHub Pages**.

A **Cloudflare Worker** is used for server-side functionality such as caching scientific queries, protecting provider credentials and proxying APIs that should not be called directly from the browser.

This keeps the main application lightweight while allowing integrations that require server-side secrets.

## Running PaperTok locally

Clone the repository:

```bash
git clone https://github.com/mugar123/papertok.git
cd papertok
```

Install dependencies:

```bash
npm install
```

Start the development server:

```bash
npm run dev
```

Then open the local URL shown by Vite.

You can also create a production build with:

```bash
npm run build
```

and run the test suite with:

```bash
npm test
```

Some integrations require additional environment variables or API credentials. The frontend can still be developed independently, while server-side integrations are handled through the Worker.

See [`worker/README.md`](worker/README.md) for information about the server-side configuration.

## Repository structure

```text
papertok/
├── src/                    React app, scientific services and recommendation logic
├── worker/                 Cloudflare Worker, AI and notifications
├── public/                 Static assets
├── docs/                   Architecture and development guides
├── scripts/diagnostics/    Manual provider and proxy probes
└── .github/workflows/      GitHub Pages deployment
```

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Development guide](docs/DEVELOPMENT.md)
- [Worker configuration](worker/README.md)
- [Contributing](CONTRIBUTING.md)
- [Agent guidance](AGENTS.md)

## Why I built it

I'm an undergraduate physics student, and PaperTok started as a project to solve a problem I had myself.

When learning about a field, I often don't know the title of the paper I want to read, the author who wrote it, or even the exact keywords I should search for. Traditional search is excellent once you know what you are looking for, but I wanted to experiment with another part of the process: **discovery**.

What happens if scientific literature is something you can explore?

PaperTok is my attempt to find out.

It has also become a way for me to learn software development, recommendation systems, scientific APIs and open-source development while building something connected to the field I study.

## Project status

PaperTok is a work in progress.

Things may change quickly, APIs may occasionally fail, and parts of the architecture are still being redesigned as the project grows.

Current areas of development include:

- improving recommendation quality
- expanding and improving scientific data sources
- better deduplication across providers
- scientific discovery and trend tools
- citation and related-paper exploration
- performance and reliability
- documentation and testing
- making the project easier for other people to contribute to

## Contributing

Contributions, suggestions and bug reports are welcome.

If you find something that could be improved, feel free to open an issue or submit a pull request.

Since PaperTok is still evolving quickly, opening an issue before working on a large change is recommended so we can discuss the approach first.

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, verification and security guidance.

## Acknowledgements

PaperTok relies on the work of open scientific infrastructure projects and research databases that make scholarly metadata accessible to developers and researchers.

In particular, the project would not be possible without services such as arXiv, OpenAlex and PubMed.

## License

PaperTok is available under the [MIT License](LICENSE).

---

Built by [Nicolás Muñoz](https://github.com/mugar123) while studying physics and learning how better tools for scientific discovery could work.
