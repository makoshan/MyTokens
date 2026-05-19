export class GatewayError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, status: number, message = code) {
    super(message)
    this.name = 'GatewayError'
    this.code = code
    this.status = status
  }
}

function errorTypeForStatus(status: number, code: string): string {
  if (status === 429) return 'rate_limit_error'
  if (status === 402) return 'insufficient_quota'
  if (status === 401 || status === 403) return code === 'admin_ip_denied' ? 'permission_denied' : 'authentication_error'
  return 'mykey_gateway_error'
}

export function toErrorResponse(error: unknown): Response {
  if (error instanceof GatewayError) {
    return Response.json(
      {
        error: {
          code: error.code,
          message: error.message,
          type: errorTypeForStatus(error.status, error.code),
        },
      },
      { status: error.status }
    )
  }

  const message = error instanceof Error ? error.message : 'internal_error'
  return Response.json(
    {
      error: {
        code: 'internal_error',
        message,
        type: 'mykey_gateway_error',
      },
    },
    { status: 500 }
  )
}
