import assert from "node:assert/strict";
import test from "node:test";
import { buildUserPrompt, resolveIncludeFeedback } from "./judge.mjs";

const input = {
  question: "Q-TEXT",
  expected: "EXPECTED-TEXT",
  humanFeedback: "FEEDBACK-TEXT",
  transcript: [{ role: "assistant", content: "ANSWER-TEXT" }],
};

test("feedback is sent to the judge by default", () => {
  const prompt = buildUserPrompt(input);
  assert.match(prompt, /Older expected answer:\nEXPECTED-TEXT/);
  assert.match(prompt, /Human feedback about the older expected answer:\nFEEDBACK-TEXT/);
});

test("feedback block is left out when includeFeedback is false", () => {
  const prompt = buildUserPrompt({ ...input, includeFeedback: false });
  assert.doesNotMatch(prompt, /FEEDBACK-TEXT/);
  assert.doesNotMatch(prompt, /Human feedback/);
  assert.match(prompt, /Older reference answer \(may be outdated; use only to understand the topic\):\nEXPECTED-TEXT/);
  assert.match(prompt, /Conversation transcript:\n1\. Pola: ANSWER-TEXT/);
});

test("JUDGE_INCLUDE_FEEDBACK parsing defaults to on", () => {
  assert.equal(resolveIncludeFeedback(undefined), true);
  assert.equal(resolveIncludeFeedback(""), true);
  assert.equal(resolveIncludeFeedback("1"), true);
  assert.equal(resolveIncludeFeedback("0"), false);
  assert.equal(resolveIncludeFeedback("off"), false);
  assert.equal(resolveIncludeFeedback("false"), false);
});
