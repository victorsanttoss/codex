// Cliente HTTP mínimo para a API. M1: guarda o access token no localStorage
// (simplificação de scaffold; a API também seta cookies httpOnly). ADR documenta.

// fallback 3101: porta da API DESTE fork (3001 é o SDR IA padrão na mesma máquina)
export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3101";

const TOKEN_KEY = "sdr_access_token";

export function setToken(token: string): void {
  if (typeof window !== "undefined") localStorage.setItem(TOKEN_KEY, token);
}
export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(TOKEN_KEY);
}
export function clearToken(): void {
  if (typeof window !== "undefined") localStorage.removeItem(TOKEN_KEY);
}

// Token de PLATAFORMA (staff/curador) — separado do JWT do tenant. É o token
// PESSOAL do staff: o backend o resolve para a identidade (GET /platform/me) e
// enforça o papel. Enviado no header x-platform-token nas rotas /platform/*.
const PLATFORM_TOKEN_KEY = "sdr_platform_token";
export function setPlatformToken(token: string): void {
  if (typeof window !== "undefined") localStorage.setItem(PLATFORM_TOKEN_KEY, token);
}
export function getPlatformToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(PLATFORM_TOKEN_KEY);
}
export function clearPlatformToken(): void {
  if (typeof window !== "undefined") localStorage.removeItem(PLATFORM_TOKEN_KEY);
}

export interface TenantMembership {
  tenantId: string;
  role: "owner" | "admin" | "agent";
}

