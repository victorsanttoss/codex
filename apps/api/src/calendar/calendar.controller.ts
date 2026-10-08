import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
} from "@nestjs/common";
import { IsBoolean, IsIn, IsISO8601, IsOptional, IsString, Matches, MaxLength, MinLength } from "class-validator";
import {
  addCalendar,
  archiveCalendar,
  createCalendarEvent,
  deleteCalendarEvent,
  ensureDefaultCalendar,
  getCalendarEvent,
  getCalendarsByIds,
  getNiche,
  getTenantNicheId,
  listCalendarEvents,
  listCalendars,
  updateCalendar,
  updateCalendarEvent,
  updateCalendarLink,
  type CalendarEventRow,
  type CalendarRow,
} from "@sdr/db";
import { Roles } from "../auth/roles";
import { resourceNounForVertical } from "../verticals/kits";
import { GoogleCalendarService } from "./google-calendar.service";
import { schedulingTimezone } from "./scheduling-config.service";

// ISO SEM offset seria interpretado no fuso do PROCESSO (achado Codex) — a
// borda exige instante absoluto (Z ou ±hh:mm); a UI sempre manda toISOString().
const ISO_WITH_OFFSET = /(?:Z|[+-]\d{2}:?\d{2})$/;
const ISO_OFFSET_MSG = "use instante ISO com offset (ex.: 2026-07-30T12:00:00Z)";

class CreateEventDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsISO8601()
  @Matches(ISO_WITH_OFFSET, { message: `startsAt: ${ISO_OFFSET_MSG}` })
  startsAt!: string;

  @IsISO8601()
  @Matches(ISO_WITH_OFFSET, { message: `endsAt: ${ISO_OFFSET_MSG}` })
  endsAt!: string;

  @IsOptional()
  @IsBoolean()
  allDay?: boolean;
}

class UpdateEventDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsISO8601()
  @Matches(ISO_WITH_OFFSET, { message: `startsAt: ${ISO_OFFSET_MSG}` })
  startsAt?: string;

  @IsOptional()
  @IsISO8601()
  @Matches(ISO_WITH_OFFSET, { message: `endsAt: ${ISO_OFFSET_MSG}` })
  endsAt?: string;

  @IsOptional()
  @IsBoolean()
  allDay?: boolean;

  @IsOptional()
  @IsIn(["confirmed", "cancelled"])
  status?: "confirmed" | "cancelled";
}

class LinkCalendarDto {
  @IsIn(["internal", "google"])
  provider!: "internal" | "google";

  @IsOptional()
  @IsString()
  @MaxLength(300)
  externalCalendarId?: string;
}

class AddPoolCalendarDto {
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(300)
  externalCalendarId!: string;
}

class UpdatePoolCalendarDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  externalCalendarId?: string;
}

interface EventDto {
  id: string;
  title: string;
  description: string | null;
  startsAt: string;
  endsAt: string;
  allDay: boolean;
  status: string;
  source: string;
  appointmentId: string | null;
}

const toDto = (e: CalendarEventRow): EventDto => ({
  id: e.id,
  title: e.title,
  description: e.description,
  startsAt: e.startsAt.toISOString(),
  endsAt: e.endsAt.toISOString(),
  allDay: e.allDay,
  status: e.status,
  source: e.source,
  appointmentId: e.appointmentId,
});

interface PoolCalendarDto {
  id: string;
  name: string;
  provider: string;
  googleCalendarId: string | null;
  isDefault: boolean;
}

const toPoolDto = (c: CalendarRow): PoolCalendarDto => ({
  id: c.id,
  name: c.name,
  provider: c.provider,
  googleCalendarId: c.externalCalendarId,
  isDefault: c.isDefault,
});

/** Erro do PG com `code` (e opcionalmente a constraint) em qualquer nível do wrap. */
function isPgError(err: unknown, code: string, constraint?: string): boolean {
  for (let e = err; e; e = (e as { cause?: unknown }).cause) {
    if ((e as { code?: string }).code === code) return true;
    if (constraint && e instanceof Error && e.message.includes(constraint)) return true;
  }
  return false;
}

/** range aberto demais vira varredura — teto de 3 meses por chamada da UI. */
const MAX_RANGE_MS = 93 * 24 * 60 * 60_000;

function parseRange(from?: string, to?: string): { from: Date; to: Date } {
  const f = from ? new Date(from) : null;
  const t = to ? new Date(to) : null;
  if (!f || !t || Number.isNaN(f.getTime()) || Number.isNaN(t.getTime()) || t <= f) {
    throw new BadRequestException("Range inválido: use from/to em ISO com to > from.");
  }
  if (t.getTime() - f.getTime() > MAX_RANGE_MS) {
    throw new BadRequestException("Range máximo de 3 meses por consulta.");
  }
  return { from: f, to: t };
}

