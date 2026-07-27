import { NexusError } from '../errors/index.js';

export type Permission = string;
export interface Principal {
  readonly id: string;
  readonly subject: string;
  readonly permissions: readonly Permission[];
  readonly roles: readonly string[];
  readonly attributes: Readonly<Record<string, string>>;
}
export interface PermissionRequirement { readonly anyOf?: readonly Permission[]; readonly allOf?: readonly Permission[]; }

export class Authorizer {
  public has(principal: Principal, requirement: PermissionRequirement): boolean {
    const permissions = new Set(principal.permissions);
    const allSatisfied = requirement.allOf === undefined || requirement.allOf.every((permission) => permissions.has(permission));
    const oneSatisfied = requirement.anyOf === undefined || requirement.anyOf.some((permission) => permissions.has(permission));
    return allSatisfied && oneSatisfied;
  }
  public require(principal: Principal, requirement: PermissionRequirement): void {
    if (!this.has(principal, requirement)) throw new NexusError('AUTHORIZATION_DENIED', `Principal "${principal.subject}" lacks the required permission`);
  }
}