export async function login(
  email: string,
  password: string,
): Promise<{ accessToken: string; activeTenantId: string; tenants: TenantMembership[] }> {
  const res = await fetch(`${API_URL}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
    credentials: "include",
  });
  if (!res.ok) throw new Error("Credenciais inválidas");
  return res.json();
}

/**
 * Sai da conta: revoga a SESSÃO de refresh no servidor (ADR 0006) e limpa o
 * token local. Best-effort — servidor fora do ar não pode prender o usuário.
 */
export async function logout(): Promise<void> {
  try {
    await jwtFetch("/auth/logout", { method: "POST" });
  } catch {
    /* melhor esforço */
  }
  clearToken();
}

// ── Sessão: renovação automática de token ─────────────────────
// O access token é curto (15m); o refresh (cookie httpOnly, 30d) renova sem o
// usuário perceber. Assim a jornada do cliente NÃO quebra: ele conecta a
// qualquer hora e, se o access expirou, o web renova nos bastidores e refaz a
// chamada. Só cai no /login se o refresh também falhou (sessão de fato morta).
let refreshInFlight: Promise<string | null> | null = null;

async function refreshAccessToken(): Promise<string | null> {
  // Deduplica refreshes concorrentes (vários 401 ao mesmo tempo → 1 só refresh).
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      try {
        const res = await fetch(`${API_URL}/auth/refresh`, { method: "POST", credentials: "include" });
        if (!res.ok) return null;
        const { accessToken } = (await res.json()) as { accessToken: string };
        setToken(accessToken);
        return accessToken;
      } catch {
        return null;
      }
    })().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

function redirectToLogin(): void {
  clearToken();
  if (typeof window !== "undefined" && !window.location.pathname.startsWith("/login")) {
    window.location.href = "/login";
  }
}

/** fetch autenticado com JWT + retry único após renovar o token no 401. */
async function jwtFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const send = (token: string | null): Promise<Response> =>
    fetch(`${API_URL}${path}`, {
      ...init,
      headers: { ...(init.headers ?? {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      credentials: "include",
    });

  let res = await send(getToken());
  if (res.status === 401) {
    const fresh = await refreshAccessToken();
    if (fresh) res = await send(fresh);
    if (res.status === 401) {
      redirectToLogin();
      throw new Error("UNAUTHENTICATED");
    }
  }
  return res;
}

/**
 * Erro HTTP com a MENSAGEM do servidor quando houver (shape do Nest) — senão o
 * genérico. SÓ para 4xx (mensagem intencional ao cliente: validação, conflito…);
 * 5xx fica genérico — erro interno pode carregar detalhe que não é para a UI
 * (achado Codex: ex. erro cru da Graph API).
 */
async function httpError(res: Response): Promise<Error> {
  let msg = `Erro ${res.status}`;
  if (res.status < 500) {
    try {
      const body = (await res.json()) as { message?: string | string[] };
      if (typeof body.message === "string" && body.message) msg = body.message.slice(0, 300);
      else if (Array.isArray(body.message)) msg = body.message.join("; ").slice(0, 300);
    } catch {
      /* corpo não-JSON — mantém o genérico */
    }
  }
  return new Error(msg);
}

async function authed<T>(path: string): Promise<T> {
  const res = await jwtFetch(path);
  if (!res.ok) throw await httpError(res);
  return res.json();
}

export interface Me {
  sub: string;
  tenantId: string;
  role: string;
}
export interface UsageSummary {
  from: string;
  to: string;
  events: number;
  tokensIn: number;
  tokensOut: number;
  costMicros: number;
}

export const getMe = () => authed<Me>("/auth/me");
export const getUsage = () => authed<UsageSummary>("/usage");

// ── Embedded Signup (M3) ──────────────────────────────────────
async function authedPost<T>(path: string, body: unknown): Promise<T> {
  const res = await jwtFetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await httpError(res);
  return res.json();
}

export interface SignupConfig {
  appId?: string;
  configId?: string;
  graphApiVersion: string;
}
export const getSignupConfig = () => authed<SignupConfig>("/admin/whatsapp/signup/config");
export const submitSignup = (body: { code: string; phoneNumberId: string; wabaId: string }) =>
  authedPost<{ phoneNumberId: string; reconnected: boolean }>("/admin/whatsapp/signup/callback", body);

export interface ConnectionStatus {
  connected: boolean;
  provider?: string;
  phoneNumberId?: string;
}
/** Há WhatsApp conectado (cloud_api ou baileys)? Usado no estado vazio do início. */
export const getConnectionStatus = () => authed<ConnectionStatus>("/admin/whatsapp/connections");

// ── Painel: leitura (M14) ─────────────────────────────────────
export interface Paged<T> {
  rows: T[];
  total: number;
}
export interface LeadRow {
  conversationId: string;
  waId: string;
  name: string | null;
  phone: string | null;
  stage: string;
  status: string;
  score: number;
  summary: string | null;
  lastContactAt: string | null;
  updatedAt: string;
}
export interface ConversationRow {
  conversationId: string;
  waId: string;
  name: string | null;
  status: string;
  humanTakeover: boolean;
  leadStatus: string | null;
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
}
export interface HistoryMessage {
  direction: "inbound" | "outbound";
  type: string;
  content: Record<string, unknown>;
  createdAt: string;
}
export interface LeadProfile {
  id: string;
  conversationId: string;
  stage: string;
  status: string;
  score: number;
  fields: Record<string, unknown>;
  summary: string | null;
}
export interface AppointmentRow {
  id: string;
  whenText: string | null;
  startsAt: string | null;
  details: string;
  status: string;
}
export interface DashboardData {
  funnel: Record<string, number>;
  usage: { events: number; tokensIn: number; tokensOut: number; costMicros: number };
}

export const getDashboard = () => authed<DashboardData>("/admin/dashboard");
export const getLeads = (q: Record<string, string | number | undefined> = {}) => {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== "") params.set(k, String(v));
  return authed<Paged<LeadRow>>(`/admin/leads?${params.toString()}`);
};
export const getLeadDetail = (conversationId: string) =>
  authed<{ profile: LeadProfile | null; appointments: AppointmentRow[]; history: HistoryMessage[] }>(`/admin/leads/${conversationId}`);
export const getConversations = (q: Record<string, string | number | undefined> = {}) => {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== "") params.set(k, String(v));
  return authed<Paged<ConversationRow>>(`/admin/conversations?${params.toString()}`);
};
export const getConversationDetail = (conversationId: string) =>
  authed<{ history: HistoryMessage[]; profile: LeadProfile | null }>(`/admin/conversations/${conversationId}`);
export const setTakeover = (conversationId: string, on: boolean) =>
  authedPost<{ ok: boolean }>(`/admin/conversations/${conversationId}/takeover`, { on });

/**
 * Envio manual do humano (conversa assumida). Diferente dos demais helpers,
 * PROPAGA a mensagem de erro do backend — o composer mostra o motivo real
 * (409 IA no comando, 403 opt-out, 422 janela de 24h) num toast.
 */
export async function sendConversationMessage(
  conversationId: string,
  text: string,
  clientMessageId?: string, // idempotência: retry da MESMA mensagem reusa a chave (não duplica)
): Promise<HistoryMessage> {
  const res = await jwtFetch(`/admin/conversations/${conversationId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, ...(clientMessageId ? { clientMessageId } : {}) }),
  });
  if (!res.ok) {
    let msg = `Erro ${res.status}`;
    try {
      const body = (await res.json()) as { message?: string | string[] };
      if (typeof body.message === "string") msg = body.message;
      else if (Array.isArray(body.message)) msg = body.message.join("; ");
    } catch {
      /* corpo não-JSON — mantém o genérico */
    }
    throw new Error(msg);
  }
  const { message } = (await res.json()) as { message: HistoryMessage };
  return message;
}

