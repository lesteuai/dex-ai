import type { AgentAdapter, AgentEvent, AgentResultSchemaName, AgentStartInput } from "./adapter";
import { parseAgentResult } from "./results";

/** One scripted run: reasoning lines, then a validated result, or a failure. */
export interface ScriptedAgentFixture {
  reasoning: string[];
  result: unknown;
  failWith?: string;
}

export type ScriptedAgentFixtures = Readonly<
  Partial<Record<AgentResultSchemaName, ScriptedAgentFixture>>
>;

// Fixed fixture event and rule ids so scripted results stay valid UUID references.
// Exported for tests that seed a session whose events back the scripted citations.
export const fixtureEventIds = {
  search: "7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d",
  nameField: "5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b",
  secondNameField: "9c0d1e2f-3a4b-4c5d-8e6f-7a8b9c0d1e2f",
  emailField: "6f7a8b9c-0d1e-4f2a-9b3c-4d5e6f7a8b9c",
  coverLetterReason: "8b9c0d1e-2f3a-4b4c-9d5e-6f7a8b9c0d1e",
} as const;
const SEARCH_EVENT_ID = fixtureEventIds.search;
const NAME_FIELD_EVENT_ID = fixtureEventIds.nameField;
const SECOND_NAME_FIELD_EVENT_ID = fixtureEventIds.secondNameField;
const EMAIL_FIELD_EVENT_ID = fixtureEventIds.emailField;
const COVER_LETTER_REASON_EVENT_ID = fixtureEventIds.coverLetterReason;
const EMAIL_FILL_RULE_ID = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";

export const defaultScriptedFixtures: ScriptedAgentFixtures = {
  profile: {
    reasoning: [
      "Observed one search and three field_filled events on the local fixture application form.",
      "The full name field repeats one value across two events, so it is a user fact.",
      "No reason_stated event mentions salary or team criteria, so the criteria section stays empty.",
    ],
    result: {
      sections: [
        {
          section: "user_facts",
          entries: [
            {
              key: "full_name",
              value: "Jordan Lee",
              confidence: 0.9,
              sourceEventIds: [NAME_FIELD_EVENT_ID, SECOND_NAME_FIELD_EVENT_ID],
              reasoningTrace: "The same full name was typed into the name field on two fixture applications.",
            },
          ],
        },
        {
          section: "job_sources",
          entries: [
            {
              key: "fixture_board",
              value: "local fixture job site",
              confidence: 0.8,
              sourceEventIds: [SEARCH_EVENT_ID],
              reasoningTrace: "The only search in this session ran against the local fixture job site.",
            },
          ],
        },
        {
          section: "preferences",
          entries: [
            {
              key: "cover_letter",
              value: "reuse the stored paragraph",
              confidence: 0.75,
              sourceEventIds: [COVER_LETTER_REASON_EVENT_ID],
              reasoningTrace: "The stated reason says to reuse one stored cover letter paragraph.",
            },
          ],
        },
        { section: "criteria", entries: [] },
        {
          section: "form_rules",
          entries: [
            {
              key: "email_field",
              value: "fill with the stored email address",
              confidence: 0.8,
              sourceEventIds: [EMAIL_FIELD_EVENT_ID],
              reasoningTrace: "The email field was filled with one address every time it appeared.",
            },
          ],
        },
      ],
    },
  },
  rules: {
    reasoning: [
      "The transcript says to always answer the salary question with the stored range.",
      "That maps to one fill rule scoped to salary fields.",
    ],
    result: {
      rules: [
        {
          scope: "rehearsal.fill",
          condition: { fieldLabelContains: "salary" },
          action: { fillValueFrom: "profile.salary_range" },
          confidence: 0.9,
          sourceEventIds: [],
          reasoningTrace: "Teaching transcript: answer salary questions with the stored range.",
        },
      ],
    },
  },
  rehearsalPlan: {
    reasoning: [
      "The posting links to the fixture application form, so navigate there first.",
      "The profile has a full name fact and an email rule, so fill both fields.",
      "There is no submit action in the vocabulary, so the plan ends after filling.",
    ],
    result: {
      postingUrl: "http://127.0.0.1:8787/fixtures/job/posting.html",
      reasoningTrace: "Plan uses the fixture apply page and fills only fields backed by profile facts.",
      actions: [
        {
          action: { kind: "navigate", url: "http://127.0.0.1:8787/fixtures/job/apply.html" },
          confidence: 0.95,
          reasoning: "The apply link on the fixture posting leads to the application form.",
        },
        {
          action: { kind: "fill", selector: "#full-name", value: "Jordan Lee" },
          confidence: 0.9,
          reasoning: "The full name fact from the profile backs this value.",
        },
        {
          action: { kind: "fill", selector: "#email", value: "jordan.lee@example.com" },
          confidence: 0.85,
          reasoning: "The email form rule backs this value.",
        },
      ],
    },
  },
  correction: {
    reasoning: [
      "The user corrected the email value, so the email fill rule must change.",
      "One rule contributed to the wrong proposal and needs an update.",
    ],
    result: {
      reasoningTrace: "The correction replaces the email value used by the fill rule that caused the proposal.",
      ruleUpdates: [
        {
          ruleId: EMAIL_FILL_RULE_ID,
          condition: { fieldLabelContains: "email" },
          action: { fillValueFrom: "profile.email" },
          confidence: 0.9,
          changeReason: "The user corrected the email value on the proposed fill action.",
        },
      ],
    },
  },
};

