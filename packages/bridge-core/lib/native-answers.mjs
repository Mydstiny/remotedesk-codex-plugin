import { fields, object, string, requireThat } from "./errors.mjs";
export function validateNativeAnswer(request, answer) {
  if (request.kind === "questions") {
    fields(answer, ["answers"], ["answers"]);
    object(answer.answers);
    const questions = request.questions;
    requireThat(
      questions.every((q) => !q.isSecret),
      "HOST_SECRET_INPUT_REQUIRED",
    );
    const ids = questions.map((q) => q.id);
    requireThat(
      Object.keys(answer.answers).every((k) => ids.includes(k)),
      "QUESTION_ID_INVALID",
    );
    for (const q of questions) {
      const value = answer.answers[q.id];
      fields(value, ["answers"], ["answers"]);
      requireThat(
        Array.isArray(value.answers) &&
          value.answers.length > 0 &&
          value.answers.length <= 16,
        "QUESTION_ANSWER_INVALID",
      );
      for (const text of value.answers) string(text, 32000);
    }
    return;
  }
  fields(
    answer,
    request.kind === "permissions" ? ["decision", "scope"] : ["decision"],
    ["decision"],
  );
  requireThat(
    ["accept", "decline", "cancel"].includes(answer.decision),
    "APPROVAL_DECISION_INVALID",
  );
  if (request.kind === "permissions" && answer.decision === "accept")
    requireThat(
      answer.scope === "turn",
      "EXPLICIT_TURN_PERMISSION_SCOPE_REQUIRED",
    );
}