// ── Área da Plataforma (staff, M14) — token x-platform-token ───
async function platformGet<T>(path: string): Promise<T> {
  const token = getPlatformToken();
  const res = await fetch(`${API_URL}${path}`, { headers: token ? { "x-platform-token": token } : {}, credentials: "include" });
  if (res.status === 401 || res.status === 403) throw new Error("PLATFORM_UNAUTHORIZED");
  if (!res.ok) throw await httpError(res);
  return res.json();
}
async function platformPost<T>(path: string, body: unknown): Promise<T> {
  const token = getPlatformToken();
  const res = await fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { "x-platform-token": token } : {}) },
    body: JSON.stringify(body),
    credentials: "include",
  });
  if (res.status === 401 || res.status === 403) throw new Error("PLATFORM_UNAUTHORIZED");
  if (!res.ok) throw await httpError(res);
  return res.json();
}
async function platformDelete<T>(path: string): Promise<T> {
  const token = getPlatformToken();
  const res = await fetch(`${API_URL}${path}`, {
    method: "DELETE",
    headers: token ? { "x-platform-token": token } : {},
    credentials: "include",
  });
  if (res.status === 401 || res.status === 403) throw new Error("PLATFORM_UNAUTHORIZED");
  if (!res.ok) throw await httpError(res);
  return res.json();
}
export interface PlatformOverview { tenants: number; activeTenants: number; niches: number }
export interface PlatformTenant { id: string; name: string; slug: string; status: string; createdAt: string }
export interface PlatformNiche { id: string; name: string; vertical: string; motion: string; guidance: string | null; status: string }
export interface CandidateRow { id: string; candidateType: string; content: Record<string, unknown>; status: string; piiFlag?: boolean; createdAt: string }

