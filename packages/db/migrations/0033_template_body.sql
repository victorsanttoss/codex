-- M8-ext: corpo da mensagem no catálogo de templates.
-- Motivo: o texto do follow-up escrito pelo CLIENTE precisa morar do nosso lado.
-- No canal não-oficial (Baileys) o body é enviado como texto normal; na Cloud
-- API oficial o envio segue por HSM (nome/idioma) e o body serve de fonte para
-- a SUBMISSÃO do template à Meta (aprovação continua externa).
ALTER TABLE message_templates ADD COLUMN IF NOT EXISTS body_text text;
-- Correlação da SUBMISSÃO à Meta (achado Codex): o id devolvido pelo Graph POST
-- é ecoado no webhook de aprovação; sem ele, um webhook atrasado de submissão
-- antiga aprovaria o corpo NOVO do template (nomes são reutilizados).
ALTER TABLE message_templates ADD COLUMN IF NOT EXISTS meta_template_id text;
