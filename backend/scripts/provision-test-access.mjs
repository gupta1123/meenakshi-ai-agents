import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "")
  .replace(/\/rest\/v1\/?$/i, "")
  .replace(/\/+$/, "");
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;

if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
  throw new Error("SUPABASE_URL and SUPABASE_SECRET_KEY/SUPABASE_SERVICE_ROLE_KEY are required.");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const accounts = [
  {
    email: "meenakshi.api.admin@example.test",
    password: "MeenakshiApiAdminTest!2026",
    displayName: "Meenakshi API Test Administrator",
    role: "administrator",
  },
  {
    email: "meenakshi.api.finance@example.test",
    password: "MeenakshiApiFinanceTest!2026",
    displayName: "Meenakshi API Test Finance Approver",
    role: "finance_approver",
  },
];

function fail(message, error) {
  throw new Error(`${message}: ${error?.message ?? "Unknown error"}`);
}

async function provision() {
  const { data: organization, error: organizationError } = await supabase
    .from("organizations")
    .upsert({ code: "MEENAKSHI_LOCAL_TEST", name: "Meenakshi Local Test", timezone: "Asia/Kolkata", is_active: true }, { onConflict: "code" })
    .select("id")
    .single();
  if (organizationError) fail("Could not provision test organization", organizationError);

  const organizationId = organization.id;
  const now = new Date().toISOString();
  const { error: featureError } = await supabase
    .from("organization_features")
    .upsert({ organization_id: organizationId, feature: "meenakshi_discounts", is_enabled: true, enabled_at: now, configuration: {} }, { onConflict: "organization_id,feature" });
  if (featureError) fail("Could not enable test feature", featureError);

  const { data: company, error: companyError } = await supabase
    .from("companies")
    .upsert({ organization_id: organizationId, code: "MEENAKSHI_LOCAL_TALLY", tally_company_guid: "LOCAL-TEST-TALLY-GUID-001", tally_company_name: "Meenakshi Local Test Company", timezone: "Asia/Kolkata", is_active: true }, { onConflict: "organization_id,code" })
    .select("id")
    .single();
  if (companyError) fail("Could not provision test company", companyError);

  const { data: existingProfiles, error: profileLookupError } = await supabase
    .from("profiles")
    .select("id, display_name")
    .in("display_name", accounts.map((account) => account.displayName));
  if (profileLookupError) fail("Could not look up test profiles", profileLookupError);
  const profilesByName = new Map((existingProfiles ?? []).map((profile) => [profile.display_name, profile]));

  const users = [];
  for (const account of accounts) {
    const existingProfile = profilesByName.get(account.displayName);
    if (existingProfile) {
      const { data, error } = await supabase.auth.admin.updateUserById(existingProfile.id, {
        password: account.password,
        email_confirm: true,
        user_metadata: { display_name: account.displayName, meenakshi_test_user: true },
      });
      if (error || !data.user) fail(`Could not update test user ${account.email}`, error);
      users.push({ ...account, id: data.user.id });
    } else {
      const { data, error } = await supabase.auth.admin.createUser({
        email: account.email,
        password: account.password,
        email_confirm: true,
        user_metadata: { display_name: account.displayName, meenakshi_test_user: true },
      });
      if (error || !data.user) fail(`Could not create test user ${account.email}`, error);
      users.push({ ...account, id: data.user.id });
    }
  }

  for (const user of users) {
    const { error: profileError } = await supabase
      .from("profiles")
      .upsert({ id: user.id, display_name: user.displayName }, { onConflict: "id" });
    if (profileError) fail(`Could not provision profile for ${user.email}`, profileError);

    const { error: membershipError } = await supabase
      .from("organization_memberships")
      .upsert({ organization_id: organizationId, profile_id: user.id, role: user.role }, { onConflict: "organization_id,profile_id,role" });
    if (membershipError) fail(`Could not assign ${user.role} to ${user.email}`, membershipError);
  }

  console.log(JSON.stringify({
    status: "completed",
    organizationId,
    companyId: company.id,
    users: users.map(({ email, role, id }) => ({ email, role, id })),
  }, null, 2));
}

provision().catch((error) => {
  console.error(`PROVISION_TEST_ACCESS_FAILED=${error.message}`);
  process.exitCode = 1;
});