/**
 * Deterministic AgentAdapter for automated tests and local fixture runs.
 * It never reads the prompt and never touches OpenCode or the network.
 * Each result schema name maps to a scripted fixture, and every scripted
 * result is validated against its schema before it is emitted.
 */
export class DeterministicAgentAdapter implements AgentAdapter {
  private readonly cancelledTaskIds = new Set<string>();

  constructor(private readonly fixtures: ScriptedAgentFixtures = defaultScriptedFixtures) {}

  start(input: AgentStartInput): AsyncIterable<AgentEvent> {
    return this.runScriptedTask(input);
  }

  async cancel(taskId: string): Promise<void> {
    this.cancelledTaskIds.add(taskId);
  }

  private isCancelled(input: AgentStartInput): boolean {
    return input.signal.aborted || this.cancelledTaskIds.has(input.taskId);
  }

  private cancelledStatusEvent(input: AgentStartInput): AgentEvent {
    this.cancelledTaskIds.delete(input.taskId);
    return { type: "status", status: "cancelled" };
  }

  private async *runScriptedTask(input: AgentStartInput): AsyncGenerator<AgentEvent> {
    if (this.isCancelled(input)) {
      yield this.cancelledStatusEvent(input);
      return;
    }
    yield { type: "status", status: "running" };

    const fixture = this.fixtures[input.resultSchema];
    if (!fixture) {
      yield { type: "error", message: `No scripted fixture for result schema ${input.resultSchema}` };
      yield { type: "status", status: "failed" };
      return;
    }

    for (const text of fixture.reasoning) {
      if (this.isCancelled(input)) {
        yield this.cancelledStatusEvent(input);
        return;
      }
      yield { type: "reasoning", text };
    }

    if (fixture.failWith) {
      yield { type: "error", message: fixture.failWith };
      yield { type: "status", status: "failed" };
      return;
    }

    if (this.isCancelled(input)) {
      yield this.cancelledStatusEvent(input);
      return;
    }

    // A fixture that drifts from its schema surfaces as a task error.
    try {
      const value = parseAgentResult(input.resultSchema, fixture.result);
      yield { type: "result", value };
      yield { type: "status", status: "completed" };
    } catch (error) {
      yield { type: "error", message: (error as Error).message };
      yield { type: "status", status: "failed" };
    }
  }
}
