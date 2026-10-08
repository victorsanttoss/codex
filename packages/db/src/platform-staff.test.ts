import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, makeMigrationClient } from "./client";
import {
  createPlatformStaff,
  deletePlatformStaff,
  findStaffByTokenHash,
  setStaffTokenHashById,
} from "./platform-read";

const dbConfigured = Boolean(process.env.DATABASE_URL && process.env.MIGRATION_DATABASE_URL);
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

describe.skipIf(!dbConfigured)("gestão de staff da plataforma (M14)", () => {
  let mig: ReturnType<typeof makeMigrationClient>;
  const email = `mgmt-${randomUUID().slice(0, 8)}@t.local`;

  beforeAll(() => { mig = makeMigrationClient(); });
  afterAll(async () => {
    await mig.sql`DELETE FROM platform_staff WHERE email = ${email}`;
    await mig.sql.end();
    await closeDb();
  });

  it("create → autentica pelo token; rotate → só o NOVO vale; delete → revoga", async () => {
    const t1 = "tok1-" + randomUUID();
    const created = await createPlatformStaff({ email, name: "Mgmt", role: "curator", tokenHash: sha256(t1) });
    expect(created.role).toBe("curator");
    expect((await findStaffByTokenHash(sha256(t1)))?.id).toBe(created.id);

    const t2 = "tok2-" + randomUUID();
    expect(await setStaffTokenHashById(created.id, sha256(t2))).toBe(true);
    expect(await findStaffByTokenHash(sha256(t1))).toBeNull(); // antigo revogado
    expect((await findStaffByTokenHash(sha256(t2)))?.id).toBe(created.id);

    expect(await deletePlatformStaff(created.id)).toBe(true);
    expect(await findStaffByTokenHash(sha256(t2))).toBeNull(); // acesso revogado
    expect(await deletePlatformStaff(created.id)).toBe(false); // idempotência do delete
  });

  it("valida formato do hash e id inexistente", async () => {
    await expect(createPlatformStaff({ email: "x@x", name: "X", role: "support", tokenHash: "curto" })).rejects.toThrow(/sha256/);
    expect(await setStaffTokenHashById(randomUUID(), sha256("t"))).toBe(false);
  });
});
