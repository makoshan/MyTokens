import { AccountBalance } from '../billing/account-do.js'
import { estimateReservation, findPriceRow, priceUsage } from '../billing/pricing.js'
import { reservationIdForRequest } from '../billing/reservations.js'
import { GatewayError } from '../errors.js'
import { parseOpenAIStreamEventUsage, parseOpenAIUsage, type OpenAIUsage } from '../providers/openai.js'
import type { PriceBookRow, RequestLog, ResolvedRoute } from '../types.js'

function roughInputTokens(body: Record<string, unknown>): number {
  const input = body.input ?? body.messages ?? ''
  return Math.max(1, Math.ceil(JSON.stringify(input).length / 4))
}

function maxOutputTokens(body: Record<string, unknown>): number {
  const value = body.max_output_tokens ?? body.max_tokens ?? 256
  return Math.max(1, Number(value) || 256)
}

function ceilDiv(numerator: number, denominator: number): number {
  return Math.ceil(numerator / denominator)
}

interface RelayCommonInput {
  account: AccountBalance
  apiKeyId: string
  requestId: string
  body: Record<string, unknown>
  routing: ResolvedRoute
  upstreamApiKey: string
  priceBook: PriceBookRow[]
  now: string
  fetchImpl?: typeof fetch
}

export async function relayOpenAIResponses(input: RelayCommonInput) {
  const startedAt = Date.now()
  const provider = input.routing.providerToken.provider
  const model = input.routing.actualProviderModel
  const row = findPriceRow({ priceBook: input.priceBook, provider, model, at: input.now })
  const estimate = estimateReservation({
    inputTokens: roughInputTokens(input.body),
    maxOutputTokens: maxOutputTokens(input.body),
    inputMicroUsdPer1MTokens: row.sellInputMicroUsdPer1MTokens,
    outputMicroUsdPer1MTokens: row.sellOutputMicroUsdPer1MTokens,
    minimumReserveMicroUsd: 1,
  })
  const reservationId = reservationIdForRequest(input.requestId)

  input.account.reserve({
    reservationId,
    requestId: input.requestId,
    estimatedMicroUsd: estimate.estimatedMicroUsd,
    provider,
    model,
    now: input.now,
  })

  const fetchImpl = input.fetchImpl ?? fetch
  const upstreamBody = {
    ...input.body,
    model,
  }

  let response: Response
  try {
    response = await fetchImpl('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${input.upstreamApiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(upstreamBody),
    })
  } catch (error) {
    input.account.refund({ reservationId, idempotencyKey: `refund:${input.requestId}`, now: input.now })
    throw error
  }

  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    input.account.refund({ reservationId, idempotencyKey: `refund:${input.requestId}`, now: input.now })
    throw new GatewayError(`provider_http_${response.status}`, response.status)
  }

  const usage = parseOpenAIUsage(payload)
  const cost = priceUsage({
    priceBook: input.priceBook,
    provider,
    model,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    at: input.now,
  })
  input.account.settle({
    reservationId,
    actualMicroUsd: cost.sellCostMicroUsd,
    idempotencyKey: `settle:${input.requestId}`,
    now: input.now,
  })

  const log: RequestLog = {
    id: input.requestId,
    accountId: input.account.snapshot().accountId,
    apiKeyId: input.apiKeyId,
    providerTokenId: input.routing.providerToken.id,
    routingRuleId: input.routing.routingRule.id,
    createdAt: input.now,
    provider,
    model,
    endpoint: '/v1/responses',
    statusCode: response.status,
    latencyMs: Math.max(0, Date.now() - startedAt),
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    sellCostMicroUsd: cost.sellCostMicroUsd,
    upstreamCostMicroUsd: cost.upstreamCostMicroUsd,
  }

  return {
    status: response.status,
    payload,
    log,
  }
}

export interface RelayStreamResult {
  status: number
  response: Response
  finalize: () => Promise<{
    log: RequestLog
    usage: OpenAIUsage | null
    settledWithEstimate: boolean
  }>
}

