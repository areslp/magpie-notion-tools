import { ProviderError } from "./core.mjs"

const MAX_ERROR_BYTES = 16 * 1024
const ENDPOINTS = new Set([
  "getSpaces", "getAvailableModels", "authValidate", "getCreditRateLimitStatus",
  "getAIUsageEligibilityV2", "getThreadTranscript", "listenToThreadTranscript",
  "createAgentThread", "sendEventToAgentThread",
])
// Only exact machine identifiers are recognized. Free-form vendor messages may
// contain credentials, prompts or document contents and must never be returned.
const REASONS = new Map([
  ["credits_exhausted", ["credits_exhausted", "The server reports exhausted AI credits."]],
  ["insufficient_quota", ["credits_exhausted", "The server reports insufficient AI quota."]],
  ["notion_exhausted", ["credits_exhausted", "The server reports exhausted Notion AI allowance."]],
  ["subscription_required", ["plan_required", "The server requires a subscription for this request."]],
  ["upgrade_required", ["plan_required", "The server requires a plan upgrade for this request."]],
  ["model_unavailable", ["model_unavailable", "The server reports that this model is unavailable."]],
])

export async function readFailurePayload(response, signal) {
  if (!response.body) return undefined
  const reader = response.body.getReader()
  const abort = () => { void reader.cancel(signal.reason).catch(() => {}) }
  signal?.addEventListener("abort", abort, { once: true })
  const chunks = []
  let size = 0
  try {
    for (;;) {
      signal?.throwIfAborted()
      const next = await reader.read()
      signal?.throwIfAborted()
      if (next.done) break
      size += next.value.byteLength
      if (size > MAX_ERROR_BYTES) return undefined
      chunks.push(next.value)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    return JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    signal?.throwIfAborted()
    return undefined
  } finally {
    signal?.removeEventListener("abort", abort)
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

export function httpFailure(endpoint, status, payload, retryAfter) {
  const where = ENDPOINTS.has(endpoint) ? endpoint : "upstream endpoint"
  const admission = payload?.clientData
  if (status === 429 && payload?.isNotionError === true && payload.name === "TooManyRequestsError" &&
      admission?.type === "rate_limited" && admission.code === "ai_credit_usage_limit" &&
      admission.limitedBy === "billing_period" && admission.aiCreditOverageBlockReason === "overage_disabled") {
    const bucket = admission.limitedBucketId === "flex" ? "精选" : admission.limitedBucketId === "auto" ? "标准" : "当前"
    const alternative = admission.limitedBucketId === "flex" ? " 可改用 notion/auto 使用标准额度。" : ""
    return new ProviderError(402, "credits_exhausted",
      `Notion AI 本计费周期的${bucket}额度已用完，且未启用超额用量。${alternative}`,
      { retryable: false })
  }
  const prefix = `Notion AI rejected ${where} (HTTP ${status}).`
  const values = [payload?.code, payload?.errorCode, payload?.error?.code, payload?.error]
  const reasons = values.filter((value) => typeof value === "string" && REASONS.has(value)).map((value) => REASONS.get(value))
  const categories = new Set(reasons.map(([code]) => code))
  let code = "upstream_http_error"
  let detail = "No recognized machine-readable reason was returned; check the Notion client."
  if (status === 401) code = "session_expired"
  else if (status === 429) code = "rate_limited"
  else if ((status === 402 || status === 403) && categories.size === 1) [code, detail] = reasons[0]
  else if (status === 402) code = "payment_reason_unknown"
  else if (status === 403) code = "workspace_forbidden"
  return new ProviderError(status, code, `${prefix} ${detail}`, retryAfter ? { retryAfter } : undefined)
}
