import { GatewayError } from '../errors.js'

export function assertAdminRequest(input: { isMtlsVerified?: boolean; sourceAllowed?: boolean; hasAdminToken?: boolean }): void {
  if (!input.isMtlsVerified && !input.sourceAllowed && !input.hasAdminToken) {
    throw new GatewayError('admin_auth_required', 401)
  }
}
