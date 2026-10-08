import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeDebouncedPersist, restoreAuth } from "./real-driver";

// Fakes do BufferJSON/initAuthCreds da lib (identidade — sem Buffers reais).
const BufferJSON = { reviver: undefined, replacer: undefined };
const initAuthCreds = () => ({ me: "novo" });

describe("makeDebouncedPersist (persistência de sessão Baileys)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("schedule agrupa writes na janela do debounce (um único persist)", () => {
    const persist = vi.fn();
    const p = makeDebouncedPersist(persist, 1500);
    p.schedule();
    p.schedule();
    p.schedule();
    expect(persist).not.toHaveBeenCalled(); // ainda na janela
    vi.advanceTimersByTime(1500);
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it("writes após o flush do timer agendam um NOVO persist", () => {
    const persist = vi.fn();
    const p = makeDebouncedPersist(persist, 1500);
    p.schedule();
    vi.advanceTimersByTime(1500);
    p.schedule();
    vi.advanceTimersByTime(1500);
    expect(persist).toHaveBeenCalledTimes(2);
  });

  it("flush dispara imediatamente e CANCELA o timer pendente (sem persist dobrado)", () => {
    const persist = vi.fn();
    const p = makeDebouncedPersist(persist, 1500);
    p.schedule();
    p.flush(); // ex.: creds.update ou close()
    expect(persist).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5000);
    expect(persist).toHaveBeenCalledTimes(1); // timer antigo não dispara de novo
  });
});

describe("restoreAuth (signal keys persistidas em keys.set)", () => {
  it("keys.set MUTA o estado e notifica (correção do Bad MAC pós-restart)", () => {
    const onKeysMutated = vi.fn();
    const auth = restoreAuth(null, initAuthCreds, BufferJSON, onKeysMutated);
    auth.state.keys.set({ session: { "dev1": { k: 1 } }, "pre-key": { "7": { k: 2 } } });
    expect(onKeysMutated).toHaveBeenCalledTimes(1);
    expect(auth.state.keys.get("session", ["dev1"])).toEqual({ dev1: { k: 1 } });
    // o serialize leva as keys avançadas — é isto que o evento `creds` persiste.
    const restored = restoreAuth(auth.serialize(), initAuthCreds, BufferJSON);
    expect(restored.state.keys.get("pre-key", ["7"])).toEqual({ "7": { k: 2 } });
  });

  it("restaura creds do blob serializado (sem novo QR)", () => {
    const serialized = JSON.stringify({ creds: { me: "restaurado" }, keys: {} });
    const auth = restoreAuth(serialized, initAuthCreds, BufferJSON);
    expect(auth.state.creds).toEqual({ me: "restaurado" });
  });
});
