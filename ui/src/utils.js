/**
 * Pure formatting, threshold, and context anatomy helpers for kohaku-context-lens.
 */

export const BUCKET_ORDER = Object.freeze([
  "system_prompt",
  "rules_memory",
  "skills_tools",
  "tool_outputs",
  "chat_channels",
  "reasoning_compaction",
])

export const DEFAULT_PREFS = Object.freeze({
  warn_pct: 70,
  critical_pct: 85,
  fragile_patterns: "antigravity",
})

export function formatTokens(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return "--"
  }
  if (value >= 1000000) {
    return `${(value / 1000000).toFixed(2)}M`
  }
  if (value >= 1000) {
    return `${(value / 1000).toFixed(1)}k`
  }
  return String(Math.round(value))
}

export function formatPct(ratio) {
  if (typeof ratio !== "number" || !Number.isFinite(ratio) || ratio < 0) {
    return "--"
  }
  const pct = ratio * 100
  if (pct >= 100) return `${Math.round(pct)}%`
  if (pct >= 10) return `${pct.toFixed(1)}%`
  return `${pct.toFixed(1)}%`
}

export function formatWholePct(ratio) {
  if (typeof ratio !== "number" || !Number.isFinite(ratio) || ratio < 0) {
    return "--"
  }
  return `${Math.round(ratio * 100)}%`
}

