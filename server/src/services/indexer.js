const Repo = require("../models/Repo");
const logger = require("../utils/logger");
const env = require("../config/env");

const github = require("./github");
const chunker = require("./chunker");
const embedder = require("./embedder");
const vectorStore = require("./vectorStore");
const llm = require("./llm");

// Decide whether we can reuse an existing index for this repo.
function isCacheFresh(repo) {
  if (!repo || repo.status !== "ready" || !repo.lastIndexedAt) return false;
  const ageMs = Date.now() - new Date(repo.lastIndexedAt).getTime();
  const maxAgeMs = env.limits.cacheReindexHours * 60 * 60 * 1000;
  return ageMs < maxAgeMs;
}

// Reserve a repo document before starting the long-running indexing work.
// This gives the API a stable id that the client can poll while indexing runs.
async function prepareRepo({ repoUrl, force = false }) {
  const { owner, name, normalizedUrl } = github.parseGithubUrl(repoUrl);
  let repo = await Repo.findOne({ repoUrl: normalizedUrl });

  if (!force && isCacheFresh(repo)) return { repo, shouldStart: false };
  if (repo?.status === "indexing") {
    const indexingAgeMs = Date.now() - new Date(repo.updatedAt).getTime();
    const staleIndexingMs = 10 * 60 * 1000;
    if (Number.isFinite(indexingAgeMs) && indexingAgeMs < staleIndexingMs) {
      return { repo, shouldStart: false };
    }
  }

  const collectionName = vectorStore.collectionNameFor(normalizedUrl);
  if (!repo) {
    repo = await Repo.create({
      repoUrl: normalizedUrl,
      owner,
      name,
      collectionName,
      status: "indexing",
    });
  } else {
    repo.status = "indexing";
    repo.error = null;
    repo.collectionName = collectionName;
    await repo.save();
  }

  return { repo, shouldStart: true };
}

// End-to-end: clone -> chunk -> embed -> upsert -> summary -> persist.
// Returns the persisted Repo document.
async function indexRepo({ repoUrl, force = false }) {
  const { owner, name, normalizedUrl } = github.parseGithubUrl(repoUrl);

  let repo = await Repo.findOne({ repoUrl: normalizedUrl });
  let clonePath;
  try {
    if (!force && isCacheFresh(repo)) {
      logger.info(`Cache hit for ${normalizedUrl} (indexed ${repo.lastIndexedAt})`);
      return repo;
    }

    // Pre-flight: fetch repo metadata to fail fast on private / 404.
    const meta = await github.fetchRepoMetadata(owner, name);
    if (meta.isPrivate) {
      throw new Error("Private repos are not supported in MVP.");
    }

    // Guard against truly huge repos before we even clone. GitHub size is in KB.
    const maxRepoSizeKB = env.limits.maxRepoSizeMB * 1024;
    if (meta.sizeKB && meta.sizeKB > maxRepoSizeKB) {
      throw new Error(
        `Repo is too large (${(meta.sizeKB / 1024).toFixed(1)} MB). Maximum supported size is ${env.limits.maxRepoSizeMB} MB.`
      );
    }

    const collectionName = vectorStore.collectionNameFor(normalizedUrl);

    if (!repo) {
      repo = await Repo.create({
        repoUrl: normalizedUrl,
        owner,
        name,
        defaultBranch: meta.defaultBranch,
        collectionName,
        status: "indexing",
      });
    } else {
      repo.status = "indexing";
      // null (not undefined) so the field is reliably cleared in MongoDB.
      repo.error = null;
      repo.defaultBranch = meta.defaultBranch;
      repo.collectionName = collectionName;
      await repo.save();
    }

    // Clone shallow.
    const cloneResult = await github.cloneRepo({
      owner,
      name,
      normalizedUrl,
    });
    clonePath = cloneResult.localPath;
    repo.commitSha = cloneResult.commitSha;

    // Chunk.
    logger.info(`Chunking ${normalizedUrl}...`);
    const { chunks, stats } = await chunker.chunkRepository({ repoRoot: clonePath });
    if (chunks.length === 0) {
      throw new Error(
        "No supported source files found. MVP supports JavaScript, TypeScript, and Python."
      );
    }
    logger.info(`Produced ${chunks.length} chunks across ${stats.files} files`);

    // Start the architecture summary now so it runs while we embed.
    const sample = chunks.slice(0, 12).map((c) => ({
      content: c.content,
      payload: c.metadata,
    }));
    const summaryPromise = Promise.race([
      llm.generateArchitectureSummary({
        repoName: `${owner}/${name}`,
        topChunks: sample,
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Architecture summary timed out")), 30_000)
      ),
    ]);
    // Avoid an unhandled rejection if embedding fails before we await it.
    summaryPromise.catch(() => {});

    // Embed.
    const { vectors, usedTokens } = await embedder.embedTexts(
      chunks.map((c) => c.content)
    );

    // (Re)create the Qdrant collection from scratch so we never mix old + new.
    await vectorStore.dropCollection(collectionName);
    await vectorStore.ensureCollection(collectionName);
    await vectorStore.upsertChunks({ collectionName, chunks, vectors });

    let summary = "";
    try {
      summary = await summaryPromise;
    } catch (err) {
      logger.warn(`Architecture summary failed (non-fatal): ${err.message}`);
    }

    repo.stats = {
      files: stats.files,
      lines: stats.lines,
      chunks: chunks.length,
      embedTokens: usedTokens || 0,
      languages: stats.languages,
    };
    repo.architectureSummary = summary;
    repo.status = "ready";
    repo.lastIndexedAt = new Date();
    await repo.save();

    return repo;
  } catch (err) {
    repo.status = "failed";
    repo.error = err.message;
    await repo.save();
    throw err;
  } finally {
    if (clonePath) {
      await github.cleanupClone(clonePath);
    }
  }
}

module.exports = { indexRepo, isCacheFresh, prepareRepo };
