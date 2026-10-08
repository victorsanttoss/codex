"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import QRCode from "qrcode";
import { connectBaileys, getBaileysQr, getToken, type BaileysPairing } from "../../lib/api";
import { ConnectShell } from "../../components/ConnectShell";
import { Badge, Button, Card, Field, Input } from "../../components/ui";

/**
 * Onboarding por QR do canal NÃO-OFICIAL (Baileys, M13), no design system V4.
 * Registra a conexão e faz POLL do pareamento (QR → connected) publicado pelo
 * session-worker. ⚠️ Canal não-oficial: viola os Termos do WhatsApp; o padrão
 * recomendado é a Cloud API oficial.
 */
export default function ConnectBaileysPage() {
  const router = useRouter();
  const [phone, setPhone] = useState("");
  const [pairing, setPairing] = useState<BaileysPairing | null>(null);
  const [qrImg, setQrImg] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!getToken()) router.replace("/login");
    return () => {
      if (poll.current) clearInterval(poll.current);
    };
  }, [router]);

  // O session-worker entrega o payload em texto; o WhatsApp lê o QR como imagem.
  useEffect(() => {
    if (pairing?.status === "qr" && pairing.qr) {
      QRCode.toDataURL(pairing.qr, { width: 232, margin: 1 }).then(setQrImg).catch(() => setQrImg(""));
    } else {
      setQrImg("");
    }
  }, [pairing]);

  async function start() {
    const digits = phone.replace(/[^\d]/g, "");
    if (digits.length < 8) {
      setStatus("Informe o número com DDI — ex.: 5511999999999.");
      return;
    }
    setStatus("");
    setBusy(true);
    try {
      await connectBaileys(digits);
    } catch (e) {
      setStatus(`Não foi possível iniciar: ${(e as Error).message}`);
      setBusy(false);
      return;
    }
    if (poll.current) clearInterval(poll.current);
    poll.current = setInterval(async () => {
      try {
        const p = await getBaileysQr(digits);
        setPairing(p);
        if (p.status === "connected" || p.status === "logged_out") {
          if (poll.current) clearInterval(poll.current);
          setBusy(false);
        }
      } catch {
        /* mantém o poll */
      }
    }, 2000);
  }

  const st = pairing?.status;

  return (
    <ConnectShell
      channel="qr"
      kicker="Conexão por QR Code"
      title="Conecte lendo um QR Code"
      sub="Rápido como o WhatsApp Web. Funciona com qualquer número, sem aprovação da Meta."
    >
      <Card style={{ marginBottom: 16, display: "flex", gap: 12, alignItems: "flex-start", borderColor: "var(--warning)" }}>
        <Badge tone="warning">Atenção</Badge>
        <p className="muted" style={{ margin: 0, fontSize: 13, lineHeight: 1.5 }}>
          Canal <strong>não-oficial</strong>: viola os Termos do WhatsApp e o número <strong>pode ser banido</strong>.
          O padrão recomendado é a conexão oficial (Cloud API). Use sob sua responsabilidade.
        </p>
      </Card>

      {st !== "connected" && (
        <Card>
          <Field label="Número do WhatsApp (com DDI)">
            <Input
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="5511999999999"
              inputMode="numeric"
              disabled={busy && st === "qr"}
            />
          </Field>
          <Button onClick={start} disabled={busy && st === "qr"} style={{ marginTop: 14 }}>
            {busy && st !== "qr" ? "Gerando QR…" : st === "qr" ? "Aguardando leitura…" : "Gerar QR e parear"}
          </Button>
          {status && <p style={{ color: "var(--error-text)", fontSize: 13, marginTop: 12, marginBottom: 0 }}>{status}</p>}

          {st === "qr" && (
            <div style={{ marginTop: 22, display: "grid", gridTemplateColumns: "auto 1fr", gap: 20, alignItems: "center" }}>
              <div style={{ background: "#fff", padding: 10, borderRadius: "var(--r-card)", border: "1px solid var(--border-200)", width: "fit-content" }}>
                {qrImg ? (
                  <img src={qrImg} alt="QR de pareamento" width={232} height={232} style={{ display: "block" }} />
                ) : (
                  <div style={{ width: 232, height: 232, display: "grid", placeItems: "center", color: "var(--text-subtle)", fontSize: 13 }}>Gerando…</div>
                )}
              </div>
              <div>
                <div className="eyebrow" style={{ marginBottom: 10 }}>Como escanear</div>
                <ol style={{ margin: 0, paddingLeft: 18, fontSize: 13.5, color: "var(--text-body)", lineHeight: 1.7 }}>
                  <li>Abra o <strong>WhatsApp</strong> no celular do número</li>
                  <li>Toque em <strong>Aparelhos conectados</strong></li>
                  <li><strong>Conectar um aparelho</strong> e aponte para o QR</li>
                </ol>
                <p className="caption" style={{ marginTop: 12 }}>O QR expira em ~90s e se renova sozinho.</p>
              </div>
            </div>
          )}

          {st === "logged_out" && (
            <div style={{ marginTop: 16, padding: "12px 14px", borderRadius: "var(--r-sm)", background: "var(--error-bg)", color: "var(--error-text)", fontSize: 13, fontWeight: 600 }}>
              Sessão deslogada — gere um novo QR e escaneie de novo.
            </div>
          )}
        </Card>
      )}

      {st === "connected" && (
        <Card style={{ textAlign: "center", padding: 36 }}>
          <div style={{ width: 52, height: 52, borderRadius: "50%", background: "var(--success)", display: "inline-flex", alignItems: "center", justifyContent: "center", marginBottom: 14 }}>
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="m5 12 5 5L20 7" /></svg>
          </div>
          <h2 className="h2" style={{ margin: "0 0 6px" }}>WhatsApp conectado!</h2>
          <p className="muted" style={{ margin: "0 0 18px", fontSize: 14 }}>Seu número está pareado. A SDR já pode atender por aqui.</p>
          <Button onClick={() => router.push("/onboarding")}>Continuar onboarding →</Button>
        </Card>
      )}
    </ConnectShell>
  );
}
