import assert from "node:assert/strict";
import test from "node:test";

import { canQueueNotification, msg91Recipient, normalizeStoredE164 } from "./eligibility.ts";
import { Msg91DeliveryError, providerMessageId, sendMsg91Notification } from "./msg91-client.ts";
import { renderMsg91Template, templatePreview } from "./template-renderer.ts";

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
  const previousTestRecipient = process.env.MEENAKSHI_MSG91_TEST_RECIPIENT_E164;
  process.env.MEENAKSHI_MSG91_TRANSPORT = "mock";
  delete process.env.MEENAKSHI_MSG91_MOCK_RESULT;
  delete process.env.MEENAKSHI_MSG91_TEST_RECIPIENT_E164;
  try {
    const result = await sendMsg91Notification({
      eventType: "cd_credit_note_created", recipientPhoneE164: "+919876543210",
      payload: { customerName: "Asha", creditNoteNumber: "CN-12", creditNoteAmount: "1200" }, template,
    });
    assert.equal(result.mocked, true);
    assert.match(result.providerMessageId, /^mock-/);

    process.env.MEENAKSHI_MSG91_TEST_RECIPIENT_E164 = "+919876543210";
    await assert.rejects(
      () => sendMsg91Notification({ eventType: "cd_credit_note_created", recipientPhoneE164: "+919876543211", payload: { customerName: "Asha", creditNoteNumber: "CN-12" }, template }),
      (error) => error instanceof Msg91DeliveryError && error.statusCode === 403 && error.retryable === false
    );
    const allowlisted = await sendMsg91Notification({
      eventType: "cd_credit_note_created", recipientPhoneE164: "+919876543210",
      payload: { customerName: "Asha", creditNoteNumber: "CN-12" }, template,
    });
    assert.equal(allowlisted.mocked, true);
    delete process.env.MEENAKSHI_MSG91_TEST_RECIPIENT_E164;

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
    if (previousTestRecipient === undefined) delete process.env.MEENAKSHI_MSG91_TEST_RECIPIENT_E164;
    else process.env.MEENAKSHI_MSG91_TEST_RECIPIENT_E164 = previousTestRecipient;
  }
});

test("provider correlation extraction accepts common MSG91 response shapes", () => {
  assert.equal(providerMessageId({ data: [{ message_id: "msg-1" }] }), "msg-1");
  assert.equal(providerMessageId({ requestId: 42 }), "42");
  assert.equal(providerMessageId({}), null);
});