export interface PlatformTemplate { tenantId: string; name: string; category: string; languageCode: string; status: string }
export interface PlatformTemplatesView { templates: PlatformTemplate[]; counts: { approved: number; pending: number; rejected: number } }
export interface StaffRow { id: string; email: string; name: string; role: string }
/** Identidade do staff logado, resolvida pelo backend a partir do token pessoal. */
export interface PlatformMe { id: string; email: string; name: string; role: "admin" | "curator" | "support" }
export interface OperationSnapshot {
  signals: { diskUsedPercent: number; expiringTokens: number; outboxFailed: number; downConnections: number; queueBacklog: number };
  alerts: Array<{ kind: string; severity: "warning" | "critical"; message: string }>;
}
export const getPlatformMe = () => platformGet<PlatformMe>("/platform/me");
// Gestão de staff (ADMIN). O token cru aparece UMA única vez — copiar na hora.
export const createStaff = (email: string, name: string, role: string) =>
  platformPost<StaffRow & { token: string }>("/platform/staff", { email, name, role });
export const rotateStaffToken = (id: string) =>
  platformPost<{ token: string }>(`/platform/staff/${id}/rotate-token`, {});
export const deleteStaff = (id: string) => platformDelete<{ ok: true }>(`/platform/staff/${id}`);
export const getPlatformOverview = () => platformGet<PlatformOverview>("/platform/overview");
export const getPlatformTemplates = () => platformGet<PlatformTemplatesView>("/platform/templates");
export const getPlatformStaff = () => platformGet<StaffRow[]>("/platform/staff");
export const getPlatformOperation = () => platformGet<OperationSnapshot>("/platform/operation");
export const getPlatformTenants = () => platformGet<PlatformTenant[]>("/platform/tenants");
export const getPlatformNiches = () => platformGet<PlatformNiche[]>("/platform/niches");
export const getCandidates = (nicheId: string, status?: string) =>
  platformGet<CandidateRow[]>(`/platform/niches/${nicheId}/candidates${status ? `?status=${status}` : ""}`);
// A identidade do curador vem do TOKEN (backend resolve o staff); não se envia
// mais um curatorId no corpo. Papel curador/admin é exigido pelo guard.
export const approveCandidate = (nicheId: string, id: string, content?: string) =>
  platformPost<{ ok: true }>(`/platform/niches/${nicheId}/candidates/${id}/approve`, content ? { content } : {});
export const rejectCandidate = (nicheId: string, id: string) =>
  platformPost<{ ok: true }>(`/platform/niches/${nicheId}/candidates/${id}/reject`, {});
export const promoteCandidate = (nicheId: string, id: string) =>
  platformPost<{ knowledgeId: string }>(`/platform/niches/${nicheId}/candidates/${id}/promote`, {});

// ── Configuração & Conta (M14) ────────────────────────────────
export interface AgentSettings {
  persona: string;
  fallbackMessage: string;
  nonTextMessage: string;
  handoffMessage: string;
  optOutMessage: string;
  knowledge: { topK: number; minScore: number };
  guardrails: { maxToolIterations: number; maxCostMicrosPerTurn: number };
  qualification: { qualifyAtScore: number; enabled?: boolean; fields: Array<{ key: string; type?: string; weight?: number; required?: boolean; eliminatory?: unknown; description?: string }> };
  business: { products: string; tone: string; canSay: string; cannotSay: string };
}
export interface MemberRow { userId: string; email: string; role: string }
export interface ComplianceSummary { optedOut: number; contacts: number }

export const getAgentSettings = () => authed<AgentSettings>("/admin/settings/agent");
export const saveAgentSettings = (patch: Record<string, unknown>) => authedPut<{ ok: true }>("/admin/settings/agent", { patch });
export const getCadenceSettings = () => authed<Record<string, unknown>>("/admin/settings/cadence");
export const saveCadenceSettings = (patch: Record<string, unknown>) =>
  authedPut<{ ok: true; applied: Record<string, unknown> }>("/admin/settings/cadence", { patch });

// ── Agendamento pela SDR (0034) ───────────────────────────────
export interface SchedulingSettings {
  enabled: boolean;
  durationMinutes: number;
  slotStepMinutes: number;
  windowHours: number;
  minNoticeMinutes: number;
  maxDaysAhead: number;
  hours: { startHour: number; endHour: number; days: number[] };
  appointmentLabel: string;
}
export const getSchedulingSettings = () => authed<SchedulingSettings>("/admin/settings/scheduling");
export const saveSchedulingSettings = (patch: Record<string, unknown>) =>
  authedPut<{ ok: true; applied: SchedulingSettings }>("/admin/settings/scheduling", { patch });
