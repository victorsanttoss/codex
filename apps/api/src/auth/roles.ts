import { Reflector } from "@nestjs/core";

/** Papéis no tenant (espelha o enum do banco). */
export type MembershipRole = "owner" | "admin" | "agent";

/** Hierarquia: owner > admin > agent. */
const RANK: Record<MembershipRole, number> = { owner: 3, admin: 2, agent: 1 };

export function roleSatisfies(actual: MembershipRole, required: MembershipRole): boolean {
  return RANK[actual] >= RANK[required];
}

/** Decorator @Roles('admin') — exige papel mínimo no tenant ativo. */
export const Roles = Reflector.createDecorator<MembershipRole>();
