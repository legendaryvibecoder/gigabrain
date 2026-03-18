type ProviderPrompts = {
  answerPrompt?: (question: string, context: unknown[], questionDate?: string) => string
}

interface GigabrainResult {
  content?: string
  type?: string
  score?: number
  _score?: number
  score_total?: number
  scope?: string
  memory_tier?: string
  updated_at?: string
  source_layer?: string
}

function resolveDisplayScore(row: GigabrainResult): number | null {
  const candidates = [row.score, row._score, row.score_total]
  for (const value of candidates) {
    if (typeof value === "number" && Number.isFinite(value)) return value
  }
  return null
}

function formatGigabrainContext(context: unknown[]): string {
  if (context.length === 0) {
    return "No Gigabrain memories were retrieved."
  }

  return context
    .map((item, index) => {
      const row = item as GigabrainResult
      const content = String(row.content || JSON.stringify(item))
      const displayScore = resolveDisplayScore(row)
      const parts = [
        `Memory ${index + 1}:`,
        `type=${row.type || "unknown"}`,
        `score=${displayScore == null ? "n/a" : displayScore.toFixed(3)}`,
        `memory_tier=${row.memory_tier || "n/a"}`,
        `updated_at=${row.updated_at || "n/a"}`,
        `source_layer=${row.source_layer || "n/a"}`,
        `scope=${row.scope || "n/a"}`,
        `content=${content}`,
      ]
      return parts.join("\n")
    })
    .join("\n\n")
}

export const GIGABRAIN_PROMPTS: ProviderPrompts = {
  answerPrompt: (question: string, context: unknown[], questionDate?: string) => {
    return `You are answering a benchmark question using Gigabrain recall results.

Question: ${question}
Question Date: ${questionDate || "Not specified"}

Retrieved Gigabrain Memories:
${formatGigabrainContext(context)}

	Instructions:
	- Use only the retrieved Gigabrain memories above.
	- Prefer explicit facts over inference when the memories conflict.
	- You may make a small inference about the user's likely preference only when it is directly supported by retrieved memories about their past success, tastes, or repeated choices.
	- Treat memories about the user's own statements and experiences as stronger evidence than assistant suggestions.
	- Pay attention to timestamps and memory updates for temporal questions.
	- If the memories do not contain enough information, answer exactly "I don't know".
	- Keep the answer concise and directly responsive to the question.

Answer:`
  },
}
