import { createHash, randomBytes } from "node:crypto";
import {
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Logger,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import { IsEmail, IsIn, IsString, MinLength } from "class-validator";
import {
  createPlatformStaff,
  deletePlatformStaff,
  insertAuditLog,
  setStaffTokenHashById,
  type StaffRow,
} from "@sdr/db";
import { ThrottlerGuard } from "@nestjs/throttler";
import { Public } from "../auth/decorators";
import { type ActingStaff, PlatformStaffGuard, RequireStaffRole, Staff } from "./platform-staff.guard";

class CreateStaffDto {
  @IsEmail() email!: string;
  @IsString() @MinLength(1) name!: string;
  @IsIn(["admin", "curator", "support"]) role!: string;
}

/** Token pessoal de alta entropia; o banco guarda só o sha256. */
function newToken(): { token: string; hash: string } {
  const token = "sk-staff-" + randomBytes(24).toString("hex");
  return { token, hash: createHash("sha256").update(token).digest("hex") };
}

/** Violação de unique do Postgres (código 23505), inclusive embrulhada em `cause`. */
function isUniqueViolation(e: unknown): boolean {
  for (let cur = e; cur instanceof Error; cur = cur.cause) {
    if ((cur as { code?: string }).code === "23505") return true;
  }
  return false;
}

/**
 * GESTÃO de staff da plataforma pela UI (M14, dívida do ADR 0044 — antes só
 * seed/SQL). ADMIN-only. O token cru é retornado UMA única vez (na criação/
 * rotação) e nunca persistido; toda ação vai para o audit_log (best-effort,
 * pós-commit — mesma semântica da curadoria).
 */
@Public()
@UseGuards(ThrottlerGuard, PlatformStaffGuard)
@RequireStaffRole("admin")
@Controller("platform/staff")
export class PlatformStaffController {
  private readonly logger = new Logger(PlatformStaffController.name);

  @Post()
  async create(@Body() dto: CreateStaffDto, @Staff() staff: ActingStaff): Promise<StaffRow & { token: string }> {
    const { token, hash } = newToken();
    // email normalizado (unique de text é case-sensitive — 'A@x' ≠ 'a@x' sem isso).
    const email = dto.email.trim().toLowerCase();
    let created: StaffRow;
    try {
      created = await createPlatformStaff({ email, name: dto.name.trim(), role: dto.role, tokenHash: hash });
    } catch (e) {
      // unique(email) → 409 legível (mensagem genérica; detalhe só no log) em vez
      // de 500. Detecção pelo código Postgres 23505 (regex de mensagem é frágil).
      if (isUniqueViolation(e)) {
        this.logger.warn(`staff.create: email duplicado (${email}).`);
        throw new ConflictException("Email já cadastrado.");
      }
      throw e;
    }
    await this.audit(staff, "staff.create", created.id, { email, role: dto.role });
    return { ...created, token };
  }

  @Post(":id/rotate-token")
  async rotate(@Param("id") id: string, @Staff() staff: ActingStaff): Promise<{ token: string }> {
    const { token, hash } = newToken();
    if (!(await setStaffTokenHashById(id, hash))) throw new NotFoundException("Staff não encontrado.");
    await this.audit(staff, "staff.rotate_token", id, {});
    return { token };
  }

  @Delete(":id")
  async remove(@Param("id") id: string, @Staff() staff: ActingStaff): Promise<{ ok: true }> {
    // Autopreservação: admin não remove a si mesmo (evita trancar a porta por
    // engano; o token compartilhado de bootstrap continua sendo a chave mestra).
    if (id === staff.id) throw new ForbiddenException("Você não pode remover a si mesmo.");
    if (!(await deletePlatformStaff(id))) throw new NotFoundException("Staff não encontrado.");
    await this.audit(staff, "staff.delete", id, {});
    return { ok: true };
  }

  private async audit(staff: ActingStaff, action: string, target: string, metadata: Record<string, unknown>): Promise<void> {
    try {
      await insertAuditLog({ actor: staff.id, action, target, metadata: { ...metadata, staffEmail: staff.email } });
    } catch (e) {
      this.logger.warn(`audit_log falhou (${action} ${target}): ${(e as Error).message}`);
    }
  }
}