export const getGoogleCalendarStatus = () =>
  authed<{ configured: boolean; serviceAccountEmail: string | null }>("/admin/calendar/google-status");
export const linkGoogleCalendar = (input: { provider: "internal" | "google"; externalCalendarId?: string }) =>
  authedPost<{ ok: true; calendar: CalendarInfo }>("/admin/calendar/link", input);

// ── Pool de agendas (multi-recurso, 0036) ─────────────────────
export interface PoolCalendar {
  id: string;
  name: string;
  provider: "internal" | "google";
  googleCalendarId: string | null;
  isDefault: boolean;
}
/** Termo da vertical p/ o recurso ("Adicionar {singular}"); fallback "agenda". */
export interface ResourceNoun {
  singular: string;
  plural: string;
}
export interface CalendarPool {
  calendars: PoolCalendar[];
  configured: boolean;
  serviceAccountEmail: string | null;
  resourceNoun: ResourceNoun;
}
export const getCalendarPool = () => authed<CalendarPool>("/admin/calendar/pool");
export const addPoolCalendar = (input: { name: string; externalCalendarId: string }) =>
  authedPost<{ ok: true; calendar: PoolCalendar }>("/admin/calendar/pool", input);
export const updatePoolCalendar = (id: string, patch: { name?: string; externalCalendarId?: string }) =>
  authedPatch<{ ok: true; calendar: PoolCalendar }>(`/admin/calendar/pool/${encodeURIComponent(id)}`, patch);
export const removePoolCalendar = (id: string) =>
  authedDelete<{ ok: true }>(`/admin/calendar/pool/${encodeURIComponent(id)}`);

// ── Vertical do tenant (adapta wizard/Configuração ao segmento) ─
export interface VerticalInfo {
  vertical: string | null;
  nicheName: string | null;
  resourceNoun: ResourceNoun;
}
export const getVerticalInfo = () => authed<VerticalInfo>("/admin/settings/vertical");

// ── Corretores parceiros (vertical imobiliária) ─
export interface ImobAgency {
  id: string;
  name: string;
  archivedAt: string | null;
}
export interface ImobBroker {
  id: string;
  agencyId: string | null;
  agencyName: string | null;
  name: string;
  whatsapp: string;
  waId: string | null;
  regions: string[];
  dailyCapacity: number;
  active: boolean;
  archivedAt: string | null;
}
export const getImobAgencies = () => authed<{ agencies: ImobAgency[] }>("/admin/imob/agencies");
export const createImobAgency = (name: string) =>
  authedPost<{ agencyId: string }>("/admin/imob/agencies", { name });
export const getImobBrokers = (includeArchived = false) =>
  authed<{ brokers: ImobBroker[] }>(`/admin/imob/brokers${includeArchived ? "?includeArchived=true" : ""}`);
export const createImobBrokerApi = (input: {
  name: string;
  whatsapp: string;
  agencyId?: string;
  regions?: string[];
  dailyCapacity?: number;
}) => authedPost<{ brokerId: string }>("/admin/imob/brokers", input);
export const patchImobBroker = (
  id: string,
  patch: { name?: string; whatsapp?: string; regions?: string[]; dailyCapacity?: number; active?: boolean; archived?: boolean },
) => authedPatch<{ ok: true }>(`/admin/imob/brokers/${encodeURIComponent(id)}`, patch);

