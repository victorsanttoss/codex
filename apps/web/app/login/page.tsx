"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { getOnboarding, login, setToken } from "../../lib/api";
import { Button, Field, Input } from "../../components/ui";
import s from "./login.module.css";

/**
 * Login — split screen do design V4: marca escura à esquerda ("Sua SDR de IA nunca
 * dorme") + formulário à direita (entrar / Google / Fale com a V4). Em sucesso:
 * onboarding NÃO ativado → volta ao wizard, que retoma do passo salvo (o cliente
 * continua de onde parou); ativado → área do cliente (/inicio).
 */
export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("owner@demo.local");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await login(email, password);
      setToken(res.accessToken);
      // Retomada do onboarding: não-ativado volta DIRETO ao wizard (que abre no
      // passo salvo). Falha na consulta não bloqueia o login → /inicio.
      const ob = await getOnboarding().catch(() => null);
      router.push(ob && !ob.activatedAt ? "/onboarding" : "/inicio");
    } catch {
      setError("Não foi possível entrar. Verifique e-mail e senha.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className={s.wrap}>
      <section className={s.brand}>
        <div className={s.logo}>
          <span className={s.logoMark}>V4</span>
          <strong style={{ fontSize: 15 }}>SDR de IA</strong>
        </div>
        <div>
          <span className={s.badge247}>Atende 24/7</span>
          <h1 className={s.headline}>Sua SDR de IA nunca dorme</h1>
          <p className={s.sub}>
            Atende, qualifica e agenda seus leads no WhatsApp 24 horas por dia — com a sua voz e as
            suas regras.
          </p>
        </div>
        <div className={s.brandFoot}>V4 Company · Souza Santos &amp; Associados</div>
      </section>

      <section className={s.form}>
        <form className={s.formInner} onSubmit={onSubmit}>
          <h2 className="h2" style={{ marginBottom: 4 }}>Entrar</h2>
          <p className="muted" style={{ marginTop: 0, marginBottom: 22, fontSize: 13 }}>
            Acesse o painel da sua SDR.
          </p>

          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <Field label="E-mail">
              <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
            </Field>
            <label style={{ display: "flex", flexDirection: "column" }}>
              <span className={s.labelRow}>
                <span className={s.fieldLabel}>Senha</span>
                {/* Recuperação de senha ainda não existe — não fingir link (href="#"). */}
                <span className={s.forgot} title="Em breve — peça o reset ao suporte." style={{ cursor: "default", opacity: 0.6 }}>Esqueci minha senha</span>
              </span>
              <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" />
            </label>
          </div>

          {error && <div className={s.error}>{error}</div>}

          <Button type="submit" disabled={loading} style={{ width: "100%", marginTop: 18 }}>
            {loading ? "Entrando…" : "Entrar"}
          </Button>

          <div className={s.divider}>ou</div>

          <button type="button" className={s.gauth} disabled>
            Continuar com Google
          </button>

          <p className={s.foot}>
            Ainda não tem SDR? <a href="https://v4company.com" target="_blank" rel="noreferrer">Fale com a V4</a>
          </p>
        </form>
      </section>
    </main>
  );
}
