/** Shapes for the CRM link. Kept separate so both the lead and sync modules can import them. */
export interface CrmConfig {
  provider: "ghl";
  pipelineId: string;
  stages: { new: string; quoted: string; booked: string; completed: string; lost: string };
  /** Add jobs booked in the CRM that did not start as a quote request. */
  importBooked: boolean;
  /** Only CRM changes after this moment are imported, so old history is not copied in. */
  since: string;
}

export interface LeadCrm {
  contactId?: string;
  opportunityId?: string;
  linkedExisting?: boolean;
  imported?: boolean;
  syncedAt?: string;
  error?: string;
}

const ID = /^[A-Za-z0-9_-]{6,64}$/;

export function cleanCrmConfig(input: any): CrmConfig | null {
  if (!input || typeof input !== "object" || input.provider !== "ghl") return null;
  const stages = input.stages ?? {};
  const ids = [input.pipelineId, stages.new, stages.quoted, stages.booked, stages.completed, stages.lost];
  if (!ids.every((id) => typeof id === "string" && ID.test(id))) return null;
  const since = typeof input.since === "string" && !Number.isNaN(Date.parse(input.since)) ? input.since : new Date().toISOString();
  return {
    provider: "ghl",
    pipelineId: input.pipelineId,
    stages: { new: stages.new, quoted: stages.quoted, booked: stages.booked, completed: stages.completed, lost: stages.lost },
    importBooked: input.importBooked !== false,
    since,
  };
}
