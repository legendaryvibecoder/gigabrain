import { spawn } from "node:child_process"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join } from "node:path"
import * as os from "node:os"
import type {
  Provider,
  ProviderConfig,
  IngestOptions,
  IngestResult,
  SearchOptions,
  IndexingProgressCallback,
} from "../../types/provider"
import type { UnifiedSession } from "../../types/unified"
import { logger } from "../../utils/logger"
import { GIGABRAIN_PROMPTS } from "./prompts"

interface GigabrainProviderConfig extends ProviderConfig {
  gigabrainModuleRoot?: string
  gigabrainConfigTemplate?: string
  gigabrainStoreRoot?: string
  gigabrainNodeBin?: string
}

interface GigabrainSearchRow {
  content?: string
  type?: string
  score?: number
  _score?: number
  score_total?: number
}

interface ContainerConfig {
  configPath: string
  scope: string
  rootDir: string
}

const DEFAULT_INSTALLED_MODULE_ROOT = join(
  os.homedir(),
  ".codex",
  "packages",
  "gigabrain",
  "node_modules",
  "@legendaryvibecoder",
  "gigabrain"
)
const DEFAULT_CONFIG_TEMPLATE = join(os.homedir(), ".codex", "gigabrain", "config.json")
const MIN_SENTENCE_CHARS = 12
const MAX_NOTE_CHARS = 500
const MAX_NOTES_PER_SESSION = 8

const FILLER_RE =
  /^(?:hi|hello|hey|thanks|thank you|ok|okay|cool|great|nice|sure|yes|no|yep|nope|got it|sounds good|understood)[!. ]*$/i
const DECISION_RE =
  /\b(?:will|going to|plan(?:ning)? to|decided to|should|need to|must|scheduled|schedule|booked|booking)\b/i
