import { extractBlocks, getAttribute, getTagText } from "./xml.mjs";

function value(block, name) {
  return getTagText(block, name) || getAttribute(block, name) || "";
}

function sourcePayload(values) {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== "" && value !== null && value !== undefined));
}

function masterIdentity(block) {
  return {
    guid: value(block, "GUID"),
    masterId: value(block, "MASTERID"),
    alterId: value(block, "ALTERID"),
    name: value(block, "NAME"),
  };
}

function parseMasterList(xml, tagName, map) {
  return extractBlocks(xml, tagName).map(map).filter((item) => item.guid && item.name);
}

export function parseCustomerGroups(xml) {
  return parseMasterList(xml, "GROUP", (block) => {
    const item = masterIdentity(block);
    const parentGuid = value(block, "PARENTGUID");
    const parentName = value(block, "PARENT");
    return {
      ...item,
      parentGuid,
      sourcePayload: sourcePayload({ ...item, parentGuid, parentName }),
    };
  });
}

export function parseUnits(xml) {
  return parseMasterList(xml, "UNIT", (block) => {
    const item = masterIdentity(block);
    const code = value(block, "BASEUNITS") || item.name;
    return {
      ...item,
      code,
      sourcePayload: sourcePayload({ ...item, code, baseUnits: value(block, "BASEUNITS") }),
    };
  }).filter((item) => item.code);
}

export function parseStockGroups(xml) {
  return parseMasterList(xml, "STOCKGROUP", (block) => {
    const item = masterIdentity(block);
    const parentGuid = value(block, "PARENTGUID");
    const parentName = value(block, "PARENT");
    return {
      ...item,
      parentGuid,
      sourcePayload: sourcePayload({ ...item, parentGuid, parentName }),
    };
  });
}

export function parseStockItems(xml) {
  return parseMasterList(xml, "STOCKITEM", (block) => {
    const item = masterIdentity(block);
    const stockGroupGuid = value(block, "PARENTGUID") || value(block, "STOCKGROUPGUID");
    const stockGroupName = value(block, "PARENT") || value(block, "STOCKGROUP");
    const uomCode = value(block, "BASEUNITS") || value(block, "UNITS");
    return {
      ...item,
      stockGroupGuid,
      uomCode,
      sourcePayload: sourcePayload({ ...item, stockGroupGuid, stockGroupName, uomCode }),
    };
  });
}

export function parseLedgers(xml) {
  return parseMasterList(xml, "LEDGER", (block) => {
    const item = masterIdentity(block);
    const parentGroupName = value(block, "PARENT");
    const gstApplicability = value(block, "GSTAPPLICABLE") || value(block, "GSTAPPLICABILITY");
    return {
      ...item,
      parentGroupName,
      gstApplicability,
      sourcePayload: sourcePayload({
        ...item,
        parentGroupName,
        gstApplicability,
        phone: value(block, "MOBILE") || value(block, "PHONENUMBER") || value(block, "PHONE"),
        contactName: value(block, "CONTACTPERSON") || value(block, "ATTENTIONTO"),
      }),
    };
  });
}

export function parseVoucherTypes(xml) {
  return parseMasterList(xml, "VOUCHERTYPE", (block) => {
    const item = masterIdentity(block);
    const parentName = value(block, "PARENT");
    const isCreditNoteType = /credit\s*note/i.test(`${item.name} ${parentName}`);
    return {
      ...item,
      isCreditNoteType,
      sourcePayload: sourcePayload({ ...item, parentName, isCreditNoteType }),
    };
  });
}

export function parseCustomers(xml) {
  return extractBlocks(xml, "LEDGER").map((block) => {
    const item = masterIdentity(block);
    const customerGroupGuid = value(block, "PARENTGUID");
    const customerGroupName = value(block, "PARENT");
    const taxIdentifier = value(block, "PARTYGSTIN");
    const phone = value(block, "MOBILE") || value(block, "PHONENUMBER") || value(block, "PHONE");
    return {
      guid: item.guid,
      masterId: item.masterId,
      alterId: item.alterId,
      ledgerName: item.name,
      customerGroupGuid,
      taxIdentifier,
      sourcePayload: sourcePayload({ ...item, customerGroupGuid, customerGroupName, taxIdentifier, phone }),
    };
  }).filter((item) => item.guid && item.ledgerName);
}

export function filterCustomersInGroupTree(customerGroups, customers, rootGroupName) {
  const groupsByGuid = new Map(customerGroups.map((group) => [group.guid, group]));
  const groupsByName = new Map(customerGroups.map((group) => [group.name, group]));

  function belongsToTree(group) {
    const visited = new Set();
    let current = group;
    while (current && !visited.has(current.guid || current.name)) {
      visited.add(current.guid || current.name);
      if (current.name === rootGroupName) return true;
      const parentName = current.sourcePayload?.parentName;
      current = (current.parentGuid && groupsByGuid.get(current.parentGuid)) || (parentName && groupsByName.get(parentName));
    }
    return false;
  }

  const eligibleGroupGuids = new Set(customerGroups.filter(belongsToTree).map((group) => group.guid));
  const eligibleGroupNames = new Set(customerGroups.filter(belongsToTree).map((group) => group.name));
  return customers.filter((customer) =>
    eligibleGroupGuids.has(customer.customerGroupGuid)
    || eligibleGroupNames.has(customer.sourcePayload?.customerGroupName),
  );
}