export async function relayOpenAIResponsesStream(input: RelayCommonInput): Promise<RelayStreamResult> {
  const startedAt = Date.now()
  const provider = input.routing.providerToken.provider
  const model = input.routing.actualProviderModel
  const row = findPriceRow({ priceBook: input.priceBook, provider, model, at: input.now })
  const inputTokens = roughInputTokens(input.body)
  const maxOutTokens = maxOutputTokens(input.body)
  const estimate = estimateReservation({
    inputTokens,
    maxOutputTokens: maxOutTokens,
    inputMicroUsdPer1MTokens: row.sellInputMicroUsdPer1MTokens,
    outputMicroUsdPer1MTokens: row.sellOutputMicroUsdPer1MTokens,
    minimumReserveMicroUsd: 1,
  })
  const reservationId = reservationIdForRequest(input.requestId)

  input.account.reserve({
    reservationId,
    requestId: input.requestId,
    estimatedMicroUsd: estimate.estimatedMicroUsd,
    provider,
    model,
    now: input.now,
  })

  const fetchImpl = input.fetchImpl ?? fetch
  const upstreamBody = { ...input.body, model, stream: true }

  let response: Response
  try {
    response = await fetchImpl('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${input.upstreamApiKey}`,
        'content-type': 'application/json',
        accept: 'text/event-stream',
      },
      body: JSON.stringify(upstreamBody),
    })
  } catch (error) {
    input.account.refund({ reservationId, idempotencyKey: `refund:${input.requestId}`, now: input.now })
    throw error
  }

  if (!response.ok || !response.body) {
    input.account.refund({ reservationId, idempotencyKey: `refund:${input.requestId}`, now: input.now })
    throw new GatewayError(`provider_http_${response.status}`, response.status)
  }

  const decoder = new TextDecoder()
  let buffer = ''
  let finalUsage: OpenAIUsage | null = null

  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(chunk)
      buffer += decoder.decode(chunk, { stream: true })
      let boundary = buffer.indexOf('\n\n')
      while (boundary >= 0) {
        const eventBlock = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const usage = parseOpenAIStreamEventUsage(eventBlock)
        if (usage) finalUsage = usage
        boundary = buffer.indexOf('\n\n')
      }
    },
    flush() {
      buffer += decoder.decode()
      if (buffer.trim().length > 0) {
        const usage = parseOpenAIStreamEventUsage(buffer)
        if (usage) finalUsage = usage
      }
      buffer = ''
    },
  })

  const pipePromise = response.body.pipeTo(transform.writable).catch(() => {
    // Upstream aborted mid-stream. We still settle with whatever usage we parsed
    // (or fail-closed to the reservation estimate below).
  })

  const headers = new Headers()
  headers.set('content-type', response.headers.get('content-type') ?? 'text/event-stream')
  const cacheControl = response.headers.get('cache-control')
  if (cacheControl) headers.set('cache-control', cacheControl)

  const downstreamResponse = new Response(transform.readable, {
    status: response.status,
    headers,
  })

  const finalize: RelayStreamResult['finalize'] = async () => {
    await pipePromise
    let usageForLog: OpenAIUsage
    let sellCostMicroUsd: number
    let upstreamCostMicroUsd: number
    let settledWithEstimate = false
    if (finalUsage) {
      usageForLog = finalUsage
      const cost = priceUsage({
        priceBook: input.priceBook,
        provider,
        model,
        inputTokens: finalUsage.inputTokens,
        outputTokens: finalUsage.outputTokens,
        at: input.now,
      })
      sellCostMicroUsd = cost.sellCostMicroUsd
      upstreamCostMicroUsd = cost.upstreamCostMicroUsd
    } else {
      settledWithEstimate = true
      usageForLog = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
      sellCostMicroUsd = estimate.estimatedMicroUsd
      upstreamCostMicroUsd =
        ceilDiv(inputTokens * row.upstreamInputMicroUsdPer1MTokens, 1_000_000) +
        ceilDiv(maxOutTokens * row.upstreamOutputMicroUsdPer1MTokens, 1_000_000)
    }
    input.account.settle({
      reservationId,
      actualMicroUsd: sellCostMicroUsd,
      idempotencyKey: `settle:${input.requestId}`,
      now: input.now,
    })
    const log: RequestLog = {
      id: input.requestId,
      accountId: input.account.snapshot().accountId,
      apiKeyId: input.apiKeyId,
      providerTokenId: input.routing.providerToken.id,
      routingRuleId: input.routing.routingRule.id,
      createdAt: input.now,
      provider,
      model,
      endpoint: '/v1/responses',
      statusCode: response.status,
      latencyMs: Math.max(0, Date.now() - startedAt),
      inputTokens: usageForLog.inputTokens,
      outputTokens: usageForLog.outputTokens,
      totalTokens: usageForLog.totalTokens,
      sellCostMicroUsd,
      upstreamCostMicroUsd,
      errorCode: settledWithEstimate ? 'usage_unavailable' : undefined,
    }
    return { log, usage: finalUsage, settledWithEstimate }
  }

  return { status: response.status, response: downstreamResponse, finalize }
}
