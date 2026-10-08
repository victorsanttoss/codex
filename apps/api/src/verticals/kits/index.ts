import type { VerticalKit } from "../vertical-kit";
import { SOLAR_KIT } from "./solar";
import { ODONTO_KIT } from "./odonto";
import { IMOBILIARIO_KIT } from "./imobiliario";
import { IMOBILIARIO_ALTO_PADRAO_KIT } from "./imobiliario-alto-padrao";
import { IMOBILIARIO_LOTEAMENTO_KIT } from "./imobiliario-loteamento";
import { IMOBILIARIO_USADOS_KIT } from "./imobiliario-usados";

/** Kits de vertical embutidos (id → kit). Imobiliário tem um kit por PADRÃO de
 *  empreendimento (pesquisa de mercado ago/2026) — todos vertical 'imobiliario'. */
export const ALL_KITS: Record<string, VerticalKit> = {
  solar: SOLAR_KIT,
  odonto: ODONTO_KIT,
  imobiliario: IMOBILIARIO_KIT, // econômico/MCMV — padrão default
  imobiliario_alto_padrao: IMOBILIARIO_ALTO_PADRAO_KIT,
  imobiliario_loteamento: IMOBILIARIO_LOTEAMENTO_KIT,
  imobiliario_usados: IMOBILIARIO_USADOS_KIT,
};

/** Padrão de empreendimento → id do kit (provisionamento via Central). */
export const IMOB_KIT_BY_PADRAO: Record<string, string> = {
  economico: "imobiliario",
  alto_padrao: "imobiliario_alto_padrao",
  loteamento: "imobiliario_loteamento",
  usados: "imobiliario_usados",
};

export { SOLAR_KIT, ODONTO_KIT, IMOBILIARIO_KIT, IMOBILIARIO_ALTO_PADRAO_KIT, IMOBILIARIO_LOTEAMENTO_KIT, IMOBILIARIO_USADOS_KIT };

export interface ResourceNoun {
  singular: string;
  plural: string;
}

/** Fallback NEUTRO quando a vertical não define um termo próprio. */
export const DEFAULT_RESOURCE_NOUN: ResourceNoun = { singular: "agenda", plural: "agendas" };

/**
 * Termo da vertical para o recurso do pool de agendas (0036) — o kit manda
 * (profissional/corretor/consultor…); vertical desconhecida → "agenda".
 */
export function resourceNounForVertical(vertical: string | null | undefined): ResourceNoun {
  if (vertical) {
    for (const kit of Object.values(ALL_KITS)) {
      if (kit.niche.vertical === vertical && kit.resourceNoun) return kit.resourceNoun;
    }
  }
  return DEFAULT_RESOURCE_NOUN;
}
