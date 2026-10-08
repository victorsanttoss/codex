"use client";

import { ErrorState } from "./ui";

/** Bits compartilhados das telas de plataforma (staff). */
export function PlatformError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  const auth = message.includes("UNAUTHORIZED");
  return (
    <div style={{ maxWidth: 560 }}>
      <h1 className="h1-page" style={{ marginBottom: 14 }}>Acesso</h1>
      <ErrorState
        message={auth ? "Token de plataforma inválido ou sem permissão. Saia e entre novamente com o seu token pessoal." : "Algo deu errado ao falar com a plataforma. Tente de novo em instantes."}
        detail={message}
        onRetry={onRetry}
      />
    </div>
  );
}

export function PlatformTitle({ children }: { children: React.ReactNode }) {
  return <h1 className="h1-page" style={{ marginBottom: 18, color: "var(--ink-900)" }}>{children}</h1>;
}
