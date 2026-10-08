"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { getSignupConfig, getToken, submitSignup, type SignupConfig } from "../../lib/api";
import { ConnectShell } from "../../components/ConnectShell";
import { Badge, Button, Card } from "../../components/ui";

/* eslint-disable @typescript-eslint/no-explicit-any */
declare global {
  interface Window {
    FB?: any;
    fbAsyncInit?: () => void;
  }
}

/**
 * UI mínima do Embedded Signup (M3). Carrega o FB JS SDK, dispara o fluxo com o
 * `config_id` da plataforma e captura (1) o `code` do FB.login e (2) o
 * `phone_number_id`/`waba_id` do evento WA_EMBEDDED_SIGNUP — enviando ambos ao
 * backend autenticado.
 */
export default function ConnectPage() {
  const router = useRouter();
  const [cfg, setCfg] = useState<SignupConfig | null>(null);
  const [status, setStatus] = useState<string>("");
  const [stalled, setStalled] = useState(false);
  const selected = useRef<{ phoneNumberId?: string; wabaId?: string }>({});
  const stallTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!getToken()) {
      router.replace("/login");
      return;
    }
    getSignupConfig()
      .then((c) => {
        setCfg(c);
        if (c.appId) loadFbSdk(c);
      })
      .catch((e: Error) => setStatus(`Erro ao carregar config: ${e.message}`));

    // Evento do Embedded Signup com phone_number_id / waba_id.
    const onMessage = (e: MessageEvent) => {
      // só aceita mensagens vindas do domínio da Meta/Facebook.
      if (!/^https:\/\/([a-z0-9-]+\.)?facebook\.com$/.test(e.origin)) return;
      if (typeof e.data !== "string") return;
      try {
        const data = JSON.parse(e.data);
        if (data?.type === "WA_EMBEDDED_SIGNUP" && data?.data) {
          selected.current = {
            phoneNumberId: data.data.phone_number_id,
            wabaId: data.data.waba_id,
          };
        }
      } catch {
        /* ignore */
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [router]);

  function loadFbSdk(c: SignupConfig) {
    if (window.FB || document.getElementById("fb-sdk")) return;
    window.fbAsyncInit = () => {
      window.FB.init({ appId: c.appId, autoLogAppEvents: true, xfbml: true, version: c.graphApiVersion });
    };
    const s = document.createElement("script");
    s.id = "fb-sdk";
    s.async = true;
    s.src = "https://connect.facebook.net/en_US/sdk.js";
    document.body.appendChild(s);
  }

  function connect() {
    if (!cfg?.appId || !cfg.configId || !window.FB) {
      setStatus("Embedded Signup não configurado (defina WHATSAPP_APP_ID / CONFIG_ID).");
      return;
    }
    setStatus("Abrindo o Embedded Signup…");
    setStalled(false);
    selected.current = {}; // limpa seleção de um fluxo anterior
    // O callback do FB.login NÃO dispara se o popup for bloqueado ou se o app da
    // Meta não aceitar este domínio (ex.: localhost em dev) — sem isto a tela
    // ficava presa em "Abrindo…" para sempre.
    if (stallTimer.current) clearTimeout(stallTimer.current);
    stallTimer.current = setTimeout(() => {
      setStatus("A janela da Meta não respondeu.");
      setStalled(true);
    }, 45_000);
    window.FB.login(
      async (resp: any) => {
        if (stallTimer.current) clearTimeout(stallTimer.current);
        setStalled(false);
        const code = resp?.authResponse?.code;
        const { phoneNumberId, wabaId } = selected.current;
        if (!code || !phoneNumberId || !wabaId) {
          setStatus("Onboarding cancelado ou incompleto.");
          return;
        }
        try {
          const r = await submitSignup({ code, phoneNumberId, wabaId });
          setStatus(`Conectado: ${r.phoneNumberId}${r.reconnected ? " (reconexão)" : ""}.`);
        } catch (e) {
          setStatus(`Falha ao registrar: ${(e as Error).message}`);
        }
      },
      { config_id: cfg.configId, response_type: "code", override_default_response_type: true },
    );
  }

  const configured = Boolean(cfg?.appId && cfg?.configId);

  return (
    <ConnectShell
      channel="oficial"
      kicker="Conexão oficial · Meta"
      title="Conecte pelo WhatsApp oficial"
      sub="Conexão pela API oficial da Meta: selo verificado e sem risco de bloqueio do número."
    >
      <Card>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
          <strong style={{ fontSize: 15, color: "var(--ink-900)" }}>WhatsApp Business oficial</strong>
          <Badge tone="success">Recomendado</Badge>
        </div>
        <p className="muted" style={{ margin: "0 0 16px", fontSize: 13.5, lineHeight: 1.5 }}>
          Em poucos cliques, pela Embedded Signup da Meta. Requer perfil admin e uma conta
          WhatsApp Business.
        </p>
        <Button onClick={connect} disabled={!configured}>Conectar WhatsApp</Button>
        {status && <p style={{ marginTop: 14, marginBottom: 0, fontSize: 13, color: "var(--text-body)" }}>{status}</p>}
        {stalled && (
          <div style={{ marginTop: 10, padding: "10px 12px", background: "var(--surface-subtle)", borderRadius: 8, fontSize: 13, lineHeight: 1.5 }}>
            <p style={{ margin: "0 0 8px" }} className="muted">
              Verifique se o navegador bloqueou o popup da Meta. Se este ambiente ainda não
              tem o app da Meta aprovado (ex.: desenvolvimento local), a conexão oficial não
              conclui — você pode conectar por QR Code e testar tudo agora.
            </p>
            <Link href="/connect-baileys"><Button variant="secondary" size="sm">Conectar por QR Code →</Button></Link>
          </div>
        )}
      </Card>

      {!configured && (
        <Card style={{ marginTop: 16, borderColor: "var(--warning)" }}>
          <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
            <Badge tone="warning">Indisponível</Badge>
            <div>
              <p style={{ margin: "0 0 6px", fontSize: 13.5, fontWeight: 700, color: "var(--ink-900)" }}>
                Conexão oficial ainda não configurada neste servidor
              </p>
              <p className="muted" style={{ margin: "0 0 12px", fontSize: 13, lineHeight: 1.5 }}>
                Falta o app da Meta (WHATSAPP_APP_ID / CONFIG_ID). Enquanto isso, você pode
                conectar por QR Code para começar a testar agora.
              </p>
              <Link href="/connect-baileys"><Button variant="secondary" size="sm">Conectar por QR Code →</Button></Link>
            </div>
          </div>
        </Card>
      )}
    </ConnectShell>
  );
}
