import assert from "node:assert/strict";
import test from "node:test";

import { canQueueNotification, msg91Recipient, normalizeStoredE164 } from "./eligibility.ts";
import { Msg91DeliveryError, providerMessageId, sendMsg91Notification } from "./msg91-client.ts";
import { renderMsg91Template, templatePreview, TemplateConfigurationError } from "./template-renderer.ts";
import { providerTemplateProblem } from "./provider-template.ts";

test("live template validation rejects local placeholders and missing required PDFs", () => {
  const catalog = [{ name: "share_credit_memo", languages: [{ language: "en", status: "approved", variables: ["header_1", "body_1"], variable_type: { header_1: { type: "document" }, body_1: { type: "text" } } }] }];
  assert.match(providerTemplateProblem({ providerTemplateId: "LOCAL_TOD_CREDIT_NOTE_V1", languageCode: "en" }, catalog), /not approved/);
  const template = { providerTemplateId: "share_credit_memo", languageCode: "en", componentSchema: { components: [{ component: "header_1", type: "document", value: "documentUrl" }, { component: "body_1", value: "customerName" }] } };
  assert.match(providerTemplateProblem(template, catalog, false), /requires a Credit Note PDF/);
  assert.equal(providerTemplateProblem(template, catalog, true), null);
});

test("missing frozen template is a permanent configuration failure, not a retry loop", () => {
  assert.throws(() => renderMsg91Template({ eventType: "tod_credit_note_created", recipient: "917977925397", payload: {}, template: {} }), (error) => error instanceof TemplateConfigurationError && error.retryable === false);
});

test("missing approved template variable fails before provider delivery", () => {
  assert.throws(() => renderMsg91Template({ eventType: "tod_credit_note_created", recipient: "917977925397", payload: {}, template: { providerTemplateId: "approved", languageCode: "en" } }), (error) => error instanceof TemplateConfigurationError && error.retryable === false);
});

const template = {
  providerTemplateId: "credit_note_created",
  languageCode: "en",
  namespace: "approved-template-namespace",
  componentSchema: {
    components: [
      { component: "body_var_1", value: "customerName" },
      { component: "body_var_2", value: "creditNoteNumber" },
      { component: "header_1", type: "document", value: "documentUrl", filenameValue: "documentName" },
    ],
  },
};

test("notification eligibility permits open CD reminders and reached TOD tiers, but blocks unverified Credit Notes", () => {
  for (const status of ["sending", "failed", "cancelled", "verification_pending", "queued"]) {
    assert.equal(canQueueNotification("cd_credit_note_created", { scheme_type: "cd", status: "eligible" }, { status }), false);
  }
  assert.equal(canQueueNotification("cd_credit_note_created", { scheme_type: "cd", status: "eligible" }, { status: "created_verified" }), true);
  const openDeadline = "2099-01-01";
  assert.equal(canQueueNotification("cd_shortfall", { scheme_type: "cd", status: "near_eligibility", shortfall_amount: "1.00", eligibility_deadline: openDeadline }), true);
  assert.equal(canQueueNotification("cd_shortfall", { scheme_type: "cd", status: "partially_paid", shortfall_amount: "1.00", eligibility_deadline: openDeadline }), true);
  assert.equal(canQueueNotification("cd_shortfall", { scheme_type: "cd", status: "unpaid", shortfall_amount: "1.00", eligibility_deadline: openDeadline }), true);
  assert.equal(canQueueNotification("cd_shortfall", { scheme_type: "cd", status: "deadline_expired", shortfall_amount: "1.00", eligibility_deadline: openDeadline }), false);
  assert.equal(canQueueNotification("tod_tier_reached", { scheme_type: "tod", status: "tracking", achieved_tier_id: "tier-3" }), true);
  assert.equal(canQueueNotification("tod_tier_reached", { scheme_type: "tod", status: "needs_review", achieved_tier_id: "tier-3" }), false);
});

