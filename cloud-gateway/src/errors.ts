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

export function toErrorResponse(error: unknown): Response {
  if (error instanceof GatewayError) {
    return Response.json(
      {
        error: {
          code: error.code,
          message: error.message,
          type: 'mykey_gateway_error',
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
