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

export type StageKey = keyof CrmConfig["stages"];

const STAGE_HINTS: [StageKey, RegExp][] = [
  ["lost", /lost|dead|not interested|disqualif|no sale/i],
  ["completed", /complet|finished|installed|done\b/i],
  ["quoted", /quot|estimate|proposal/i],
  ["booked", /booked|closed|won\b|sold|scheduled|deposit/i],
  ["new", /\bnew\b|inquir|enquir|incoming/i],
];

/**
 * Best guess at which of a pipeline's stages each Lumiquote status belongs in, by stage name.
 * A stage is used once; anything left blank is for the owner to choose.
 */
export function suggestStages(stages: { id: string; name: string }[]): Record<StageKey, string> {
  const picked: Record<StageKey, string> = { new: "", quoted: "", booked: "", completed: "", lost: "" };
  const used = new Set<string>();
  for (const [key, pattern] of STAGE_HINTS) {
    const match = stages.find((stage) => !used.has(stage.id) && pattern.test(stage.name));
    if (match) {
      picked[key] = match.id;
      used.add(match.id);
    }
  }
  if (!picked.new && stages[0] && !used.has(stages[0].id)) picked.new = stages[0].id;
  return picked;
}