test("stored contact phones must already be E.164 and are converted for MSG91 only at delivery", () => {
  assert.equal(normalizeStoredE164("+91 98765 43210"), "+919876543210");
  assert.equal(msg91Recipient("+919876543210"), "919876543210");
  assert.equal(normalizeStoredE164("9876543210"), null);
  assert.equal(msg91Recipient("+9198765432100000"), null);
});

test("renderer maps only approved variables and omits a missing PDF component", () => {
  const withoutPdf = renderMsg91Template({
    eventType: "cd_credit_note_created", recipient: "919876543210",
    payload: { customerName: "Asha", creditNoteNumber: "CN-12", creditNoteAmount: "1200" }, template,
  });
  const components = withoutPdf.template.to_and_components[0].components;
  assert.equal(components.body_var_1.value, "Asha");
  assert.equal(components.header_1, undefined);

  const preview = templatePreview("cd_credit_note_created", { customerName: "Asha", creditNoteNumber: "CN-12" }, template.componentSchema);
  assert.match(preview.find((line) => line.component === "header_1").value, /PDF omitted/);
});

test("TOD tier-reached preview uses the reached tier and projected amount, not a Credit Note", () => {
  const preview = templatePreview("tod_tier_reached", {
    customerName: "Asha Rebar",
    todTierPercentage: "3",
    todPeriodStart: "2026-08-15",
    todPeriodEnd: "2026-09-14",
    todTonnes: "430",
    benefitAmount: "12859.50",
  });
  assert.deepEqual(preview.map((line) => line.variable), [
    "customerName", "todTierPercentage", "todPeriodDisplay", "todTonnesDisplay", "benefitAmount",
  ]);
  assert.equal(preview.at(-1)?.value, "12,859.50");
});

test("mock MSG91 delivery has no network dependency and records a provider correlation id", async () => {
  const previousTransport = process.env.MEENAKSHI_MSG91_TRANSPORT;
  const previousResult = process.env.MEENAKSHI_MSG91_MOCK_RESULT;
  process.env.MEENAKSHI_MSG91_TRANSPORT = "mock";
  delete process.env.MEENAKSHI_MSG91_MOCK_RESULT;
  try {
    const result = await sendMsg91Notification({
      eventType: "cd_credit_note_created", recipientPhoneE164: "+919876543210",
      payload: { customerName: "Asha", creditNoteNumber: "CN-12", creditNoteAmount: "1200" }, template,
    });
    assert.equal(result.mocked, true);
    assert.match(result.providerMessageId, /^mock-/);

    // Any entered customer number is delivered; there is no test-recipient gate.
    const anyNumber = await sendMsg91Notification({
      eventType: "cd_credit_note_created", recipientPhoneE164: "+919876543211",
      payload: { customerName: "Asha", creditNoteNumber: "CN-12" }, template,
    });
    assert.equal(anyNumber.mocked, true);

    process.env.MEENAKSHI_MSG91_MOCK_RESULT = "permanent_failure";
    await assert.rejects(
      () => sendMsg91Notification({ eventType: "cd_credit_note_created", recipientPhoneE164: "+919876543210", payload: { customerName: "Asha", creditNoteNumber: "CN-12" }, template }),
      (error) => error instanceof Msg91DeliveryError && error.retryable === false
    );
  } finally {
    if (previousTransport === undefined) delete process.env.MEENAKSHI_MSG91_TRANSPORT;
    else process.env.MEENAKSHI_MSG91_TRANSPORT = previousTransport;
    if (previousResult === undefined) delete process.env.MEENAKSHI_MSG91_MOCK_RESULT;
    else process.env.MEENAKSHI_MSG91_MOCK_RESULT = previousResult;
  }
});

test("provider correlation extraction accepts common MSG91 response shapes", () => {
  assert.equal(providerMessageId({ data: [{ message_id: "msg-1" }] }), "msg-1");
  assert.equal(providerMessageId({ requestId: 42 }), "42");
  assert.equal(providerMessageId({}), null);
});
