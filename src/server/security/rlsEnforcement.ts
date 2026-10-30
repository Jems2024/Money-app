/**
 * STOP SPEND — Multi-User Isolation, Composite Ownership & Server Authorization Guard
 * (`src/server/security/rlsEnforcement.ts`)
 *
 * Enforces Section 11 & Acceptance Test 20:
 * - Service-role keys bypass RLS: server code MUST explicitly authorize the requesting user
 *   and enforce ownership (`row.userId === authenticatedUserId`).
 * - Never trust a client-supplied `user_id` parameter; always bind writes and queries to
 *   the verified JWT `authenticatedUserId`.
 * - Composite ownership check: User B cannot link a transaction, split, refund, or obligation
 *   to User A's accountId or transactionId.
 */

export class SecurityAccessDeniedError extends Error {
  public readonly status = 403;
  public readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'SecurityAccessDeniedError';
    this.code = code;
  }
}

export class UnauthenticatedAccessError extends Error {
  public readonly status = 401;
  public readonly code = 'UNAUTHENTICATED';
  constructor(message: string = 'Acceso denegado: sesión no autenticada.') {
    super(message);
    this.name = 'UnauthenticatedAccessError';
  }
}

export function requireAuthenticatedUser(authenticatedUserId: string | null | undefined): string {
  if (!authenticatedUserId || !authenticatedUserId.trim()) {
    throw new UnauthenticatedAccessError();
  }
  return authenticatedUserId.trim();
}

/**
 * Enforces that a target resource belongs to `authenticatedUserId`, and rejects any attempt
 * where a client payload tries to spoof a different `userId`.
 */
export function enforceRowOwnership<T extends { userId: string }>(
  authenticatedUserId: string | null | undefined,
  row: T | null | undefined,
  resourceName: string = 'recurso'
): T {
  const userId = requireAuthenticatedUser(authenticatedUserId);
  if (!row || row.userId !== userId) {
    throw new SecurityAccessDeniedError(
      'RLS_OWNERSHIP_VIOLATION',
      `Acceso denegado: no tienes permiso para leer o modificar este ${resourceName}.`
    );
  }
  return row;
}

/**
 * Enforces composite foreign-key ownership (`(id, user_id)`):
 * e.g., when creating/modifying a transaction referencing `accountId` or `linkedExpenseId`,
 * verifies that all referenced parent entities belong to the same `authenticatedUserId`.
 */
export function enforceCompositeReferenceOwnership(params: {
  authenticatedUserId: string | null | undefined;
  payloadClientUserId?: string | null;
  referencedEntities: ReadonlyArray<{ id: string; userId: string; kind: string }>;
}): string {
  const userId = requireAuthenticatedUser(params.authenticatedUserId);

  if (params.payloadClientUserId && params.payloadClientUserId !== userId) {
    throw new SecurityAccessDeniedError(
      'CLIENT_USER_ID_SPOOF_REJECTED',
      'Violación de seguridad: el user_id del cliente no coincide con el usuario autenticado.'
    );
  }

  for (const ref of params.referencedEntities) {
    if (ref.userId !== userId) {
      throw new SecurityAccessDeniedError(
        'COMPOSITE_FK_OWNERSHIP_VIOLATION',
        `Violación de integridad referencial: la entidad referenciada (${ref.kind} "${ref.id}") pertenece a otro usuario.`
      );
    }
  }

  return userId;
}

/**
 * Filters a collection strictly to rows owned by `authenticatedUserId` (mirroring Postgres RLS `USING (auth.uid() = user_id)`).
 */
export function filterRowsByRls<T extends { userId: string }>(
  authenticatedUserId: string | null | undefined,
  rows: readonly T[]
): T[] {
  const userId = requireAuthenticatedUser(authenticatedUserId);
  return rows.filter((r) => r.userId === userId);
}