// ── Atendimento (kanban/lista do gestor — antes vivia na Central Menin) ─
export interface ImobOverview {
  today: { offered: number; accepted: number; acceptedInSla: number; expired: number; declined: number };
  active: { offered: number; accepted: number };
  byStage: Array<{ stage: string; count: number }>;
  avgAcceptSeconds: number | null;
  slaMinutes: number;
  byBrokerToday: Array<{ brokerId: string; brokerName: string; offered: number; accepted: number }>;
}
export interface ImobAssignmentJoined {
  id: string;
  conversationId: string;
  brokerId: string;
  status: string;
  stage: string | null;
  attempt: number;
  offeredAt: string;
  expiresAt: string;
  respondedAt: string | null;
  stageUpdatedAt: string | null;
  followupCount: number;
  offerMode: string;
  brokerName: string;
  brokerWhatsapp: string;
  agencyName: string | null;
  contactName: string | null;
  contactPhone: string | null;
  leadStatus: string | null;
  leadScore: number | null;
  leadFields: Record<string, unknown> | null;
}
export const getImobOverviewApi = () => authed<ImobOverview>("/admin/imob/overview");
export const getImobAssignmentsApi = (limit = 200) =>
  authed<{ assignments: ImobAssignmentJoined[] }>(`/admin/imob/assignments?limit=${limit}`);

/** Modo de atendimento do corretor: 'ficha' (WhatsApp pessoal) | 'workspace' (pela plataforma). */
export type ImobBrokerMode = "ficha" | "workspace";
export const getImobSettings = () => authed<{ brokerMode: ImobBrokerMode }>("/admin/imob/settings");
export const setImobBrokerModeApi = (brokerMode: ImobBrokerMode) =>
  authedPatch<{ ok: true; brokerMode: ImobBrokerMode }>("/admin/imob/settings", { brokerMode });
export const getImobWorkspaceLink = (brokerId: string, revoke = false) =>
  authedPost<{ link: string; revoked: boolean }>(
    `/admin/imob/brokers/${encodeURIComponent(brokerId)}/workspace-link`,
    { revoke },
  );

// ── Catálogo de templates (M8-ext: corpo escrito pelo cliente) ─
export interface TemplateCatalogRow {
  name: string;
  languageCode: string;
  category: string;
  /** 'approved' | 'pending' (aguardando Meta) | 'rejected' | 'paused' */
  status: string;
  bodyText: string | null;
  variables: string[];
}
export const listTemplates = () => authed<TemplateCatalogRow[]>("/admin/templates");
export const upsertTemplate = (t: { name: string; bodyText: string; languageCode?: string; category?: string }) =>
  authedPost<{ ok: true; status: string; submittedToMeta: boolean; reason?: string }>("/admin/templates", t);
export const archiveTemplate = (name: string) =>
  authedPost<{ ok: true; archived: boolean }>(`/admin/templates/${encodeURIComponent(name)}/archive`, {});

// ── Base de conhecimento (M5) ─────────────────────────────────
export interface KnowledgeSourceRow {
  externalRef: string;
  kind: string;
  title: string;
  /** pending (processando) | ready | failed — a ingestão é assíncrona. */
  status: string;
  chunkCount: number;
  updatedAt: string;
}
export const listKnowledgeSources = () => authed<KnowledgeSourceRow[]>("/admin/knowledge/sources");
export const ingestKnowledge = (input: { externalRef: string; kind: "faq" | "doc" | "text"; title: string; content: string }) =>
  authedPost<{ queued: true }>("/admin/knowledge/sources", input);
export const deleteKnowledgeSource = async (externalRef: string): Promise<{ deleted: true }> => {
  const res = await jwtFetch(`/admin/knowledge/sources/${encodeURIComponent(externalRef)}`, { method: "DELETE" });
  if (!res.ok) throw await httpError(res);
  return res.json();
};
export const getMembers = () => authed<MemberRow[]>("/admin/account/members");
export const getCompliance = () => authed<ComplianceSummary>("/admin/account/compliance");

