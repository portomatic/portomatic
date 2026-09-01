const atlas = document.querySelector("#logo-atlas-groups");
const toggles = [...document.querySelectorAll("[data-atlas-view]")];

const companyGroups = [...atlas.querySelectorAll(".logo-atlas-group")].map((group) => {
  const title = group.querySelector("h4").textContent;
  const note = group.querySelector(".logo-atlas-group__header > p").textContent;
  const cards = [...group.querySelectorAll(".logo-atlas-card")];

  for (const card of cards) card.dataset.companyGroup = title;
  return { title, note, cards };
});

const cardsByName = new Map(
  companyGroups.flatMap(({ cards }) => cards).map((card) => [card.querySelector("h5").textContent, card]),
);

const feelingGroups = [
  {
    title: "Precise & controlled",
    note: "Exact, calm, intentionally machined",
    names: ["PlanetScale", "Linear", "Railway", "Replicate", "Render", "Neon", "Etched", "Black Forest Labs", "Vercel", "Cursor", "Biome", "Better Stack", "Clerk"],
  },
  {
    title: "Light & kinetic",
    note: "Fast, open, and low friction",
    names: ["Netlify", "Fly.io", "Supabase", "Upstash", "SpacetimeDB", "Fireworks AI", "SpaceX", "StackBlitz", "Apache Airflow", "Airbyte", "Zapier", "Inngest", "Temporal"],
  },
  {
    title: "Solid & dependable",
    note: "Stable systems you can trust",
    names: ["Docker", "Kubernetes", "Cloudflare", "DigitalOcean", "Redis", "Databricks", "CockroachDB", "ScyllaDB", "Auth0", "Kong", "Hasura", "Sentry", "Coder"],
  },
  {
    title: "Friendly & approachable",
    note: "Warm without feeling consumer",
    names: ["Deno", "Bun", "MongoDB", "Drizzle", "Hugging Face", "Ollama", "PostHog", "Datadog", "Honeybadger", "GitHub Copilot", "Storybook", "Replit", "Turso"],
  },
  {
    title: "Technical & intricate",
    note: "Dense, capable, deeply engineered",
    names: ["Timescale", "ClickHouse", "Qdrant", "Prisma", "LangChain", "PyTorch", "Weights & Biases", "Grafana", "Prometheus", "OpenTelemetry", "Apache Kafka", "n8n", "GraphQL"],
  },
  {
    title: "Bold & distinctive",
    note: "Immediate, memorable, self-assured",
    names: ["Convex", "Mistral AI", "Anthropic", "Modal", "Groq", "Perplexity", "New Relic", "Elastic", "Gitpod", "CodeSandbox", "Insomnia", "Postman"],
  },
];

function groupId(title) {
  return `atlas-${title.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "")}`;
}

function makeGroup({ title, note, cards }) {
  const section = document.createElement("section");
  const id = groupId(title);
  section.className = "logo-atlas-group";
  section.setAttribute("aria-labelledby", id);
  section.innerHTML = `
    <header class="logo-atlas-group__header">
      <div><h4 id="${id}">${title}</h4><span>${cards.length}</span></div>
      <p>${note}</p>
    </header>
    <div class="logo-atlas-grid"></div>
  `;
  section.querySelector(".logo-atlas-grid").append(...cards);
  return section;
}

function renderAtlas(view) {
  const groups = view === "company"
    ? companyGroups
    : feelingGroups.map(({ title, note, names }) => ({
        title,
        note,
        cards: names.map((name) => cardsByName.get(name)),
      }));

  atlas.replaceChildren(...groups.map(makeGroup));
  for (const toggle of toggles) {
    toggle.setAttribute("aria-pressed", String(toggle.dataset.atlasView === view));
  }
}

for (const toggle of toggles) {
  toggle.addEventListener("click", () => renderAtlas(toggle.dataset.atlasView));
}

renderAtlas("feeling");
