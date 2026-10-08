import { describe, expect, it } from "vitest";
import {
  assignTenant,
  getContext,
  MissingTenantContextError,
  requireTenantContext,
  runAsSystem,
  runWithRequestContext,
  runWithTenant,
  withContextOverrides,
} from "./tenant-context";

describe("tenant-context", () => {
  it("propaga tenantId dentro de runWithTenant", () => {
    runWithTenant({ tenantId: "t1", userId: "u1" }, () => {
      const ctx = requireTenantContext();
      expect(ctx.tenantId).toBe("t1");
      expect(ctx.userId).toBe("u1");
    });
  });

  it("requireTenantContext lança fora de qualquer escopo", () => {
    expect(() => requireTenantContext()).toThrow(MissingTenantContextError);
  });

  it("caminho system NÃO satisfaz requireTenantContext", () => {
    runAsSystem("migração noturna", () => {
      expect(getContext()?.system).toBe(true);
      expect(() => requireTenantContext()).toThrow(MissingTenantContextError);
    });
  });

  it("padrão HTTP: assignTenant muta o contexto da requisição (visível adiante)", () => {
    runWithRequestContext("req-1", () => {
      expect(getContext()?.system).toBe(true); // anônimo no início
      expect(() => requireTenantContext()).toThrow();

      // o guard autentica e preenche o tenant…
      assignTenant({ tenantId: "t9", userId: "u9" });

      // …e o "handler" enxerga o tenant no mesmo contexto.
      const ctx = requireTenantContext();
      expect(ctx.tenantId).toBe("t9");
      expect(ctx.userId).toBe("u9");
      expect(ctx.requestId).toBe("req-1");
    });
  });

  it("withContextOverrides anexa conversationKey preservando o tenant", () => {
    runWithTenant({ tenantId: "t1" }, () => {
      withContextOverrides({ conversationKey: "conv-9" }, () => {
        const ctx = requireTenantContext();
        expect(ctx.tenantId).toBe("t1");
        expect(ctx.conversationKey).toBe("conv-9");
      });
    });
  });

  it("não vaza contexto entre escopos irmãos", () => {
    runWithTenant({ tenantId: "a" }, () => {
      expect(requireTenantContext().tenantId).toBe("a");
    });
    runWithTenant({ tenantId: "b" }, () => {
      expect(requireTenantContext().tenantId).toBe("b");
    });
    expect(getContext()).toBeUndefined();
  });
});
