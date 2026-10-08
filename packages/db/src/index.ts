export * as schema from "./schema";
export {
  TENANT_SCOPED_TABLES,
  tenants,
  users,
  memberships,
  tenantSecrets,
  usageEvents,
  processedMessages,
  auditLog,
  membershipRole,
  tenantStatus,
  tenantSecretKind,
  // M2
  channelConnections,
  contacts,
  conversations,
  messages,
  mediaObjects,
  messageDirection,
  messageStatus,
  // M5 — conhecimento / RAG
  knowledgeSources,
  knowledgeChunks,
  knowledgeSourceKind,
  KNOWLEDGE_VECTOR_DIM,
} from "./schema";

export {
  type Database,
  type TenantScope,
  getDb,
  closeDb,
  makeMigrationClient,
  withTenant,
  withUser,
  withSystem,
  withNiche,
  withCuration,
} from "./client";

export { TenantSecretsStore, makeCipherFromEnv, clearTenantSecretsCache } from "./secrets-store";
export { isMessageProcessed, markMessageProcessed } from "./messages";
export {
  type UsageEventInput,
  type UsageAggregate,
  recordUsage,
  aggregateUsage,
} from "./usage";

// M2 — canal WhatsApp
export {
  type ResolvedConnection,
  type UpsertConnectionInput,
  type ConnectionStatus,
  type ConnectionOwner,
  type ExpiringConnection,
  type TenantConnection,
  type ProviderConnection,
  type RoutedConnection,
  getActiveConnectionForTenant,
  getConnectionForConversation,
  listConnectionsForTenant,
  countNonActiveConnections,
  resolveConnectionByPhoneNumberId,
  upsertChannelConnection,
  findConnectionOwner,
  setConnectionStatus,
  listExpiringConnections,
  listActiveTenantIds,
  findConnectionsByWaba,
  listActiveConnectionsByProvider,
  isPhoneNumberTakenByOtherTenant,
} from "./channel-connections";
export { BaileysSessionStore } from "./baileys-session-store";
export {
  type InboundRecord,
  type RecordedInbound,
  type ConversationView,
  type OutboundRecord,
  type HistoryMessage,
  SERVICE_WINDOW_MS,
  isWithinServiceWindow,
  recordInboundMessage,
  setInboundTranscription,
  getConversationByKey,
  getConversationHistory,
  recordOutboundMessage,
  markMessageStatusByExternalId,
  type ConversationContact,
  getConversationContact,
  getConversationWindow,
} from "./conversations";

// M6 — agente
export {
  type LeadProfile,
  type LeadDecisionUpdate,
  getLeadProfile,
  getOrCreateLeadProfile,
  mergeLeadFields,
  applyLeadDecision,
  setLeadSummary,
  claimAgentResponse,
  releaseAgentResponse,
  getAgentConfig,
  putAgentConfig,
} from "./agent";

// Durable reactive turns (0041): immutable plan, recovery and lease fencing.
export { agentTurns } from "./schema";
export {
  type AgentTurnPlan,
  type AgentTurnRow,
  type AgentTurnReplyStatus,
  type AgentTurnClaim,
  type AgentTurnRecoveryFilter,
  claimAgentTurn,
  saveAgentTurnPlan,
  renewAgentTurnLease,
  markAgentTurnReply,
  completeAgentTurnEffect,
  finishAgentTurn,
  releaseAgentTurnLease,
  listRecoverableAgentTurns,
  getAgentTurn,
  listPendingAgentTurns,
  listTenantIdsWithPendingAgentTurns,
  listUncertainAgentTurns,
} from "./agent-turns";

// M7 — CRM built-in + agendamento + notificação + sync
export {
  type UpsertContactInput,
  type UpsertOpportunityInput,
  type CreateAppointmentInput,
  type CrmSyncRow,
  upsertCrmContact,
  upsertOpportunity,
  addActivity,
  createAppointment,
  setAppointmentStatus,
  setAppointmentCalendar,
  createNotification,
  getCrmSync,
  upsertCrmSync,
} from "./crm";