/**
 * Agenda da plataforma (0034): CRUD de eventos da agenda default do tenant +
 * vínculo com Google Calendar. Tenant-scoped (RLS); papel mínimo `agent`
 * (atendente gerencia a agenda), vínculo externo exige `admin`.
 */
@Controller("admin/calendar")
export class CalendarController {
  constructor(private readonly google: GoogleCalendarService) {}

  @Roles("agent")
  @Get()
  async calendar() {
    const cal = await ensureDefaultCalendar();
    return {
      calendar: {
        id: cal.id,
        name: cal.name,
        timezone: schedulingTimezone(cal.timezone),
        provider: cal.provider,
        googleCalendarId: cal.externalCalendarId,
      },
    };
  }

  /** Status da integração Google — o onboarding mostra o e-mail da SA. */
  @Roles("agent")
  @Get("google-status")
  googleStatus() {
    return {
      configured: this.google.isConfigured(),
      serviceAccountEmail: this.google.serviceAccountEmail(),
    };
  }

  /** Vincula (ou volta para interna) a agenda externa. Valida o acesso ANTES. */
  @Roles("admin")
  @Post("link")
  async link(@Body() dto: LinkCalendarDto) {
    if (dto.provider === "google") {
      const id = dto.externalCalendarId?.trim();
      if (!id) throw new BadRequestException("Informe o ID da agenda do Google.");
      const check = await this.google.validateAccess(id);
      if (!check.ok) throw new BadRequestException(check.error);
      try {
        const cal = await updateCalendarLink({ provider: "google", externalCalendarId: id });
        return { ok: true, calendar: cal };
      } catch (err) {
        // Índice único GLOBAL (0035): a agenda já pertence a OUTRO tenant —
        // erro legível, sem vazar SQL (primeiro-vence, decisão do 0035).
        if (isPgError(err, "23505", "calendars_external_id_uniq")) {
          throw new BadRequestException(
            "Essa agenda do Google já está vinculada a outra conta da plataforma. Use outra agenda.",
          );
        }
        throw err;
      }
    }
    const cal = await updateCalendarLink({ provider: "internal" });
    return { ok: true, calendar: cal };
  }

  // ── Pool de agendas (multi-recurso, 0036) ──────────────────────

  /**
   * Pool de agendas do tenant + e-mail da SA + termo da vertical p/ a UI
   * ("Adicionar {singular}"). Uma agenda por recurso (profissional/vendedor/
   * corretor…); o cliente conecta várias no onboarding/Configuração.
   */
  @Roles("agent")
  @Get("pool")
  async pool() {
    const [calendars, resourceNoun] = await Promise.all([listCalendars(), this.resourceNoun()]);
    return {
      calendars: calendars.map(toPoolDto),
      configured: this.google.isConfigured(),
      serviceAccountEmail: this.google.serviceAccountEmail(),
      resourceNoun,
    };
  }

  /** Adiciona uma agenda ao pool — valida o acesso da SA ANTES de salvar. */
  @Roles("admin")
  @Post("pool")
  async addPool(@Body() dto: AddPoolCalendarDto) {
    const name = dto.name.trim();
    const id = dto.externalCalendarId.trim();
    if (!name) throw new BadRequestException("Informe um nome para a agenda.");
    if (!id) throw new BadRequestException("Informe o ID da agenda do Google.");
    const check = await this.google.validateAccess(id);
    if (!check.ok) throw new BadRequestException(check.error);
    try {
      const cal = await addCalendar({ name, provider: "google", externalCalendarId: id });
      return { ok: true, calendar: toPoolDto(cal) };
    } catch (err) {
      if (isPgError(err, "23505", "calendars_external_id_uniq")) {
        throw new BadRequestException(
          "Essa agenda do Google já está vinculada a outra conta da plataforma. Use outra agenda.",
        );
      }
      throw err;
    }
  }

