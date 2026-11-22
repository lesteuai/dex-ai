/**
 * Auto mode familiarity gate from the product vision: the agent acts without
 * pausing only when both the platform and the role type have each been seen
 * in N completed rehearsals. A new company alone is not new; a new platform or
 * role type is. Submission stays blocked either way.
 */
import type { AutonomyAssessment, ObservedEventEnvelope } from "@dex-ai/shared";
import type { ControlPlaneDb } from "../db/client";
import { listSessionEvents } from "../repositories/events";
import { listCompletedRehearsals } from "../repositories/rehearsals";

// "Senior Engineer at Acme", "Senior Engineer - Acme", "Senior Engineer | Acme".
const COMPANY_SUFFIX = /\s+(?:at|@|-|–|\|)\s+.*$/i;

export interface RehearsalHistoryItem {
  platform: string;
  roleType: string | null;
}

export function platformOf(postingUrl: string): string {
  return new URL(postingUrl).host.toLowerCase();
}

export function roleTypeOf(title: string | undefined): string | null {
  if (title === undefined) return null;
  const withoutCompany = title.replace(COMPANY_SUFFIX, "");
  const normalized = withoutCompany.toLowerCase().replace(/\s+/g, " ").trim();
  return normalized === "" ? null : normalized;
}

/** The title of the posting the session opened at this url, else its last opened posting. */
export function postingTitleFor(events: ObservedEventEnvelope[], postingUrl: string): string | undefined {
  const opened = events.filter((event) => event.type === "posting_opened");
  const exact = opened.find((event) => event.payload.pageUrl === postingUrl);
  const chosen = exact ?? opened.at(-1);
  return chosen?.type === "posting_opened" ? chosen.payload.title : undefined;
}

export function assessAutonomy(
  target: RehearsalHistoryItem,
  history: RehearsalHistoryItem[],
  requiredCount: number,
): AutonomyAssessment {
  const platformCount = history.filter((item) => item.platform === target.platform).length;
  const roleCount = target.roleType === null
    ? 0
    : history.filter((item) => item.roleType === target.roleType).length;
  const platformFamiliar = platformCount >= requiredCount;
  const roleFamiliar = roleCount >= requiredCount;
  const autonomous = platformFamiliar && roleFamiliar;

  let reason = `Familiar platform and role type (${requiredCount}+ completed rehearsals each); no pauses.`;
  if (!platformFamiliar) {
    reason = `New platform: ${platformCount} of ${requiredCount} completed rehearsals on ${target.platform}.`;
  } else if (target.roleType === null) {
    reason = "Role type unknown: no posting title was observed, so every low-confidence action asks first.";
  } else if (!roleFamiliar) {
    reason = `New role type: ${roleCount} of ${requiredCount} completed rehearsals for "${target.roleType}".`;
  }
  return {
    autonomous,
    requiredCount,
    platform: target.platform,
    platformCount,
    roleType: target.roleType,
    roleCount,
    reason,
  };
}

async function historyItemFor(db: ControlPlaneDb, sessionId: string, postingUrl: string) {
  const events = await listSessionEvents(db, sessionId);
  return { platform: platformOf(postingUrl), roleType: roleTypeOf(postingTitleFor(events, postingUrl)) };
}

// ponytail: reads every completed rehearsal's events per start; add a role column if history grows large.
export async function loadAutonomyAssessment(
  db: ControlPlaneDb,
  sessionId: string,
  postingUrl: string,
  requiredCount: number,
): Promise<AutonomyAssessment> {
  const completed = await listCompletedRehearsals(db);
  const withUrl = completed.flatMap((rehearsal) =>
    rehearsal.postingUrl === null ? [] : [{ sessionId: rehearsal.sessionId, postingUrl: rehearsal.postingUrl }],
  );
  const history = await Promise.all(withUrl.map((item) => historyItemFor(db, item.sessionId, item.postingUrl)));
  const target = await historyItemFor(db, sessionId, postingUrl);
  return assessAutonomy(target, history, requiredCount);
}
