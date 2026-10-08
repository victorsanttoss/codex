import { BadRequestException, Body, Controller, Get, Param, Post } from "@nestjs/common";
import { IsIn, IsOptional, IsString, Matches, MaxLength, MinLength } from "class-validator";
import { getActiveConnectionForTenant, listMessageTemplates, setTemplateMetaId, setTemplateStatus, upsertMessageTemplate, type TemplateRow } from "@sdr/db";
import { Roles } from "../auth/roles";
import { MetaTemplateSubmitService } from "./meta-template-submit.service";

export class UpsertTemplateDto {
  /** Nome do template no padrão da Meta (minúsculas/números/underscore). */
  @IsString()
  @Matches(/^[a-z0-9_]+$/)
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  languageCode?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(1024) // teto do BODY de HSM na Meta
  bodyText!: string;

  @IsOptional()
  @IsIn(["marketing", "utility"])
  category?: string;
}

export class ArchiveTemplateDto {
  @IsOptional()
  @IsString()
  @MaxLength(10)
  languageCode?: string;
}

export interface UpsertTemplateResult {
  ok: true;
  /** 'approved' (canal QR/Baileys — sem Meta) ou 'pending' (aguardando aprovação da Meta). */
  status: string;
  /** Pedido de aprovação já enviado à Meta? (Cloud API; best-effort.) */
  submittedToMeta: boolean;
  reason?: string;
}

/**
 * Catálogo de templates do TENANT (M8-ext) — o corpo do follow-up escrito pelo
 * cliente mora aqui. Regra de status na criação:
 *  - conexão Baileys (QR): 'approved' direto — não existe aprovação da Meta no
 *    canal não-oficial (o corpo é enviado como texto normal);
 *  - conexão Cloud API: 'pending' + SUBMISSÃO AUTOMÁTICA à Meta; o webhook
 *    `message_template_status_update` promove/rejeita. A cadência só dispara
 *    template aprovado (guardrail M8) — pending nunca vira spam nem lixo.
 */
@Controller("admin/templates")
export class TemplatesController {
  constructor(private readonly meta: MetaTemplateSubmitService) {}

  @Roles("admin")
  @Get()
  list(): Promise<TemplateRow[]> {
    return listMessageTemplates();
  }

  @Roles("admin")
  @Post()
  async upsert(@Body() dto: UpsertTemplateDto): Promise<UpsertTemplateResult> {
    const languageCode = dto.languageCode ?? "pt_BR";
    const category = dto.category ?? "marketing";
    const conn = await getActiveConnectionForTenant();
    const needsMeta = conn?.provider === "cloud_api";
    const status = needsMeta ? "pending" : "approved";

    await upsertMessageTemplate({
      name: dto.name,
      languageCode,
      category,
      variables: [],
      status,
      bodyText: dto.bodyText,
      // Nova submissão INVALIDA a correlação anterior no mesmo write (sem janela
      // p/ webhook atrasado da submissão antiga casar com o corpo novo).
      metaTemplateId: null,
    });

    if (!needsMeta) return { ok: true, status, submittedToMeta: false };

    const sub = await this.meta.submit({ name: dto.name, languageCode, category, bodyText: dto.bodyText });
    // Correlação: o webhook de aprovação só será aceito se bater com ESTE id
    // (nome é reutilizado entre reedições — achado Codex).
    if (sub.submitted && sub.metaTemplateId) {
      await setTemplateMetaId(dto.name, languageCode, sub.metaTemplateId);
    }
    return { ok: true, status, submittedToMeta: sub.submitted, ...(sub.reason ? { reason: sub.reason } : {}) };
  }

  /**
   * ARQUIVA um template (achado Codex: reedição/remoção de passos no wizard
   * deixava nomes órfãos 'approved' no catálogo). 'archived' nunca dispara
   * (getApprovedTemplate exige 'approved') e some dos badges.
   */
  @Roles("admin")
  @Post(":name/archive")
  async archive(
    @Param("name") name: string,
    @Body() dto: ArchiveTemplateDto,
  ): Promise<{ ok: true; archived: boolean }> {
    if (!/^[a-z0-9_]{1,120}$/.test(name)) throw new BadRequestException("nome de template inválido");
    const res = await setTemplateStatus(name, dto.languageCode ?? "pt_BR", "archived");
    return { ok: true, archived: res === "updated" };
  }
}
