const OpenAI = require("openai");
const env = require("../config/env");
const logger = require("../utils/logger");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let _client = null;
function client() {
  if (!_client) {
    if (!env.openai.apiKey) {
      throw new Error("OPENAI_API_KEY is not set. Add it to server/.env.");
    }
    _client = new OpenAI({
      apiKey: env.openai.apiKey,
      baseURL: env.openai.baseURL,
    });
  }
  return _client;
}

// Vector dim depends on which embedding model is in use.
// Configured in env so the Qdrant collection size always matches.
const EMBED_DIM = env.openai.embedDim;

// OpenAI's embeddings endpoint accepts an array of inputs. We split the
// texts into batches and send a few batches at the same time. If OpenAI
// says we're going too fast (HTTP 429), we wait and retry that batch.
async function embedBatch(input, attempt = 0) {
  try {
    return await client().embeddings.create({
      model: env.openai.embedModel,
      input,
    });
  } catch (err) {
    const status = err && err.status;
    const retryable = status === 429 || (status >= 500 && status < 600);
    if (!retryable || attempt >= 5) throw err;
    const waitMs = Math.min(2000 * 2 ** attempt, 30_000);
    logger.warn(`Embedding request failed (${status}); retrying in ${waitMs}ms`);
    await sleep(waitMs);
    return embedBatch(input, attempt + 1);
  }
}

async function embedTexts(texts) {
  if (!Array.isArray(texts) || texts.length === 0) {
    return { vectors: [], usedTokens: 0 };
  }

  const batchSize = env.limits.embedBatchSize;
  const concurrency = Math.max(1, env.limits.embedConcurrency);
  const results = new Array(texts.length);
  let usedTokens = 0;

  const starts = [];
  for (let i = 0; i < texts.length; i += batchSize) starts.push(i);
  const totalBatches = starts.length;

  // Simple worker pool: each worker takes the next batch until none are left.
  let next = 0;
  async function worker() {
    while (next < starts.length) {
      const i = starts[next++];
      const slice = texts.slice(i, i + batchSize);
      logger.debug(
        `Embedding batch ${i / batchSize + 1}/${totalBatches} (${slice.length} items)`
      );
      const resp = await embedBatch(slice);
      for (let j = 0; j < resp.data.length; j++) {
        results[i + j] = resp.data[j].embedding;
      }
      if (resp.usage && resp.usage.total_tokens) {
        usedTokens += resp.usage.total_tokens;
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, totalBatches) }, worker)
  );

  return { vectors: results, usedTokens };
}

async function embedSingle(text) {
  const { vectors } = await embedTexts([text]);
  return vectors[0];
}

module.exports = { embedTexts, embedSingle, EMBED_DIM };
