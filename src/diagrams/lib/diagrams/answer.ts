// Switchboard's half of ✦ Answer, beside the admin's ai.ts (mirrored by hand, with
// Switchboard's changes to it marked): what a request looks like here, and what a CLI
// is told on top of the admin's prompt.
//
// The admin sends the question to one OpenAI model. Switchboard can send it to four
// (src/main/answer.js): Claude Code or Codex, which run in the workspace folder and
// read its code, or the Claude or OpenAI API, which see only the diagram — exactly
// what the admin sends, and the web when Web access is on. The prompt (with
// Switchboard's changes) and the answer's JSON shape are the same either way, so the
// boxes that come back are drawn the same.

import {
  DEFAULT_FLOW_AI_EFFORT,
  DEFAULT_FLOW_AI_MODEL,
  FLOW_AI_TEXT_FORMAT,
  flowAiPrompt,
  type FlowAiRequest,
} from "./ai"

/** The JSON Schema every provider answers in — the admin's Responses API format's. */
export const FLOW_ANSWER_SCHEMA = FLOW_AI_TEXT_FORMAT.schema

/** What the editor knows about a question, before it knows who answers it. */
export type FlowQuestion = Pick<
  FlowAiRequest,
  "question" | "detail" | "context" | "existing" | "title" | "split" | "subtext"
>

// Added to the admin's system prompt for a CLI. It is in the workspace with tools
// that only read; the point of asking it rather than an API is that it looks.
// Whether it may also go on the web is main's to say (answer.js webPrompt), since
// main is what hands it the tools.
const CLI_PROMPT = `You are running in the folder of a code workspace — one or more repositories — with tools that read and search its files. The flowchart is about this code. Read and search as much as you need to answer accurately, rather than guessing, then answer.

You can only read here. Never try to change a file or run anything.`

// Only with Subtext on: without it, a box has no second line to say where.
const CLI_SOURCES = `When a part of the answer comes from the code, use its "detail" to say where: the file path, and the function or component when that helps.`

/** The system and user messages for a question, for an API or for a CLI. */
export function answerPrompt(
  question: FlowQuestion,
  kind: "cli" | "api",
): { system: string; user: string } {
  // flowAiPrompt reads only the question's own fields; the model and effort it is
  // typed with are the admin's request's, which nothing here sends.
  const { system, user } = flowAiPrompt({
    ...question,
    productId: "",
    model: DEFAULT_FLOW_AI_MODEL,
    effort: DEFAULT_FLOW_AI_EFFORT,
  })
  if (kind !== "cli") return { system, user }
  const cli = question.subtext === false ? CLI_PROMPT : `${CLI_PROMPT}\n\n${CLI_SOURCES}`
  return { system: `${system}\n\n${cli}`, user }
}