export function parseFragilePatterns(rawPatterns) {
  return String(rawPatterns || "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0)
}

export function normalizePrefs(raw) {
  const source = raw && typeof raw === "object" ? raw : {}
  const warnRaw = Number(source.warn_pct)
  const critRaw = Number(source.critical_pct)
  const warnPct = Number.isFinite(warnRaw) ? Math.min(95, Math.max(10, Math.round(warnRaw))) : DEFAULT_PREFS.warn_pct
  const critFloor = Math.min(100, warnPct + 1)
  const critPct = Number.isFinite(critRaw)
    ? Math.min(100, Math.max(critFloor, Math.round(critRaw)))
    : Math.max(critFloor, DEFAULT_PREFS.critical_pct)
  const patterns =
    typeof source.fragile_patterns === "string"
      ? source.fragile_patterns.trim()
      : DEFAULT_PREFS.fragile_patterns
  return {
    warn_pct: warnPct,
    critical_pct: critPct,
    fragile_patterns: patterns,
  }
}

export function validatePrefsInput(warnValue, criticalValue) {
  const warn = Number(warnValue)
  const critical = Number(criticalValue)
  if (!Number.isFinite(warn) || !Number.isFinite(critical)) return false
  if (warn < 10 || warn > 95) return false
  if (critical < 15 || critical > 100) return false
  return warn < critical
}

export function matchesFragileModel(llmName, compactEnabled, fragilePatternsRaw) {
  if (compactEnabled === false) return false
  const name = String(llmName || "").trim().toLowerCase()
  if (!name) return false
  const patterns = parseFragilePatterns(fragilePatternsRaw)
  return patterns.some((pattern) => name.includes(pattern))
}

export function computeEffectiveTokens(context, anatomy) {
  const promptTokens = context ? context.last_prompt_tokens : null
  if (typeof promptTokens === "number" && Number.isFinite(promptTokens) && promptTokens > 0) {
    return promptTokens
  }
  const estimated = anatomy ? anatomy.estimated_tokens : context ? context.estimated_tokens : null
  if (typeof estimated === "number" && Number.isFinite(estimated) && estimated >= 0) {
    return estimated
  }
  return null
}

export function computeEffectiveLimit(context) {
  if (!context || typeof context !== "object") {
    return { limit: null, kind: "none" }
  }
  const compactEnabled = context.compact_enabled
  const compactAt = context.compact_at_tokens
  if (compactEnabled !== false && typeof compactAt === "number" && Number.isFinite(compactAt) && compactAt > 0) {
    return { limit: compactAt, kind: "compact" }
  }
  const maxContext = context.max_context_tokens
  if (typeof maxContext === "number" && Number.isFinite(maxContext) && maxContext > 0) {
    return { limit: maxContext, kind: "window" }
  }
  return { limit: null, kind: "none" }
}

export function computeUsageRatio(tokens, limit) {
  if (
    typeof tokens !== "number" ||
    !Number.isFinite(tokens) ||
    tokens < 0 ||
    typeof limit !== "number" ||
    !Number.isFinite(limit) ||
    limit <= 0
  ) {
    return null
  }
  return tokens / limit
}

export function evaluateWatermarkStatus(context, anatomy, riskFlags, prefs) {
  const effectivePrefs = normalizePrefs(prefs)
  const effectiveTokens = computeEffectiveTokens(context, anatomy)
  const limitInfo = computeEffectiveLimit(context)
  const usageRatio = computeUsageRatio(effectiveTokens, limitInfo.limit)
  const usagePct = usageRatio === null ? null : usageRatio * 100

  const backendFlags = Array.isArray(riskFlags) ? riskFlags.filter((f) => typeof f === "string") : []
  const backendFragile =
    Boolean(context && context.signature_fragile && context.compact_enabled !== false) ||
    backendFlags.includes("signature_chain") ||
    backendFlags.includes("signature_fragile")
  const patternFragile = matchesFragileModel(
    context ? context.llm_name : null,
    context ? context.compact_enabled : null,
    effectivePrefs.fragile_patterns,
  )
  const signatureFragile = backendFragile || patternFragile

  const flags = [...backendFlags]
  if (signatureFragile && !flags.includes("signature_chain") && !flags.includes("signature_fragile")) {
    flags.push("signature_fragile")
  }
  if (usagePct !== null && usagePct >= effectivePrefs.warn_pct) {
    if (limitInfo.kind === "compact" && !flags.includes("near_compaction")) {
      flags.push("near_compaction")
    } else if (limitInfo.kind === "window" && !flags.includes("near_context_window")) {
      flags.push("near_context_window")
    }
  }

  let tone = "neutral"
  if (effectiveTokens !== null) {
    tone = "ok"
  }
  if (usagePct !== null && usagePct >= effectivePrefs.critical_pct) {
    tone = "critical"
  } else if (
    (usagePct !== null && usagePct >= effectivePrefs.warn_pct) ||
    signatureFragile ||
    flags.length > 0
  ) {
    tone = "warn"
  }

  return {
    effectiveTokens,
    limit: limitInfo.limit,
    limitKind: limitInfo.kind,
    usageRatio,
    usagePct,
    tone,
    flags,
    signatureFragile,
  }
}

export function buildBucketEntries(buckets, totalTokens) {
  const source = buckets && typeof buckets === "object" ? buckets : {}
  const sumFromBuckets = BUCKET_ORDER.reduce((acc, key) => {
    const val = Number(source[key])
    return acc + (Number.isFinite(val) && val > 0 ? val : 0)
  }, 0)
  const denom =
    sumFromBuckets > 0
      ? sumFromBuckets
      : typeof totalTokens === "number" && Number.isFinite(totalTokens) && totalTokens > 0
        ? totalTokens
        : 0

  return BUCKET_ORDER.map((key) => {
    const raw = Number(source[key])
    const tokens = Number.isFinite(raw) && raw > 0 ? raw : 0
    const share = denom > 0 ? tokens / denom : 0
    return {
      key,
      tokens,
      share,
      pctText: formatPct(share),
    }
  })
}

export function extractApiError(err) {
  if (!err) return "Request failed"
  const status = err.response && err.response.status ? err.response.status : null
  const detail = err.response && err.response.data ? err.response.data.detail : null
  let message = ""
  if (detail && typeof detail === "object") {
    message = detail.message || detail.error || JSON.stringify(detail)
  } else if (typeof detail === "string" && detail.trim()) {
    message = detail.trim()
  } else if (typeof err.message === "string" && err.message.trim()) {
    message = err.message.trim()
  } else {
    message = String(err)
  }
  return status ? `HTTP ${status}: ${message}` : message
}