// ── Playground sandbox (M14) ──────────────────────────────────
export interface PlaygroundResult {
  reply: string;
  retrieved: Array<{ title: string; snippet: string; score: number }>;
  fields: Record<string, unknown>;
  score: number;
  route: string;
  costMicros: number;
  iterations: number;
}
export const simulatePlayground = (text: string, niche?: string) =>
  authedPost<PlaygroundResult>("/admin/playground/message", { text, ...(niche ? { niche } : {}) });
export const resetPlayground = (niche?: string) =>
  authedPost<{ ok: true }>("/admin/playground/reset", niche ? { niche } : {});

// ── Onboarding / wizard (M14) ─────────────────────────────────
export interface OnboardingState {
  step: number;
  payload: Record<string, unknown>;
  activatedAt: string | null;
}
async function authedPut<T>(path: string, body: unknown): Promise<T> {
  const res = await jwtFetch(path, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await httpError(res);
  return res.json();
}
export const getOnboarding = () => authed<OnboardingState>("/admin/onboarding");
export const saveOnboarding = (step: number, patch: Record<string, unknown>) =>
  authedPut<OnboardingState>("/admin/onboarding", { step, patch });
export const activateOnboarding = () => authedPost<{ activated: true }>("/admin/onboarding/activate", {});

// ── Agenda (calendário do tenant) ─────────────────────────────
async function authedPatch<T>(path: string, body: unknown): Promise<T> {
  const res = await jwtFetch(path, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await httpError(res);
  return res.json();
}
async function authedDelete<T>(path: string): Promise<T> {
  const res = await jwtFetch(path, { method: "DELETE" });
  if (!res.ok) throw await httpError(res);
  return res.json();
}

export interface CalendarInfo {
  id: string;
  name: string;
  /** IANA tz do calendário — TODA renderização de dia/hora usa este fuso, não o do navegador. */
  timezone: string;
  provider: "internal" | "google";
  googleCalendarId: string | null;
}
export interface CalendarEvent {
  id: string;
  title: string;
  description: string | null;
  startsAt: string;
  endsAt: string;
  allDay: boolean;
  status: "confirmed" | "cancelled";
  /** "sdr" = agendado pela SDR IA (ganha destaque visual na agenda). */
  source: "manual" | "sdr";
  appointmentId: string | null;
}
export const getCalendar = () => authed<{ calendar: CalendarInfo }>("/admin/calendar");
export const getCalendarEvents = (fromIso: string, toIso: string) =>
  authed<{ events: CalendarEvent[] }>(
    `/admin/calendar/events?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}`,
  );
export const createCalendarEvent = (input: {
  title: string;
  description?: string;
  startsAt: string;
  endsAt: string;
  allDay?: boolean;
}) => authedPost<{ event: CalendarEvent }>("/admin/calendar/events", input);
export const updateCalendarEvent = (
  id: string,
  patch: Partial<{
    title: string;
    description: string;
    startsAt: string;
    endsAt: string;
    allDay: boolean;
    status: "confirmed" | "cancelled";
  }>,
) => authedPatch<{ event: CalendarEvent }>(`/admin/calendar/events/${encodeURIComponent(id)}`, patch);
export const deleteCalendarEvent = (id: string) =>
  authedDelete<{ ok: true }>(`/admin/calendar/events/${encodeURIComponent(id)}`);

// ── Canal não-oficial (Baileys) — onboarding por QR (M13) ─────
export interface BaileysPairing {
  status: "pending" | "qr" | "connected" | "logged_out" | "closed" | "connecting";
  qr?: string;
  updatedAt?: string;
}
export const connectBaileys = (phoneNumber: string) =>
  authedPost<{ status: "pending"; phoneNumber: string }>("/admin/whatsapp/baileys/connect", { phoneNumber });
export const getBaileysQr = (phoneNumber: string) =>
  authed<BaileysPairing>(`/admin/whatsapp/baileys/qr?phoneNumber=${encodeURIComponent(phoneNumber)}`);