// M8 — outbox de entrega
export {
  type OutboxKind,
  type OutboxBilling,
  type EnqueueOutboxInput,
  type RecordSentOutboxInput,
  type ClaimedOutbox,
  type ClaimedConnection,
  type ClaimRouting,
  type HumanOutboxClaim,
  enqueueOutbox,
  recordSentOutbox,
  claimHumanOutbox,
  claimDueOutbox,
  markOutboxSent,
  markOutboxFailed,
  markOutboxCanceled,
  cancelPendingOutbox,
  reconcileOutboxStatus,
  countOutboxSentSince,
  countOutboxFailed,
  sweepStuckOutbox,
  listTenantsWithDueOutbox,
} from "./outbox";

// M8 — cadência + opt-out
export {
  type CadenceStateRow,
  type DueCadence,
  getCadenceState,
  armCadence,
  stopCadence,
  completeCadence,
  claimDueCadence,
  markContactOptedOut,
  isContactOptedOut,
  type ApprovedTemplate,
  type TemplateRow,
  getApprovedTemplate,
  listMessageTemplates,
  setTemplateMetaId,
  setTemplateStatus,
  upsertMessageTemplate,
} from "./cadence";

// M9 — camada de nicho + curadoria
export {
  type NicheRef,
  type NicheChunk,
  type CandidateInput,
  type CandidateRow,
  type NicheConfigRow,
  getTenantNicheId,
  assignTenantNiche,
  getNiche,
  getNicheByName,
  setNicheGuidance,
  getNicheConfig,
  upsertNicheConfig,
  retirePlatformAuthoredKnowledge,
  createNiche,
  searchNicheKnowledge,
  createCandidate,
  listCandidates,
  getCandidate,
  setCandidateStatus,
  insertNicheKnowledge,
  promoteCandidate,
  retireNicheKnowledge,
  recordPlatformUsage,
  listConvertedConversationIds,
} from "./niche";
export {
  type MediaObjectInput,
  insertMediaObject,
  type CachedTranscription,
  getTranscriptionByMedia,
  saveTranscription,
} from "./media";
export { type OnboardingState, getOnboarding, saveOnboarding, activateOnboarding } from "./onboarding";
export {
  type LeadRow,
  type LeadFilter,
  type Paged,
  type ConversationRow,
  type AppointmentRow,
  listLeads,
  leadFunnel,
  listConversations,
  listAppointmentsForConversation,
  setHumanTakeover,
  isHumanTakeover,
  isPanelConversation,
} from "./crm-read";
export { ensureSandboxConversation, resetSandbox } from "./playground";
export { type MemberRow, type ComplianceSummary, listTenantMembers, complianceSummary } from "./account";
export {
  type PlatformTenant,
  type PlatformNiche,
  type PlatformOverview,
  listAllTenants,
  listNiches,
  platformOverview,
  type PlatformTemplate,
  type PlatformTemplatesView,
  type StaffRow,
  listPlatformTemplates,
  listPlatformStaff,
  findStaffByTokenHash,
  setStaffTokenHash,
  setStaffTokenHashById,
  createPlatformStaff,
  deletePlatformStaff,
} from "./platform-read";

// M14 — auditoria de operações sensíveis (plataforma/curadoria)
export { type AuditEntry, insertAuditLog } from "./audit";

// M5 — conhecimento / RAG
export {
  type KnowledgeSourceKind,
  type UpsertSourceInput,
  type UpsertSourceResult,
  type ChunkInput,
  type SearchOptions,
  type RetrievedChunk,
  type SourceRef,
  type ChunkContent,
  assertVectorDim,
  deleteKnowledgeSource,
  listKnowledgeSources,
  type KnowledgeSourceRow,
  upsertKnowledgeSource,
  replaceSourceChunks,
  markSourceFailed,
  searchKnowledgeChunks,
  findSourceByRef,
  listSourceChunkContents,
} from "./knowledge";

