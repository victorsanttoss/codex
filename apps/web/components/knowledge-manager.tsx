"use client";

import { useEffect, useRef, useState } from "react";
import {
  deleteKnowledgeSource as apiDeleteKnowledgeSource,
  ingestKnowledge,
  listKnowledgeSources,
  type KnowledgeSourceRow,
} from "../lib/api";
import { ConfirmDialog, SkeletonBlock } from "./ui";

/** Extensões cujo CONTEÚDO conseguimos ler no navegador (texto puro). */
const TEXT_EXTENSIONS = /\.(txt|md|markdown|csv)$/i;

/**
 * Gerenciador da BASE DE CONHECIMENTO do tenant (upload + lista + exclusão),
 * compartilhado entre a etapa 6 do wizard e a página de Configuração — o
 * cliente vê e gerencia os arquivos enviados também DEPOIS do onboarding.
 * Ingestão é assíncrona (fila): poll contínuo enquanto houver fonte pendente.
 */
export function KnowledgeManager() {
  const [sources, setSources] = useState<KnowledgeSourceRow[] | null>(null);
  const [uploading, setUploading] = useState(false);
  const [notice, setNotice] = useState<{ kind: "ok" | "warn" | "error"; text: string } | null>(null);
  const [dragOver, setDragOver] = useState(false);

  // Exclusão com confirmação (pedido do cliente: gerenciar direto do wizard).
  const [toDelete, setToDelete] = useState<KnowledgeSourceRow | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Timers de re-poll cancelados no unmount (Codex): sem isto, sair da etapa
  // disparava request + setState em componente desmontado.
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const mountedRef = useRef(true);
  const refresh = () =>
    listKnowledgeSources()
      .then((rows) => mountedRef.current && setSources(rows))
      // Erro transitório PRESERVA o estado anterior (Codex: zerar matava o poll
      // e a tela nunca mostrava o status terminal); [] só no primeiro load.
      .catch(() => mountedRef.current && setSources((prev) => prev ?? []));
  useEffect(() => {
    mountedRef.current = true;
    refresh();
    const timers = timersRef.current;
    return () => {
      mountedRef.current = false;
      for (const t of timers) clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Poll CONTÍNUO enquanto houver fonte "processando" (bug real: a falha da
  // ingestão chegava DEPOIS dos retries da fila e a tela congelava em
  // PROCESSANDO — agora o status terminal, PRONTO ou FALHOU, sempre aparece).
  useEffect(() => {
    if (!sources?.some((r) => r.status === "pending")) return;
    const t = setTimeout(refresh, 3500);
    timersRef.current.push(t);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sources]);

  async function confirmDelete() {
    if (!toDelete) return;
    setDeleting(true);
    try {
      await apiDeleteKnowledgeSource(toDelete.externalRef);
      setNotice({ kind: "ok", text: `"${toDelete.title}" removido da base.` });
    } catch (err) {
      // 404 = a fonte JÁ não existia (lista defasada) — exclusão é idempotente:
      // para o cliente, o resultado desejado ("fora da base") está atingido.
      if (err instanceof Error && err.message.includes("404")) {
        setNotice({ kind: "ok", text: `"${toDelete.title}" já não estava mais na base.` });
      } else {
        setNotice({ kind: "error", text: "Não conseguimos remover o arquivo. Tente de novo." });
      }
    } finally {
      // Tenta atualizar sempre — na prática a linha fantasma sai da tela
      // (refresh engole falha transitória preservando o estado anterior).
      await refresh();
      setDeleting(false);
      setToDelete(null);
    }
  }

  async function onPick(file: File) {
    setNotice(null);
    if (!TEXT_EXTENSIONS.test(file.name)) {
      setNotice({
        kind: "warn",
        text: `Por enquanto lemos TXT e MD direto do navegador — converta "${file.name}" para um desses formatos (a leitura de PDF/DOCX chega em breve).`,
      });
      return;
    }
    if (file.size > 900_000) {
      setNotice({ kind: "error", text: "Arquivo muito grande (máx. ~900KB de texto)." });
      return;
    }
    setUploading(true);
    try {
      const content = await file.text();
      if (!content.trim()) {
        setNotice({ kind: "error", text: "O arquivo está vazio." });
        return;
      }
      await ingestKnowledge({
        externalRef: `onboarding:${file.name}`,
        kind: "doc",
        title: file.name,
        content,
      });
      setNotice({ kind: "ok", text: `"${file.name}" enviado! Processando — quando terminar, ele aparece como PRONTO na lista abaixo (arquivos maiores levam alguns minutos).` });
      await refresh();
      // A ingestão é assíncrona (fila): re-consulta em alguns segundos p/ o
      // status sair de "processando" sem o cliente precisar recarregar.
      timersRef.current.push(setTimeout(refresh, 4000), setTimeout(refresh, 10000));
    } catch {
      setNotice({ kind: "error", text: "Não conseguimos enviar o arquivo. Tente de novo." });
    } finally {
      setUploading(false);
    }
  }

  return (
    <div>
      <label
        style={{ display: "block", position: "relative", border: `1.5px dashed ${dragOver ? "var(--red-700)" : "var(--border-300)"}`, borderRadius: 12, padding: 36, textAlign: "center", color: "var(--text-muted)", cursor: uploading ? "wait" : "pointer", background: dragOver ? "var(--warning-tint)" : "var(--surface-subtle)", opacity: uploading ? 0.6 : 1 }}
        onDragOver={(e) => {
          e.preventDefault();
          if (!uploading) setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          // "Arraste aqui" agora funciona de verdade (Codex: a promessa era só visual).
          e.preventDefault();
          setDragOver(false);
          const f = e.dataTransfer.files?.[0];
          if (f && !uploading) void onPick(f);
        }}
      >
        <input
          type="file"
          accept=".txt,.md,.markdown,.csv,.pdf,.doc,.docx"
          aria-label="Enviar arquivo para a base de conhecimento"
          disabled={uploading}
          style={{ position: "absolute", width: 1, height: 1, opacity: 0 }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = ""; // permite re-selecionar o mesmo arquivo
            if (f) void onPick(f);
          }}
        />
        {uploading ? "Enviando…" : (
          <>
            Arraste um arquivo aqui ou <strong style={{ color: "var(--red-700)" }}>escolha do computador</strong>
            <div className="caption" style={{ marginTop: 6 }}>TXT ou MD (markdown é o que a IA lê melhor) · PDF/DOCX em breve · opcional, dá para pular</div>
          </>
        )}
      </label>

      {notice && (
        <div style={{ marginTop: 12, padding: "10px 14px", borderRadius: 10, fontSize: 13, background: notice.kind === "ok" ? "var(--success-tint)" : notice.kind === "warn" ? "var(--warning-tint)" : "var(--error-bg)", color: notice.kind === "ok" ? "var(--success-text)" : notice.kind === "warn" ? "var(--warning-text)" : "var(--error-text)" }}>
          {notice.text}
        </div>
      )}

      <div style={{ marginTop: 18 }}>
        <div className="eyebrow" style={{ marginBottom: 8 }}>Materiais na base</div>
        {sources === null && <SkeletonBlock height={38} />}
        {sources?.length === 0 && <p className="muted" style={{ fontSize: 13, margin: 0 }}>Nenhum material ainda — a SDR responde só com o que você ensinou no onboarding.</p>}
        {sources?.map((src) => (
          <div key={src.externalRef} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, border: "1px solid var(--border-200)", borderRadius: 10, padding: "9px 12px", marginBottom: 6 }}>
            <span style={{ fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>📄 {src.title}</span>
            <span style={{ display: "flex", alignItems: "center", gap: 8, flex: "none" }}>
              <span style={{ fontSize: 11, fontWeight: 800, padding: "2px 9px", borderRadius: 999, background: src.status === "ready" ? "var(--success-tint)" : src.status === "failed" ? "var(--error-bg)" : "var(--warning-tint)", color: src.status === "ready" ? "var(--success-text)" : src.status === "failed" ? "var(--error-text)" : "var(--warning-text)" }}>
                {src.status === "ready" ? `PRONTO · ${src.chunkCount} trechos` : src.status === "failed" ? "FALHOU — envie de novo" : "PROCESSANDO…"}
              </span>
              <button
                type="button"
                aria-label={`Excluir ${src.title} da base de conhecimento`}
                onClick={() => setToDelete(src)}
                style={{ border: "none", background: "none", color: "var(--red-700)", cursor: "pointer", fontSize: 15, padding: "2px 4px", lineHeight: 1 }}
              >
                🗑
              </button>
            </span>
          </div>
        ))}
      </div>

      <ConfirmDialog
        open={toDelete !== null}
        title="Excluir da base de conhecimento?"
        message={`A SDR vai parar de usar "${toDelete?.title ?? ""}" nas respostas imediatamente. Você pode enviar o arquivo de novo quando quiser.`}
        confirmLabel="Excluir"
        danger
        busy={deleting}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setToDelete(null)}
      />
    </div>
  );
}