  /** Renomeia e/ou re-vincula uma agenda do pool (valida o novo ID quando muda). */
  @Roles("admin")
  @Patch("pool/:id")
  async updatePool(@Param("id") id: string, @Body() dto: UpdatePoolCalendarDto) {
    // Agendas do pool são Google e NÃO-default; a principal (plataforma) não é
    // gerenciada por aqui — impede "reservar" um ID Google numa linha errada.
    const [target] = await getCalendarsByIds([id]);
    if (!target) throw new NotFoundException("Agenda não encontrada.");
    if (target.isDefault) {
      throw new BadRequestException("A agenda principal não é gerenciada pelo pool.");
    }
    const patch: { name?: string; externalCalendarId?: string } = {};
    if (dto.name !== undefined) {
      const name = dto.name.trim();
      if (!name) throw new BadRequestException("Informe um nome para a agenda.");
      patch.name = name;
    }
    if (dto.externalCalendarId !== undefined) {
      const ext = dto.externalCalendarId.trim();
      if (!ext) throw new BadRequestException("Informe o ID da agenda do Google.");
      const check = await this.google.validateAccess(ext);
      if (!check.ok) throw new BadRequestException(check.error);
      patch.externalCalendarId = ext;
    }
    try {
      const cal = await updateCalendar(id, patch);
      if (!cal) throw new NotFoundException("Agenda não encontrada.");
      return { ok: true, calendar: toPoolDto(cal) };
    } catch (err) {
      if (isPgError(err, "23505", "calendars_external_id_uniq")) {
        throw new BadRequestException(
          "Essa agenda do Google já está vinculada a outra conta da plataforma. Use outra agenda.",
        );
      }
      throw err;
    }
  }

  /** Remove (arquiva) uma agenda do pool; preserva o histórico. */
  @Roles("admin")
  @Delete("pool/:id")
  async removePool(@Param("id") id: string) {
    const r = await archiveCalendar(id);
    if (r.ok) return { ok: true };
    if (r.reason === "not_found") throw new NotFoundException("Agenda não encontrada.");
    if (r.reason === "is_default") {
      throw new BadRequestException("A agenda principal não pode ser removida.");
    }
    if (r.reason === "last_calendar") {
      throw new BadRequestException("Deixe ao menos uma agenda ativa no pool.");
    }
    throw new BadRequestException("Não foi possível remover a agenda.");
  }

  /** Termo (singular/plural) da vertical do tenant p/ rotular o recurso na UI. */
  private async resourceNoun(): Promise<{ singular: string; plural: string }> {
    try {
      const nicheId = await getTenantNicheId();
      const vertical = nicheId ? (await getNiche(nicheId))?.vertical : undefined;
      return resourceNounForVertical(vertical);
    } catch {
      // termo é decorativo — nunca derrubar o GET do pool por causa dele.
      return resourceNounForVertical(undefined);
    }
  }

  @Roles("agent")
  @Get("events")
  async events(@Query("from") from?: string, @Query("to") to?: string) {
    const range = parseRange(from, to);
    const cal = await ensureDefaultCalendar();
    const rows = await listCalendarEvents({ calendarId: cal.id, from: range.from, to: range.to });
    return { events: rows.map(toDto) };
  }

  @Roles("agent")
  @Post("events")
  async create(@Body() dto: CreateEventDto) {
    const startsAt = new Date(dto.startsAt);
    const endsAt = new Date(dto.endsAt);
    if (endsAt <= startsAt) throw new BadRequestException("O fim deve ser depois do início.");
    const cal = await ensureDefaultCalendar();
    const event = await createCalendarEvent({
      calendarId: cal.id,
      title: dto.title.trim(),
      ...(dto.description?.trim() ? { description: dto.description.trim() } : {}),
      startsAt,
      endsAt,
      allDay: dto.allDay ?? false,
    });
    return { event: toDto(event) };
  }

  @Roles("agent")
  @Patch("events/:id")
  async update(@Param("id") id: string, @Body() dto: UpdateEventDto) {
    const patch: Parameters<typeof updateCalendarEvent>[1] = {};
    if (dto.title !== undefined) patch.title = dto.title.trim();
    if (dto.description !== undefined) patch.description = dto.description.trim() || null;
    if (dto.startsAt !== undefined) patch.startsAt = new Date(dto.startsAt);
    if (dto.endsAt !== undefined) patch.endsAt = new Date(dto.endsAt);
    if (dto.allDay !== undefined) patch.allDay = dto.allDay;
    if (dto.status !== undefined) patch.status = dto.status;
    // Intervalo validado contra o evento ATUAL (achado Codex): patch só de
    // startsAt podia inverter o intervalo e estourar o CHECK do banco como 500.
    if (patch.startsAt || patch.endsAt) {
      const current = await getCalendarEvent(id);
      if (!current) throw new NotFoundException("Evento não encontrado.");
      const starts = patch.startsAt ?? current.startsAt;
      const ends = patch.endsAt ?? current.endsAt;
      if (ends.getTime() <= starts.getTime()) {
        throw new BadRequestException("O fim deve ser depois do início.");
      }
    }
    const event = await updateCalendarEvent(id, patch);
    if (!event) throw new NotFoundException("Evento não encontrado.");
    return { event: toDto(event) };
  }

  @Roles("agent")
  @Delete("events/:id")
  async remove(@Param("id") id: string) {
    const ok = await deleteCalendarEvent(id);
    if (!ok) throw new NotFoundException("Evento não encontrado.");
    return { ok: true };
  }
}
