import { describe, expect, it } from "vitest";
import { roleSatisfies } from "./roles";

describe("roleSatisfies (RBAC hierárquico)", () => {
  it("owner satisfaz tudo", () => {
    expect(roleSatisfies("owner", "owner")).toBe(true);
    expect(roleSatisfies("owner", "admin")).toBe(true);
    expect(roleSatisfies("owner", "agent")).toBe(true);
  });

  it("admin satisfaz admin e agent, mas não owner", () => {
    expect(roleSatisfies("admin", "owner")).toBe(false);
    expect(roleSatisfies("admin", "admin")).toBe(true);
    expect(roleSatisfies("admin", "agent")).toBe(true);
  });

  it("agent só satisfaz agent", () => {
    expect(roleSatisfies("agent", "owner")).toBe(false);
    expect(roleSatisfies("agent", "admin")).toBe(false);
    expect(roleSatisfies("agent", "agent")).toBe(true);
  });
});