// 0031 — sessões de refresh (revogação/rotação de refresh token, ADR 0006)
export { authSessions, inboundQuarantine, calendars, calendarEvents } from "./schema";

// 0034 — agenda da plataforma (estilo Google Agenda) + vínculo externo
export {
  type CalendarRow,
  type CalendarEventRow,
  type CreateCalendarEventInput,
  ensureDefaultCalendar,
  updateCalendarLink,
  listCalendarEvents,
  createCalendarEvent,
  updateCalendarEvent,
  deleteCalendarEvent,
  getCalendarEvent,
  getEventByAppointment,
  hasEventOverlap,
  cancelEventsByAppointment,
  // 0036 — pool de agendas (multi-recurso)
  listCalendars,
  listPoolCalendars,
  getCalendarsByIds,
  addCalendar,
  updateCalendar,
  archiveCalendar,
} from "./calendar";
export {
  type AuthSessionRow,
  type CreateAuthSessionInput,
  createAuthSession,
  findAuthSession,
  revokeAuthSession,
  revokeAllUserSessions,
  deleteExpiredAuthSessions,
} from "./auth-sessions";

// 0032 — quarentena de inbound (conexão não-ativa)
export {
  type QuarantineInboundInput,
  type ReplayableQuarantine,
  QUARANTINE_TTL_MS,
  quarantineInbound,
  listReplayableQuarantine,
  markQuarantineReplayed,
  deleteExpiredQuarantine,
} from "./inbound-quarantine";

// 0037 — vertical imobiliária (fork sdr-ia-imob): corretores + distribuição + SLA
export {
  type ImobAgencyRow,
  type ImobBrokerRow,
  type ImobBrokerCandidate,
  type CreateImobBrokerInput,
  type UpdateImobBrokerInput,
  type ImobAssignmentRow,
  type ImobAssignmentJoined,
  type ImobOverview,
  type ImobEventRow,
  IMOB_TERMINAL_STAGES,
  normalizePhoneDigits,
  brPhoneVariants,
  listImobAgencies,
  createImobAgency,
  archiveImobAgency,
  listImobBrokers,
  createImobBroker,
  updateImobBroker,
  findImobBrokerByWa,
  listImobBrokerCandidates,
  getActiveImobAssignment,
  listImobPriorBrokerIds,
  createImobAssignment,
  acceptImobAssignment,
  declineImobAssignment,
  expireImobAssignment,
  setImobAssignmentStage,
  markImobStatusPrompt,
  findImobAssignmentAwaitingReply,
  listImobDueAcceptExpiries,
  listImobDueStatusFollowups,
  claimImobDueStatusFollowups,
  revertImobStatusPrompt,
  isUniqueViolation,
  listImobAssignments,
  getImobAssignmentJoined,
  getImobOverview,
  recordImobEvent,
  listImobEvents,
  listTenantsWithImobDue,
} from "./imob";

// Entrada de leads de campanha (Meta Lead Ads / formulários / integrações)
export {
  type EnsureIntakeLeadInput,
  type EnsureIntakeLeadResult,
  ensureIntakeLead,
} from "./lead-intake";

// Provisionamento de empreendimentos da vertical imobiliária (via Central)
export {
  type ProvisionImobTenantInput,
  type ProvisionImobTenantResult,
  type ImobTenantRow,
  provisionImobTenant,
  listImobTenants,
  isImobTenant,
} from "./imob-provision";

// Workspace do corretor (0040)
export {
  type ImobBrokerMode,
  getImobBrokerMode,
  setImobBrokerMode,
  getImobBrokerById,
  bumpImobBrokerTokenVersion,
  listImobWorkspaceAssignments,
  imobAssignmentForBrokerConversation,
} from "./imob";
