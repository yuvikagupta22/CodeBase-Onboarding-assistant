const path = require("path");
const dotenv = require("dotenv");

dotenv.config({ path: path.resolve(__dirname, "../../.env") });

function asInt(value, fallback) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

// CLIENT_URL accepts a comma-separated list so deployments can whitelist
// production + preview domains in one variable, e.g.
//   CLIENT_URL=https://app.example.com,https://app-git-*-foo.vercel.app
const clientUrls = (process.env.CLIENT_URL || "http://localhost:5173")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Google's Gemini endpoint also accepts the key in its own header. Sending
// it there too lets newer Google key formats (e.g. "AQ.") work, which may
// not be accepted as a Bearer token.
function providerHeaders(baseURL, apiKey) {
  if (baseURL && baseURL.includes("googleapis.com") && apiKey) {
    return { "x-goog-api-key": apiKey };
  }
  return undefined;
}

const env = {
  nodeEnv: process.env.NODE_ENV || "development",
  port: asInt(process.env.PORT, 5000),
  clientUrl: clientUrls[0],
  clientUrls,

  openai: {
    apiKey: (process.env.OPENAI_API_KEY || "").trim(),
    // Override to point the OpenAI SDK at any OpenAI-compatible server
    // (Ollama: http://localhost:11434/v1, Groq: https://api.groq.com/openai/v1, …).
    // Leave unset for the real OpenAI API.
    baseURL: process.env.OPENAI_BASE_URL || undefined,
    defaultHeaders: providerHeaders(
      process.env.OPENAI_BASE_URL,
      (process.env.OPENAI_API_KEY || "").trim()
    ),
    chatModel: process.env.OPENAI_CHAT_MODEL || "gpt-4o-mini",
    embedModel: process.env.OPENAI_EMBED_MODEL || "text-embedding-3-small",
    // Vector dim emitted by the embedding model. Must match the Qdrant
    // collection size. text-embedding-3-small=1536, nomic-embed-text=768,
    // bge-large-en=1024, etc.
    embedDim: asInt(process.env.EMBED_DIM, 1536),
  },

  mongoUri:
    process.env.MONGODB_URI ||
    "mongodb://localhost:27017/codebase-onboarding",

  qdrant: {
    url: process.env.QDRANT_URL || "http://localhost:6333",
    apiKey: process.env.QDRANT_API_KEY || undefined,
  },

  githubToken: process.env.GITHUB_TOKEN || undefined,

  limits: {
    maxRepoSizeMB: asInt(process.env.MAX_REPO_SIZE_MB, 250),
    maxFiles: asInt(process.env.MAX_FILES_PER_REPO, 500),
    maxLines: asInt(process.env.MAX_LINES_PER_REPO, 100_000),
    maxFileSize: asInt(process.env.MAX_FILE_SIZE_BYTES, 200_000),
    embedBatchSize: asInt(process.env.EMBED_BATCH_SIZE, 256),
    // How many embedding requests run at the same time.
    embedConcurrency: asInt(process.env.EMBED_CONCURRENCY, 4),
    cacheReindexHours: asInt(process.env.CACHE_REINDEX_HOURS, 24),
  },
};

module.exports = env;