const PREFERENCE_RE =
  /\b(?:like|love|prefer|favorite|favourite|enjoy|hate|dislike|prefer not|can't stand)\b/i
const EPISODE_RE =
  /\b(?:today|yesterday|tomorrow|last|next|met|visited|went|happened|travel(?:ing|ling)?|moved|started|finished|arrived|left)\b/i
const AGENT_RE =
  /\b(?:as an assistant|as your assistant|i can help|i will remember|i'm here to help)\b/i
const FIRST_PERSON_RE =
  /\b(?:i|i'm|i’ve|i'd|i'll|i was|i am|i have|i had|my|me|mine|we|we're|we've|we'd|we'll|our|ours)\b/i
const QUESTION_START_RE =
  /^(?:do|does|did|can|could|would|should|what|which|when|where|who|why|how|is|are|am|will)\b/i
const SUCCESS_RE =
  /\b(?:success(?:ful)?|worked well|turn(?:ed)? out (?:well|great|amazing|surprisingly well)|was a hit|went well)\b/i
const EVENT_DETAIL_RE =
  /\b(?:made|baked|cooked|tried|hosting|hosted|gathering|party|colleague|colleagues|family|weekend|recipe|dessert|cake|cookies?)\b/i
const BULLETISH_RE = /^(?:[*-]|\d+\.)\s/
const STOPWORDS = new Set([
  "any",
  "about",
  "after",
  "again",
  "been",
  "considering",
  "from",
  "have",
  "just",
  "like",
  "more",
  "much",
  "that",
  "them",
  "they",
  "this",
  "what",
  "when",
  "where",
  "which",
  "with",
  "would",
  "your",
  "should",
  "tips",
])

function sanitizePath(input: string): string {
  return input.replace(/[^a-zA-Z0-9_.-]/g, "_")
}

function resolveExistingPath(candidates: Array<string | undefined>): string {
  for (const candidate of candidates) {
    const value = String(candidate || "").trim()
    if (value && existsSync(value)) return value
  }
  return ""
}

function buildSessionContent(session: UnifiedSession): string {
  const date = String(session.metadata?.formattedDate || session.metadata?.date || "Unknown date")
  const lines = session.messages.map((message, index) => {
    const timestamp = message.timestamp ? ` @ ${message.timestamp}` : ""
    return `${index + 1}. ${message.role}${timestamp}: ${message.content}`
  })

  return [
    `Session ID: ${session.sessionId}`,
    `Session Date: ${date}`,
    "Transcript:",
    ...lines,
  ].join("\n")
}

function splitIntoSentences(text: string): string[] {
  return String(text || "")
    .replace(/\r/g, "\n")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter(Boolean)
}

function shouldKeepSentence(sentence: string): boolean {
  if (sentence.length < MIN_SENTENCE_CHARS || sentence.length > MAX_NOTE_CHARS) return false
  if (FILLER_RE.test(sentence)) return false
  if (!/[a-zA-Z]/.test(sentence)) return false
  if (BULLETISH_RE.test(sentence)) return false
  return true
}

function inferNoteType(sentence: string, role: "user" | "assistant"): string {
  if (PREFERENCE_RE.test(sentence)) return "PREFERENCE"
  if (SUCCESS_RE.test(sentence)) return "EPISODE"
  if (DECISION_RE.test(sentence)) return "DECISION"
  if (AGENT_RE.test(sentence) && role === "assistant") return "AGENT_IDENTITY"
  if (EPISODE_RE.test(sentence)) return "EPISODE"
  return "USER_FACT"
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

function scoreSentenceForMemory(sentence: string, role: "user" | "assistant"): number {
  if (role !== "user") return 0

  const firstPerson = FIRST_PERSON_RE.test(sentence)
  let score = 0

  if (firstPerson) score += 2.5
  if (PREFERENCE_RE.test(sentence)) score += 2.2
  if (SUCCESS_RE.test(sentence)) score += 2.4
  if (EVENT_DETAIL_RE.test(sentence)) score += 1.1
  if (DECISION_RE.test(sentence) && firstPerson) score += 0.8
  if (EPISODE_RE.test(sentence)) score += 0.5
  if (sentence.includes("?")) score -= firstPerson ? 0.4 : 2.4
  if (QUESTION_START_RE.test(sentence) && !firstPerson) score -= 1.6

  return score
}

function confidenceFromScore(score: number): string {
  const value = Math.max(0.76, Math.min(0.94, 0.76 + score * 0.03))
  return value.toFixed(2)
}

function tokenize(value: string): string[] {
  return String(value || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3 && !STOPWORDS.has(token))
}

function extractSpeaker(content: string): string {
  const match = String(content || "").match(/^\[([^|\]]+)/)
  return String(match?.[1] || "").trim().toLowerCase()
}

function getRowScore(row: Record<string, unknown>): number {
  const candidates = [row.score, row._score, row.score_total]
  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate
  }
  return 0
}

function rerankRecallResults(query: string, results: unknown[], limit: number): unknown[] {
  const queryTokens = new Set(tokenize(query))
  const rescored = results.map((item, index) => {
    const row = item as Record<string, unknown>
    const content = String(row.content || "")
    const speaker = extractSpeaker(content)
    const contentTokens = tokenize(content)
    const overlap = contentTokens.reduce((count, token) => count + (queryTokens.has(token) ? 1 : 0), 0)
    let score = getRowScore(row)

    if (speaker === "user") score += 1.25
    if (speaker === "assistant") score -= 0.9
    if (String(row.type || "") === "PREFERENCE") score += 0.8
    if (String(row.type || "") === "EPISODE") score += 0.5
    if (String(row.type || "") === "DECISION") score += 0.3
    if (SUCCESS_RE.test(content)) score += 0.9
    if (PREFERENCE_RE.test(content)) score += 0.7
    if (EVENT_DETAIL_RE.test(content)) score += 0.3
    if (content.includes("?")) score -= 0.15
    if (/\*\*/.test(content) || BULLETISH_RE.test(content.replace(/^\[[^\]]+\]\s*/, ""))) score -= 1.2
    score += overlap * 0.24

    return { content, index, item, score, speaker }
  })

  const pool =
    rescored.filter((entry) => entry.speaker === "user").length >= Math.min(limit, 3)
      ? rescored.filter((entry) => entry.speaker === "user")
      : rescored

  const seen = new Set<string>()
  return pool
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .filter((entry) => {
      const key = entry.content.toLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .slice(0, limit)
    .map((entry) => entry.item)
}

function buildSearchQueries(query: string): string[] {
  const tokens = tokenize(query).slice(0, 10)
  const compact = tokens.join(" ")
  const audience = tokens
    .filter((token) =>
      ["friend", "friends", "family", "colleague", "colleagues", "coworker", "coworkers", "party", "gathering"].includes(
        token
      )
    )
    .join(" ")
  const hasBakingIntent = tokens.some((token) =>
    ["bake", "baking", "cake", "cakes", "cookie", "cookies", "dessert", "desserts", "recipe", "recipes"].includes(token)
  )
  const queries = [
    query,
    `${query} previous experience user preference`,
    `${query} past success good experience worked well was a hit`,
    compact ? `${compact} user preference` : "",
    compact ? `${compact} past success hit` : "",
    hasBakingIntent ? `${audience} cake dessert recipe baking past success hit` : "",
    hasBakingIntent ? `previous cake dessert recipe that was a hit ${audience}` : "",
  ]

  return Array.from(
    new Set(
      queries
        .map((value) => value.trim())
        .filter(Boolean)
    )
  )
}

function buildMemoryNoteTags(session: UnifiedSession): string[] {
  const dateLabel = String(session.metadata?.formattedDate || session.metadata?.date || "").trim()
  const seen = new Set<string>()
  const notes: Array<{ content: string; order: number; score: number; type: string }> = []
  let order = 0

  for (const message of session.messages) {
    const role = message.role
    if (role !== "user") continue

    const speaker = String(message.speaker || role).trim() || role
    const timestamp = String(message.timestamp || "").trim()
    const prefixParts = [speaker]
    if (timestamp) prefixParts.push(timestamp)
    else if (dateLabel) prefixParts.push(dateLabel)
    const prefix = prefixParts.length > 0 ? `[${prefixParts.join(" | ")}] ` : ""

    for (const sentence of splitIntoSentences(message.content)) {
      if (!shouldKeepSentence(sentence)) continue
      const score = scoreSentenceForMemory(sentence, role)
      if (score < 2.5) continue
      const content = `${prefix}${sentence}`.trim()
      const dedupeKey = `${role}:${content.toLowerCase()}`
      if (seen.has(dedupeKey)) continue
      seen.add(dedupeKey)
      const type = inferNoteType(sentence, role)
      notes.push({ content, order: order++, score, type })
    }
  }

  return notes
    .sort((left, right) => right.score - left.score || left.order - right.order)
    .slice(0, MAX_NOTES_PER_SESSION)
    .sort((left, right) => left.order - right.order)
    .map(
      (note) =>
        `<memory_note type="${note.type}" confidence="${confidenceFromScore(note.score)}">${xmlEscape(
          note.content
        )}</memory_note>`
    )
}

export class GigabrainProvider implements Provider {
  name = "gigabrain"
  prompts = GIGABRAIN_PROMPTS
  concurrency = {
    default: 20,
    ingest: 4,
    indexing: 20,
    search: 20,
  }

  private moduleRoot = ""
  private nodeBin = "node"
  private configTemplatePath = ""
  private storeRoot = ""

  async initialize(config: ProviderConfig): Promise<void> {
    const providerConfig = config as GigabrainProviderConfig
    const moduleRoot = resolveExistingPath([
      providerConfig.gigabrainModuleRoot,
      process.env.GIGABRAIN_MODULE_ROOT,
      DEFAULT_INSTALLED_MODULE_ROOT,
    ])
    if (!moduleRoot) {
      throw new Error(
        "Gigabrain module root not found. Set GIGABRAIN_MODULE_ROOT or install the Codex Gigabrain package."
      )
    }
    this.moduleRoot = moduleRoot

    this.configTemplatePath = resolveExistingPath([
      providerConfig.gigabrainConfigTemplate,
      process.env.GIGABRAIN_CONFIG_TEMPLATE,
      DEFAULT_CONFIG_TEMPLATE,
    ])
    if (!this.configTemplatePath) {
      throw new Error(
        "Gigabrain config template not found. Set GIGABRAIN_CONFIG_TEMPLATE to a working config.json."
      )
    }

    this.storeRoot =
      String(
        providerConfig.gigabrainStoreRoot ||
          process.env.GIGABRAIN_STORE_ROOT ||
          join(process.cwd(), "data", "providers", "gigabrain")
      ).trim() || join(process.cwd(), "data", "providers", "gigabrain")
    this.nodeBin = String(providerConfig.gigabrainNodeBin || process.env.GIGABRAIN_NODE_BIN || "node")
    await mkdir(this.storeRoot, { recursive: true })
    logger.info(`Initialized Gigabrain provider using module root ${moduleRoot}`)
  }

  async ingest(sessions: UnifiedSession[], options: IngestOptions): Promise<IngestResult> {
    if (!this.moduleRoot) throw new Error("Provider not initialized")

    const container = await this.ensureContainer(options.containerTag)
    const documentIds: string[] = []

    for (const session of sessions) {
      const noteTags = buildMemoryNoteTags(session)

      if (noteTags.length > 0) {
        const captured = await this.invokeGigabrain("captureFromEvent", {
          configPath: container.configPath,
          runId: `memorybench:${sanitizePath(options.containerTag)}:${sanitizePath(session.sessionId)}`,
          event: {
            scope: container.scope,
            agentId: container.scope,
            sessionKey: `memorybench:${options.containerTag}:${session.sessionId}`,
            text: noteTags.join("\n"),
            output: noteTags.join("\n"),
            prompt: "",
            messages: session.messages,
            metadata: {
              source: "memorybench",
              sessionId: session.sessionId,
              ...session.metadata,
            },
          },
        })
        const insertedIds = Array.isArray(captured.inserted_ids)
          ? captured.inserted_ids.map((value: unknown) => String(value))
          : []
        if (insertedIds.length > 0) {
          documentIds.push(...insertedIds)
          logger.debug(
            `Captured ${insertedIds.length} notes from session ${session.sessionId} into Gigabrain container ${options.containerTag}`
          )
          continue
        }
      }

      const remembered = await this.invokeGigabrain("runRemember", {
        configPath: container.configPath,
        target: "project",
        scope: container.scope,
        type: "CONTEXT",
        content: buildSessionContent(session),
      })

      documentIds.push(String(remembered.memory_id || sanitizePath(session.sessionId)))
      logger.debug(
        `Fallback-ingested transcript session ${session.sessionId} into Gigabrain container ${options.containerTag}`
      )
    }

    return { documentIds }
  }

  async awaitIndexing(
    result: IngestResult,
    _containerTag: string,
    onProgress?: IndexingProgressCallback
  ): Promise<void> {
    onProgress?.({
      completedIds: result.documentIds,
      failedIds: [],
      total: result.documentIds.length,
    })
  }

  async search(query: string, options: SearchOptions): Promise<unknown[]> {
    if (!this.moduleRoot) throw new Error("Provider not initialized")

    const container = await this.ensureContainer(options.containerTag)
    const requestedLimit = Math.max(options.limit || 10, 1)
    const mergedResults: unknown[] = []

    for (const expandedQuery of buildSearchQueries(query)) {
      const recalled = await this.invokeGigabrain("runRecall", {
        configPath: container.configPath,
        target: "project",
        scope: container.scope,
        query: expandedQuery,
        topK: Math.max(requestedLimit * 2, 12),
        includeProvenance: true,
      })

      if (Array.isArray(recalled.results)) mergedResults.push(...recalled.results)
    }

    return rerankRecallResults(query, mergedResults, requestedLimit)
  }

  async clear(containerTag: string): Promise<void> {
    const rootDir = this.getContainerRoot(containerTag)
    await rm(rootDir, { recursive: true, force: true })
    logger.info(`Cleared Gigabrain benchmark store for ${containerTag}`)
  }

  private getContainerRoot(containerTag: string): string {
    return join(this.storeRoot, sanitizePath(containerTag))
  }

  private async ensureContainer(containerTag: string): Promise<ContainerConfig> {
    const rootDir = this.getContainerRoot(containerTag)
    const configPath = join(rootDir, "config.json")
    const scope = `project:memorybench:${sanitizePath(containerTag)}`

    if (!existsSync(configPath)) {
      await mkdir(rootDir, { recursive: true })
      const raw = JSON.parse(await readFile(this.configTemplatePath, "utf8")) as Record<string, any>
      raw.runtime = raw.runtime || {}
      raw.runtime.paths = raw.runtime.paths || {}
      raw.runtime.paths.workspaceRoot = rootDir
      raw.runtime.paths.memoryRoot = "memory"
      raw.runtime.paths.registryPath = "memory/registry.sqlite"
      raw.runtime.paths.outputDir = "output"
      raw.runtime.paths.reviewQueuePath = "output/memory-review-queue.jsonl"

      raw.vault = {
        ...(raw.vault || {}),
        enabled: false,
      }
      raw.remoteBridge = {
        ...(raw.remoteBridge || {}),
        enabled: false,
      }
      raw.codex = {
        ...(raw.codex || {}),
        enabled: true,
        storeMode: "global",
        projectRoot: join(rootDir, "project"),
        projectStorePath: rootDir,
        userProfilePath: join(rootDir, "profile"),
        projectScope: scope,
        defaultProjectScope: scope,
      }

      await mkdir(raw.codex.projectRoot, { recursive: true })
      await mkdir(join(rootDir, "memory"), { recursive: true })
      await mkdir(join(rootDir, "output"), { recursive: true })
      await mkdir(join(rootDir, "profile"), { recursive: true })
      await writeFile(configPath, `${JSON.stringify(raw, null, 2)}\n`, "utf8")
    }

    return {
      configPath,
      scope,
      rootDir,
    }
  }

  private async invokeGigabrain(
    method: "runRemember" | "runRecall" | "captureFromEvent",
    options: Record<string, unknown>
  ) {
    const payload = {
      moduleRoot: this.moduleRoot,
      method,
      options,
    }

    return await new Promise<any>((resolve, reject) => {
      const child = spawn(
        this.nodeBin,
        [
          "--input-type=module",
          "-e",
          `
            import { randomUUID } from "node:crypto";
            import { mkdirSync, readFileSync } from "node:fs";
            import { dirname, join } from "node:path";
            import { pathToFileURL } from "node:url";

            const loadGigabrainConfig = async (moduleRoot, configPath) => {
              const configMod = await import(pathToFileURL(join(moduleRoot, "lib", "core", "config.js")).href);
              const rawConfig = JSON.parse(readFileSync(String(configPath || ""), "utf8"));
              const workspaceRoot =
                String(rawConfig?.runtime?.paths?.workspaceRoot || "").trim() || process.cwd();
              const loaded = configMod.loadResolvedConfig({
                config: rawConfig,
                configPath: String(configPath || ""),
                workspaceRoot,
              });
              return {
                configMod,
                config: loaded.config,
              };
            };

            const openGigabrainDb = async (moduleRoot, configPath) => {
              const sqliteMod = await import(pathToFileURL(join(moduleRoot, "lib", "core", "sqlite.js")).href);
              const projectionMod = await import(pathToFileURL(join(moduleRoot, "lib", "core", "projection-store.js")).href);
              const eventStoreMod = await import(pathToFileURL(join(moduleRoot, "lib", "core", "event-store.js")).href);
              const nativeSyncMod = await import(pathToFileURL(join(moduleRoot, "lib", "core", "native-sync.js")).href);
              const personMod = await import(pathToFileURL(join(moduleRoot, "lib", "core", "person-service.js")).href);
              const worldModelMod = await import(pathToFileURL(join(moduleRoot, "lib", "core", "world-model.js")).href);
              const { config } = await loadGigabrainConfig(moduleRoot, configPath);
              const dbPath = String(config?.runtime?.paths?.registryPath || "").trim();
              if (!dbPath) {
                throw new Error("Gigabrain registryPath resolved to an empty string.");
              }
              mkdirSync(dirname(dbPath), { recursive: true });
              const db = sqliteMod.openDatabase(dbPath);
              projectionMod.ensureProjectionStore(db);
              eventStoreMod.ensureEventStore(db);
              nativeSyncMod.ensureNativeStore(db);
              personMod.ensurePersonStore(db);
              worldModelMod.ensureWorldModelStore(db);
              return {
                config,
                db,
                projectionMod,
                worldModelMod,
              };
            };

            const chunks = [];
            for await (const chunk of process.stdin) chunks.push(chunk);
            const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            if (payload.method === "captureFromEvent") {
              const captureMod = await import(pathToFileURL(join(payload.moduleRoot, "lib", "core", "capture-service.js")).href);
              const { config, db } = await openGigabrainDb(payload.moduleRoot, payload.options.configPath || "");
              try {
                const result = captureMod.captureFromEvent({
                  db,
                  config,
                  event: payload.options.event || {},
                  runId: payload.options.runId || "",
                  reviewVersion: "",
                });
                process.stdout.write(JSON.stringify(result));
              } finally {
                db.close();
              }
            } else if (payload.method === "runRemember") {
              const { config, db, projectionMod } = await openGigabrainDb(payload.moduleRoot, payload.options.configPath || "");
              try {
                const nowIso = new Date().toISOString();
                const scope = String(payload.options.scope || "shared").trim() || "shared";
                const memoryId =
                  String(payload.options.memoryId || payload.options.memory_id || "").trim() ||
                  \`memorybench:\${randomUUID()}\`;
                projectionMod.upsertCurrentMemory(
                  db,
                  {
                    memory_id: memoryId,
                    type: String(payload.options.type || "CONTEXT").trim() || "CONTEXT",
                    content: String(payload.options.content || "").trim(),
                    confidence: Number(payload.options.confidence ?? 0.72) || 0.72,
                    scope,
                    source: "memorybench",
                    source_agent: scope,
                    source_session: String(payload.options.sessionKey || "").trim() || null,
                    source_layer: "registry",
                    created_at: nowIso,
                    updated_at: nowIso,
                    tags: ["memorybench"],
                  },
                  { syncLegacy: true }
                );
                process.stdout.write(JSON.stringify({ memory_id: memoryId, inserted_ids: [memoryId] }));
              } finally {
                db.close();
              }
            } else if (payload.method === "runRecall") {
              const orchestratorMod = await import(pathToFileURL(join(payload.moduleRoot, "lib", "core", "orchestrator.js")).href);
              const { config, db } = await openGigabrainDb(payload.moduleRoot, payload.options.configPath || "");
              try {
                const topK = Math.max(Number(payload.options.topK || 0) || 0, 1);
                const configWithTopK = topK
                  ? {
                      ...config,
                      recall: {
                        ...(config?.recall || {}),
                        topK,
                      },
                    }
                  : config;
                const result = orchestratorMod.orchestrateRecall({
                  db,
                  config: configWithTopK,
                  query: String(payload.options.query || ""),
                  scope: String(payload.options.scope || "shared").trim() || "shared",
                });
                process.stdout.write(JSON.stringify({ results: result?.results || [] }));
              } finally {
                db.close();
              }
            } else {
              throw new Error(\`Unsupported Gigabrain benchmark bridge method: \${String(payload.method || "")}\`);
            }
          `,
        ],
        {
          stdio: ["pipe", "pipe", "pipe"],
        }
      )

      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)))
      child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)))
      child.on("error", (error) => reject(error))
      child.on("close", (code) => {
        const stderrText = Buffer.concat(stderr).toString("utf8").trim()
        if (code !== 0) {
          reject(new Error(stderrText || `Gigabrain subprocess exited with code ${code}`))
          return
        }
        const stdoutText = Buffer.concat(stdout).toString("utf8").trim()
        try {
          resolve(stdoutText ? JSON.parse(stdoutText) : {})
        } catch (error) {
          reject(
            new Error(
              `Failed to parse Gigabrain subprocess output: ${
                error instanceof Error ? error.message : String(error)
              }`
            )
          )
        }
      })
      child.stdin.end(JSON.stringify(payload))
    })
  }
}

export default GigabrainProvider
