import type { ReactNode } from "react";
import Link from "next/link";
import s from "./ConnectShell.module.css";

/**
 * Shell visual das telas de conexão de WhatsApp (oficial e Baileys). Mantém a
 * jornada contínua com o onboarding: rail à esquerda (marca + os dois canais,
 * com o atual destacado + voltar) e o conteúdo centralizado à direita.
 */
export function ConnectShell({
  channel,
  kicker,
  title,
  sub,
  children,
}: {
  channel: "oficial" | "qr";
  kicker: string;
  title: string;
  sub: string;
  children: ReactNode;
}) {
  return (
    <main className={s.wrap}>
      <aside className={s.rail}>
        <div className={s.brand}>
          <span className={s.mark}>V4</span>
          <strong style={{ fontSize: 14 }}>Configurar sua SDR</strong>
        </div>
        <div className={s.railKicker}>Etapa 1 de 8</div>
        <div className={s.railTitle}>Conectar o WhatsApp do seu negócio</div>
        {/* Opções NAVEGÁVEIS: o cliente alterna entre os dois canais de qualquer
            tela de conexão (antes eram divs decorativas — quem caía direto no QR
            não tinha como escolher a via oficial). */}
        <div className={s.opts}>
          <Link
            href="/connect"
            className={[s.opt, channel === "oficial" ? s.optOn : ""].join(" ")}
            style={{ textDecoration: "none", color: "inherit" }}
            aria-current={channel === "oficial" ? "page" : undefined}
          >
            <span className={s.optIcon}>✓</span>
            WhatsApp Oficial
          </Link>
          <Link
            href="/connect-baileys"
            className={[s.opt, channel === "qr" ? s.optOn : ""].join(" ")}
            style={{ textDecoration: "none", color: "inherit" }}
            aria-current={channel === "qr" ? "page" : undefined}
          >
            <span className={s.optIcon}>▣</span>
            Ler QR Code
          </Link>
        </div>
        <div className={s.railFoot}>
          <Link href="/onboarding" className={s.back}>← Voltar ao onboarding</Link>
        </div>
      </aside>

      <section className={s.content}>
        <div className={s.inner}>
          <div className={s.head}>
            <div className={s.eyebrow2}>{kicker}</div>
            <h1 className={s.title}>{title}</h1>
            <p className={s.sub}>{sub}</p>
          </div>
          {children}
        </div>
      </section>
    </main>
  );
}
