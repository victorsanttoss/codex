"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { getToken } from "../../lib/api";

/**
 * Página de ESCOLHA do canal de conexão do WhatsApp — destino de todos os
 * botões "Reconectar"/"Conectar" fora do wizard. As duas vias lado a lado,
 * cada uma com a explicação e o trade-off; o clique leva à tela específica
 * (/connect oficial · /connect-baileys QR). Pedido do cliente: nunca cair
 * direto num canal sem ver a opção do outro.
 */
export default function ConectarPage() {
  const router = useRouter();
  // Segura o render até checar o token (Codex): sem isto a página aparecia
  // por um frame antes do redirect ao /login.
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!getToken()) {
      router.replace("/login");
      return;
    }
    setReady(true);
  }, [router]);

  if (!ready) return null;

  return (
    <main style={{ minHeight: "100vh", background: "var(--surface-subtle)", display: "grid", placeItems: "center", padding: 24 }}>
      <div style={{ width: "min(880px, 100%)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 26 }}>
          <span style={{ width: 34, height: 34, borderRadius: 9, background: "var(--red-700)", color: "#fff", display: "inline-flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: 13 }}>V4</span>
          <strong style={{ fontSize: 14 }}>SDR de IA</strong>
        </div>

        <div className="eyebrow" style={{ marginBottom: 6 }}>Conexão do WhatsApp</div>
        <h1 className="h1-page" style={{ marginBottom: 6 }}>Como você quer conectar seu número?</h1>
        <p className="muted" style={{ margin: "0 0 22px" }}>
          As duas vias deixam sua SDR atendendo no seu WhatsApp — escolha a que faz sentido agora. Dá para trocar depois.
        </p>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 16 }}>
          <Link href="/connect" style={{ textDecoration: "none", color: "inherit" }}>
            <div style={{ height: "100%", background: "#fff", border: "1.5px solid var(--border-300)", borderRadius: 14, padding: 22, display: "flex", flexDirection: "column", gap: 10, cursor: "pointer" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <strong style={{ fontSize: 16, color: "var(--ink-900)" }}>WhatsApp Oficial</strong>
                <span style={{ fontSize: 10.5, fontWeight: 800, color: "var(--success-text)", background: "var(--success-tint)", padding: "2px 8px", borderRadius: 999 }}>RECOMENDADO</span>
              </div>
              <p className="muted" style={{ margin: 0, fontSize: 13.5 }}>
                Conexão pela API oficial da Meta (Cloud API), em poucos cliques.
              </p>
              <ul className="muted" style={{ margin: 0, paddingLeft: 18, fontSize: 13, display: "flex", flexDirection: "column", gap: 4 }}>
                <li><strong>Sem risco de bloqueio</strong> do número</li>
                <li>Selo de conta verificada</li>
                <li>Follow-up com templates aprovados pela Meta</li>
                <li>Requer uma conta Meta Business</li>
              </ul>
              <span style={{ marginTop: "auto", fontSize: 13.5, fontWeight: 700, color: "var(--red-700)" }}>Conectar pela via oficial →</span>
            </div>
          </Link>

          <Link href="/connect-baileys" style={{ textDecoration: "none", color: "inherit" }}>
            <div style={{ height: "100%", background: "#fff", border: "1.5px solid var(--border-300)", borderRadius: 14, padding: 22, display: "flex", flexDirection: "column", gap: 10, cursor: "pointer" }}>
              <strong style={{ fontSize: 16, color: "var(--ink-900)" }}>Ler QR Code</strong>
              <p className="muted" style={{ margin: 0, fontSize: 13.5 }}>
                Conecta lendo um QR no celular, como o WhatsApp Web — pronto em minutos, com qualquer número.
              </p>
              <ul className="muted" style={{ margin: 0, paddingLeft: 18, fontSize: 13, display: "flex", flexDirection: "column", gap: 4 }}>
                <li>Sem conta Meta Business nem aprovação</li>
                <li>Ideal para testar a SDR agora</li>
              </ul>
              <div style={{ padding: "8px 12px", borderRadius: 10, background: "var(--warning-tint)", color: "var(--warning-text)", fontSize: 12.5 }}>
                ⚠️ Canal <strong>não-oficial</strong>: viola os Termos do WhatsApp e o número <strong>pode ser banido</strong>. Use sob sua responsabilidade.
              </div>
              <span style={{ marginTop: "auto", fontSize: 13.5, fontWeight: 700, color: "var(--red-700)" }}>Conectar por QR Code →</span>
            </div>
          </Link>
        </div>

        <div style={{ marginTop: 22 }}>
          <Link href="/inicio" style={{ fontSize: 13, fontWeight: 700, color: "var(--text-muted)", textDecoration: "none" }}>← Voltar ao painel</Link>
        </div>
      </div>
    </main>
  );
}
